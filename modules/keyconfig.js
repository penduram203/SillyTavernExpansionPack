// keyconfig.js
// キーボード操作で選択肢・開始ボタン・バトルコマンドを決定する拡張モジュール。
//
// 対応キー:
//   ↑ / W  … 前の要素へ
//   ↓ / S  … 次の要素へ
//   Enter / Space / E / F … 選択決定（要素を .click()）
//
// コンテキスト決定（優先度順）:
//   1. RPGモード=1 かつ バトルモード=1
//      → 画面左端の .variable-command-btn 4 つのみ
//   2. RPGモード=1 かつ バトル開始変数=1
//      → 最後に表示されたバトル開始ボタンのみ
//   3. 選択肢モード=1 かつ state=initial
//      → ゲーム開始ボタンのみ（見つからなければ 4 へフォールスルー）
//   4. RPGモード=1 または (選択肢モード=1 かつ state=clicked)
//      → 最後の .lbe-choices-block 内の選択肢のみ
//   5. それ以外 → キーボード介入なし
//
// 安全策:
//   - textarea / input / contenteditable にフォーカスがあるときは一切介入しない
//   - Ctrl / Alt / Meta 併用時は介入しない
//   - IME 変換中 (isComposing) は介入しない
//   - Enter のオートリピートは無視
//   - 入力ロック中は ST のメッセージボタン等の自動クリックを抑止する
//     （.mes_edit などにフォーカスが残っていると Enter/Space で誤爆する）

