// worldbook_auto_select.js
// キャラクター切替時に、キャラに関連付けられたロアブックを自動選択する。
// ロアブックが存在しない場合はキャラ名と同じロアブックを自動作成し、
// キャラクターとバインド（char.data.extensions.world）する。
//
// ★ 設計方針: ロアブック名 = キャラ名
//   候補の順序は [char.name, extensions.world, data.world]。
//
// ★ 競合状態対策:
//   - ST の saveWorldInfo に依存せず、自前で /api/worldinfo/edit を叩く
//   - 保存は 3 リトライ + 5 検証
//   - バインド前に world_info[name] の存在を必ず確認（TypeError 防止）
//   - _setEditTarget を try/catch で保護（ST 内部エラーで連鎖しない）
//   - 保存直後は getSettings() で UI を強制同期

(function () {
    'use strict';
    const LOG = '[WBAutoSelect]';
    const DEBOUNCE_MS = 300;
    const RETRY_AFTER_FAILURE_MS = 1500;
    const FIND_RETRY_MAX = 5;
    const FIND_RETRY_DELAY_MS = 300;
    const SAVE_RETRY_MAX = 3;
    const SAVE_RETRY_DELAY_MS = 500;
    const VERIFY_RETRY_MAX = 5;
    const VERIFY_RETRY_DELAY_MS = 300;
    const APPLY_DELAY_MS = 200;

    const COMMON_RULE_CONTENT =
        '【絶対厳守ルール】\n' +
        '1. プレイヤーが入力した番号に対応する場面を描写する。\n' +
        '2. {{char}}の台詞を日本のラノベ風にした上で、{{char}}の台詞だけで状況や心情を説明する\n' +
        '3. 地の文を絶対に使わない\n' +
        '3. {{user}}の台詞や独白を描写しない\n' +
        '4. 描写の長さは必ず 約400文字 とすること。100文字や200文字といった短い本文は絶対禁止。\n' +
        '5. 情景・人物の動き・心情・五感・会話を丁寧に書き、短くまとめてはいけない。\n' +
        '6. 描写本文を書いたら、必ず空行を2行入れる。';

    let _generationToken = 0;
    let _scheduleTimer = null;
    let _retryTimer = null;
    let _lastProcessedChar = null;
    let _lastFailure = { char: null, at: 0 };
    const _warnedMismatch = new Set();

    function getSTContext() {
        try {
            if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
                return window.SillyTavern.getContext();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function getCurrentChar() {
        try {
            const ctx = getSTContext();
            return ctx?.characters?.[ctx?.characterId] || ctx?.character || null;
        } catch (e) { return null; }
    }

    function getCurrentCharName() {
        const char = getCurrentChar();
        return char?.name || null;
    }

    function wait(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function getJQuery() {
        return window.$ || window.jQuery || null;
    }

    // ============================================================
    // 確実な getRequestHeaders（CSRF トークン付き）
    // ============================================================
    async function getRequestHeadersSafe() {
        try {
            const mod = await import('../../../../../script.js');
            if (typeof mod.getRequestHeaders === 'function') {
                const h = mod.getRequestHeaders();
                if (h && typeof h === 'object') return h;
            }
        } catch (e) { /* ignore */ }

        try {
            const ctx = getSTContext();
            if (ctx && typeof ctx.getRequestHeaders === 'function') {
                const h = ctx.getRequestHeaders();
                if (h && typeof h === 'object') return h;
            }
        } catch (e) { /* ignore */ }

        const headers = { 'Content-Type': 'application/json' };
        try {
            const csrfMeta = document.querySelector('meta[name="csrf-token"]');
            const csrfInput = document.querySelector('#csrf_token');
            const csrf =
                csrfMeta?.getAttribute('content') ||
                csrfInput?.getAttribute('data-token') ||
                csrfInput?.value ||
                '';
            if (csrf) headers['X-CSRF-Token'] = csrf;
        } catch (e) { /* ignore */ }
        return headers;
    }

    function getWorldInfoInstance() {
        try {
            const ctx = getSTContext();
            if (ctx && ctx.world_info && typeof ctx.world_info === 'object') {
                return ctx.world_info;
            }
        } catch (e) { /* ignore */ }

        if (window.world_info && typeof window.world_info === 'object') {
            return window.world_info;
        }
        return null;
    }

    // ============================================================
    // ST 本体の getSettings を呼んで UI セレクトを更新
    //   内部で saveWorldInfo を呼ばないよう、ctx.getSettings を優先。
    // ============================================================
    async function refreshWorldSelects() {
        try {
            const ctx = getSTContext();
            if (ctx && typeof ctx.getSettings === 'function') {
                await ctx.getSettings();
                return true;
            }
        } catch (e) { /* ignore */ }

        try {
            const mod = await import('../../../../world-info.js');
            if (typeof mod.getSettings === 'function') {
                await mod.getSettings();
                return true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    // ============================================================
    // サーバーからロアブックを取得（メモリ復元用）
    // ============================================================
    async function fetchWorldbookFromServer(worldName) {
        if (!worldName) return null;
        try {
            const headers = await getRequestHeadersSafe();
            const resp = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: worldName }),
                cache: 'no-store',
            });
            if (!resp.ok) return null;
            const data = await resp.json();
            if (data?.entries && Object.keys(data.entries).length > 0) {
                return data;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    function _findOptionValue(selectEl, name) {
        if (!selectEl || !name) return null;
        for (const opt of selectEl.options) {
            const v = (opt.value || '').trim();
            const t = (opt.textContent || '').trim();
            if (v === name) return opt.value;
            if (t === name) return opt.value;
        }
        return null;
    }

    function _hasWorldBook(name) {
        if (!name) return false;
        const ed = document.querySelector('#world_editor_select');
        if (_findOptionValue(ed, name) !== null) return true;
        const wi = document.querySelector('#world_info');
        if (_findOptionValue(wi, name) !== null) return true;
        return false;
    }

    async function _verifyWorldbookOnServer(worldName) {
        if (!worldName) return false;
        const data = await fetchWorldbookFromServer(worldName);
        return !!data;
    }

    function _getCharacterWorldCandidates(char) {
        const candidates = [];
        if (!char) return candidates;

        if (char.name && typeof char.name === 'string' && char.name.trim()) {
            candidates.push(char.name.trim());
        }

        const fromExt = char.data?.extensions?.world;
        if (fromExt && typeof fromExt === 'string' && fromExt.trim()) {
            const w = fromExt.trim();
            if (!candidates.includes(w)) candidates.push(w);
        }

        const fromData = char.data?.world;
        if (fromData && typeof fromData === 'string' && fromData.trim()) {
            const w = fromData.trim();
            if (!candidates.includes(w)) candidates.push(w);
        }

        return candidates;
    }

    function _createCommonRuleEntry(uid) {
        return {
            uid: uid,
            key: [],
            keysecondary: [],
            comment: '00_共通ルール',
            content: COMMON_RULE_CONTENT,
            constant: true,
            vectorized: false,
            selective: true,
            selectiveLogic: 0,
            addMemo: false,
            order: 100,
            position: 4,
            disable: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: 1,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWord: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            sticky: 0,
            cooldown: 0,
            delay: 0,
        };
    }

    // ============================================================
    // ロアブックの自動作成
    //   ST の saveWorldInfo に頼らず、自前で /api/worldinfo/edit を直接叩く。
    //   保存は 3 リトライ、検証は 5 回。
    // ============================================================
    async function _createWorldbookIfMissing(worldName) {
        if (!worldName) return false;

        // 1. サーバー上の実在確認
        const existing = await fetchWorldbookFromServer(worldName);
        if (existing) {
            // メモリにも反映（ST が reload していて消えている場合の保険）
            const worldInfo = getWorldInfoInstance();
            if (worldInfo && !worldInfo[worldName]) {
                worldInfo[worldName] = { entries: existing.entries };
                console.debug(LOG, `既存ロアブック "${worldName}" をメモリに復元`);
            }
            return true;
        }

        // 2. world_info インスタンス取得
        const worldInfo = getWorldInfoInstance();
        if (!worldInfo) {
            console.warn(LOG, 'world_info インスタンスを取得できません');
            return false;
        }

        // 3. メモリに書き込み
        const newWorldData = { entries: { 0: _createCommonRuleEntry(0) } };
        worldInfo[worldName] = newWorldData;

        // 4. サーバー保存（3 リトライ）
        let saveSucceeded = false;
        for (let attempt = 1; attempt <= SAVE_RETRY_MAX; attempt++) {
            try {
                const headers = await getRequestHeadersSafe();
                const resp = await fetch('/api/worldinfo/edit', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        name: worldName,
                        data: newWorldData,
                    }),
                });
                if (resp.ok) {
                    console.log(`${LOG} 💾 /api/worldinfo/edit 成功 (attempt ${attempt})`);
                    saveSucceeded = true;
                    break;
                }
                let errText = '';
                try { errText = await resp.text(); } catch (e) { /* ignore */ }
                console.warn(
                    `${LOG} /api/worldinfo/edit HTTP ${resp.status} (attempt ${attempt}) ` +
                    `body="${errText.slice(0, 200)}"`
                );
            } catch (e) {
                console.warn(LOG, `/api/worldinfo/edit 例外 (attempt ${attempt}):`, e);
            }
            if (attempt < SAVE_RETRY_MAX) await wait(SAVE_RETRY_DELAY_MS);
        }

        if (!saveSucceeded) return false;

        // 5. 検証（5 リトライ）
        for (let i = 0; i < VERIFY_RETRY_MAX; i++) {
            if (await _verifyWorldbookOnServer(worldName)) {
                console.log(`${LOG} 🆕 ロアブック "${worldName}" を自動作成しました`);

                // メモリに再設定（ST が reload していて消えている場合の保険）
                const worldInfo2 = getWorldInfoInstance();
                if (worldInfo2 && !worldInfo2[worldName]) {
                    worldInfo2[worldName] = newWorldData;
                    console.debug(LOG, `"${worldName}" をメモリに再設定`);
                }
                return true;
            }
            await wait(VERIFY_RETRY_DELAY_MS);
        }

        console.warn(`${LOG} ロアブック "${worldName}" のサーバー保存を確認できませんでした`);
        return false;
    }

    // ============================================================
    // キャラクターへのバインド
    //   ★ バインド前に world_info[name] の存在を必ず確認する。
    //     存在しなければ ST の getCharacterLore がクラッシュするため。
    // ============================================================
    async function _bindCharacterToWorld(char, worldName, force = false) {
        if (!char || !worldName) return false;

        if (!force && char.data?.extensions?.world === worldName) {
            return true;
        }

        // ★ 最重要: world_info[name] のメモリ存在を確認
        let worldInfo = getWorldInfoInstance();
        if (worldInfo && !worldInfo[worldName]) {
            // メモリに無い → サーバーから復元を試みる
            console.log(`${LOG} ⚠️ world_info["${worldName}"] がメモリに無い → サーバーから復元を試行`);
            const fromServer = await fetchWorldbookFromServer(worldName);
            if (fromServer) {
                worldInfo[worldName] = { entries: fromServer.entries };
                console.log(`${LOG} ✅ world_info["${worldName}"] をメモリに復元`);
            }
        }

        // 再チェック
        worldInfo = getWorldInfoInstance();
        if (!worldInfo || !worldInfo[worldName]) {
            console.warn(
                `${LOG} world_info["${worldName}"] がメモリにもサーバーにも存在しないため、` +
                `バインドを中止します（TypeError 防止）`
            );
            return false;
        }

        // メモリは同期的に更新
        try {
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};
            char.data.extensions.world = worldName;
        } catch (e) { /* ignore */ }

        // サーバー保存: avatar / ch_name を明示
        try {
            const avatar = char.avatar && char.avatar !== 'none'
                ? char.avatar
                : `${char.name}.png`;
            const headers = await getRequestHeadersSafe();
            const resp = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    avatar: avatar,
                    avatar_url: avatar,
                    ch_name: char.name,
                    data: { extensions: { world: worldName } },
                }),
            });
            if (resp.ok) {
                console.log(`${LOG} 🔗 キャラ "${char.name}" をロアブック "${worldName}" にバインド`);
                return true;
            }
            console.warn(`${LOG} merge-attributes HTTP ${resp.status}`);
            return false;
        } catch (e) {
            console.warn(LOG, '_bindCharacterToWorld error:', e);
            return false;
        }
    }

    // ============================================================
    // UI 反映（try/catch で保護）
    //   ST の onWorldEditorSelectChange が内部で saveWorldInfo(currentWorld) を
    //   呼ぶが、これが 400 で失敗しても連鎖クラッシュしないようにする。
    // ============================================================
    function _setEditTarget(name) {
        const $ = getJQuery();
        if (!$) return false;
        const ed = document.querySelector('#world_editor_select');
        if (!ed) return false;
        const value = _findOptionValue(ed, name);
        if (value === null) return false;

        // ★ change 発火前に、#world_info で既に選択中ならスキップ
        //    （冗長な saveWorldInfo(currentWorld) 呼び出しを抑制）
        try {
            $(ed).val(value).trigger('change');
            return true;
        } catch (e) {
            console.warn(LOG, '_setEditTarget error (ST 内部の saveWorldInfo 失敗の可能性):', e);
            return false;
        }
    }

    function _setActive(name) {
        const $ = getJQuery();
        if (!$) return false;
        const wi = document.querySelector('#world_info');
        if (!wi) return false;
        const value = _findOptionValue(wi, name);
        if (value === null) return false;
        try {
            if (wi.hasAttribute('multiple')) {
                $(wi).val([value]).trigger('change');
            } else {
                $(wi).val(value).trigger('change');
            }
            return true;
        } catch (e) {
            console.warn(LOG, '_setActive error:', e);
            return false;
        }
    }

    // ============================================================
    // メイン処理
    // ============================================================
    async function autoSelect(myToken, reason, options = {}) {
        const isStale = () => _generationToken !== myToken;

        const charAtStart = getCurrentChar();
        const charNameAtStart = charAtStart?.name || null;
        if (!charNameAtStart) {
            console.debug(LOG, `スキップ: キャラ未選択 (${reason})`);
            return;
        }

        const extW = charAtStart.data?.extensions?.world;
        if (extW && extW !== charNameAtStart) {
            const key = `${charNameAtStart}::${extW}`;
            if (!_warnedMismatch.has(key)) {
                _warnedMismatch.add(key);
                console.warn(
                    `${LOG} ⚠️ char="${charNameAtStart}" に異なる world="${extW}" が設定されています。` +
                    `UI 選択後に自動同期されます。`
                );
            }
        }

        const candidates = _getCharacterWorldCandidates(charAtStart);
        console.log(`${LOG} 開始: char="${charNameAtStart}", reason=${reason}, 候補=[${candidates.join(', ')}]`);

        try {
            // ── 1. 既存ロアブックを探す ──
            let targetName = null;
            for (let i = 0; i < FIND_RETRY_MAX; i++) {
                if (isStale()) {
                    console.debug(LOG, `中断: キャラ変更検出 (${charNameAtStart} → ${getCurrentCharName()})`);
                    return;
                }
                for (const name of candidates) {
                    if (_hasWorldBook(name)) {
                        targetName = name;
                        break;
                    }
                }
                if (targetName) break;
                await wait(FIND_RETRY_DELAY_MS);
            }

            // ── 2. 無ければ自動作成 + バインド ──
            if (!targetName) {
                const worldToCreate = charNameAtStart;
                console.log(`${LOG} 🆕 ロアブック "${worldToCreate}" が存在しないため自動作成します`);

                const created = await _createWorldbookIfMissing(worldToCreate);
                if (!created) {
                    console.warn(`${LOG} ロアブック "${worldToCreate}" の作成に失敗しました`);
                    _recordFailure(charNameAtStart);
                    return;
                }

                // ★ バインド（world_info[name] が無ければ内部で中止される）
                const bound = await _bindCharacterToWorld(charAtStart, worldToCreate);
                if (!bound) {
                    console.warn(`${LOG} ロアブック "${worldToCreate}" へのバインドに失敗しました`);
                    _recordFailure(charNameAtStart);
                    return;
                }

                // ★ getSettings で UI 更新を強制
                await refreshWorldSelects();
                await wait(300);

                // DOM セレクト反映確認
                for (let i = 0; i < FIND_RETRY_MAX; i++) {
                    if (_hasWorldBook(worldToCreate)) {
                        targetName = worldToCreate;
                        break;
                    }
                    if (i === 1) await refreshWorldSelects();
                    await wait(FIND_RETRY_DELAY_MS);
                }

                if (!targetName) {
                    console.warn(
                        `${LOG} ロアブック "${worldToCreate}" はサーバーに保存されましたが、` +
                        `UI への反映を確認できませんでした`
                    );
                    _recordFailure(charNameAtStart);
                    return;
                }
            }

            // ── 3. UI 選択 ──
            if (isStale()) {
                console.log(`${LOG} キャラ切替検出のため UI 反映スキップ (選択予定="${targetName}")`);
                return;
            }

            const sameChar = (_lastProcessedChar === charNameAtStart);
            if (!options.force && sameChar && reason !== 'chat-changed') {
                console.debug(LOG, `同一キャラ "${charNameAtStart}" のためスキップ`);
                return;
            }

            const editOk = _setEditTarget(targetName);
            await wait(APPLY_DELAY_MS);
            if (isStale()) return;
            const activeOk = _setActive(targetName);

            if (isStale()) return;

            if (editOk || activeOk) {
                console.log(
                    `${LOG} 🔖 ロアブック "${targetName}" を自動選択 ` +
                    `(編集=${editOk}, アクティブ=${activeOk}, reason=${reason}, force=${!!options.force})`
                );

                // ★ 自己修復: targetName == char.name なら extensions.world を同期
                if (targetName === charNameAtStart) {
                    const currentExt = charAtStart.data?.extensions?.world;
                    if (currentExt !== targetName) {
                        console.log(`${LOG} 🔄 char.extensions.world を "${targetName}" に同期 (旧: "${currentExt || 'none'}")`);
                        await _bindCharacterToWorld(charAtStart, targetName, true);
                    }
                }

                _lastProcessedChar = charNameAtStart;
                _lastFailure = { char: null, at: 0 };
            } else {
                console.warn(`${LOG} ロアブック "${targetName}" の選択に失敗しました`);
                _recordFailure(charNameAtStart);
            }
        } catch (e) {
            console.warn(LOG, 'autoSelect error:', e);
            _recordFailure(charNameAtStart);
        }
    }

    function _recordFailure(charName) {
        _lastProcessedChar = null;
        _lastFailure = { char: charName, at: Date.now() };
        _scheduleRetry(charName);
    }

    function _scheduleRetry(charName) {
        if (_retryTimer) clearTimeout(_retryTimer);
        _retryTimer = setTimeout(() => {
            _retryTimer = null;
            const currentChar = getCurrentCharName();
            if (!currentChar) return;
            if (currentChar === charName) {
                console.log(`${LOG} 🔄 失敗リトライ: char="${currentChar}"`);
                scheduleAutoSelect('retry-after-failure', { force: true });
            }
        }, RETRY_AFTER_FAILURE_MS);
    }

    function scheduleAutoSelect(reason, options = {}) {
        const myToken = ++_generationToken;

        if (_scheduleTimer) clearTimeout(_scheduleTimer);
        if (_retryTimer) {
            clearTimeout(_retryTimer);
            _retryTimer = null;
        }

        _scheduleTimer = setTimeout(() => {
            _scheduleTimer = null;
            autoSelect(myToken, reason, options).catch(e => console.warn(LOG, e));
        }, DEBOUNCE_MS);
    }

    function setupEventListeners() {
        const ctx = getSTContext();
        if (!ctx?.eventSource || !ctx?.eventTypes) return false;

        const et = ctx.eventTypes;
        const es = ctx.eventSource;

        const events = [
            { name: 'CHARACTER_SELECTED', reason: 'character-selected' },
            { name: 'CHAT_CHANGED', reason: 'chat-changed' },
            { name: 'CHARACTER_PAGE_LOADED', reason: 'character-page-loaded' },
            { name: 'SETTINGS_LOADED', reason: 'settings-loaded' },
        ];

        let installed = 0;
        for (const { name, reason } of events) {
            if (et[name] && typeof es.on === 'function') {
                es.on(et[name], () => scheduleAutoSelect(reason));
                installed++;
            }
        }

        if (installed > 0) {
            console.log(LOG, `イベントリスナーを ${installed} 件登録`);
        }
        return installed > 0;
    }

    async function init() {
        let waited = 0;
        while (!getSTContext() && waited < 10000) {
            await wait(200);
            waited += 200;
        }

        setupEventListeners();
        setTimeout(() => scheduleAutoSelect('initial'), 1500);

        console.log(LOG, '初期化完了');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.WorldbookAutoSelect = {
        run: (reason, options) => {
            const token = ++_generationToken;
            return autoSelect(token, reason || 'manual', options || {});
        },
        runForce: () => {
            const token = ++_generationToken;
            return autoSelect(token, 'manual-force', { force: true });
        },
        getCurrentCharName,
        hasWorldBook: _hasWorldBook,
        getCharacterWorldCandidates: () => _getCharacterWorldCandidates(getCurrentChar()),
        createWorldbook: (name) => _createWorldbookIfMissing(name || getCurrentCharName()),
        verifyWorldbookOnServer: (name) => _verifyWorldbookOnServer(name || getCurrentCharName()),
        fetchWorldbook: (name) => fetchWorldbookFromServer(name || getCurrentCharName()),
        bindCharacter: async (worldName, force) => {
            const char = getCurrentChar();
            return _bindCharacterToWorld(char, worldName || getCurrentCharName(), !!force);
        },
        // ★ 汚染された extensions.world を全キャラ一括修復
        fixCorruptedBindings: async () => {
            const ctx = getSTContext();
            const chars = ctx?.characters || [];
            const results = [];
            for (const char of chars) {
                const extW = char.data?.extensions?.world;
                if (extW && extW !== char.name) {
                    const hasNameWorld = await _verifyWorldbookOnServer(char.name);
                    if (hasNameWorld) {
                        const ok = await _bindCharacterToWorld(char, char.name, true);
                        results.push({
                            char: char.name,
                            oldWorld: extW,
                            newWorld: char.name,
                            ok,
                        });
                    } else {
                        results.push({
                            char: char.name,
                            oldWorld: extW,
                            newWorld: char.name,
                            ok: false,
                            reason: 'char.name のロアブックが存在しません',
                        });
                    }
                }
            }
            console.log(`${LOG} 🧹 汚染修復結果:`, results);
            return results;
        },
        // ★ 壊れた world_info[name] を一括チェック（TypeError の原因特定用）
        diagnoseCorruption: () => {
            const ctx = getSTContext();
            const worldInfo = ctx?.world_info || window.world_info;
            const chars = ctx?.characters || [];
            const issues = [];

            for (const char of chars) {
                const extW = char.data?.extensions?.world;
                if (!extW) continue;
                if (!worldInfo || !worldInfo[extW]) {
                    issues.push({
                        char: char.name,
                        world: extW,
                        issue: 'world_info に存在しない',
                    });
                }
            }

            return {
                worldInfoKeys: worldInfo ? Object.keys(worldInfo) : [],
                issues,
            };
        },
        diagnose: async () => {
            const ctx = getSTContext();
            const worldInfoCtx = ctx?.world_info;
            const worldInfoWin = window.world_info;
            const sameInstance = worldInfoCtx === worldInfoWin;
            const headers = await getRequestHeadersSafe();
            return {
                hasCtxWorldInfo: !!worldInfoCtx,
                hasWinWorldInfo: !!worldInfoWin,
                sameInstance,
                worldInfoKeys: worldInfoCtx ? Object.keys(worldInfoCtx) : [],
                hasCsrfToken: !!(headers['X-CSRF-Token']),
                currentToken: _generationToken,
                lastProcessedChar: _lastProcessedChar,
                lastFailure: _lastFailure,
                warnedMismatch: Array.from(_warnedMismatch),
            };
        },
        resetProcessed: () => {
            _lastProcessedChar = null;
            _lastFailure = { char: null, at: 0 };
            _warnedMismatch.clear();
            if (_retryTimer) {
                clearTimeout(_retryTimer);
                _retryTimer = null;
            }
        },
    };
})();
