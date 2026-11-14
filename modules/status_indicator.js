// status_indicator.js
// 画面上部に「応答生成中…」「画像生成中…」のステータスを表示する。
//   - LLM応答生成: MESSAGE_SENT/MESSAGE_SWIPED で表示、GENERATION_ENDED で非表示
//   - 画像生成: gic-image-generation-started/ended カスタムイベントで表示制御
//     ★ 準備中 (preparing:true) と 生成中 (preparing:false) を枠色で差別化
//       - preparing  : 緑枠（従来どおり）
//       - generating : オレンジ枠 + SVG 円形進捗リング
//     ★ 生成中の進捗は ComfyUI WebSocket の progress メッセージ
//       （comfy_boot.js が中継する comfyui-progress カスタムイベント）から取得
//   - 事前設定モード: 応答生成中のみ「応答生成中…」の真下に表示
//     （背景生成モードから勝手に切り替わったことにユーザーが気づけるようにする）

(function () {
    'use strict';
    const LOG = '[StatusIndicator]';
    const CONTAINER_ID = 'status-indicator-container';
    const STYLE_ID = 'status-indicator-style';
    const MAX_SHOW_MS = 180000; // 3分でタイムアウト（暴走防止）
    // ============================================================
    // ★ 旧「事前設定モード」用のスタブ
    //   背景生成モードは合体モード固定化に伴い廃止されたが、
    //   既存コードに参照が残っているため no-op として定義する。
    // ============================================================
    function isPreSetupMode() { return false; }
    function showPreSetupModeUnderLLM() { /* no-op */ }
    // ============================================================
    // ★ 画像生成進捗リング用の定数
    //    SVG 円周 = 2πr。dasharray / dashoffset で進捗を表現する。
    //    色は status-generating の枠色 (#ff9800) と揃える。
    // ============================================================
    const PROGRESS_RING_R = 10;
    const PROGRESS_RING_CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RING_R; // ≈ 62.83
    const PROGRESS_RING_COLOR = '#ff9800';

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

    // ============================================================
    // ★ SVG 進捗リングの生成
    //    ピル内に収まる 26x26 のリング。
    //    - track : 背景の薄い円
    //    - fill  : オレンジの進捗円（dashoffset で長さを制御）
    //    - text  : 中央のパーセント表示
    // ============================================================
    function createProgressRing() {
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'status-progress-ring');
        svg.setAttribute('width', '26');
        svg.setAttribute('height', '26');
        svg.setAttribute('viewBox', '0 0 26 26');

        // 背景トラック
        const track = document.createElementNS(NS, 'circle');
        track.setAttribute('class', 'status-progress-ring-track');
        track.setAttribute('cx', '13');
        track.setAttribute('cy', '13');
        track.setAttribute('r', String(PROGRESS_RING_R));
        track.setAttribute('fill', 'none');
        track.setAttribute('stroke', 'rgba(255, 255, 255, 0.15)');
        track.setAttribute('stroke-width', '3');
        svg.appendChild(track);

        // 進捗リング
        const fill = document.createElementNS(NS, 'circle');
        fill.setAttribute('class', 'status-progress-ring-fill');
        fill.setAttribute('cx', '13');
        fill.setAttribute('cy', '13');
        fill.setAttribute('r', String(PROGRESS_RING_R));
        fill.setAttribute('fill', 'none');
        fill.setAttribute('stroke', PROGRESS_RING_COLOR);
        fill.setAttribute('stroke-width', '3');
        fill.setAttribute('stroke-linecap', 'round');
        fill.setAttribute('stroke-dasharray', String(PROGRESS_RING_CIRCUMFERENCE));
        fill.setAttribute('stroke-dashoffset', String(PROGRESS_RING_CIRCUMFERENCE));
        fill.setAttribute('transform', 'rotate(-90 13 13)');
        fill.style.transition = 'stroke-dashoffset 0.2s ease-out';
        svg.appendChild(fill);

        // 中央のパーセント表示
        const text = document.createElementNS(NS, 'text');
        text.setAttribute('class', 'status-progress-ring-text');
        text.setAttribute('x', '13');
        text.setAttribute('y', '13');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', 'central');
        text.setAttribute('font-size', '7');
        text.setAttribute('font-weight', 'bold');
        text.setAttribute('fill', PROGRESS_RING_COLOR);
        text.textContent = '0%';
        svg.appendChild(text);

        return svg;
    }

    function updateProgressRing(el, value, max) {
        if (!el) return;
        const ring = el.querySelector('.status-progress-ring');
        if (!ring) return;
        const fill = ring.querySelector('.status-progress-ring-fill');
        const text = ring.querySelector('.status-progress-ring-text');
        const ratio = (Number.isFinite(max) && max > 0)
            ? Math.max(0, Math.min(1, value / max))
            : 0;
        const offset = PROGRESS_RING_CIRCUMFERENCE * (1 - ratio);
        if (fill) fill.setAttribute('stroke-dashoffset', String(offset));
        if (text) text.textContent = `${Math.round(ratio * 100)}%`;
    }

    function resetProgressRing(el) {
        updateProgressRing(el, 0, 1);
    }

    // ============================================================
    // ★ ステータス表示
    //    type:
    //      'llm'        … 応答生成中…（青枠・スピナー）
    //      'preparing'  … 画像準備中…（緑枠・スピナー）
    //      'generating' … 画像生成中…（オレンジ枠・SVG 進捗リング）
    //      'mode'       … モード表示（黄枠・スピナーなし）
    //    'image' は後方互換（preparing 相当として扱う）
    // ============================================================
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

        // ── 中身を組み立て ──
        el.innerHTML = '';
        if (type === 'generating') {
            // ★ 画像生成中: SVG 円形リング + テキスト
            el.appendChild(createProgressRing());
            const span = document.createElement('span');
            span.className = 'status-text-label';
            span.textContent = text;
            el.appendChild(span);
        } else {
            // 準備中 / LLM / モード: テキストのみ（スピナーは CSS ::before）
            el.textContent = text;
        }

        // ── クラス切り替え ──
        const isImage = (type === 'image' || type === 'preparing' || type === 'generating');
        el.classList.toggle('status-image',      isImage);
        el.classList.toggle('status-preparing',  type === 'preparing' || type === 'image');
        el.classList.toggle('status-generating', type === 'generating');
        el.classList.toggle('status-llm',        type === 'llm');
        el.classList.toggle('status-mode',       type === 'mode');

        if (!el.parentNode) container.appendChild(el);

        resetTimer(key);

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

        // ============================================================
        // 画像生成（カスタムイベント）
        //   preparing=true  → 画像準備中…（緑枠）
        //   preparing=false → 画像生成中…（オレンジ枠 + 進捗リング）
        // ============================================================
        window.addEventListener('gic-image-generation-started', (e) => {
            const preparing = e?.detail?.preparing === true;
            const text = preparing ? '画像準備中…' : '画像生成中…';
            const type = preparing ? 'preparing' : 'generating';
            showStatus('image', text, type);
        });
        window.addEventListener('gic-image-generation-ended', () => {
            hideStatus('image');
        });

        // ============================================================
        // ★ ComfyUI 進捗イベント（comfy_boot.js の WS インターセプタ由来）
        //   status-generating ピルが存在する時のみ反応する
        //   （別セッション・別生成の進捗で誤動作しないためのガード）
        // ============================================================
        window.addEventListener('comfyui-progress-start', () => {
            const el = items.get('image');
            if (!el || !el.classList.contains('status-generating')) return;
            resetProgressRing(el);
        });

        window.addEventListener('comfyui-progress', (e) => {
            const el = items.get('image');
            if (!el || !el.classList.contains('status-generating')) return;
            const { value, max } = e.detail || {};
            updateProgressRing(el, value, max);
        });

        window.addEventListener('comfyui-progress-end', () => {
            const el = items.get('image');
            if (!el || !el.classList.contains('status-generating')) return;
            // 完了時は 100% を表示（gic-image-generation-ended が来るまで）
            updateProgressRing(el, 1, 1);
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
