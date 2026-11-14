// worldbook_auto_select.js
// キャラクター切替時に、キャラに関連付けられたロアブックを
//   - 「アクティブな世界情報」（#world_info）として自動選択
//   - 「編集対象の世界情報」（#world_editor_select）として自動選択
//
// ★ ロアブックが存在しない場合は、キャラ名と同じロアブックを自動作成し、
//   キャラクターとバインド（char.data.extensions.world）する。
//   自動作成されるロアブックには「00_共通ルール」エントリが1つだけ
//   Constant / at Depth System / depth=1 で事前作成される。
//
// ★ ST 本体と同じ world_info インスタンス / saveWorldInfo / getRequestHeaders
//   を使用する。動的 import による別インスタンス問題を回避する。

(function () {
    'use strict';
    const LOG = '[WBAutoSelect]';
    const DEBOUNCE_MS = 700;
    const FIND_RETRY_MAX = 5;
    const FIND_RETRY_DELAY_MS = 300;
    const APPLY_DELAY_MS = 200;
    const POST_CREATE_WAIT_MS = 500;

    // ============================================================
    // ★ 自動作成する「00_共通ルール」エントリの本文
    // ============================================================
    const COMMON_RULE_CONTENT =
        '【絶対厳守ルール】\n' +
        '1. プレイヤーが入力した番号に対応する場面を描写する。\n' +
        '2. {{char}}の台詞を日本のラノベ風にした上で、{{char}}の台詞だけで状況や心情を説明する\n' +
        '3. 地の文を絶対に使わない\n' +
        '3. {{user}}の台詞や独白を描写しない\n' +
        '4. 描写の長さは必ず 約400文字 とすること。100文字や200文字といった短い本文は絶対禁止。\n' +
        '5. 情景・人物の動き・心情・五感・会話を丁寧に書き、短くまとめてはいけない。\n' +
        '6. 描写本文を書いたら、必ず空行を2行入れる。';

    let _scheduleTimer = null;
    let _lastProcessedChar = null;
    let _processInFlight = false;

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
    // ★ ST 本体と同じ world_info インスタンスを取得
    //   優先順:
    //     1. ctx.world_info (getContext 経由)
    //     2. window.world_info
    //     3. 動的 import の mod.world_info (最終手段)
    // ============================================================
    function getWorldInfoInstance() {
        // 1. ctx.world_info
        try {
            const ctx = getSTContext();
            if (ctx && ctx.world_info && typeof ctx.world_info === 'object') {
                return ctx.world_info;
            }
        } catch (e) { /* ignore */ }

        // 2. window.world_info
        if (window.world_info && typeof window.world_info === 'object') {
            return window.world_info;
        }

        return null;
    }

    // ============================================================
    // ★ ST 本体と同じ saveWorldInfo 関数を取得
    // ============================================================
    async function getSaveWorldInfoFn() {
        try {
            const ctx = getSTContext();
            if (ctx && typeof ctx.saveWorldInfo === 'function') {
                return ctx.saveWorldInfo;
            }
        } catch (e) { /* ignore */ }

        try {
            const mod = await import('../../../../world-info.js');
            if (typeof mod.saveWorldInfo === 'function') {
                return mod.saveWorldInfo;
            }
        } catch (e) {
            console.warn(LOG, 'saveWorldInfo の動的 import 失敗:', e);
        }
        return null;
    }

    // ============================================================
    // ★ 確実な getRequestHeaders（CSRF トークン付き）
    //   優先順:
    //     1. script.js の getRequestHeaders（動的 import）
    //     2. ctx.getRequestHeaders
    //     3. meta[name="csrf-token"] から自前で構築
    // ============================================================
    async function getRequestHeadersSafe() {
        // 1. script.js の getRequestHeaders
        try {
            const mod = await import('../../../../../script.js');
            if (typeof mod.getRequestHeaders === 'function') {
                const h = mod.getRequestHeaders();
                if (h && typeof h === 'object') return h;
            }
        } catch (e) { /* ignore */ }

        // 2. ctx.getRequestHeaders
        try {
            const ctx = getSTContext();
            if (ctx && typeof ctx.getRequestHeaders === 'function') {
                const h = ctx.getRequestHeaders();
                if (h && typeof h === 'object') return h;
            }
        } catch (e) { /* ignore */ }

        // 3. フォールバック: meta タグから構築
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

    // ============================================================
    // ロアブックの存在確認（DOM セレクト）
    // ============================================================
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

    // ============================================================
    // ★ サーバー上の実在確認（一次情報源）
    // ============================================================
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
    // キャラに関連付けられたロアブック名の候補
    // ============================================================
    function _getCharacterWorldCandidates() {
        const candidates = [];
        try {
            const char = getCurrentChar();
            if (!char) return candidates;

            const fromExt = char.data?.extensions?.world;
            if (fromExt && typeof fromExt === 'string' && fromExt.trim()) {
                candidates.push(fromExt.trim());
            }
            const fromData = char.data?.world;
            if (fromData && typeof fromData === 'string' && fromData.trim()) {
                candidates.push(fromData.trim());
            }
            if (char.name && typeof char.name === 'string' && char.name.trim()) {
                candidates.push(char.name.trim());
            }
        } catch (e) { /* ignore */ }

        const seen = new Set();
        return candidates.filter(c => {
            if (!c || seen.has(c)) return false;
            seen.add(c);
            return true;
        });
    }

    // ============================================================
    // 自動作成するエントリのテンプレート
    // ============================================================
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
    // ★ ロアブックの自動作成（ST 本体のインスタンスを使用）
    // ============================================================
    async function _createWorldbookIfMissing(worldName) {
        if (!worldName) return false;

        // ── 1. サーバー上の実在確認 ──
        if (await _verifyWorldbookOnServer(worldName)) {
            console.debug(LOG, `"${worldName}" はサーバー上に既存 → 作成スキップ`);
            return true;
        }

        // ── 2. ST 本体の world_info インスタンスを取得 ──
        const worldInfo = getWorldInfoInstance();
        if (!worldInfo) {
            console.warn(LOG, 'world_info インスタンスを取得できません');
            return false;
        }

        // ── 3. 強制上書き（残骸 stub を除去） ──
        worldInfo[worldName] = {
            entries: {
                0: _createCommonRuleEntry(0),
            },
        };

        // ── 4. 保存 ──
        let saved = false;

        // ① saveWorldInfo を試す
        const saveWorldInfo = await getSaveWorldInfoFn();
        if (saveWorldInfo) {
            try {
                await saveWorldInfo(worldName, true, false);
                // 例外が出なければ成功とみなす（実際の確認は後で）
                saved = true;
                console.log(`${LOG} 💾 saveWorldInfo("${worldName}", true, false) 実行`);
            } catch (e) {
                console.warn(LOG, 'saveWorldInfo 失敗:', e);
            }
        }

        // ② サーバー確認（①が成功しても実際には保存されていない可能性）
        if (!(await _verifyWorldbookOnServer(worldName))) {
            console.log(`${LOG} saveWorldInfo で保存されなかったため、直接 API を叩きます`);
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
                    console.warn(
                        `${LOG} /api/worldinfo/edit HTTP ${resp.status} ` +
                        `body="${errText.slice(0, 200)}"`
                    );
                }
            } catch (e) {
                console.warn(LOG, '/api/worldinfo/edit 例外:', e);
            }
        } else {
            saved = true;
        }

        if (!saved) return false;

        // ── 5. サーバー保存の最終確認 ──
        const verified = await _verifyWorldbookOnServer(worldName);
        if (verified) {
            console.log(
                `${LOG} 🆕 ロアブック "${worldName}" を自動作成しました ` +
                `(00_共通ルール: Constant / at Depth System / depth=1)`
            );
        } else {
            console.warn(
                `${LOG} ロアブック "${worldName}" のサーバー保存を確認できませんでした`
            );
        }
        return verified;
    }

    // ============================================================
    // キャラクターへのバインド
    // ============================================================
    async function _bindCharacterToWorld(char, worldName) {
        if (!char || !worldName) return false;
        try {
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};

            if (char.data.extensions.world === worldName) {
                return true;
            }

            char.data.extensions.world = worldName;

            if (window.CharStore?.saveCharacterExtension) {
                window.CharStore.saveCharacterExtension('world', worldName, { immediate: true });
                console.log(`${LOG} 🔗 キャラ "${char.name}" をロアブック "${worldName}" にバインド`);
                return true;
            }

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
            console.warn(LOG, `merge-attributes 失敗: ${resp.status}`);
            return false;
        } catch (e) {
            console.warn(LOG, '_bindCharacterToWorld error:', e);
            return false;
        }
    }

    // ============================================================
    // 編集対象ドロップダウンへの反映
    // ============================================================
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

    // ============================================================
    // アクティブな世界情報への反映
    // ============================================================
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
    async function autoSelect(reason, options = {}) {
        const { force = false } = options;
        if (_processInFlight) return;
        _processInFlight = true;

        try {
            const charName = getCurrentCharName();
            if (!charName) {
                console.debug(LOG, `スキップ: キャラ未選択 (${reason})`);
                return;
            }

            const char = getCurrentChar();
            const sameChar = (_lastProcessedChar === charName);
            const candidates = _getCharacterWorldCandidates();

            // ── 1. 既存ロアブックを探す ──
            let targetName = null;
            for (let i = 0; i < FIND_RETRY_MAX; i++) {
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
            if (!targetName) {
                const worldToCreate = candidates[0] || charName;
                console.log(
                    `${LOG} 🆕 ロアブック "${worldToCreate}" が存在しないため自動作成します ` +
                    `(候補=[${candidates.join(', ')}])`
                );

                const ok = await _createWorldbookIfMissing(worldToCreate);
                if (!ok) {
                    console.warn(`${LOG} ロアブック "${worldToCreate}" の作成に失敗しました`);
                    _lastProcessedChar = charName;
                    return;
                }

                await _bindCharacterToWorld(char, worldToCreate);

                // ST のワールドリスト再読込を待つ
                await wait(POST_CREATE_WAIT_MS);

                // DOM セレクトへの反映を確認
                for (let i = 0; i < FIND_RETRY_MAX; i++) {
                    if (_hasWorldBook(worldToCreate)) {
                        targetName = worldToCreate;
                        break;
                    }
                    await wait(FIND_RETRY_DELAY_MS);
                }

                if (!targetName) {
                    console.warn(
                        `${LOG} ロアブック "${worldToCreate}" はサーバーに保存されましたが、` +
                        `UI への反映を確認できませんでした`
                    );
                    _lastProcessedChar = charName;
                    return;
                }
            }

            // ── 3. 同一キャラで既に設定済みならスキップ ──
            if (!force && sameChar && reason !== 'chat-changed') {
                console.debug(LOG, `同一キャラ "${charName}" のためスキップ`);
                return;
            }

            // ── 4. 編集対象 → アクティブ の順で設定 ──
            const editOk = _setEditTarget(targetName);
            await wait(APPLY_DELAY_MS);
            const activeOk = _setActive(targetName);

            _lastProcessedChar = charName;

            if (editOk || activeOk) {
                console.log(
                    `${LOG} 🔖 ロアブック "${targetName}" を自動選択 ` +
                    `(編集=${editOk}, アクティブ=${activeOk}, reason=${reason}, force=${force})`
                );
            } else {
                console.warn(`${LOG} ロアブック "${targetName}" の選択に失敗しました`);
            }
        } catch (e) {
            console.warn(LOG, 'autoSelect error:', e);
        } finally {
            _processInFlight = false;
        }
    }

    function scheduleAutoSelect(reason, options = {}) {
        if (_scheduleTimer) clearTimeout(_scheduleTimer);
        _scheduleTimer = setTimeout(() => {
            _scheduleTimer = null;
            autoSelect(reason, options).catch(e => console.warn(LOG, e));
        }, DEBOUNCE_MS);
    }

    // ============================================================
    // イベント登録
    // ============================================================
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

    // ============================================================
    // 初期化
    // ============================================================
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

    // デバッグ用 API
    window.WorldbookAutoSelect = {
        run: (reason, options) => autoSelect(reason || 'manual', options || {}),
        runForce: () => autoSelect('manual-force', { force: true }),
        getCurrentCharName,
        hasWorldBook: _hasWorldBook,
        getCharacterWorldCandidates: _getCharacterWorldCandidates,
        createWorldbook: (name) => _createWorldbookIfMissing(name || getCurrentCharName()),
        verifyWorldbookOnServer: (name) => _verifyWorldbookOnServer(name || getCurrentCharName()),
        bindCharacter: async (worldName) => {
            const char = getCurrentChar();
            return _bindCharacterToWorld(char, worldName || getCurrentCharName());
        },
        // ★ デバッグ: ST 本体の world_info / saveWorldInfo の取得状態を確認
        diagnose: async () => {
            const ctx = getSTContext();
            const worldInfoCtx = ctx?.world_info;
            const worldInfoWin = window.world_info;
            const sameInstance = worldInfoCtx === worldInfoWin;
            const saveFn = await getSaveWorldInfoFn();
            const headers = await getRequestHeadersSafe();
            return {
                hasCtxWorldInfo: !!worldInfoCtx,
                hasWinWorldInfo: !!worldInfoWin,
                sameInstance,
                worldInfoKeys: worldInfoCtx ? Object.keys(worldInfoCtx) : [],
                hasSaveWorldInfo: !!saveFn,
                hasCsrfToken: !!(headers['X-CSRF-Token']),
                headers,
            };
        },
        resetProcessed: () => { _lastProcessedChar = null; },
    };
})();
