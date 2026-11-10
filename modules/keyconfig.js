// keyconfig.js
// キーボード操作で選択肢・開始ボタン・バトルコマンドを決定する拡張モジュール。
//
// 対応キー:
//   ↑ / W  … 前の要素へ
//   ↓ / S  … 次の要素へ
//   Enter / Space / E / F … 選択決定（要素を .click()）
//   ← / →  … 常にブロック（ST のスワイプ操作誤爆防止）
//
// コンテキスト決定（優先度順）:
//   1. RPGモード=1 かつ バトルモード=1 かつ プレイヤーターン
//      → 画面左端の .variable-command-btn 4 つのみ
//   2. RPGモード=1 かつ バトル開始変数=1
//      → 最後に表示されたバトル開始ボタンのみ
//   3. 選択肢モード=1 かつ state=initial
//      → ゲーム開始ボタンのみ（見つからなければ 4 へフォールスルー）
//   4. RPGモード=1 または (選択肢モード=1 かつ state=clicked)
//      → 最後の .lbe-choices-block 内の選択肢のみ
//   5. それ以外 → キーボード介入なし
//
// ★ キーボード / マウスの排他制御:
//   body.keyconfig-mouse-mode    … マウス操作が優先。:hover を有効化、キーボード focus は非表示。
//   body.keyconfig-keyboard-mode … キーボード操作が優先。:hover を CSS で抑止、キーボード focus を表示。
//   選択状態 _indices は常に 1 つ。Enter/Space/E/F は _indices の要素のみ .click() する。
//
// 安全策:
//   - textarea / input / contenteditable にフォーカスがあるときは一切介入しない
//   - Ctrl / Alt / Meta 併用時は介入しない
//   - IME 変換中 (isComposing) は介入しない
//   - Enter のオートリピートは無視

