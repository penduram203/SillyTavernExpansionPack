// user_status.js
// ユーザー（ペルソナ）のステータス（最大HP / 現在HP）を管理し、
// 画面左下に緑色のHPバーとして表示する。
//   - デフォルト: 最大HP=500, 現在HP=500
//   - 名前は #user_avatar_block の .ch_name から取得（ペルソナ名）
//   - 表示形式は variable_manager.js の敵HPバーと同形式
//   - ★ ロアブック「00_共通ルール」の RPGモード 変数が 1 の時のみ表示
//   - ★ キャラ未選択の時は絶対に表示しない（ST起動直後対策）

(function () {
    'use strict';
    const LOG = '[UserStatus]';
    const MODULE_NAME = 'user_status';
    const PANEL_ID = 'user-status-panel';
    const STYLE_ID = 'user-status-style';
    const POLL_INTERVAL_MS = 1000;

    const DEFAULT_MAX_HP = 500;
    const DEFAULT_CUR_HP = 500;

    let _lastRenderKey = '';

    (function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const link = document.createElement('link');
        link.id = STYLE_ID;
        link.rel = 'stylesheet';
        try {
            link.href = new URL('../styles/user_status.css', import.meta.url).href;
        } catch (e) {
            link.href = 'styles/user_status.css';
        }
        document.head.appendChild(link);
    })();

    function getSTContext() {
        try {
            if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
                return window.SillyTavern.getContext();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // ============================================================
    // ★ キャラが選択されているか（同期判定）
    //   - ctx.characters[ctx.characterId] に名前があるか
    //   - 無ければ ctx.character?.name にフォールバック
    // ============================================================
    function hasActiveCharacter() {
        try {
            const ctx = getSTContext();
            if (!ctx) return false;

            if (ctx.characterId !== undefined && ctx.characterId !== null) {
                const char = ctx.characters?.[ctx.characterId];
                if (char?.name) return true;
            }
            if (ctx.character?.name) return true;
            return false;
        } catch (e) { return false; }
    }

    function _ensureSettings() {
        try {
            const ctx = getSTContext();
            if (!ctx?.extensionSettings) return null;
            if (!ctx.extensionSettings[MODULE_NAME]) {
                ctx.extensionSettings[MODULE_NAME] = {};
            }
            return ctx.extensionSettings[MODULE_NAME];
        } catch (e) { return null; }
    }

    function getUserStatus() {
        const s = _ensureSettings();
        if (!s) return { maxHP: DEFAULT_MAX_HP, curHP: DEFAULT_CUR_HP };

        if (typeof s.maxHP !== 'number' || !isFinite(s.maxHP) || s.maxHP <= 0) {
            s.maxHP = DEFAULT_MAX_HP;
        }
        if (typeof s.curHP !== 'number' || !isFinite(s.curHP) || s.curHP < 0) {
            s.curHP = DEFAULT_CUR_HP;
        }
        s.curHP = Math.max(0, Math.min(s.maxHP, s.curHP));
        return { maxHP: s.maxHP, curHP: s.curHP };
    }

    function setUserStatus(patch) {
        const s = _ensureSettings();
        if (!s) return;

        if (typeof patch.maxHP === 'number' && isFinite(patch.maxHP) && patch.maxHP > 0) {
            s.maxHP = patch.maxHP;
        }
        if (typeof patch.curHP === 'number' && isFinite(patch.curHP)) {
            s.curHP = patch.curHP;
        }
        const cur = getUserStatus();
        s.curHP = Math.max(0, Math.min(cur.maxHP, s.curHP));

        try {
            const ctx = getSTContext();
            if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch (e) { /* ignore */ }

        _lastRenderKey = '';
        render();
    }

    // ============================================================
    // ★ RPGモード判定
    //   - キャラ未選択 → false
    //   - VariableManager のキャッシュが ok:true → その rpgMode を返す
    //   - キャッシュが ok:false → refreshCommonRuleFlags を呼んで再取得
    // ============================================================
    function isRPGModeSync() {
        if (!hasActiveCharacter()) return false;
        try {
            const flags = window.VariableManager?.getCommonRuleFlags?.();
            return flags?.rpgMode === true;
        } catch (e) { return false; }
    }

    async function isRPGMode() {
        // ★ キャラ未選択なら VariableManager に問い合わせず即 false
        if (!hasActiveCharacter()) return false;

        try {
            const flags = window.VariableManager?.getCommonRuleFlags?.();
            if (flags && flags.ok === true) {
                return flags.rpgMode === true;
            }
            if (window.VariableManager?.refreshCommonRuleFlags) {
                const refreshed = await window.VariableManager.refreshCommonRuleFlags();
                return refreshed?.rpgMode === true;
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    async function waitForVariableManager(maxWaitMs = 10000) {
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            if (window.VariableManager?.getCurrentVariables &&
                window.VariableManager?.refreshCommonRuleFlags) return true;
            await new Promise(r => setTimeout(r, 200));
        }
        return false;
    }

    async function isBattleModeActive() {
        try {
            if (window.VariableManager?.getCurrentVariables) {
                const result = await window.VariableManager.getCurrentVariables();
                if (!result.ok) return false;
                const v = (result.variables || []).find(x => x.name === 'バトルモード');
                return String(v?.value ?? '').trim() === '1';
            }
        } catch (e) { /* ignore */ }
        return false;
    }

    function getUserName() {
        const el = document.querySelector('#user_avatar_block .avatar-container.selected .ch_name')
                || document.querySelector('#user_avatar_block .ch_name');
        if (el) {
            const t = (el.textContent || '').trim();
            if (t) return t;
        }
        try {
            const ctx = getSTContext();
            return ctx?.name1 || ctx?.user_name || 'User';
        } catch (e) { return 'User'; }
    }

    function ensurePanel() {
        let panel = document.getElementById(PANEL_ID);
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'user-status-panel';
        panel.style.display = 'none';
        document.body.appendChild(panel);
        return panel;
    }

    async function render() {
        const panel = ensurePanel();

        // ★ キャラ未選択なら即座に非表示
        if (!hasActiveCharacter()) {
            if (panel.style.display !== 'none') {
                panel.style.display = 'none';
            }
            _lastRenderKey = '';
            return;
        }

        const active = await isRPGMode();

        // ★ RPGモード=0 なら非表示
        if (!active) {
            if (panel.style.display !== 'none') {
                panel.style.display = 'none';
            }
            _lastRenderKey = '';
            return;
        }

        panel.style.display = '';

        const status = getUserStatus();
        const userName = getUserName();

        const ratio = status.maxHP > 0
            ? Math.max(0, Math.min(1, status.curHP / status.maxHP))
            : 0;

        const signature = `${userName}|${status.curHP}|${status.maxHP}|${ratio.toFixed(4)}`;
        if (signature === _lastRenderKey) return;
        _lastRenderKey = signature;

        panel.innerHTML = '';

        // ── HPバー + 数値 ──
        const hpContainer = document.createElement('div');
        hpContainer.className = 'user-status-hp-container';

        const hpWrap = document.createElement('div');
        hpWrap.className = 'user-status-hp-bar-wrap';

        const hpBar = document.createElement('div');
        hpBar.className = 'user-status-hp-bar';
        hpBar.style.width = `${ratio * 100}%`;
        hpWrap.appendChild(hpBar);
        hpContainer.appendChild(hpWrap);

        const hpText = document.createElement('div');
        hpText.className = 'user-status-hp-text';
        hpText.textContent = String(Math.round(status.curHP));
        hpContainer.appendChild(hpText);

        panel.appendChild(hpContainer);

        // ── 名前（HPバーの下） ──
        const nameEl = document.createElement('div');
        nameEl.className = 'user-status-name';
        nameEl.textContent = userName;
        panel.appendChild(nameEl);
    }

    async function init() {
        ensurePanel();
        const panel = document.getElementById(PANEL_ID);
        if (panel) panel.style.display = 'none';

        await waitForVariableManager();
        await render();
        setInterval(render, POLL_INTERVAL_MS);
        console.log(LOG, '初期化完了');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.UserStatus = {
        getStatus: getUserStatus,
        setStatus: setUserStatus,
        setMaxHP: (v) => setUserStatus({ maxHP: v }),
        setCurrentHP: (v) => setUserStatus({ curHP: v }),
        damage: (v) => {
            const s = getUserStatus();
            setUserStatus({ curHP: s.curHP - Math.max(0, Number(v) || 0) });
        },
        heal: (v) => {
            const s = getUserStatus();
            setUserStatus({ curHP: s.curHP + Math.max(0, Number(v) || 0) });
        },
        fullHeal: () => {
            const s = getUserStatus();
            setUserStatus({ curHP: s.maxHP });
        },
        reset: () => {
            const s = _ensureSettings();
            if (!s) return;
            s.maxHP = DEFAULT_MAX_HP;
            s.curHP = DEFAULT_CUR_HP;
            try {
                const ctx = getSTContext();
                if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
            } catch (e) { /* ignore */ }
            _lastRenderKey = '';
            render();
        },
        refresh: render,
        getUserName,
        hasActiveCharacter,
        isBattleModeActive,
        isRPGMode,
        isRPGModeSync,
    };
})();
