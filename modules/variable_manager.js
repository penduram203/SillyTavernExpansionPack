// variable_manager.js
// 画面左上にロアブックの「現在のエントリ」の変数の値を表示する。
//   - 現在のエントリ = 最後のユーザーメッセージの番号に対応するロアブックエントリ
//   - 変数値のみを文字列として表示（ヘッダー・折りたたみ・枠なし）
//   - キャラクター管理メニューに「UI設定 / 開始ボタン / 場所」を追加し、
//     キャラ毎の表示/非表示・開始ボタン有無を切り替える（extensionSettings に永続化）

(function () {
    'use strict';
    const LOG = '[VarManager]';
    const PANEL_ID = 'variable-manager-panel';
    const STYLE_ID = 'variable-manager-style';
    const FALLBACK_CHOICE = '000';
    const POLL_INTERVAL_MS = 1500;

    const UI_SETTINGS_CLASS = 'variable-manager-ui-settings';
    const VISIBLE_CHECKBOX_ID = 'variable-manager-visible-checkbox';
    const START_CHECKBOX_ID = 'variable-manager-start-checkbox';
    const EXT_SETTINGS_KEY = 'variable_manager';
    const EVENT_START_CHANGED = 'variable-manager-start-changed';

    let _lastRenderKey = '';
    let _renderInFlight = false;
    let _initialized = false;
    let _uiObsPending = false;

    (function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const link = document.createElement('link');
        link.id = STYLE_ID;
        link.rel = 'stylesheet';
        try {
            link.href = new URL('../styles/variable_manager.css', import.meta.url).href;
        } catch (e) {
            link.href = 'styles/variable_manager.css';
        }
        document.head.appendChild(link);
    })();

    function waitForLBE(maxWaitMs = 10000) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                if (window.LorebookExpansion?.getDataFor &&
                    window.LorebookExpansion?.loadWorldInfoEntriesByName) {
                    resolve(true);
                } else if (Date.now() - start > maxWaitMs) {
                    resolve(false);
                } else {
                    setTimeout(check, 200);
                }
            };
            check();
        });
    }

    function getSTContext() {
        try {
            if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
                return window.SillyTavern.getContext();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function getWorldName() {
        if (window.LorebookExpansion?.getCurrentWorldName) {
            try {
                const n = window.LorebookExpansion.getCurrentWorldName();
                if (n) return n;
            } catch (e) { /* ignore */ }
        }
        try {
            const ctx = getSTContext();
            const char = ctx?.characters?.[ctx?.characterId];
            return char?.data?.extensions?.world || char?.data?.world || null;
        } catch (e) { return null; }
    }

    function getLastChoiceNumber() {
        const ctx = getSTContext();
        if (!ctx?.chat) return null;

        for (let i = ctx.chat.length - 1; i >= 0; i--) {
            const m = ctx.chat[i];
            if (m.is_system) continue;
            if (!m.is_user) continue;

            const text = m.mes || '';
            let num = null;
            if (window.LorebookExpansion?.extractChoiceNumber) {
                try { num = window.LorebookExpansion.extractChoiceNumber(text); } catch (e) { /* ignore */ }
            }
            if (!num) {
                const match = text.match(/(\d{3,4})/);
                if (match) num = match[1].padStart(3, '0');
            }
            if (num) return num;
        }
        return null;  // ★ '000' → null に変更
    }

    async function getCurrentVariables() {
        const worldName = getWorldName();
        if (!worldName) return { ok: false, reason: 'no-world' };

        const choiceNum = getLastChoiceNumber();
        if (!choiceNum) {
            // ★ ユーザーがまだ何も選択していない
            return { ok: false, reason: 'no-choice' };
        }

        let entries = null;
        try {
            entries = await window.LorebookExpansion.loadWorldInfoEntriesByName(worldName);
        } catch (e) { return { ok: false, reason: 'load-error' }; }
        if (!entries) return { ok: false, reason: 'no-entries' };

        let entry = null;
        try { entry = window.LorebookExpansion.findEntryByChoice?.(entries, choiceNum); } catch (e) { /* ignore */ }
        if (!entry) return { ok: false, reason: 'no-entry', choiceNum, worldName };

        const uid = entry.uid ?? null;
        if (uid === null) return { ok: false, reason: 'no-uid' };

        let data = null;
        try {
            data = window.LorebookExpansion.getDataFor(worldName, uid, entry);
        } catch (e) { return { ok: false, reason: 'data-error' }; }

        return {
            ok: true,
            variables: Array.isArray(data?.variables) ? data.variables : []
        };
    }

    // ============================================================
    // UI設定
    // ============================================================
    function getCurrentCharName() {
        try {
            const ctx = getSTContext();
            const char = ctx?.characters?.[ctx?.characterId];
            return char?.name || null;
        } catch (e) { return null; }
    }

    function _ensureExtSettings() {
        try {
            const ctx = getSTContext();
            if (!ctx?.extensionSettings) return null;
            if (!ctx.extensionSettings[EXT_SETTINGS_KEY]) {
                ctx.extensionSettings[EXT_SETTINGS_KEY] = {};
            }
            return ctx.extensionSettings[EXT_SETTINGS_KEY];
        } catch (e) { return null; }
    }

    function getVisibleByCharMap() {
        const s = _ensureExtSettings();
        if (!s) return {};
        if (!s.visibleByChar || typeof s.visibleByChar !== 'object') s.visibleByChar = {};
        return s.visibleByChar;
    }

    function saveVisibleByCharMap(map) {
        const s = _ensureExtSettings();
        if (!s) return;
        s.visibleByChar = map;
        try {
            const ctx = getSTContext();
            if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch (e) { /* ignore */ }
    }

    function getStartButtonMap() {
        const s = _ensureExtSettings();
        if (!s) return {};
        if (!s.startButtonByChar || typeof s.startButtonByChar !== 'object') s.startButtonByChar = {};
        return s.startButtonByChar;
    }

    function saveStartButtonMap(map) {
        const s = _ensureExtSettings();
        if (!s) return;
        s.startButtonByChar = map;
        try {
            const ctx = getSTContext();
            if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch (e) { /* ignore */ }
    }

    function isVisibleForChar(charName) {
        if (!charName) return false;
        return getVisibleByCharMap()[charName] === true;
    }

    function isStartButtonEnabledForChar(charName) {
        if (!charName) return false;
        return getStartButtonMap()[charName] === true;
    }

    function applyPanelVisibility() {
        const panel = document.getElementById(PANEL_ID);
        const charName = getCurrentCharName();
        const visible = isVisibleForChar(charName);
        const startEnabled = isStartButtonEnabledForChar(charName);

        if (panel) {
            panel.classList.toggle('variable-manager-disabled', !visible);
        }
        const visCb = document.getElementById(VISIBLE_CHECKBOX_ID);
        if (visCb) {
            visCb.checked = visible;
            visCb.disabled = !charName;
        }
        const startCb = document.getElementById(START_CHECKBOX_ID);
        if (startCb) {
            startCb.checked = startEnabled;
            startCb.disabled = !charName;
        }
    }

    function createUISettings() {
        if (document.getElementById(VISIBLE_CHECKBOX_ID)) return;

        const select = document.getElementById('char-management-dropdown');
        if (!select) return;

        const label = select.closest('label') || select.parentElement;
        if (!label) return;

        const container = document.createElement('div');
        container.className = UI_SETTINGS_CLASS;

        // UI設定（太字）
        const uiLabel = document.createElement('span');
        uiLabel.className = 'variable-manager-ui-label';
        uiLabel.textContent = 'UI設定';
        container.appendChild(uiLabel);

        // 開始ボタン（チェックボックス）
        const startWrap = document.createElement('label');
        startWrap.className = 'variable-manager-checkbox-wrap';
        startWrap.title = 'ゲーム開始ボタンを表示（キャラ毎に保存）';
        const startCb = document.createElement('input');
        startCb.type = 'checkbox';
        startCb.id = START_CHECKBOX_ID;
        startCb.className = 'variable-manager-visible-checkbox';
        startWrap.appendChild(startCb);
        const startText = document.createElement('span');
        startText.className = 'variable-manager-checkbox-text';
        startText.textContent = '開始ボタン';
        startWrap.appendChild(startText);
        startCb.addEventListener('change', () => {
            const charName = getCurrentCharName();
            if (!charName) return;
            const map = getStartButtonMap();
            map[charName] = startCb.checked === true;
            saveStartButtonMap(map);
            try {
                window.dispatchEvent(new CustomEvent(EVENT_START_CHANGED, {
                    detail: { charName, enabled: startCb.checked === true }
                }));
            } catch (e) { /* ignore */ }
        });
        container.appendChild(startWrap);

        // 場所（チェックボックス）
        const placeWrap = document.createElement('label');
        placeWrap.className = 'variable-manager-checkbox-wrap';
        placeWrap.title = '変数ウインドウを表示（キャラ毎に保存）';
        const visCb = document.createElement('input');
        visCb.type = 'checkbox';
        visCb.id = VISIBLE_CHECKBOX_ID;
        visCb.className = 'variable-manager-visible-checkbox';
        placeWrap.appendChild(visCb);
        const placeText = document.createElement('span');
        placeText.className = 'variable-manager-checkbox-text';
        placeText.textContent = '場所';
        placeWrap.appendChild(placeText);
        visCb.addEventListener('change', () => {
            const charName = getCurrentCharName();
            if (!charName) return;
            const map = getVisibleByCharMap();
            map[charName] = visCb.checked === true;
            saveVisibleByCharMap(map);
            applyPanelVisibility();
            render();
        });
        container.appendChild(placeWrap);

        // ★ select の直後（label の内側）に挿入
        select.insertAdjacentElement('afterend', container);

        // ★ label を flex コンテナ化して <select> と横並びにする
        label.style.setProperty('display', 'flex', 'important');
        label.style.setProperty('align-items', 'center', 'important');
        label.style.setProperty('gap', '6px', 'important');
        label.style.setProperty('flex-wrap', 'nowrap', 'important');
        label.style.setProperty('min-width', '0', 'important');
    }

    function ensureUISettings() {
        const select = document.getElementById('char-management-dropdown');
        if (select) {
            const next = select.nextElementSibling;
            const isProper = next && next.classList && next.classList.contains(UI_SETTINGS_CLASS);
            if (!isProper) {
                document.querySelectorAll('.' + UI_SETTINGS_CLASS).forEach(el => el.remove());
                createUISettings();
            }
        }
        applyPanelVisibility();
    }

    function setupUISettingsObserver() {
        const obs = new MutationObserver(() => {
            if (_uiObsPending) return;
            _uiObsPending = true;
            requestAnimationFrame(() => {
                _uiObsPending = false;
                ensureUISettings();
            });
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    // ---- パネル（変数値のみのシンプルなテキスト表示） ----
    function ensurePanel() {
        let panel = document.getElementById(PANEL_ID);
        if (panel) return panel;

        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'variable-manager-panel variable-manager-disabled';
        document.body.appendChild(panel);
        return panel;
    }

    function renderPanel(panel, result) {
        if (!panel) return;

        if (!result.ok) {
            // ★ 何も選択していない → 「場所」プレースホルダを表示
            if (result.reason === 'no-choice') {
                if (_lastRenderKey !== '__placeholder__') {
                    _lastRenderKey = '__placeholder__';
                    panel.innerHTML = '';
                    const line = document.createElement('div');
                    line.className = 'variable-manager-value-text';
                    line.textContent = '場所';
                    panel.appendChild(line);
                }
                return;
            }
            // その他のエラー（no-world 等）は空表示
            if (_lastRenderKey !== '') {
                _lastRenderKey = '';
                panel.innerHTML = '';
            }
            return;
        }

        if (!Array.isArray(result.variables) || result.variables.length === 0) {
            if (_lastRenderKey !== '') {
                _lastRenderKey = '';
                panel.innerHTML = '';
            }
            return;
        }

        const values = [];
        for (const v of result.variables) {
            if (v.value === '' || v.value === null || v.value === undefined) continue;
            values.push(String(v.value));
        }

        if (values.length === 0) {
            if (_lastRenderKey !== '') {
                _lastRenderKey = '';
                panel.innerHTML = '';
            }
            return;
        }

        const key = JSON.stringify(values);
        if (key === _lastRenderKey) return;
        _lastRenderKey = key;

        panel.innerHTML = '';
        for (const val of values) {
            const line = document.createElement('div');
            line.className = 'variable-manager-value-text';
            line.textContent = val;
            panel.appendChild(line);
        }
    }

    async function render() {
        ensureUISettings();

        const charName = getCurrentCharName();
        if (!isVisibleForChar(charName)) {
            _lastRenderKey = '';
            return;
        }

        if (_renderInFlight) return;
        _renderInFlight = true;
        try {
            const panel = ensurePanel();
            applyPanelVisibility();
            const result = await getCurrentVariables();
            renderPanel(panel, result);
        } catch (e) {
            console.warn(LOG, 'render error:', e);
        } finally {
            _renderInFlight = false;
        }
    }

    function scheduleRender() { setTimeout(render, 150); }

    function setupEventListeners() {
        try {
            const ctx = getSTContext();
            if (ctx?.eventSource && ctx?.eventTypes) {
                const et = ctx.eventTypes;
                const es = ctx.eventSource;
                const events = [
                    'CHAT_CHANGED', 'CHARACTER_SELECTED',
                    'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED',
                    'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED',
                    'CHAT_LOADED', 'GENERATION_ENDED', 'CHARACTER_PAGE_LOADED',
                ];
                for (const name of events) {
                    if (et[name] && typeof es.on === 'function') es.on(et[name], scheduleRender);
                }
            }
        } catch (e) { /* ignore */ }
    }

    async function init() {
        if (_initialized) return;
        _initialized = true;

        const ready = await waitForLBE();
        if (!ready) { _initialized = false; setTimeout(init, 1000); return; }

        ensurePanel();
        ensureUISettings();
        setupEventListeners();
        setupUISettingsObserver();
        await render();

        setInterval(render, POLL_INTERVAL_MS);
        console.log(LOG, '初期化完了');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.VariableManager = {
        refresh: render,
        getCurrentVariables,
        isVisibleForChar,
        isStartButtonEnabledForChar,
        setVisibleForChar: (charName, visible) => {
            if (!charName) return false;
            const map = getVisibleByCharMap();
            map[charName] = !!visible;
            saveVisibleByCharMap(map);
            applyPanelVisibility();
            render();
            return true;
        },
        setStartButtonForChar: (charName, enabled) => {
            if (!charName) return false;
            const map = getStartButtonMap();
            map[charName] = !!enabled;
            saveStartButtonMap(map);
            applyPanelVisibility();
            try {
                window.dispatchEvent(new CustomEvent(EVENT_START_CHANGED, {
                    detail: { charName, enabled: !!enabled }
                }));
            } catch (e) { /* ignore */ }
            return true;
        },
        _debug: () => ({
            worldName: getWorldName(),
            choiceNum: getLastChoiceNumber(),
            currentChar: getCurrentCharName(),
            visibleMap: getVisibleByCharMap(),
            startButtonMap: getStartButtonMap(),
        }),
    };
})();
