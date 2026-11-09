// keyconfig.js
// キーボード操作で選択肢・開始ボタン・バトルコマンドを決定する拡張モジュール。
//
// 対応キー:
//   ↑ / W  … 前の要素へ
//   ↓ / S  … 次の要素へ
//   Enter / Space / E / F … 選択決定（要素を .click()）
//
// 対象コンテキスト（優先度順）:
//   1. バトルコマンド (.variable-command-btn × 4)
//   2. チャット内インタラクティブ要素
//      - .lbe-choice-item       ロアブックの選択肢
//      - .variable-battle-start-btn  バトル開始ボタン
//      - .game-start-choice     ゲーム開始ボタン
//
// 安全策:
//   - textarea / input / contenteditable にフォーカスがあるときは一切介入しない
//   - Ctrl / Alt / Meta 併用時は介入しない
//   - IME 変換中 (isComposing) は介入しない
//   - Enter のオートリピートは無視（多重送信防止）

(function () {
    'use strict';
    const LOG = '[KeyConfig]';

    const STYLE_ID = 'keyconfig-style';
    const FOCUS_CLASS = 'keyconfig-focused';

    const NAV_UP_KEYS = ['ArrowUp', 'w', 'W'];
    const NAV_DOWN_KEYS = ['ArrowDown', 's', 'S'];
    const CONFIRM_KEYS = ['Enter', ' ', 'e', 'E', 'f', 'F'];

    // ============================================================
    // コンテキスト定義（優先度順）
    // ============================================================
    const CONTEXTS = [
        {
            name: 'battle-commands',
            selector: '.variable-command-btn',
            container: () => document.getElementById('variable-battle-commands'),
            visible: () => {
                const c = document.getElementById('variable-battle-commands');
                if (!c) return false;
                const cs = window.getComputedStyle(c);
                if (cs.display === 'none' || cs.visibility === 'hidden') return false;
                return c.querySelectorAll('.variable-command-btn').length > 0;
            },
            multi: true,
        },
        {
            name: 'chat-interactive',
            selector: '.lbe-choice-item, .variable-battle-start-btn, .game-start-choice',
            container: null,
            visible: () => {
                return document.querySelector('.lbe-choice-item') !== null ||
                       document.querySelector('.variable-battle-start-btn') !== null ||
                       document.querySelector('.game-start-choice') !== null;
            },
            multi: true,
        },
    ];

    // コンテキストごとのフォーカス index
    const _indices = {
        'battle-commands': 0,
        'chat-interactive': 0,
    };

    let _lastActiveContextName = null;
    let _lastElementsSignature = '';

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

    function getActiveContext() {
        for (const ctx of CONTEXTS) {
            try {
                if (ctx.visible()) return ctx;
            } catch (e) { /* ignore */ }
        }
        return null;
    }

    function getElements(ctx) {
        const root = ctx.container ? ctx.container() : document;
        if (!root) return [];
        return Array.from(root.querySelectorAll(ctx.selector)).filter(isElementVisible);
    }

    function clearFocus() {
        document.querySelectorAll('.' + FOCUS_CLASS).forEach(el => {
            el.classList.remove(FOCUS_CLASS);
        });
    }

    function applyFocus(ctx, elements) {
        clearFocus();
        if (!ctx.multi || elements.length === 0) return;
        let idx = _indices[ctx.name] ?? 0;
        if (idx >= elements.length) idx = elements.length - 1;
        if (idx < 0) idx = 0;
        _indices[ctx.name] = idx;
        elements[idx].classList.add(FOCUS_CLASS);
    }

    // ============================================================
    // フォーカス管理
    // ============================================================
    function ensureFocus() {
        const ctx = getActiveContext();
        if (!ctx) {
            if (_lastActiveContextName !== null) {
                clearFocus();
                _lastActiveContextName = null;
                _lastElementsSignature = '';
            }
            return;
        }

        if (_lastActiveContextName !== ctx.name) {
            if (ctx.multi) _indices[ctx.name] = 0;
            _lastActiveContextName = ctx.name;
            _lastElementsSignature = '';
        }

        const elements = getElements(ctx);
        if (elements.length === 0) {
            clearFocus();
            return;
        }

        // 内容が変わったら index をリセット（新しい選択肢が出た等）
        const sig = elements.map(el => el.textContent?.slice(0, 30) || '').join('|');
        if (sig !== _lastElementsSignature) {
            if (_lastElementsSignature === '') {
                _indices[ctx.name] = 0;
            }
            _lastElementsSignature = sig;
        }

        // clamp
        let idx = _indices[ctx.name] ?? 0;
        if (idx >= elements.length) idx = elements.length - 1;
        if (idx < 0) idx = 0;
        _indices[ctx.name] = idx;

        // 適用
        clearFocus();
        if (ctx.multi) {
            elements[idx].classList.add(FOCUS_CLASS);
        }
    }

    // ============================================================
    // ナビゲーション
    // ============================================================
    function navigate(delta) {
        const ctx = getActiveContext();
        if (!ctx || !ctx.multi) return;
        const elements = getElements(ctx);
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
    // 決定（要素の .click() を発火）
    // ============================================================
    function confirm() {
        const ctx = getActiveContext();
        if (!ctx) return false;
        const elements = getElements(ctx);
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
    // キーイベントハンドラ（capture フェーズ）
    // ============================================================
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.isComposing) return;
        if (isTypingTarget(e.target)) return;

        const ctx = getActiveContext();
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
            if (e.repeat) return;      // Enter 押しっぱなしの多重送信防止
            confirm();
            e.preventDefault();
            e.stopPropagation();
            return;
        }
    }, true);

    // ============================================================
    // DOM 監視 + ポーリング
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
        setInterval(ensureFocus, 500);
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
        getActiveContextName: () => {
            const ctx = getActiveContext();
            return ctx ? ctx.name : null;
        },
        getIndices: () => ({ ..._indices }),
        resetIndex: (name) => {
            if (name && _indices[name] !== undefined) {
                _indices[name] = 0;
            } else {
                for (const k of Object.keys(_indices)) _indices[k] = 0;
            }
            ensureFocus();
        },
    };
})();
