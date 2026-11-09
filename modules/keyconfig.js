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
//      → ゲーム開始ボタンのみ
//   4. RPGモード=1 または (選択肢モード=1 かつ state=clicked)
//      → 最後の .lbe-choices-block 内の選択肢のみ
//   5. それ以外 → キーボード介入なし
//
// 入力欄の制御:
//   VariableManager の rpgMode / choicesMode が 1 の時は
//   #send_textarea を非表示・非クリック化する。

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
        if (!el) return false;
        if (!el.isConnected) return false;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none') return false;
        if (cs.visibility === 'hidden') return false;
        if (parseFloat(cs.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        return true;
    }

    function getCurrentCharName() {
        try {
            const ctx = window.SillyTavern?.getContext?.();
            return ctx?.characters?.[ctx?.characterId]?.name || null;
        } catch (e) { return null; }
    }

    // ============================================================
    // キーボードコンテキストの決定
    // ============================================================
    function getKeyboardContext() {
        const flags = window.VariableManager?.getCommonRuleFlags?.();
        if (!flags || !flags.ok) return null;
        const rpg = flags.rpgMode === true;
        const choices = flags.choicesMode === true;
        if (!rpg && !choices) return null;

        const battleActive = window.VariableManager?.isBattleActive?.() === true;
        const battleStart = window.VariableManager?.getBattleStartVar?.() === true;
        const charName = getCurrentCharName();
        const state = window.ChoiceClick?.getStartState?.(charName) || 'initial';

        // ① RPGモード + バトルモード → 左端の4ボタンのみ
        if (rpg && battleActive) {
            const container = document.getElementById('variable-battle-commands');
            if (container && isElementVisible(container)) {
                const btns = Array.from(container.querySelectorAll('.variable-command-btn')).filter(isElementVisible);
                if (btns.length > 0) {
                    return { name: 'battle-commands', multi: true, elements: btns };
                }
            }
            return null;
        }

        // ② RPGモード + バトル開始変数=1 → 最後のバトル開始ボタンのみ
        if (rpg && battleStart) {
            const btns = document.querySelectorAll('.variable-battle-start-btn');
            if (btns.length > 0) {
                const last = btns[btns.length - 1];
                if (isElementVisible(last)) {
                    return { name: 'battle-start', multi: false, elements: [last] };
                }
            }
            return null;
        }

        // ③ 選択肢モード + state=initial → ゲーム開始ボタンのみ
        //    （RPGモードと併用時も、まだ開始前ならここで扱う）
        if (choices && state === 'initial') {
            const btns = document.querySelectorAll('.game-start-choice:not(.game-reset-choice)');
            if (btns.length > 0) {
                const last = btns[btns.length - 1];
                if (isElementVisible(last)) {
                    return { name: 'game-start', multi: false, elements: [last] };
                }
            }
            return null;
        }

        // ④ 最後の選択肢ブロック内の選択肢のみ
        if (rpg || (choices && state === 'clicked')) {
            return getLastChoicesContext();
        }

        return null;
    }

    function getLastChoicesContext() {
        const blocks = document.querySelectorAll('.lbe-choices-block');
        if (blocks.length === 0) return null;
        const last = blocks[blocks.length - 1];
        const items = Array.from(last.querySelectorAll('.lbe-choice-item')).filter(isElementVisible);
        if (items.length === 0) return null;

        // 新しい選択肢ブロックに切り替わったらインデックスをリセット
        if (last !== _lastChoicesBlock) {
            _lastChoicesBlock = last;
            _indices['choices'] = 0;
        }
        return { name: 'choices', multi: true, elements: items };
    }

    // ============================================================
    // 入力欄の非表示制御
    // ============================================================
    function isInputLocked() {
        try {
            const f = window.VariableManager?.getCommonRuleFlags?.();
            if (!f || !f.ok) return false;
            return f.rpgMode === true || f.choicesMode === true;
        } catch (e) {
            return false;
        }
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
            console.log(LOG, '入力欄をロック');
        } else {
            console.log(LOG, '入力欄のロックを解除');
        }
    }

    // ============================================================
    // フォーカス管理
    // ============================================================
    function clearFocus() {
        document.querySelectorAll('.' + FOCUS_CLASS).forEach(el => {
            el.classList.remove(FOCUS_CLASS);
        });
    }

    function ensureFocus() {
        updateInputLock();

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

        clearFocus();
        elements[idx].classList.add(FOCUS_CLASS);
    }

    // ============================================================
    // ナビゲーション
    // ============================================================
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

    // ============================================================
    // 決定
    // ============================================================
    function confirm() {
        const ctx = getKeyboardContext();
        if (!ctx) return false;
        const elements = ctx.elements;
        if (elements.length === 0) return false;
        const idx = Math.min(_indices[ctx.name] ?? 0, elements.length - 1);
        const el = elements[idx];
        if (!el) return false;
        try {
            el.click();
            return true;
        } catch (e) {
            return false;
        }
    }

    // ============================================================
    // キーイベント
    // ============================================================
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.isComposing) return;
        if (isTypingTarget(e.target)) return;

        const ctx = getKeyboardContext();
        if (!ctx) return;

        const key = e.key;

        if (ctx.multi && NAV_UP_KEYS.includes(key)) {
            navigate(-1);
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (ctx.multi && NAV_DOWN_KEYS.includes(key)) {
            navigate(1);
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (CONFIRM_KEYS.includes(key)) {
            if (e.repeat) return;
            confirm();
            e.preventDefault();
            e.stopPropagation();
            return;
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
        if (!document.body) {
            setTimeout(start, 200);
            return;
        }
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
        _debugElements: () => {
            const ctx = getKeyboardContext();
            if (!ctx) return { context: null, elements: [] };
            return {
                context: ctx.name,
                elements: ctx.elements.map(el => ({
                    tag: el.tagName,
                    class: el.className,
                    text: (el.textContent || '').slice(0, 40),
                })),
            };
        },
    };
})();
