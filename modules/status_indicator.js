// status_indicator.js
// 画面上部に「応答生成中…」「画像生成中…」のステータスを表示する。
//   - LLM応答生成: MESSAGE_SENT/MESSAGE_SWIPED で表示、GENERATION_ENDED で非表示
//   - 画像生成: gic-image-generation-started/ended カスタムイベントで表示制御
//   - 事前設定モード: 応答生成中のみ「応答生成中…」の真下に表示
//     （背景生成モードから勝手に切り替わったことにユーザーが気づけるようにする）

(function () {
    'use strict';
    const LOG = '[StatusIndicator]';
    const CONTAINER_ID = 'status-indicator-container';
    const STYLE_ID = 'status-indicator-style';
    const MAX_SHOW_MS = 180000; // 3分でタイムアウト（暴走防止）

    const timers = new Map();  // key -> timeout id
    const items = new Map();   // key -> element

    (function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const link = document.createElement('link');
        link.id = STYLE_ID;
        link.rel = 'stylesheet';
        try {
            link.href = new URL('../styles/status_indicator.css', import.meta.url).href;
        } catch (e) {
            link.href = 'styles/status_indicator.css';
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

    function ensureContainer() {
        let container = document.getElementById(CONTAINER_ID);
        if (container) return container;
        container = document.createElement('div');
        container.id = CONTAINER_ID;
        container.style.display = 'none';
        document.body.appendChild(container);
        return container;
    }

    // ============================================================
    // ★ 事前設定モード判定
    //   GicApi.isOverrideMode() もしくは ImageDisplayExtension.isOverride() が
    //   true なら背景生成モード。両方 false なら事前設定モード。
    // ============================================================
    function isPreSetupMode() {
        try {
            let isOverride = false;
            if (typeof window.GicApi?.isOverrideMode === 'function') {
                isOverride = isOverride || window.GicApi.isOverrideMode() === true;
            }
            if (typeof window.ImageDisplayExtension?.isOverride === 'function') {
                isOverride = isOverride || window.ImageDisplayExtension.isOverride() === true;
            }
            return !isOverride;
        } catch (e) { return false; }
    }

    function resetTimer(key) {
        if (timers.has(key)) {
            clearTimeout(timers.get(key));
            timers.delete(key);
        }
        const timer = setTimeout(() => {
            console.warn(`${LOG} タイムアウト（${MAX_SHOW_MS}ms）: ${key}`);
            hideStatus(key);
        }, MAX_SHOW_MS);
        timers.set(key, timer);
    }

    function showStatus(key, text, type) {
        if (!key || !text) return;
        const container = ensureContainer();

        let el = items.get(key);
        if (el && el.parentNode !== container) {
            el = null;
            items.delete(key);
        }
        if (!el) {
            el = document.createElement('div');
            el.className = 'status-indicator-item';
            el.dataset.key = key;
            items.set(key, el);
        }
        el.textContent = text;
        el.classList.toggle('status-image', type === 'image');
        el.classList.toggle('status-llm', type === 'llm');
        el.classList.toggle('status-mode', type === 'mode');
        if (!el.parentNode) container.appendChild(el);

        resetTimer(key);

        container.style.display = 'flex';
    }

    // ============================================================
    // ★ 事前設定モード表示（「応答生成中…」の直下に配置）
    //   - llm 要素が表示されていない場合は何もしない
    //   - 既に mode 要素があれば位置だけ保証する
    //   - 順序: llm → mode になるよう llm の nextSibling に挿入
    // ============================================================
    function showPreSetupModeUnderLLM() {
        const container = ensureContainer();
        const llmEl = items.get('llm');
        if (!llmEl || !llmEl.parentNode) return;

        let modeEl = items.get('mode');
        if (!modeEl || modeEl.parentNode !== container) {
            if (modeEl && modeEl.parentNode) modeEl.parentNode.removeChild(modeEl);
            modeEl = document.createElement('div');
            modeEl.className = 'status-indicator-item status-mode';
            modeEl.dataset.key = 'mode';
            modeEl.textContent = '事前設定モード';
            items.set('mode', modeEl);
        } else {
            modeEl.textContent = '事前設定モード';
        }

        // llm の直後に配置（順序保証）
        if (llmEl.nextSibling !== modeEl) {
            if (modeEl.parentNode) modeEl.parentNode.removeChild(modeEl);
            llmEl.insertAdjacentElement('afterend', modeEl);
        }

        resetTimer('mode');
        container.style.display = 'flex';
    }

    function hideStatus(key) {
        if (!key) return;
        const el = items.get(key);
        if (el && el.parentNode) el.parentNode.removeChild(el);
        items.delete(key);

        if (timers.has(key)) {
            clearTimeout(timers.get(key));
            timers.delete(key);
        }

        const container = document.getElementById(CONTAINER_ID);
        if (container && container.children.length === 0) {
            container.style.display = 'none';
        }
    }

    function setupEventListeners() {
        const ctx = getSTContext();
        if (!ctx?.eventSource || !ctx?.eventTypes) {
            setTimeout(setupEventListeners, 500);
            return;
        }

        const et = ctx.eventTypes;
        const es = ctx.eventSource;

        const showLLM = () => {
            showStatus('llm', '応答生成中…', 'llm');
            // ★ 事前設定モード時のみ、応答生成中…の真下に表示
            if (isPreSetupMode()) {
                showPreSetupModeUnderLLM();
            }
        };
        const hideLLM = () => {
            hideStatus('llm');
            hideStatus('mode');
        };

        const on = (name, fn) => {
            if (et[name] && typeof es.on === 'function') es.on(et[name], fn);
        };

        on('MESSAGE_SENT', showLLM);
        on('MESSAGE_SWIPED', showLLM);
        on('GENERATION_ENDED', hideLLM);
        on('CHARACTER_MESSAGE_RENDERED', hideLLM);

    // 画像生成（カスタムイベント）
    window.addEventListener('gic-image-generation-started', (e) => {
        const preparing = e?.detail?.preparing === true;
        const text = preparing ? '画像準備中…' : '画像生成中…';
        showStatus('image', text, 'image');
    });
    window.addEventListener('gic-image-generation-ended', () => {
        hideStatus('image');
    });

        // ★ モード切替時に即座に反映
        //   応答生成中にモードが切り替わった場合の保険
        window.addEventListener('gic-mode-changed', () => {
            const llmEl = items.get('llm');
            if (!llmEl) return; // 応答生成中のみ反映
            if (isPreSetupMode()) {
                showPreSetupModeUnderLLM();
            } else {
                hideStatus('mode');
            }
        });

        console.log(LOG, 'イベントリスナーを登録しました');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            ensureContainer();
            setupEventListeners();
        });
    } else {
        ensureContainer();
        setupEventListeners();
    }

    window.StatusIndicator = {
        show: showStatus,
        hide: hideStatus,
        isPreSetupMode,
        _items: () => Array.from(items.keys()),
    };
})();
