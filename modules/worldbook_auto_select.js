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
// ★ 新規キャラ作成直後（ロアブック未存在）でも同じ処理が走る。

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

    function getCsrfToken() {
        try {
            return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
        } catch (e) { return ''; }
    }

    async function getWorldInfoModule() {
        try {
            return await import('../../../../world-info.js');
        } catch (e) {
            console.warn(LOG, 'world-info.js import 失敗:', e);
            return null;
        }
    }

    // ============================================================
    // ロアブックの存在確認（option の value / text で照合）
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
    // キャラに関連付けられたロアブック名の候補
    //   1. char.data.extensions.world  (ST の正式な関連付け)
    //   2. char.data.world             (旧形式)
    //   3. char.name                   (キャラ名と同名のロアブック)
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
    // ★ 自動作成するエントリのテンプレート
    //   - constant: true (WI Entry Status: Constant)
    //   - position: 4 (at Depth)
    //   - depth: 1
    //   - role: 0 (System)
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
    // ★ ロアブックの自動作成
    //   新規の場合は world_info[worldName] = { entries: { 0: entry } }
    //   として保存する。既に存在する場合は何もしない。
    // ============================================================
    async function _createWorldbookIfMissing(worldName) {
        if (!worldName) return false;

        const mod = await getWorldInfoModule();
        if (!mod) {
            console.warn(LOG, 'world-info.js が読み込めないため自動作成をスキップ');
            return false;
        }

        if (!mod.world_info) mod.world_info = {};
        if (!mod.world_info[worldName]) {
            mod.world_info[worldName] = { entries: {} };
        }

        const entries = mod.world_info[worldName].entries;

        // ★ 既に 00_共通ルール (または何らかのエントリ) があれば何もしない
        const hasAnyEntry = Object.keys(entries).length > 0;
        if (hasAnyEntry) {
            console.debug(LOG, `world_info["${worldName}"] は既にエントリあり → 作成スキップ`);
            return false;
        }

        entries[0] = _createCommonRuleEntry(0);

        // ★ 保存（saveWorldInfo が利用可能なら使用。フォールバックで fetch 直叩き）
        let saved = false;
        if (typeof mod.saveWorldInfo === 'function') {
            try {
                await mod.saveWorldInfo(worldName, true, true);
                saved = true;
            } catch (e) {
                console.warn(LOG, 'saveWorldInfo 失敗:', e);
            }
        }
        if (!saved) {
            try {
                const resp = await fetch('/api/worldinfo/edit', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': getCsrfToken(),
                    },
                    body: JSON.stringify({
                        name: worldName,
                        data: mod.world_info[worldName],
                    }),
                });
                if (resp.ok) saved = true;
                else console.warn(LOG, `/api/worldinfo/edit 失敗: ${resp.status}`);
            } catch (e) {
                console.warn(LOG, '/api/worldinfo/edit 例外:', e);
            }
        }

        if (saved) {
            console.log(
                `${LOG} 🆕 ロアブック "${worldName}" を自動作成しました ` +
                `(00_共通ルール: Constant / at Depth System / depth=1)`
            );
            return true;
        }
        return false;
    }

    // ============================================================
    // ★ キャラクターへのバインド（char.data.extensions.world を設定）
    // ============================================================
    async function _bindCharacterToWorld(char, worldName) {
        if (!char || !worldName) return false;
        try {
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};

            if (char.data.extensions.world === worldName) {
                return true;  // 既にバインド済み
            }

            char.data.extensions.world = worldName;

            // CharStore 経由で保存（推奨）
            if (window.CharStore?.saveCharacterExtension) {
                window.CharStore.saveCharacterExtension('world', worldName, { immediate: true });
                console.log(`${LOG} 🔗 キャラ "${char.name}" をロアブック "${worldName}" にバインド`);
                return true;
            }

            // フォールバック: 直接 merge-attributes
            const avatar = char.avatar && char.avatar !== 'none'
                ? char.avatar
                : `${char.name}.png`;
            const resp = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': getCsrfToken(),
                },
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
        if (value === null) {
            console.debug(LOG, `#world_editor_select に "${name}" のオプションなし`);
            return false;
        }
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
        if (value === null) {
            console.debug(LOG, `#world_info に "${name}" のオプションなし`);
            return false;
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

            // ── 1. 候補名を取得 ──
            const candidates = _getCharacterWorldCandidates();

            // ── 2. 存在するロアブックを探す（リトライ付き） ──
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

            // ── 3. 見つからない場合は自動作成 + バインド ──
            if (!targetName) {
                const worldToCreate = candidates[0] || charName;
                console.log(
                    `${LOG} 🆕 ロアブック "${worldToCreate}" が存在しないため自動作成します ` +
                    `(候補=[${candidates.join(', ')}])`
                );

                const created = await _createWorldbookIfMissing(worldToCreate);
                if (created) {
                    await _bindCharacterToWorld(char, worldToCreate);
                }

                // ST のワールドリストが再読込されるのを待つ
                await wait(POST_CREATE_WAIT_MS);

                // もう一度存在確認
                for (let i = 0; i < FIND_RETRY_MAX; i++) {
                    if (_hasWorldBook(worldToCreate)) {
                        targetName = worldToCreate;
                        break;
                    }
                    await wait(FIND_RETRY_DELAY_MS);
                }

                if (!targetName) {
                    console.warn(
                        `${LOG} ロアブック "${worldToCreate}" の作成に成功しましたが、` +
                        `選択肢への反映を確認できませんでした`
                    );
                    _lastProcessedChar = charName;
                    return;
                }
            }

            // ── 4. 同一キャラで既に正しく設定されている場合はスキップ ──
            if (!force && sameChar && reason !== 'chat-changed') {
                console.debug(LOG, `同一キャラ "${charName}" のためスキップ（force=true で再適用可能）`);
                return;
            }

            // ── 5. 編集対象 → アクティブ の順で設定 ──
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
        bindCharacter: async (worldName) => {
            const char = getCurrentChar();
            return _bindCharacterToWorld(char, worldName || getCurrentCharName());
        },
        resetProcessed: () => { _lastProcessedChar = null; },
    };
})();
