// variable_manager.js
// 画面左上にロアブックの「現在のエントリ」の変数を表示する。
//   - 現在のエントリ = 最後のユーザーメッセージの番号に対応するロアブックエントリ
//   - ユーザーメッセージが未送信の場合は「000」をフォールバック
//   - 変数は LorebookExpansion の per-world ストアから取得

(function () {
    'use strict';
    const LOG = '[VarManager]';
    const PANEL_ID = 'variable-manager-panel';
    const STYLE_ID = 'variable-manager-style';
    const FALLBACK_CHOICE = '000';
    const STORAGE_KEY_COLLAPSED = 'variable_manager_collapsed';
    const POLL_INTERVAL_MS = 1500;

    let _lastRenderKey = '';
    let _renderInFlight = false;
    let _initialized = false;

    // ---- CSS 注入 ----
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

    // ---- LorebookExpansion の準備待ち ----
    function waitForLBE(maxWaitMs = 10000) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                if (window.LorebookExpansion?.getDataFor &&
                    window.LorebookExpansion?.loadWorldInfoEntriesByName) {
                    resolve(true);
                } else if (Date.now() - start > maxWaitMs) {
                    console.warn(LOG, 'LorebookExpansion が利用可能になりませんでした');
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

    // ---- 現在のロアブック名 ----
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

    // ---- 現在の選択肢番号（最後の有効な数字を持つユーザーメッセージ） ----
    function getLastChoiceNumber() {
        const ctx = getSTContext();
        if (!ctx?.chat) return FALLBACK_CHOICE;

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
        return FALLBACK_CHOICE;
    }

    // ---- 現在のエントリの変数を取得 ----
    async function getCurrentVariables() {
        const worldName = getWorldName();
        if (!worldName) return { ok: false, reason: 'no-world' };

        const choiceNum = getLastChoiceNumber();
        if (!choiceNum) return { ok: false, reason: 'no-choice' };

        let entries = null;
        try {
            entries = await window.LorebookExpansion.loadWorldInfoEntriesByName(worldName);
        } catch (e) {
            return { ok: false, reason: 'load-error' };
        }
        if (!entries) return { ok: false, reason: 'no-entries' };

        let entry = null;
        try {
            entry = window.LorebookExpansion.findEntryByChoice?.(entries, choiceNum);
        } catch (e) { /* ignore */ }
        if (!entry) return { ok: false, reason: 'no-entry', choiceNum, worldName };

        const uid = entry.uid ?? null;
        if (uid === null) return { ok: false, reason: 'no-uid' };

        let data = null;
        try {
            data = window.LorebookExpansion.getDataFor(worldName, uid, entry);
        } catch (e) { return { ok: false, reason: 'data-error' }; }

        const entryKeyRaw = entry.comment || (entry.keys?.[0] || entry.key?.[0]) || String(uid);
        const entryKey = String(entryKeyRaw).trim();

        return {
            ok: true,
            worldName,
            choiceNum,
            entryKey,
            variables: Array.isArray(data?.variables) ? data.variables : []
        };
    }

    // ---- パネル生成 ----
    function ensurePanel() {
        let panel = document.getElementById(PANEL_ID);
        if (panel) return panel;

        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'variable-manager-panel';

        const header = document.createElement('div');
        header.className = 'variable-manager-header';

        const title = document.createElement('span');
        title.className = 'variable-manager-title';
        title.textContent = '変数';
        header.appendChild(title);

        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'variable-manager-toggle';
        toggleBtn.textContent = '−';
        toggleBtn.title = '表示/非表示';
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            panel.classList.toggle('collapsed');
            const isCollapsed = panel.classList.contains('collapsed');
            toggleBtn.textContent = isCollapsed ? '+' : '−';
            try { localStorage.setItem(STORAGE_KEY_COLLAPSED, isCollapsed ? '1' : '0'); } catch (err) { /* ignore */ }
        });
        header.appendChild(toggleBtn);

        panel.appendChild(header);

        const body = document.createElement('div');
        body.className = 'variable-manager-body';
        panel.appendChild(body);

        document.body.appendChild(panel);

        try {
            if (localStorage.getItem(STORAGE_KEY_COLLAPSED) === '1') {
                panel.classList.add('collapsed');
                toggleBtn.textContent = '+';
            }
        } catch (e) { /* ignore */ }

        return panel;
    }

    function renderPanel(panel, result) {
        const title = panel.querySelector('.variable-manager-title');
        const body = panel.querySelector('.variable-manager-body');
        if (!title || !body) return;

        if (!result.ok) {
            if (result.reason === 'no-world') {
                title.textContent = '変数 (ロアブックなし)';
            } else if (result.reason === 'no-entry') {
                title.textContent = `${result.choiceNum || '?'} (エントリなし)`;
            } else {
                title.textContent = '変数';
            }
            title.title = '';
            body.innerHTML = '<div class="variable-manager-empty">—</div>';
            _lastRenderKey = '';
            return;
        }

        title.textContent = result.entryKey || '変数';
        title.title = `${result.entryKey} (${result.choiceNum}) — ${result.worldName}`;

        if (result.variables.length === 0) {
            body.innerHTML = '<div class="variable-manager-empty">変数なし</div>';
            _lastRenderKey = '';
            return;
        }

        const key = result.entryKey + '|' + JSON.stringify(result.variables);
        if (key === _lastRenderKey) return;
        _lastRenderKey = key;

        body.innerHTML = '';
        for (const v of result.variables) {
            const row = document.createElement('div');
            row.className = 'variable-manager-row';

            const nameEl = document.createElement('span');
            nameEl.className = 'variable-manager-name';
            nameEl.textContent = v.name || '(無名)';
            row.appendChild(nameEl);

            const valueEl = document.createElement('span');
            valueEl.className = 'variable-manager-value';
            valueEl.dataset.type = v.type === 'number' ? 'number' : 'string';
            const isEmpty = (v.value === '' || v.value === null || v.value === undefined);
            valueEl.textContent = isEmpty ? '(空)' : String(v.value);
            if (isEmpty) valueEl.classList.add('empty');
            row.appendChild(valueEl);

            body.appendChild(row);
        }
    }

    async function render() {
        if (_renderInFlight) return;
        _renderInFlight = true;
        try {
            const panel = ensurePanel();
            const result = await getCurrentVariables();
            renderPanel(panel, result);
        } catch (e) {
            console.warn(LOG, 'render error:', e);
        } finally {
            _renderInFlight = false;
        }
    }

    function scheduleRender() {
        setTimeout(render, 150);
    }

    // ---- イベント登録 ----
    function setupEventListeners() {
        try {
            const ctx = getSTContext();
            if (ctx?.eventSource && ctx?.eventTypes) {
                const et = ctx.eventTypes;
                const es = ctx.eventSource;
                const events = [
                    'CHAT_CHANGED',
                    'CHARACTER_SELECTED',
                    'CHARACTER_MESSAGE_RENDERED',
                    'USER_MESSAGE_RENDERED',
                    'MESSAGE_EDITED',
                    'MESSAGE_DELETED',
                    'MESSAGE_SWIPED',
                    'CHAT_LOADED',
                    'GENERATION_ENDED',
                ];
                for (const name of events) {
                    if (et[name] && typeof es.on === 'function') {
                        es.on(et[name], scheduleRender);
                    }
                }
            }
        } catch (e) {
            console.warn(LOG, 'event listener setup failed:', e);
        }
    }

    // ---- 初期化 ----
    async function init() {
        if (_initialized) return;
        _initialized = true;

        const ready = await waitForLBE();
        if (!ready) {
            _initialized = false;
            setTimeout(init, 1000);
            return;
        }

        ensurePanel();
        setupEventListeners();
        await render();

        setInterval(render, POLL_INTERVAL_MS);

        console.log(LOG, '初期化完了');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ---- 公開 API（デバッグ用） ----
    window.VariableManager = {
        refresh: render,
        getCurrentVariables,
        _debug: () => ({
            worldName: getWorldName(),
            choiceNum: getLastChoiceNumber(),
        }),
    };
})();
