// worldbook_auto_select.js
// キャラクター切替時に、キャラに関連付けられたロアブックを自動選択する。
// ロアブックが存在しない場合はキャラ名と同じロアブックを自動作成し、
// キャラクターとバインド（char.data.extensions.world）する。
//
// ★ 設計方針: ロアブック名 = キャラ名
//   候補の順序は [char.name, extensions.world, data.world]。
//   char.name のロアブックが存在すれば必ずそれを優先する。
//
// ★ 競合状態対策:
//   - 世代トークンで古い処理を無効化（UI 選択のみ）
//   - 自動作成・バインドは捕捉済みの charAtStart に対して完遂する
//     （キャラ切替で中断しない）
//   - バインドは merge-attributes に avatar / ch_name を明示
//
// ★ 自己修復:
//   - UI 選択後、targetName == char.name なら extensions.world を強制同期
//   - これにより過去のバグで蓄積した汚染が次の選択時に解消される

(function () {
    'use strict';
    const LOG = '[WBAutoSelect]';
    const DEBOUNCE_MS = 300;
    const RETRY_AFTER_FAILURE_MS = 1500;
    const FIND_RETRY_MAX = 5;
    const FIND_RETRY_DELAY_MS = 300;
    const APPLY_DELAY_MS = 200;
    const POST_CREATE_WAIT_MS = 500;

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
    const _warnedMismatch = new Set();  // 不整合警告の一度きり制御

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
        try {
            const headers = await getRequestHeadersSafe();
            const resp = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: worldName }),
                cache: 'no-store',
            });
            if (!resp.ok) return false;
            const data = await resp.json();
            return !!(data?.entries && Object.keys(data.entries).length > 0);
        } catch (e) {
            return false;
        }
    }

    // ============================================================
    // ★ 候補の順序: char.name を最優先
    //   設計方針「ロアブック名 = キャラ名」を強制する。
    //   char.name のロアブックが存在すれば必ずそれが選ばれる。
    //   これにより過去のバグで蓄積した extensions.world の汚染を
    //   自己修復できる。
    // ============================================================
    function _getCharacterWorldCandidates(char) {
        const candidates = [];
        if (!char) return candidates;

        // 1. char.name（最優先）
        if (char.name && typeof char.name === 'string' && char.name.trim()) {
            candidates.push(char.name.trim());
        }

        // 2. extensions.world（char.name と異なる場合のみ）
        const fromExt = char.data?.extensions?.world;
        if (fromExt && typeof fromExt === 'string' && fromExt.trim()) {
            const w = fromExt.trim();
            if (!candidates.includes(w)) candidates.push(w);
        }

        // 3. data.world (legacy)
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
    // ★ ロアブックの自動作成（isStale チェックなし）
    //   捕捉済みの charAtStart に対する処理なので、
    //   現在のキャラが切り替わっていても完遂させる。
    //   → キャラを素早く切り替えても、直前キャラのロアブックが確実に作成される。
    // ============================================================
    async function _createWorldbookIfMissing(worldName) {
        if (!worldName) return false;

        // 1. サーバー上の実在確認
        if (await _verifyWorldbookOnServer(worldName)) {
            return true;
        }

        // 2. ST 本体の world_info インスタンス
        const worldInfo = getWorldInfoInstance();
        if (!worldInfo) {
            console.warn(LOG, 'world_info インスタンスを取得できません');
            return false;
        }

        // 3. 強制上書き
        worldInfo[worldName] = {
            entries: {
                0: _createCommonRuleEntry(0),
            },
        };

        // 4. 保存: saveWorldInfo を試す
        let saved = false;
        try {
            const ctx = getSTContext();
            let saveFn = null;
            if (ctx && typeof ctx.saveWorldInfo === 'function') {
                saveFn = ctx.saveWorldInfo.bind(ctx);
            } else {
                const mod = await import('../../../../world-info.js');
                if (typeof mod.saveWorldInfo === 'function') {
                    saveFn = mod.saveWorldInfo;
                }
            }
            if (saveFn) {
                await saveFn(worldName, true, false);
                saved = true;
                console.log(`${LOG} 💾 saveWorldInfo("${worldName}") 実行`);
            }
        } catch (e) {
            console.warn(LOG, 'saveWorldInfo 失敗:', e);
        }

        // 5. サーバー確認
        if (!(await _verifyWorldbookOnServer(worldName))) {
            try {
                const headers = await getRequestHeadersSafe();
                const resp = await fetch('/api/worldinfo/edit', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        name: worldName,
                        data: worldInfo[worldName],
                    }),
                });
                if (resp.ok) {
                    saved = true;
                    console.log(`${LOG} 💾 /api/worldinfo/edit 成功`);
                } else {
                    let errText = '';
                    try { errText = await resp.text(); } catch (e) { /* ignore */ }
                    console.warn(`${LOG} /api/worldinfo/edit HTTP ${resp.status} body="${errText.slice(0, 200)}"`);
                }
            } catch (e) {
                console.warn(LOG, '/api/worldinfo/edit 例外:', e);
            }
        } else {
            saved = true;
        }

        if (!saved) return false;

        const verified = await _verifyWorldbookOnServer(worldName);
        if (verified) {
            console.log(`${LOG} 🆕 ロアブック "${worldName}" を自動作成しました`);
        }
        return verified;
    }

    // ============================================================
    // ★ キャラクターへのバインド（isStale チェックなし）
    //   charAtStart を明示的に指定するので、await 中にキャラが
    //   切り替わっても正しいキャラに保存される。
    // ============================================================
    async function _bindCharacterToWorld(char, worldName, force = false) {
        if (!char || !worldName) return false;

        if (!force && char.data?.extensions?.world === worldName) {
            return true;
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

    function _setEditTarget(name) {
        const $ = getJQuery();
        if (!$) return false;
        const ed = document.querySelector('#world_editor_select');
        if (!ed) return false;
        const value = _findOptionValue(ed, name);
        if (value === null) return false;
        try {
            $(ed).val(value).trigger('change');
            return true;
        } catch (e) {
            console.warn(LOG, '_setEditTarget error:', e);
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

        // ★ 不整合の警告（1 回だけ）
        const extW = charAtStart.data?.extensions?.world;
        if (extW && extW !== charNameAtStart) {
            const key = `${charNameAtStart}::${extW}`;
            if (!_warnedMismatch.has(key)) {
                _warnedMismatch.add(key);
                console.warn(
                    `${LOG} ⚠️ char="${charNameAtStart}" に異なる world="${extW}" が設定されています。` +
                    `意図的でない場合は要確認（UI 選択後に自動同期されます）。`
                );
            }
        }

        const candidates = _getCharacterWorldCandidates(charAtStart);
        console.log(`${LOG} 開始: char="${charNameAtStart}", reason=${reason}, 候補=[${candidates.join(', ')}]`);

        try {
            // ── 1. 既存ロアブックを探す（DOM セレクト） ──
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

            // ── 2. 見つからない場合は自動作成 + バインド ──
            //   ★ isStale() に関わらず完遂する（charAtStart に対する処理）
            if (!targetName) {
                const worldToCreate = charNameAtStart;  // 設計方針: ロアブック名 = キャラ名
                console.log(`${LOG} 🆕 ロアブック "${worldToCreate}" が存在しないため自動作成します`);

                const ok = await _createWorldbookIfMissing(worldToCreate);
                if (!ok) {
                    console.warn(`${LOG} ロアブック "${worldToCreate}" の作成に失敗しました`);
                    _recordFailure(charNameAtStart);
                    return;
                }

                await _bindCharacterToWorld(charAtStart, worldToCreate);

                // 作成後、DOM 更新を待つ
                await refreshWorldSelects();
                await wait(POST_CREATE_WAIT_MS);

                for (let i = 0; i < FIND_RETRY_MAX; i++) {
                    if (_hasWorldBook(worldToCreate)) {
                        targetName = worldToCreate;
                        break;
                    }
                    if (i === 1) {
                        await refreshWorldSelects();
                    }
                    await wait(FIND_RETRY_DELAY_MS);
                }

                if (!targetName) {
                    console.warn(`${LOG} ロアブック "${worldToCreate}" はサーバーに保存されましたが、UI への反映を確認できませんでした`);
                    _recordFailure(charNameAtStart);
                    return;
                }
            }

            // ── 3. UI 選択（ここで stale チェック） ──
            if (isStale()) {
                console.log(`${LOG} キャラ切替検出のため UI 反映スキップ (char="${charNameAtStart}", 選択予定="${targetName}")`);
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
                console.log(`${LOG} 🔖 ロアブック "${targetName}" を自動選択 (編集=${editOk}, アクティブ=${activeOk}, reason=${reason}, force=${!!options.force})`);

                // ★ 自己修復: targetName == char.name の場合、
                //   extensions.world の汚染を強制同期する
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
        bindCharacter: async (worldName, force) => {
            const char = getCurrentChar();
            return _bindCharacterToWorld(char, worldName || getCurrentCharName(), !!force);
        },
        // ★ 累積した extensions.world の汚染を全キャラ一括修復
        fixCorruptedBindings: async () => {
            const ctx = getSTContext();
            const chars = ctx?.characters || [];
            const results = [];
            for (const char of chars) {
                const extW = char.data?.extensions?.world;
                if (extW && extW !== char.name) {
                    // char.name のロアブックが存在する場合のみ修復
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
