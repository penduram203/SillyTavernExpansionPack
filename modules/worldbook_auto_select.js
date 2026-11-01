// worldbook_auto_select.js
// キャラクター切替時に、キャラ名と同じロアブックを
//   - 「アクティブな世界情報」（#world_info）として自動選択
//   - 「編集対象の世界情報」（#world_editor_select）として自動選択
// ロアブックが存在しない場合は何もしない。

(function () {
    'use strict';
    const LOG = '[WBAutoSelect]';
    const DEBOUNCE_MS = 700;
    const FIND_RETRY_MAX = 5;
    const FIND_RETRY_DELAY_MS = 300;
    const APPLY_DELAY_MS = 200;

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

    function getCurrentCharName() {
        try {
            const ctx = getSTContext();
            const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
            return char?.name || null;
        } catch (e) { return null; }
    }

    function wait(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function getJQuery() {
        return window.$ || window.jQuery || null;
    }

    // ============================================================
    // ロアブックの存在確認（option の value / text で照合）
    // ============================================================
    function _findOptionValue(selectEl, name) {
        if (!selectEl) return null;
        for (const opt of selectEl.options) {
            const v = (opt.value || '').trim();
            const t = (opt.textContent || '').trim();
            if (v === name) return opt.value;
            if (t === name) return opt.value;
        }
        return null;
    }

    function _hasWorldBook(name) {
        const ed = document.querySelector('#world_editor_select');
        if (_findOptionValue(ed, name) !== null) return true;
        const wi = document.querySelector('#world_info');
        if (_findOptionValue(wi, name) !== null) return true;
        return false;
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
            // select2 に値を反映
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
            // #world_info は multiple なので配列で指定
            const isMultiple = wi.hasAttribute('multiple');
            if (isMultiple) {
                // 既存の選択を置き換える（追加ではなく「そのロアブックのみ」アクティブに）
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
    async function autoSelect(reason) {
        if (_processInFlight) return;
        _processInFlight = true;

        try {
            const charName = getCurrentCharName();
            if (!charName) {
                console.debug(LOG, `スキップ: キャラ未選択 (${reason})`);
                return;
            }

            // CHAT_CHANGED の場合も再実行したいので、キャラ名が同じでも
            // reason が 'chat-changed' or 'character-selected' なら続行
            const sameChar = (_lastProcessedChar === charName);

            // ロアブックが存在するか確認（最大 1.5 秒リトライ）
            let found = false;
            for (let i = 0; i < FIND_RETRY_MAX; i++) {
                if (_hasWorldBook(charName)) { found = true; break; }
                await wait(FIND_RETRY_DELAY_MS);
            }
            if (!found) {
                console.debug(LOG, `ロアブック "${charName}" が見つからないためスキップ`);
                _lastProcessedChar = charName;
                return;
            }

            // 既に正しく設定されている場合はスキップ（重複処理防止）
            if (sameChar && reason !== 'chat-changed') {
                // キャラ名が同じで既に処理済み → 何もしない
                console.debug(LOG, `同一キャラ "${charName}" のためスキップ`);
                return;
            }

            // 編集対象 → アクティブ の順で設定
            const editOk = _setEditTarget(charName);
            await wait(APPLY_DELAY_MS);
            const activeOk = _setActive(charName);

            _lastProcessedChar = charName;

            if (editOk || activeOk) {
                console.log(
                    `${LOG} 🔖 ロアブック "${charName}" を自動選択 ` +
                    `(編集=${editOk}, アクティブ=${activeOk}, reason=${reason})`
                );
            } else {
                console.warn(`${LOG} ロアブック "${charName}" の選択に失敗しました`);
            }
        } catch (e) {
            console.warn(LOG, 'autoSelect error:', e);
        } finally {
            _processInFlight = false;
        }
    }

    function scheduleAutoSelect(reason) {
        if (_scheduleTimer) clearTimeout(_scheduleTimer);
        _scheduleTimer = setTimeout(() => {
            _scheduleTimer = null;
            autoSelect(reason).catch(e => console.warn(LOG, e));
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
        // ST context が利用可能になるまで待つ
        let waited = 0;
        while (!getSTContext() && waited < 10000) {
            await wait(200);
            waited += 200;
        }

        setupEventListeners();

        // 初回実行（起動直後、既にキャラが選択されている場合）
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
        run: (reason) => autoSelect(reason || 'manual'),
        getCurrentCharName,
        hasWorldBook: _hasWorldBook,
        resetProcessed: () => { _lastProcessedChar = null; },
    };
})();
