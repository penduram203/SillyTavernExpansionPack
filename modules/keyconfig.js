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
//   2. チャット内インタラクティブ要素（最新のみ）
//      - 最後の .lbe-choices-block 内の .lbe-choice-item
//      - 最新の .variable-battle-start-btn
//      - 最新の .game-start-choice
//
// 入力欄の制御:
//   VariableManager の rpgMode / choicesMode が 1 の時は
//   #send_textarea を非表示・非クリック化する。
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
    const HIDE_INPUT_CLASS = 'keyconfig-hide-input';

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
            // getElements を明示的に定義（最新のみに絞り込む）
            getElements: () => getLatestChatInteractiveElements(),
            visible: () => getLatestChatInteractiveElements().length > 0,
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

    // ============================================================
    // ★ 最新のチャット内インタラクティブ要素だけを取得
    //   - 最後の .lbe-choices-block 内の .lbe-choice-item 全て
    //   - 最後の .variable-battle-start-btn
    //   - 最後の .game-start-choice
    //   を DOM 順に並べて返す。
    // ============================================================
    function getLatestChatInteractiveElements() {
        const result = [];

        // ① 最新の選択肢ブロック内の選択肢
        const blocks = document.querySelectorAll('.lbe-choices-block');
        if (blocks.length > 0) {
            const lastBlock = blocks[blocks.length - 1];
            lastBlock.querySelectorAll('.lbe-choice-item').forEach(el => {
                if (isElementVisible(el)) result.push(el);
            });
        }

        // ② 最新のバトル開始ボタン
        const battleBtns = document.querySelectorAll('.variable-battle-start-btn');
        if (battleBtns.length > 0) {
            const last = battleBtns[battleBtns.length - 1];
            if (isElementVisible(last)) result.push(last);
        }

        // ③ 最新のゲーム開始ボタン
        const gameBtns = document.querySelectorAll('.game-start-choice');
        if (gameBtns.length > 0) {
            const last = gameBtns[gameBtns.length - 1];
            if (isElementVisible(last)) result.push(last);
        }

        // DOM 順でソート
        result.sort((a, b) => {
            if (a === b) return 0;
            const pos = a.compareDocumentPosition(b);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
        });

        return result;
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
        if (typeof ctx.getElements === 'function') {
            try { return ctx.getElements(); } catch (e) { return []; }
        }
        const root = ctx.container ? ctx.container() : document;
        if (!root) return [];
        return Array.from(root.querySelectorAll(ctx.selector)).filter(isElementVisible);
    }

    function clearFocus() {
        document.querySelectorAll('.' + FOCUS_CLASS).forEach(el => {
            el.classList.remove(FOCUS_CLASS);
        });
    }

    // ============================================================
    // 入力欄の非表示制御
    //   VariableManager の共通ルールフラグ (rpgMode / choicesMode) が
    //   true の時、body に keyconfig-hide-input を付与する。
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
            // フォーカスが textarea に残っていると keydown がそちらに吸われるため、
            // 明示的に blur する。
            const ta = document.getElementById('send_textarea');
            if (ta && document.activeElement === ta) {
                try { ta.blur(); } catch (e) { /* ignore */ }
            }
            console.log(LOG, '入力欄をロック (rpgMode または choicesMode が 1)');
        } else {
            console.log(LOG, '入力欄のロックを解除');
        }
    }

    // ============================================================
    // フォーカス管理
    // ============================================================
    function ensureFocus() {
        updateInputLock();

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

        let idx = _indices[ctx.name] ?? 0;
        if (idx >= elements.length) idx = elements.length - 1;
        if (idx < 0) idx = 0;
        _indices[ctx.name] = idx;

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
        // ★ デバッグ用: 現時点の navigable 要素を列挙
        _debugElements: () => {
            const ctx = getActiveContext();
            if (!ctx) return { context: null, elements: [] };
            const elements = getElements(ctx);
            return {
                context: ctx.name,
                elements: elements.map(el => ({
                    tag: el.tagName,
                    class: el.className,
                    text: (el.textContent || '').slice(0, 40),
                    visible: isElementVisible(el),
                })),
            };
        },
    };
})();