(function () {
    'use strict';
    const LOG = '[KeyConfig]';

    const STYLE_ID = 'keyconfig-style';
    const FOCUS_CLASS = 'keyconfig-focused';
    const HIDE_INPUT_CLASS = 'keyconfig-hide-input';

    const NAV_UP_KEYS = ['ArrowUp', 'w', 'W'];
    const NAV_DOWN_KEYS = ['ArrowDown', 's', 'S'];
    const CONFIRM_KEYS = ['Enter', ' ', 'e', 'E', 'f', 'F'];

    const _indices = {
        'battle-commands': 0,
        'battle-start': 0,
        'game-start': 0,
        'choices': 0,
    };
    let _lastContextName = null;
    let _lastChoicesBlock = null;

    // ============================================================
    // CSS 注入
    // ============================================================
    (function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const link = document.createElement('link');
        link.id = STYLE_ID;
        link.rel = 'stylesheet';
        try {
            link.href = new URL('../styles/keyconfig.css', import.meta.url).href;
        } catch (e) {
            link.href = 'styles/keyconfig.css';
        }
        document.head.appendChild(link);
    })();

    // ============================================================
    // ヘルパー
    // ============================================================
    function isTypingTarget(el) {
        if (!el) return false;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable) return true;
        return false;
    }

    function isElementVisible(el) {
        if (!el || !el.isConnected) return false;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function getCurrentCharName() {
        try {
            const ctx = window.SillyTavern?.getContext?.();
            return ctx?.characters?.[ctx?.characterId]?.name || null;
        } catch (e) { return null; }
    }

    function findLastVisible(selector) {
        const els = document.querySelectorAll(selector);
        for (let i = els.length - 1; i >= 0; i--) {
            if (isElementVisible(els[i])) return els[i];
        }
        return null;
    }

    function findVisible(selector) {
        return Array.from(document.querySelectorAll(selector)).filter(isElementVisible);
    }

    // ============================================================
    // キーボードコンテキストの決定
    // ============================================================
    function getKeyboardContext() {
        const flags = window.VariableManager?.getCommonRuleFlags?.();
        let rpg = flags?.rpgMode === true;
        let choices = flags?.choicesMode === true;

        // フラグがまだ準備できていない時のDOMフォールバック
        if (!rpg && !choices && document.body.classList.contains(HIDE_INPUT_CLASS)) {
            if (findVisible('.variable-command-btn').length > 0) rpg = true;
            else if (findVisible('.variable-battle-start-btn').length > 0) rpg = true;
            else if (findVisible('.game-start-choice').length > 0) choices = true;
            else if (findVisible('.lbe-choice-item').length > 0) rpg = true;
        }

        if (!rpg && !choices) return null;

        const battleActive = window.VariableManager?.isBattleActive?.() === true;
        const battleStart = (() => {
            try {
                if (typeof window.VariableManager?.getBattleStartVar === 'function') {
                    return window.VariableManager.getBattleStartVar() === true;
                }
            } catch (e) { /* ignore */ }
            return false;
        })();

        const charName = getCurrentCharName();
        const state = window.ChoiceClick?.getStartState?.(charName) || 'initial';

        // ① バトルモード → 左端の4ボタンのみ
        if (rpg && battleActive) {
            const container = document.getElementById('variable-battle-commands');
            if (container && isElementVisible(container)) {
                const btns = Array.from(container.querySelectorAll('.variable-command-btn')).filter(isElementVisible);
                if (btns.length > 0) return { name: 'battle-commands', multi: true, elements: btns };
            }
        }

        // ② RPG + バトル開始変数=1 → 最後のバトル開始ボタンのみ
        if (rpg && battleStart) {
            const btn = findLastVisible('.variable-battle-start-btn');
            if (btn) return { name: 'battle-start', multi: false, elements: [btn] };
        }

        // ③ 選択肢モード + 初期状態 → ゲーム開始ボタン（リセット除外）
        //    ボタンが未生成の時は ④ にフォールスルー
        if (choices && state === 'initial') {
            const btns = document.querySelectorAll('.game-start-choice:not(.game-reset-choice)');
            let found = null;
            for (let i = btns.length - 1; i >= 0; i--) {
                if (isElementVisible(btns[i])) { found = btns[i]; break; }
            }
            if (found) return { name: 'game-start', multi: false, elements: [found] };
        }

        // ④ RPG or (選択肢モード + 開始済み) → 最後の選択肢ブロックのみ
        if (rpg || choices) {
            const ctx = getLastChoicesContext();
            if (ctx) return ctx;
        }

        return null;
    }

    function getLastChoicesContext() {
        const blocks = document.querySelectorAll('.lbe-choices-block');
        if (blocks.length === 0) return null;
        const last = blocks[blocks.length - 1];
        const items = Array.from(last.querySelectorAll('.lbe-choice-item')).filter(isElementVisible);
        if (items.length === 0) return null;

        if (last !== _lastChoicesBlock) {
            _lastChoicesBlock = last;
            _indices['choices'] = 0;
        }
        return { name: 'choices', multi: true, elements: items };
    }

    // ============================================================
    // 入力欄のロック状態
    // ============================================================
    function isInputLocked() {
        try {
            const f = window.VariableManager?.getCommonRuleFlags?.();
            if (f && f.ok) return f.rpgMode === true || f.choicesMode === true;
        } catch (e) { /* ignore */ }
        return document.body.classList.contains(HIDE_INPUT_CLASS);
    }

    function updateInputLock() {
        const locked = isInputLocked();
        const already = document.body.classList.contains(HIDE_INPUT_CLASS);
        if (locked === already) return;
        document.body.classList.toggle(HIDE_INPUT_CLASS, locked);
        if (locked) {
            const ta = document.getElementById('send_textarea');
            if (ta && document.activeElement === ta) {
                try { ta.blur(); } catch (e) { /* ignore */ }
            }
        }
    }

    // ============================================================
    // フォーカス管理
    // ============================================================
    // ★ 入力ロック中、ST のメッセージボタン等にフォーカスが残っていると
    //   Enter / Space のネイティブ click が発火して誤操作の原因になる。
    //   我々のコンテキスト要素以外のフォーカスは積極的に blur する。
    function blurForeignFocus() {
        const active = document.activeElement;
        if (!active || active === document.body) return;
        if (active.matches('.lbe-choice-item, .game-start-choice, .variable-battle-start-btn, .variable-command-btn')) return;
        if (isTypingTarget(active)) return;
        if (active.matches('.mes_button, .mes_edit, .mes_edit_cancel, .mes_edit_done, .mes_hide, .mes_copy, .mes_branch, .interactable[role="button"]')) {
            try { active.blur(); } catch (e) { /* ignore */ }
        }
    }

    function clearFocus() {
        document.querySelectorAll('.' + FOCUS_CLASS).forEach(el => el.classList.remove(FOCUS_CLASS));
    }

    function ensureFocus() {
        updateInputLock();
        if (document.body.classList.contains(HIDE_INPUT_CLASS)) {
            blurForeignFocus();
        }

        const ctx = getKeyboardContext();
        if (!ctx) {
            if (_lastContextName !== null) {
                clearFocus();
                _lastContextName = null;
            }
            return;
        }

        if (_lastContextName !== ctx.name) {
            _indices[ctx.name] = 0;
            _lastContextName = ctx.name;
        }

        const elements = ctx.elements;
        if (!elements || elements.length === 0) {
            clearFocus();
            return;
        }

        let idx = _indices[ctx.name] ?? 0;
        if (idx >= elements.length) idx = elements.length - 1;
        if (idx < 0) idx = 0;
        _indices[ctx.name] = idx;

        // 対象要素以外のフォーカスクラスを除去
        document.querySelectorAll('.' + FOCUS_CLASS).forEach(el => {
            if (!elements.includes(el)) el.classList.remove(FOCUS_CLASS);
        });
        if (!elements[idx].classList.contains(FOCUS_CLASS)) {
            elements[idx].classList.add(FOCUS_CLASS);
        }
    }

    function navigate(delta) {
        const ctx = getKeyboardContext();
        if (!ctx || !ctx.multi) return;
        const elements = ctx.elements;
        if (elements.length === 0) return;

        let idx = _indices[ctx.name] ?? 0;
        idx += delta;
        if (idx < 0) idx = elements.length - 1;
        if (idx >= elements.length) idx = 0;
        _indices[ctx.name] = idx;

        clearFocus();
        elements[idx].classList.add(FOCUS_CLASS);
        try {
            elements[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } catch (e) {
            try { elements[idx].scrollIntoView(false); } catch (e2) { /* ignore */ }
        }
    }

    function confirm() {
        const ctx = getKeyboardContext();
        if (!ctx) return false;
        const elements = ctx.elements;
        if (elements.length === 0) return false;
        const idx = Math.min(_indices[ctx.name] ?? 0, elements.length - 1);
        const el = elements[idx];
        if (!el) return false;
        try { el.click(); return true; } catch (e) { return false; }
    }

    // ============================================================
    // キーイベントハンドラ（capture フェーズ）
    // ============================================================
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.isComposing) return;
        if (isTypingTarget(e.target)) return;

        const isUp = NAV_UP_KEYS.includes(e.key);
        const isDown = NAV_DOWN_KEYS.includes(e.key);
        const isConfirm = CONFIRM_KEYS.includes(e.key);

        if (!isUp && !isDown && !isConfirm) return;

        const inputLocked = isInputLocked();
        const ctx = getKeyboardContext();

        // コンテキストも入力ロックも無ければ ST の動作を尊重
        if (!ctx && !inputLocked) return;

        // ★ 入力ロック中は ST のメッセージボタン等のフォーカスを解除する
        //    これにより Enter/Space のネイティブ click を防ぐ
        if (inputLocked) {
            blurForeignFocus();
        }

        if (ctx) {
            if (ctx.multi && (isUp || isDown)) {
                navigate(isUp ? -1 : 1);
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
            if (isConfirm) {
                if (e.repeat) return;
                confirm();
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
            // ctx はあるが multi でない時、矢印キーはブラウザスクロール抑止
            if (!ctx.multi && (isUp || isDown)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
        }

        // コンテキストが無いが入力ロック中 → ST のデフォルト動作もブロック
        if (!ctx && inputLocked) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    // ============================================================
    // 監視・初期化
    // ============================================================
    let _rafPending = false;
    const observer = new MutationObserver(() => {
        if (_rafPending) return;
        _rafPending = true;
        requestAnimationFrame(() => {
            _rafPending = false;
            ensureFocus();
        });
    });

    function start() {
        if (!document.body) { setTimeout(start, 200); return; }
        observer.observe(document.body, { childList: true, subtree: true });
        ensureFocus();
        setInterval(ensureFocus, 400);
        console.log(LOG, '初期化完了');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    // ============================================================
    // 公開 API
    // ============================================================
    window.KeyConfig = {
        refresh: ensureFocus,
        navigate,
        confirm,
        getContextName: () => {
            const ctx = getKeyboardContext();
            return ctx ? ctx.name : null;
        },
        getIndices: () => ({ ..._indices }),
        _debug: () => {
            const ctx = getKeyboardContext();
            const flags = window.VariableManager?.getCommonRuleFlags?.();
            const charName = getCurrentCharName();
            return {
                context: ctx ? ctx.name : null,
                indices: { ..._indices },
                elements: ctx ? ctx.elements.map(el => ({
                    tag: el.tagName,
                    class: String(el.className).slice(0, 60),
                    text: (el.textContent || '').slice(0, 40),
                })) : [],
                flags: flags ? { ok: flags.ok, rpg: flags.rpgMode, choices: flags.choicesMode } : null,
                charName,
                state: window.ChoiceClick?.getStartState?.(charName) || 'initial',
                inputLocked: isInputLocked(),
                hideInputClass: document.body.classList.contains(HIDE_INPUT_CLASS),
                activeElement: document.activeElement
                    ? `${document.activeElement.tagName}.${String(document.activeElement.className).slice(0, 40)}`
                    : null,
            };
        },
    };
})();
