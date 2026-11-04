// variable_manager.js
// 画面左上にロアブックの「現在のエントリ」の変数の値を表示する。
//   - 現在のエントリ = 最後のユーザーメッセージの番号に対応するロアブックエントリ
//   - 変数値のみを文字列として表示（ヘッダー・折りたたみ・枠なし）
//   - 「場所」は常に表示、敵キャラの名前/HPはバトル開始後のみ表示
//   - 「バトルモード」が 1 の時、AIメッセージ末尾に「バトル開始」ボタンを表示
//   - バトル中は画面左端・高さ中央に「攻撃/防御/アイテム/逃走」ボタンを配置
//   - キャラクター管理メニューに「UI設定 / 開始ボタン / 場所」を追加

(function () {
    'use strict';
    const LOG = '[VarManager]';
    const PANEL_ID = 'variable-manager-panel';
    const STYLE_ID = 'variable-manager-style';
    const POLL_INTERVAL_MS = 1500;

    const UI_SETTINGS_CLASS = 'variable-manager-ui-settings';
    const VISIBLE_CHECKBOX_ID = 'variable-manager-visible-checkbox';
    const START_CHECKBOX_ID = 'variable-manager-start-checkbox';
    const EXT_SETTINGS_KEY = 'variable_manager';
    const EVENT_START_CHANGED = 'variable-manager-start-changed';
    const BATTLE_START_BTN_CLASS = 'variable-battle-start-btn';
    const BATTLE_COMMANDS_ID = 'variable-battle-commands';

    let _lastRenderKey = '';
    let _renderInFlight = false;
    let _initialized = false;
    let _uiObsPending = false;

    // ★ バトル状態
    let _battleActive = false;
    let _battlePrevChatHidden = null;

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
        return null;
    }

    async function getCurrentVariables() {
        const worldName = getWorldName();
        if (!worldName) return { ok: false, reason: 'no-world' };

        const choiceNum = getLastChoiceNumber();
        if (!choiceNum) return { ok: false, reason: 'no-choice' };

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

        // 開始ボタン
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

        // 場所
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

    // ---- パネル ----
    function ensurePanel() {
        let panel = document.getElementById(PANEL_ID);
        if (panel) return panel;

        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'variable-manager-panel variable-manager-disabled';
        document.body.appendChild(panel);
        return panel;
    }

    // ============================================================
    // ★ バトルモード制御
    // ============================================================
    function getLastAiMessageIndex() {
        const ctx = getSTContext();
        if (!ctx?.chat || ctx.chat.length === 0) return -1;
        for (let i = ctx.chat.length - 1; i >= 0; i--) {
            const m = ctx.chat[i];
            if (m.is_system) continue;
            if (!m.is_user) return i;
        }
        return -1;
    }

    function removeBattleStartButton() {
        document.querySelectorAll('.' + BATTLE_START_BTN_CLASS).forEach(el => el.remove());
    }

    function addBattleStartButton() {
        const lastAiIdx = getLastAiMessageIndex();
        if (lastAiIdx < 0) {
            removeBattleStartButton();
            return;
        }

        const mesEl = document.querySelector(`.mes[mesid="${lastAiIdx}"]`);
        if (!mesEl) {
            removeBattleStartButton();
            return;
        }

        const mesTextEl = mesEl.querySelector('.mes_text');
        if (!mesTextEl) {
            removeBattleStartButton();
            return;
        }

        // 既に正しい位置に存在すれば何もしない
        if (mesTextEl.querySelector(':scope > .' + BATTLE_START_BTN_CLASS)) return;

        // 他の位置のボタンを除去
        document.querySelectorAll('.' + BATTLE_START_BTN_CLASS).forEach(el => el.remove());

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = BATTLE_START_BTN_CLASS;
        btn.textContent = 'バトル開始';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            startBattle();
        });

        mesTextEl.appendChild(btn);
    }

    function startBattle() {
        if (_battleActive) return;
        _battleActive = true;
        _battlePrevChatHidden = document.body.classList.contains('variable-battle-active');
        document.body.classList.add('variable-battle-active');
        removeBattleStartButton();
        _lastRenderKey = '';
        console.log(LOG, '⚔️ バトル開始');
        applyBattleCommandsVisibility();
        render();
    }

    function endBattle() {
        if (!_battleActive) return;
        _battleActive = false;
        if (!_battlePrevChatHidden) {
            document.body.classList.remove('variable-battle-active');
        }
        _battlePrevChatHidden = null;
        removeBattleStartButton();
        _lastRenderKey = '';
        console.log(LOG, '⚔️ バトル終了');
        applyBattleCommandsVisibility();
    }

    function updateBattleUI(result) {
        const varMap = {};
        if (result.ok && Array.isArray(result.variables)) {
            for (const v of result.variables) {
                if (v && typeof v.name === 'string' && v.name) {
                    varMap[v.name] = v;
                }
            }
        }

        const battleModeRaw = varMap['バトルモード']?.value;
        const battleMode = String(battleModeRaw ?? '').trim() === '1';

        if (!battleMode) {
            if (_battleActive) endBattle();
            removeBattleStartButton();
            return;
        }

        if (_battleActive) {
            removeBattleStartButton();
        } else {
            addBattleStartButton();
        }
    }

    // ============================================================
    // ★ バトルコマンド（攻撃/防御/アイテム/逃走）— プレースホルダー
    // ============================================================
    function ensureBattleCommands() {
        let container = document.getElementById(BATTLE_COMMANDS_ID);
        if (container) return container;

        container = document.createElement('div');
        container.id = BATTLE_COMMANDS_ID;
        container.className = 'variable-battle-commands';
        container.style.display = 'none';

        const labels = ['攻撃', '防御', '道具', '逃走'];
        for (const label of labels) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'variable-command-btn';
            btn.textContent = label;
            // プレースホルダー: クリックしても何もしない
            container.appendChild(btn);
        }

        document.body.appendChild(container);
        return container;
    }

    function applyBattleCommandsVisibility() {
        const container = document.getElementById(BATTLE_COMMANDS_ID);
        if (!container) return;
        const charName = getCurrentCharName();
        const shouldShow = isVisibleForChar(charName) && _battleActive;
        container.style.display = shouldShow ? '' : 'none';
    }

    // ============================================================
    // レンダリング
    // ============================================================
    function renderPanel(panel, result) {
        if (!panel) return;

        const varMap = {};
        if (result.ok && Array.isArray(result.variables)) {
            for (const v of result.variables) {
                if (v && typeof v.name === 'string' && v.name) {
                    varMap[v.name] = v;
                }
            }
        }

        // ── 場所（常に表示） ──
        const locVal = varMap['場所']?.value;
        const locationText = (locVal !== undefined && locVal !== null && String(locVal).trim())
            ? String(locVal)
            : '場所';

        // ── 敵キャラ情報（バトル中のみ） ──
        let enemyName = null;
        let hp = null;
        if (_battleActive) {
            const enemyNameVal = varMap['敵キャラの名前']?.value;
            if (enemyNameVal !== undefined && enemyNameVal !== null && String(enemyNameVal).trim()) {
                enemyName = String(enemyNameVal);
            }

            const curHP = parseFloat(varMap['敵キャラの現在HP']?.value);
            const maxHP = parseFloat(varMap['敵キャラの最大HP']?.value);
            if (isFinite(curHP) && isFinite(maxHP) && maxHP > 0) {
                hp = {
                    cur: curHP,
                    max: maxHP,
                    ratio: Math.max(0, Math.min(1, curHP / maxHP)),
                };
            }
        }

        const signature = JSON.stringify({ locationText, enemyName, hp });
        if (signature === _lastRenderKey) return;
        _lastRenderKey = signature;

        panel.innerHTML = '';

        // ── 場所 ──
        const locEl = document.createElement('div');
        locEl.className = 'variable-manager-value-text variable-location';
        locEl.textContent = locationText;
        panel.appendChild(locEl);

        // ── 敵キャラの名前 ──
        if (enemyName) {
            const nameEl = document.createElement('div');
            nameEl.className = 'variable-manager-value-text variable-enemy-name';
            nameEl.textContent = enemyName;
            panel.appendChild(nameEl);
        }

        // ── HPバー + 数値 ──
        if (hp) {
            // HPバー（枠 + 緑塗り）
            const wrap = document.createElement('div');
            wrap.className = 'variable-hp-bar-wrap';

            const bar = document.createElement('div');
            bar.className = 'variable-hp-bar';
            bar.style.width = `${hp.ratio * 100}%`;
            wrap.appendChild(bar);

            panel.appendChild(wrap);

            // HP数値（バー右端に重ねる）
            const hpText = document.createElement('div');
            hpText.className = 'variable-hp-text';
            hpText.textContent = String(Math.round(hp.cur));
            panel.appendChild(hpText);
        }
    }

    async function render() {
        ensureUISettings();
        ensureBattleCommands();
        applyBattleCommandsVisibility();

        const charName = getCurrentCharName();
        if (!isVisibleForChar(charName)) {
            // パネル非表示: バトル状態も解除
            if (_battleActive) endBattle();
            removeBattleStartButton();
            _lastRenderKey = '';
            return;
        }

        if (_renderInFlight) return;
        _renderInFlight = true;
        try {
            const panel = ensurePanel();
            applyPanelVisibility();
            const result = await getCurrentVariables();
            updateBattleUI(result);
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

                const resetOnChange = () => {
                    if (_battleActive) endBattle();
                    scheduleRender();
                };

                const events = [
                    'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED',
                    'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED',
                    'CHAT_LOADED', 'GENERATION_ENDED',
                ];
                for (const name of events) {
                    if (et[name] && typeof es.on === 'function') es.on(et[name], scheduleRender);
                }

                const resetEvents = ['CHAT_CHANGED', 'CHARACTER_SELECTED', 'CHARACTER_PAGE_LOADED'];
                for (const name of resetEvents) {
                    if (et[name] && typeof es.on === 'function') es.on(et[name], resetOnChange);
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
        ensureBattleCommands();
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
        isBattleActive: () => _battleActive,
        startBattle,
        endBattle,
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
            battleActive: _battleActive,
        }),
    };
})();
