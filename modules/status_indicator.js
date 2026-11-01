// status_indicator.js
// 画面上部に「応答生成中…」「画像生成中…」のステータスを表示する。
//   - LLM応答生成: MESSAGE_SENT/MESSAGE_SWIPED で表示、GENERATION_ENDED で非表示
//   - 画像生成: gic-image-generation-started/ended カスタムイベントで表示制御

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
        if (!el.parentNode) container.appendChild(el);

        // タイムアウトをリセット
        if (timers.has(key)) {
            clearTimeout(timers.get(key));
            timers.delete(key);
        }
        const timer = setTimeout(() => {
            console.warn(`${LOG} タイムアウト（${MAX_SHOW_MS}ms）: ${key}`);
            hideStatus(key);
        }, MAX_SHOW_MS);
        timers.set(key, timer);

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

        const showLLM = () => showStatus('llm', '応答生成中…', 'llm');
        const hideLLM = () => hideStatus('llm');

        const on = (name, fn) => {
            if (et[name] && typeof es.on === 'function') es.on(et[name], fn);
        };

        on('MESSAGE_SENT', showLLM);
        on('MESSAGE_SWIPED', showLLM);
        on('GENERATION_ENDED', hideLLM);
        on('CHARACTER_MESSAGE_RENDERED', hideLLM);

        // 画像生成（カスタムイベント）
        window.addEventListener('gic-image-generation-started', () => {
            showStatus('image', '画像生成中…', 'image');
        });
        window.addEventListener('gic-image-generation-ended', () => {
            hideStatus('image');
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
        _items: () => Array.from(items.keys()),
    };
})();
