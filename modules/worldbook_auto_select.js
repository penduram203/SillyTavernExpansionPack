// worldbook_auto_select.js
// キャラクター切替時に、キャラに関連付けられたロアブックを
//   - 「アクティブな世界情報」（#world_info）として自動選択
//   - 「編集対象の世界情報」（#world_editor_select）として自動選択
// ロアブックが存在しないキャラの場合は、両方の選択を解除して空の状態にする。

(function () {
    'use strict';
    const LOG = '[WBAutoSelect]';
    const DEBOUNCE_MS = 700;
    const FIND_RETRY_MAX = 5;
    const FIND_RETRY_DELAY_MS = 300;
    const APPLY_DELAY_MS = 200;
    const CLEAR_DELAY_MS = 200;

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
    // ★ キャラに関連付けられたロアブック名の候補を優先順で返す
    //   1. char.data.extensions.world  (ST の正式な関連付け)
    //   2. char.data.world             (旧形式)
    //   3. char.name                   (キャラ名と同名のロアブック)
    // ============================================================
    function _getCharacterWorldCandidates() {
        const candidates = [];
        try {
            const ctx = getSTContext();
            const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
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

        // 重複排除
        const seen = new Set();
        return candidates.filter(c => {
            if (!c || seen.has(c)) return false;
            seen.add(c);
            return true;
        });
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
            const isMultiple = wi.hasAttribute('multiple');
            if (isMultiple) {
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
    // ★ 選択のクリア
    // ============================================================

    // 編集対象ドロップダウンを空（先頭の "--- Pick to Edit ---" 等）に戻す
    function _clearEditTarget() {
        const $ = getJQuery();
        if (!$) return false;
        const ed = document.querySelector('#world_editor_select');
        if (!ed) return false;
        try {
            // 空 value または "--- ..." テキストの最初のオプションを選ぶ
            let emptyValue = '';
            for (const opt of ed.options) {
                const v = (opt.value || '').trim();
                const t = (opt.textContent || '').trim();
                if (!v || /^---/.test(t) || t === 'None' || t === 'なし') {
                    emptyValue = opt.value;
                    break;
                }
            }
            $(ed).val(emptyValue).trigger('change');
            return true;
        } catch (e) {
            console.warn(LOG, '_clearEditTarget error:', e);
            return false;
        }
    }

    // アクティブワールドの選択を全解除
    function _clearActive() {
        const $ = getJQuery();
        if (!$) return false;
        const wi = document.querySelector('#world_info');
        if (!wi) return false;
        try {
            // multiple の場合は空配列で全解除、single の場合は先頭オプション
            if (wi.hasAttribute('multiple')) {
                $(wi).val([]).trigger('change');
            } else {
                let emptyValue = '';
                for (const opt of wi.options) {
                    const v = (opt.value || '').trim();
                    const t = (opt.textContent || '').trim();
                    if (!v || /^---/.test(t) || t === 'None' || t === 'なし') {
                        emptyValue = opt.value;
                        break;
                    }
                }
                $(wi).val(emptyValue).trigger('change');
            }
            return true;
        } catch (e) {
            console.warn(LOG, '_clearActive error:', e);
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

            const sameChar = (_lastProcessedChar === charName);

            // ── キャラに関連付けられた候補名を取得 ──
            const candidates = _getCharacterWorldCandidates();

            // ── どの候補名がロアブックとして存在するか、最大 1.5 秒リトライ ──
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

            // ── ロアブックが見つからない → 選択をクリア ──
            if (!targetName) {
                const alreadyCleared = (_lastProcessedChar === charName && reason !== 'chat-changed');
                if (!force && alreadyCleared) {
                    console.debug(LOG, `同一キャラ "${charName}" で既にクリア済み → スキップ`);
                    return;
                }

                console.debug(
                    LOG,
                    `ロアブック未関連付け: "${charName}" (候補=[${candidates.join(', ')}]) → 選択をクリア`
                );

                const clearedEdit = _clearEditTarget();
                await wait(CLEAR_DELAY_MS);
                const clearedActive = _clearActive();

                _lastProcessedChar = charName;

                if (clearedEdit || clearedActive) {
                    console.log(
                        `${LOG} 🧹 ロアブック未関連付けのため、選択を解除 ` +
                        `(編集=${clearedEdit}, アクティブ=${clearedActive}, char="${charName}")`
                    );
                } else {
                    console.debug(LOG, `クリア対象なし（既に空の状態）: char="${charName}"`);
                }
                return;
            }

            // ── 既に正しく設定されている場合はスキップ（重複処理防止） ──
            if (!force && sameChar && reason !== 'chat-changed') {
                console.debug(LOG, `同一キャラ "${charName}" のためスキップ（force=true で再適用可能）`);
                return;
            }

            // ── 編集対象 → アクティブ の順で設定 ──
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
        clear: async () => {
            const e = _clearEditTarget();
            await wait(CLEAR_DELAY_MS);
            const a = _clearActive();
            return { edit: e, active: a };
        },
        getCurrentCharName,
        hasWorldBook: _hasWorldBook,
        getCharacterWorldCandidates: _getCharacterWorldCandidates,
        resetProcessed: () => { _lastProcessedChar = null; },
    };
})();
