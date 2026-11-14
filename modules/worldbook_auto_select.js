// worldbook_auto_select.js
// キャラクター切替時に、キャラに関連付けられたロアブックを自動選択する。
// ロアブックが存在しない場合はキャラ名と同じロアブックを自動作成し、
// キャラクターとバインド（char.data.extensions.world）する。
//
// ★ 設計方針: ロアブック名 = キャラ名
//
// ★ 成功判定の階層:
//   1) サーバーに存在（/api/worldinfo/get で確認）
//   2) メモリに存在（world_info[name]）
//   3) DOM に存在（#world_editor_select / #world_info の option）
//   上記 1) or 2) が満たされれば「作成成功」とみなす。
//   DOM 反映は best-effort（反映されていなくても失敗扱いにしない）。

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
    // ★ DOM セレクトのオプションを更新（多重経路）
    //   優先順:
    //     1. loadWorldInfoList を直接呼ぶ（ST の正規手段）
    //     2. ctx.getSettings を呼ぶ
    //     3. 動的 import の getSettings
    // ============================================================
    async function refreshWorldSelects() {
        let success = false;

        // ① loadWorldInfoList
        try {
            const mod = await import('../../../../world-info.js');
            if (typeof mod.loadWorldInfoList === 'function') {
                await mod.loadWorldInfoList();
                console.log(`${LOG} 📋 loadWorldInfoList 実行成功`);
                success = true;
            }
        } catch (e) {
            console.warn(`${LOG} loadWorldInfoList 失敗:`, e.message || e);
        }

        // ② ctx.getSettings
        if (!success) {
            try {
                const ctx = getSTContext();
                if (ctx && typeof ctx.getSettings === 'function') {
                    await ctx.getSettings();
                    console.log(`${LOG} 📋 ctx.getSettings 実行成功`);
                    success = true;
                }
            } catch (e) {
                console.warn(`${LOG} ctx.getSettings 失敗:`, e.message || e);
            }
        }

        // ③ mod.getSettings
        if (!success) {
            try {
                const mod = await import('../../../../world-info.js');
                if (typeof mod.getSettings === 'function') {
                    await mod.getSettings();
                    console.log(`${LOG} 📋 mod.getSettings 実行成功`);
                    success = true;
                }
            } catch (e) {
                console.warn(`${LOG} mod.getSettings 失敗:`, e.message || e);
            }
        }

        return success;
    }

    // ============================================================
    // ★ DOM セレクトに option を直接注入（保険）
    //   loadWorldInfoList が効かない環境（ST のバージョン差異・
    //   キャッシュ問題）でも確実に option を出現させる。
    // ============================================================
    function _addOptionToSelectsIfMissing(name) {
        if (!name) return;
        const added = [];

        const ed = document.querySelector('#world_editor_select');
        if (ed && _findOptionValue(ed, name) === null) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            ed.appendChild(opt);
            added.push('world_editor_select');
        }

        const wi = document.querySelector('#world_info');
        if (wi && _findOptionValue(wi, name) === null) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            wi.appendChild(opt);
            added.push('world_info');
        }

        if (added.length > 0) {
            console.log(`${LOG} 📋 DOM に "${name}" option を直接注入: [${added.join(', ')}]`);
        }
    }
    
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

    // ============================================================
    // ★ DOM のみの同期チェック（高速パス）
    // ============================================================
    function _hasWorldBookInDOM(name) {
        if (!name) return false;
        const ed = document.querySelector('#world_editor_select');
        if (_findOptionValue(ed, name) !== null) return true;
        const wi = document.querySelector('#world_info');
        if (_findOptionValue(wi, name) !== null) return true;
        return false;
    }

    // ============================================================
    // ★ 存在確認（DOM + 検証済みメモリ）
    //   DOM に無くメモリだけある場合は、サーバー検証してから判断する。
    //   サーバーに無ければ stale としてメモリから削除する。
    //   （これが「手動削除後に自動作成が動かない」問題の修正点）
    // ============================================================
    async function _hasWorldBookVerified(name) {
        if (!name) return false;

        // ① DOM チェック（最速・信頼できる）
        if (_hasWorldBookInDOM(name)) return true;

        // ② メモリにあればサーバー検証
        const worldInfo = getWorldInfoInstance();
        if (worldInfo && worldInfo[name]) {
            console.debug(LOG, `"${name}" は DOM に無いがメモリにあるため、サーバー検証`);
            const serverHas = await _verifyWorldbookOnServer(name);
            if (serverHas) {
                console.debug(LOG, `"${name}" はサーバーに存在（DOM 反映遅延のみ）`);
                return true;
            }
            // ★ stale メモリを掃除
            console.warn(
                `${LOG} ⚠️ メモリの "${name}" はサーバーに存在しないため削除（手動削除の残骸）`
            );
            delete worldInfo[name];
            return false;
        }

        return false;
    }

    // 後方互換（debug 用）: DOM + メモリを同期判定（検証なし）
    function _hasWorldBook(name) {
        if (!name) return false;
        if (_hasWorldBookInDOM(name)) return true;
        const worldInfo = getWorldInfoInstance();
        return !!(worldInfo && worldInfo[name]);
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
    // ロアブックの自動作成（成功条件はサーバー or メモリ実在）
    // ============================================================
    async function _createWorldbookIfMissing(worldName) {
        if (!worldName) return false;

        // 1. サーバーに既存ならメモリに復元して成功
        const existing = await fetchWorldbookFromServer(worldName);
        if (existing) {
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

        // 5. サーバー実在確認（5 リトライ）
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

        // ★ サーバー検証が 5 回失敗しても、メモリには存在するので成功扱い
        const worldInfo3 = getWorldInfoInstance();
        if (worldInfo3 && worldInfo3[worldName]) {
            console.warn(`${LOG} サーバー検証は失敗しましたが、メモリに存在するため成功扱い: "${worldName}"`);
            return true;
        }

        return false;
    }

    // ============================================================
    // キャラクターへのバインド
    // ============================================================
    async function _bindCharacterToWorld(char, worldName, force = false) {
        if (!char || !worldName) return false;

        if (!force && char.data?.extensions?.world === worldName) {
            return true;
        }

        // world_info[name] の存在確認（バインド前必須）
        let worldInfo = getWorldInfoInstance();
        if (worldInfo && !worldInfo[worldName]) {
            console.log(`${LOG} ⚠️ world_info["${worldName}"] がメモリに無い → サーバーから復元を試行`);
            const fromServer = await fetchWorldbookFromServer(worldName);
            if (fromServer) {
                worldInfo[worldName] = { entries: fromServer.entries };
                console.log(`${LOG} ✅ world_info["${worldName}"] をメモリに復元`);
            }
        }

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
    // UI 反映（soft success）
    //   DOM に option が無くても、メモリに存在すれば「成功」扱い。
    //   DOM 選択は best-effort で行う（失敗しても致命的でない）。
    // ============================================================
    function _setEditTarget(name) {
        const $ = getJQuery();
        const ed = document.querySelector('#world_editor_select');
        if (!$ || !ed) return false;
        const value = _findOptionValue(ed, name);
        if (value === null) {
            // ★ DOM に無い: soft success（メモリには存在する）
            console.debug(LOG, `_setEditTarget: "${name}" は DOM に無いがメモリには存在するためソフト成功`);
            return true;
        }
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
        const wi = document.querySelector('#world_info');
        if (!$ || !wi) return false;
        const value = _findOptionValue(wi, name);
        if (value === null) {
            // ★ DOM に無い: soft success
            console.debug(LOG, `_setActive: "${name}" は DOM に無いがメモリには存在するためソフト成功`);
            return true;
        }
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
            // ── 1. 既存ロアブックを探す（DOM + サーバー検証済みメモリ） ──
            let targetName = null;
            for (let i = 0; i < FIND_RETRY_MAX; i++) {
                if (isStale()) {
                    console.debug(LOG, `中断: キャラ変更検出 (${charNameAtStart} → ${getCurrentCharName()})`);
                    return;
                }
                for (const name of candidates) {
                    if (await _hasWorldBookVerified(name)) {
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

                const bound = await _bindCharacterToWorld(charAtStart, worldToCreate);
                if (!bound) {
                    console.warn(`${LOG} ロアブック "${worldToCreate}" へのバインドに失敗しました`);
                    _recordFailure(charNameAtStart);
                    return;
                }

                // ── DOM 反映: refreshWorldSelects + 直接注入保険 ──
                await refreshWorldSelects();
                _addOptionToSelectsIfMissing(worldToCreate);  // ★ 保険
                await wait(300);

                // 再度 DOM 確認
                for (let i = 0; i < FIND_RETRY_MAX; i++) {
                    if (_hasWorldBookInDOM(worldToCreate)) {
                        targetName = worldToCreate;
                        break;
                    }
                    if (i === 1) {
                        await refreshWorldSelects();
                        _addOptionToSelectsIfMissing(worldToCreate);  // ★ 保険
                    }
                    await wait(FIND_RETRY_DELAY_MS);
                }

                // 最終フォールバック: サーバー実在すれば成功扱い
                if (!targetName) {
                    const serverHas = await _verifyWorldbookOnServer(worldToCreate);
                    if (serverHas) {
                        console.log(
                            `${LOG} ロアブック "${worldToCreate}" はサーバーに存在 ` +
                            `（DOM 反映遅延のため成功扱い）`
                        );
                        // メモリにも再設定
                        const worldInfo = getWorldInfoInstance();
                        if (worldInfo && !worldInfo[worldToCreate]) {
                            const fromServer = await fetchWorldbookFromServer(worldToCreate);
                            if (fromServer) {
                                worldInfo[worldToCreate] = { entries: fromServer.entries };
                            }
                        }
                        // 保険として DOM にも注入
                        _addOptionToSelectsIfMissing(worldToCreate);
                        targetName = worldToCreate;
                    } else {
                        console.warn(
                            `${LOG} ロアブック "${worldToCreate}" がどの階層にも見つかりませんでした`
                        );
                        _recordFailure(charNameAtStart);
                        return;
                    }
                }
            }

            // ── 3. UI 選択（soft） ──
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

                // 自己修復: targetName == char.name なら extensions.world を同期
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
        hasWorldBookInMemory: (name) => {
            const worldInfo = getWorldInfoInstance();
            return !!(worldInfo && worldInfo[name]);
        },
        getCharacterWorldCandidates: () => _getCharacterWorldCandidates(getCurrentChar()),
        createWorldbook: (name) => _createWorldbookIfMissing(name || getCurrentCharName()),
        verifyWorldbookOnServer: (name) => _verifyWorldbookOnServer(name || getCurrentCharName()),
        fetchWorldbook: (name) => fetchWorldbookFromServer(name || getCurrentCharName()),
        refreshWorldSelects,
        bindCharacter: async (worldName, force) => {
            const char = getCurrentChar();
            return _bindCharacterToWorld(char, worldName || getCurrentCharName(), !!force);
        },
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
                        results.push({ char: char.name, oldWorld: extW, newWorld: char.name, ok });
                    } else {
                        results.push({
                            char: char.name, oldWorld: extW, newWorld: char.name,
                            ok: false, reason: 'char.name のロアブックが存在しません',
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
            const headers = await getRequestHeadersSafe();
            const worldInfo = worldInfoCtx || worldInfoWin;
            return {
                hasCtxWorldInfo: !!worldInfoCtx,
                hasWinWorldInfo: !!worldInfoWin,
                sameInstance: worldInfoCtx === worldInfoWin,
                worldInfoKeys: worldInfo ? Object.keys(worldInfo) : [],
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