(function () {
    'use strict';
    const LOG = '[KeyConfig]';

    const STYLE_ID = 'keyconfig-style';
    const FOCUS_CLASS = 'keyconfig-focused';
    const HIDE_INPUT_CLASS = 'keyconfig-hide-input';
    const MOUSE_MODE_CLASS = 'keyconfig-mouse-mode';
    const KEYBOARD_MODE_CLASS = 'keyconfig-keyboard-mode';

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
    let _lastHoverTarget = null;

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
    // モード切替
    // ============================================================
    function switchToMouseMode() {
        if (document.body.classList.contains(MOUSE_MODE_CLASS) &&
            !document.body.classList.contains(KEYBOARD_MODE_CLASS)) {
            return;
        }
        document.body.classList.remove(KEYBOARD_MODE_CLASS);
        document.body.classList.add(MOUSE_MODE_CLASS);
        clearFocus();
    }

    function switchToKeyboardMode() {
        if (document.body.classList.contains(KEYBOARD_MODE_CLASS) &&
            !document.body.classList.contains(MOUSE_MODE_CLASS)) {
            return;
        }
        document.body.classList.remove(MOUSE_MODE_CLASS);
        document.body.classList.add(KEYBOARD_MODE_CLASS);
        // 矢印キー押下でマウス位置関係をリセット → 次の mouseover を確実に発火させる
        _lastHoverTarget = null;
    }

    // ============================================================
    // キーボードコンテキストの決定
    // ============================================================
    function getKeyboardContext() {
        const flags = window.VariableManager?.getCommonRuleFlags?.();
        let rpg = flags?.rpgMode === true;
        let choices = flags?.choicesMode === true;

        // フラグ準備前の DOM フォールバック
        if (!rpg && !choices && document.body.classList.contains(HIDE_INPUT_CLASS)) {
            if (findVisible('.variable-command-btn').length > 0) rpg = true;
            else if (findVisible('.variable-battle-start-btn').length > 0) rpg = true;
            else if (findVisible('.game-start-choice').length > 0) choices = true;
            else if (findVisible('.lbe-choice-item').length > 0) rpg = true;
        }

        if (!rpg && !choices) return null;

        // ⓪ タイトル画面 → スタート / ロード ボタン（最優先）
        //    RPGモード=1 かつ タイトル画面=1 の時のみ。
        //    他のコンテキスト（バトル・選択肢）より優先される。
        if (rpg && window.VariableManager?.isTitleScreenActive?.() === true) {
            const container = document.getElementById('variable-title-screen');
            if (container && isElementVisible(container)) {
                const btns = Array.from(container.querySelectorAll('.variable-title-btn')).filter(isElementVisible);
                if (btns.length > 0) {
                    return { name: 'title-screen', multi: true, elements: btns, horizontal: true };
                }
            }
            // タイトル画面中だがボタンが見つからない → 他へのフォールスルー禁止
            return null;
        }

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
                // ★ 非プレイヤーターン中は完全無効
                if (container.classList.contains('variable-battle-commands-waiting')) {
                    return null;
                }
                const btns = Array.from(container.querySelectorAll('.variable-command-btn')).filter(isElementVisible);
                if (btns.length > 0) return { name: 'battle-commands', multi: true, elements: btns };
            }
            // バトル中で操作対象なし → 他コンテキストへのフォールスルー禁止
            return null;
        }

        // ② RPG + バトル開始変数=1 → 最後のバトル開始ボタンのみ
        if (rpg && battleStart) {
            const btn = findLastVisible('.variable-battle-start-btn');
            if (btn) return { name: 'battle-start', multi: false, elements: [btn] };
        }

        // ③ 選択肢モード + 初期状態 → ゲーム開始ボタン（リセット除外）
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
            _lastHoverTarget = null;
            // 新しい選択肢ブロックでは初期状態（マウス優先）に戻す
            switchToMouseMode();
        }
        return { name: 'choices', multi: true, elements: items };
    }

    // ============================================================
    // 入力ロック
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

        // ★ キーボードモードの時だけ .keyconfig-focused を付与する
        if (document.body.classList.contains(KEYBOARD_MODE_CLASS)) {
            clearFocus();
            if (!elements[idx].classList.contains(FOCUS_CLASS)) {
                elements[idx].classList.add(FOCUS_CLASS);
            }
        } else {
            clearFocus();
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

        switchToKeyboardMode();
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
    // マウス操作の検出（選択肢 / バトルボタン上での hover と click）
    // ============================================================
    document.addEventListener('mouseover', (e) => {
        const target = e.target?.closest?.('.lbe-choice-item, .variable-command-btn');
        if (!target) {
            // 選択肢/バトルボタンの外に出た時はターゲット記憶をリセット
            if (_lastHoverTarget && !_lastHoverTarget.contains(e.target)) {
                _lastHoverTarget = null;
            }
            return;
        }
        if (target === _lastHoverTarget) return;
        _lastHoverTarget = target;

        const ctx = getKeyboardContext();
        if (!ctx) return;
        const idx = ctx.elements.indexOf(target);
        if (idx < 0) return;

        _indices[ctx.name] = idx;
        switchToMouseMode();
    }, { passive: true, capture: true });

    document.addEventListener('click', (e) => {
        const target = e.target?.closest?.('.lbe-choice-item, .variable-command-btn');
        if (!target) return;
        const ctx = getKeyboardContext();
        if (!ctx) return;
        const idx = ctx.elements.indexOf(target);
        if (idx < 0) return;
        _indices[ctx.name] = idx;
        switchToMouseMode();
    }, { capture: true });

    // ============================================================
    // キーイベントハンドラ（capture フェーズ）
    // ============================================================
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.isComposing) return;
        if (isTypingTarget(e.target)) return;

        // ★ タイトル画面: ←/→ または A/D で選択、E/F/Space/Enter で決定
        //    タイトル画面が有効な間は、この 6 種のキーだけを扱う。
        //    それ以外のキー（W/S 等）は無効化して他コンテキストへの漏れを防ぐ。
        if (window.VariableManager?.isTitleScreenActive?.() === true) {
            const isPrevKey = e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A';
            const isNextKey = e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D';
            const isConfirm = CONFIRM_KEYS.includes(e.key);

            if (isPrevKey || isNextKey) {
                e.preventDefault();
                e.stopImmediatePropagation();
                navigate(isPrevKey ? -1 : 1);
                return;
            }
            if (isConfirm) {
                if (e.repeat) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                confirm();
                return;
            }
            // タイトル画面中の他のキー（W/S、↑/↓ 等）は無効化
            if (['ArrowUp', 'ArrowDown', 'w', 'W', 's', 'S'].includes(e.key)) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
            return;
        }

        // ★ ST のスワイプ操作(←/→)による誤動作防止
        //    typing target 以外では常にブロックする
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
        }

        const isUp = NAV_UP_KEYS.includes(e.key);
        const isDown = NAV_DOWN_KEYS.includes(e.key);
        const isConfirm = CONFIRM_KEYS.includes(e.key);

        if (!isUp && !isDown && !isConfirm) return;

        const inputLocked = isInputLocked();
        const ctx = getKeyboardContext();

        if (!ctx && !inputLocked) return;

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
            if (!ctx.multi && (isUp || isDown)) {
                e.preventDefault();
                e.stopImmediatePropagation();
                return;
            }
        }

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
        document.body.classList.add(MOUSE_MODE_CLASS);
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
        getMode: () => {
            if (document.body.classList.contains(KEYBOARD_MODE_CLASS)) return 'keyboard';
            if (document.body.classList.contains(MOUSE_MODE_CLASS)) return 'mouse';
            return null;
        },
        _debug: () => {
            const ctx = getKeyboardContext();
            const flags = window.VariableManager?.getCommonRuleFlags?.();
            const charName = getCurrentCharName();
            const battleContainer = document.getElementById('variable-battle-commands');
            return {
                context: ctx ? ctx.name : null,
                indices: { ..._indices },
                mode: window.KeyConfig.getMode(),
                elements: ctx ? ctx.elements.map(el => ({
                    tag: el.tagName,
                    class: String(el.className).slice(0, 60),
                    text: (el.textContent || '').slice(0, 40),
                })) : [],
                flags: flags ? { ok: flags.ok, rpg: flags.rpgMode, choices: flags.choicesMode } : null,
                charName,
                state: window.ChoiceClick?.getStartState?.(charName) || 'initial',
                inputLocked: isInputLocked(),
                battleWaiting: battleContainer?.classList.contains('variable-battle-commands-waiting') ?? null,
            };
        },
    };
})();
