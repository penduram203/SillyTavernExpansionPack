// status_indicator.js
// 画面上部に「応答生成中…」「画像生成中…」のステータスを表示する。
//   - LLM応答生成: MESSAGE_SENT/MESSAGE_SWIPED で表示、GENERATION_ENDED で非表示
//   - 画像生成: gic-image-generation-started/ended カスタムイベントで表示制御
//     preparing:true → 📷 スピナー（画像準備中…）
//     preparing:false → 🖼 スピナー（画像生成中…）
//   - LLM応答生成は 📃 スピナー
//   - ホバー時に data-tooltip を即座に表示（独自ツールチップ）

(function () {
    'use strict';
    const LOG = '[StatusIndicator]';
    const CONTAINER_ID = 'status-indicator-container';
    const STYLE_ID = 'status-indicator-style';
    const MAX_SHOW_MS = 180000; // 3分でタイムアウト（暴走防止）

    // ============================================================
    // ★ 旧「事前設定モード」用のスタブ
    //   背景生成モードは合体モード固定化に伴い廃止されたが、
    //   gic-mode-changed ハンドラと window.StatusIndicator 代入部に
    //   参照が残っているため no-op として定義する。
    // ============================================================
    function isPreSetupMode() { return false; }
    function showPreSetupModeUnderLLM() { /* no-op */ }

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
    // ★ ステータス表示
    //    type:
    //      'llm'        … 📃 スピナー（応答生成中…）
    //      'preparing'  … 📷 スピナー（画像準備中…）
    //      'generating' … 📷 スピナー（画像生成中…）
    //      'mode'       … ⚙️ スピナーなし（モード表示）
    //    'image' は後方互換（preparing 相当として扱う）
    //    絵文字にホバーすると data-tooltip の詳細テキストを即座に表示する。
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
        // ★ 絵文字とツールチップテキストの決定
        let emoji = '';
        let tooltip = '';
        if (type === 'llm' || text === '応答生成中…') {
            emoji = '📃';
            tooltip = '応答生成中…';
        } else if (type === 'preparing' || type === 'image') {
            emoji = '📷';
            tooltip = '画像準備中…';
        } else if (type === 'generating') {
            emoji = '📷';              // ★ 🖼 → 📷（文字化け対策）
            tooltip = '画像生成中…';
        } else if (type === 'mode') {
            emoji = '⚙️';
            tooltip = text;
        } else {
            emoji = '⏳';
            tooltip = text;
        }

        el.textContent = emoji;
        el.dataset.tooltip = tooltip;
        el.setAttribute('aria-label', tooltip);  // アクセシビリティ用
        el.removeAttribute('title');              // native title は無効化（二重表示防止）

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

        // ★ 表示直後に位置を同期（💡 がまだ配置されていなければ
        //   次の 300ms ポーリングで追いつく）
        syncStatusContainerPosition();
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
        //   preparing=true  → 📷 スピナー（緑枠）
        //   preparing=false → 🖼 スピナー（オレンジ枠）
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

    // ============================================================
    // ★ 即座表示ツールチップ
    //    status-indicator-item にマウスが乗ったら、data-tooltip の
    //    内容を即座にツールチップとして表示する。
    //    （native title は 1秒前後の遅延があるため独自実装）
    // ============================================================
    (function setupImmediateTooltip() {
        let tooltipEl = null;

        function ensureTooltip() {
            if (tooltipEl && document.body.contains(tooltipEl)) return tooltipEl;
            tooltipEl = document.createElement('div');
            tooltipEl.id = 'status-immediate-tooltip';
            document.body.appendChild(tooltipEl);
            return tooltipEl;
        }

        function showTooltip(target) {
            const text = target.dataset.tooltip;
            if (!text) return;
            const tip = ensureTooltip();
            tip.textContent = text;
            // ★ opacity: 0 の状態で一旦レイアウト確定させてから visible を付与
            tip.classList.add('visible');

            // 位置計算: 対象の上に表示
            const rect = target.getBoundingClientRect();
            const tipRect = tip.getBoundingClientRect();

            let top = rect.top - tipRect.height - 8;
            let left = rect.left + rect.width / 2 - tipRect.width / 2;

            // 画面外にはみ出さないよう補正
            if (top < 4) top = rect.bottom + 8;   // 上に収まらなければ下へ
            if (left < 4) left = 4;
            if (left + tipRect.width > window.innerWidth - 4) {
                left = window.innerWidth - tipRect.width - 4;
            }

            tip.style.left = Math.round(left) + 'px';
            tip.style.top = Math.round(top) + 'px';
        }

        function hideTooltip() {
            if (tooltipEl) tooltipEl.classList.remove('visible');
        }

        // ── イベント委譲（document 全体で監視） ──
        document.addEventListener('mouseover', (e) => {
            const target = e.target && e.target.closest
                ? e.target.closest('.status-indicator-item')
                : null;
            if (!target) return;
            showTooltip(target);
        }, true);

        document.addEventListener('mouseout', (e) => {
            const target = e.target && e.target.closest
                ? e.target.closest('.status-indicator-item')
                : null;
            if (!target) return;
            // relatedTarget が同じ target 内なら無視（内部の子要素移動）
            if (e.relatedTarget && target.contains(e.relatedTarget)) return;
            hideTooltip();
        }, true);

        // スクロールやウィンドウリサイズ時に位置がずれないよう非表示
        window.addEventListener('scroll', hideTooltip, true);
        window.addEventListener('resize', hideTooltip);
        window.addEventListener('blur', hideTooltip);
    })();

    // ============================================================
    // ★ ステータスコンテナの位置を 💡 ボタンに追従させる
    //   - left: 💡 の左端 - padding-left 分（絵文字の左端を 💡 の左端に揃える）
    //   - bottom: 🎨 の上端 + 8px 上（📷 の下端が 🎨 の直上に来る）
    // ============================================================
    let _statusPosSyncTimer = null;

    function syncStatusContainerPosition() {
        const container = document.getElementById(CONTAINER_ID);
        if (!container) return;
        if (container.style.display === 'none') return;
        if (container.children.length === 0) return;

        const toggleBtn = document.getElementById('toggle-chat-button');
        if (!toggleBtn) return;

        const rect = toggleBtn.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.left < 0) return;

        // ── left: 絵文字の左端を 💡 の左端に揃える ──
        //    status-indicator-item の padding-left(10px) 分だけ左にずらす
        const ITEM_PADDING_LEFT = 10;
        const left = rect.left - ITEM_PADDING_LEFT;
        container.style.setProperty('left', Math.round(left) + 'px', 'important');

        // ── bottom: 🎨 の上端 + 8px 上にコンテナ下端を置く ──
        const GALLERY_H = 50;    // 🎨 の高さ
        const GALLERY_GAP = 5;   // 💡 と 🎨 の縦間隔
        const STATUS_GAP = 8;    // 📷 と 🎨 の間隔
        const galleryTop = rect.top - GALLERY_H - GALLERY_GAP;
        const bottomFromViewportBottom = window.innerHeight - galleryTop + STATUS_GAP;
        container.style.setProperty('bottom', Math.round(bottomFromViewportBottom) + 'px', 'important');
    }

    // ポーリング + リサイズ + blur で追従
    if (!_statusPosSyncTimer) {
        _statusPosSyncTimer = setInterval(syncStatusContainerPosition, 300);
    }
    window.addEventListener('resize', syncStatusContainerPosition);
    window.addEventListener('blur', syncStatusContainerPosition);
    
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
