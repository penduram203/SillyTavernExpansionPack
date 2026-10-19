// このファイルは SillyTavern の公式拡張機能ローダー（動的 import）経由で読み込まれる前提。
// classic <script> タグでの直接読み込みは行わないこと（export構文が構文エラーになるため）。

const MODULE_NAME = 'chat_window_onoff';
const OLD_STORAGE_KEY = 'chatWindowHiddenState';

// ============================================================
// ★ 設定準備完了フラグ（Settings not ready 対策）
//   SillyTavern の SETTINGS_LOADED 前は saveSettingsDebounced を呼ばず、
//   準備完了後に保留分をまとめて保存する。
// ============================================================
let _stSettingsReady = false;
let _pendingSaveRequested = false;

function _markSettingsReady() {
    if (_stSettingsReady) return;
    _stSettingsReady = true;
    if (_pendingSaveRequested) {
        _pendingSaveRequested = false;
        try {
            const context = SillyTavern.getContext();
            if (context && typeof context.saveSettingsDebounced === 'function') {
                context.saveSettingsDebounced();
                console.log('[Chat Window On/Off] 保留していた設定保存を実行しました');
            }
        } catch (e) {
            console.error('[Chat Window On/Off] 保留保存の実行に失敗:', e);
        }
    }
}

(function _setupSettingsReadyHook() {
    try {
        if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
            const ctx = SillyTavern.getContext();
            if (ctx && ctx.eventSource && ctx.eventTypes && ctx.eventTypes.SETTINGS_LOADED) {
                ctx.eventSource.on(ctx.eventTypes.SETTINGS_LOADED, _markSettingsReady);
            }
        }
    } catch (e) { /* ignore */ }
    // 保険: SETTINGS_LOADED が取れない環境でも 3 秒後に準備完了扱い
    setTimeout(_markSettingsReady, 3000);
})();

function safeSaveSettingsDebounced() {
    if (!_stSettingsReady) {
        _pendingSaveRequested = true;
        return;
    }
    try {
        const context = SillyTavern.getContext();
        if (context && typeof context.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
        }
    } catch (e) {
        console.error('[Chat Window On/Off] saveSettingsDebounced 呼び出しに失敗:', e);
    }
}

const GALLERY_HIDDEN_SELECTORS = [
    '#window-control-buttons',
    '#restore-panel-button',
    '#text-styling-button',
    '#text-styling-toggle',
    '#toggle-text-styling-button',
    '#text_styling_button',
    '.text-styling-button',
    '.text-styling-toggle',
    '[data-text-styling-toggle]',
];

const BUTTON_WAKE_WIDTH = 110;
// ★ 💡/🎨 が背景生成ボタンの上に来るので、wake ゾーンを拡張
const BUTTON_WAKE_HEIGHT = 150;

const MANUAL_SETTINGS_EXTRA_W = 160;

function getSettings() {
    const context = SillyTavern.getContext();

    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = { isHidden: false };
    }

    const settings = context.extensionSettings[MODULE_NAME];

    try {
        const oldState = localStorage.getItem(OLD_STORAGE_KEY);
        if (oldState !== null) {
            settings.isHidden = (oldState === 'true');
            // ★ ガード付き保存（準備前は保留）
            safeSaveSettingsDebounced();
            localStorage.removeItem(OLD_STORAGE_KEY);
            console.log('[Chat Window On/Off] 旧localStorageからextensionSettingsへの移行を完了しました。');
        }
    } catch (e) {
        console.error('[Chat Window On/Off] localStorageからのデータ移行中にエラー:', e);
    }

    return settings;
}

function saveSettings(settings) {
    try {
        const context = SillyTavern.getContext();
        context.extensionSettings[MODULE_NAME] = settings;
        // ★ ガード付き保存（準備前は保留）
        safeSaveSettingsDebounced();
    } catch (e) {
        console.error('[Chat Window On/Off] 設定の保存に失敗:', e);
    }
}

export async function onInstall() {
    console.log('[Chat Window On/Off] onInstall フックが呼び出されました。初回セットアップを行います。');
    try { getSettings(); } catch (e) { console.error(e); }
    if (typeof toastr !== 'undefined') {
        toastr.success('Chat Window On/Off 拡張機能がインストールされました。');
    }
}

// ============================================================
// 追加スタイル注入
// ============================================================
function injectExtraStyle() {
    const styleId = 'chat-window-onoff-extra-style';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        /* Tパネル表示中は 💡/🎨 を完全無効化 */
        html body.tsp-open #toggle-chat-button,
        html body.tsp-open #gic-open-gallery-button {
            pointer-events: none !important;
            opacity: 0 !important;
            cursor: default !important;
        }

        /* ギャラリー表示中は 💡 を非表示・クリック無効 */
        html body.gallery-open #toggle-chat-button {
            display: none !important;
            pointer-events: none !important;
            opacity: 0 !important;
            cursor: default !important;
        }

        /* JSON編集画面表示中は画面左下の全ボタンを非表示 */
        html body.stj-editor-open #toggle-chat-button,
        html body.stj-editor-open #gic-open-gallery-button,
        html body.stj-editor-open #gic-release-override-button,
        html body.stj-editor-open #text-mode-button,
        html body.stj-editor-open #restore-panel-button,
        html body.stj-editor-open #center-button,
        html body.stj-editor-open #right-half-button,
        html body.stj-editor-open #custom-button,
        html body.stj-editor-open #maximize-button,
        html body.stj-editor-open #half-maximize-button,
        html body.stj-editor-open #manual-settings-button,
        html body.stj-editor-open #window-control-buttons,
        html body.stj-editor-open #image-control-container {
            display: none !important;
            pointer-events: none !important;
            opacity: 0 !important;
            cursor: default !important;
        }

        /* 普段は 💡 非表示 */
        html body #toggle-chat-button {
            opacity: 0 !important;
            transition: opacity 0.15s ease !important;
        }

        /* ★ 🎨 は wake 時のみ表示（💡 近接中は除外して独立化） */
        html body.gic-buttons-wake:not(.chat-bulb-hover) #gic-open-gallery-button {
            opacity: 0.3 !important;
            background-color: #444 !important;
        }

        /* ★ 💡 は近接時のみ表示（🎨 とは独立） */
        html body.chat-bulb-hover #toggle-chat-button {
            opacity: 0.3 !important;
            background-color: #444 !important;
        }

        /* ボタン直接 hover 時は完全不透明 */
        html body #toggle-chat-button:hover,
        html body #gic-open-gallery-button:hover {
            opacity: 1 !important;
        }
    `;
    document.head.appendChild(style);
    console.log('[Chat Window On/Off] 追加スタイルを注入しました');
}

// ============================================================
// Tパネル監視
// ============================================================
function isTextStylingPanelOpen() {
    const panel = document.getElementById('text-styling-panel');
    if (!panel) return false;
    if (panel.classList.contains('hidden')) return false;
    const cs = window.getComputedStyle(panel);
    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden') return false;
    return true;
}

let lastTspState = null;

function syncTspOpenClass() {
    const isOpen = isTextStylingPanelOpen();
    if (isOpen === lastTspState) return;
    lastTspState = isOpen;

    if (isOpen) {
        document.body.classList.add('tsp-open');
        document.body.classList.remove('lbe-aux-hover');
        console.log('[Chat Window On/Off] 🔒 Tパネル表示中 → 💡/🎨 を完全無効化');
    } else {
        document.body.classList.remove('tsp-open');
        console.log('[Chat Window On/Off] 🔓 Tパネル非表示 → 💡/🎨 を有効化');
    }
}

function setupTspObserver() {
    const observePanel = () => {
        const panel = document.getElementById('text-styling-panel');
        if (!panel) return;
        if (panel.dataset.tspObserved === 'true') return;
        panel.dataset.tspObserved = 'true';
        const mo = new MutationObserver(() => syncTspOpenClass());
        mo.observe(panel, { attributes: true, attributeFilter: ['class', 'style'] });
    };

    const bodyMo = new MutationObserver(() => {
        observePanel();
        syncTspOpenClass();
    });
    bodyMo.observe(document.body, { childList: true, subtree: false });

    observePanel();
    setInterval(() => { observePanel(); syncTspOpenClass(); }, 300);

    syncTspOpenClass();
    console.log('[Chat Window On/Off] 🎨 Tパネル監視を開始しました');
}

function initChatWindowToggle() {
    console.log('チャットウィンドウ透過切り替え拡張機能: 初期化開始');
    if (document.getElementById('toggle-chat-button')) return;

    const settings = getSettings();
    injectExtraStyle();

    const toggleButton = document.createElement('button');
    toggleButton.id = 'toggle-chat-button';
    toggleButton.textContent = '💡';
    toggleButton.title = 'チャットウィンドウの透過/不透過';
    document.body.appendChild(toggleButton);
    console.log('💡 アイコンボタンをDOMに追加しました。');

    setupTspObserver();

    if (settings.isHidden) {
        document.body.classList.add('chat-window-is-hidden');
        toggleButton.classList.add('active');
        console.log('保存された状態（透過）を復元しました。');
    }

    toggleButton.addEventListener('click', () => {
        document.body.classList.toggle('chat-window-is-hidden');
        const isHidden = document.body.classList.contains('chat-window-is-hidden');
        toggleButton.classList.toggle('active', isHidden);
        settings.isHidden = isHidden;
        saveSettings(settings);
        console.log(`💡 チャットウィンドウ: ${isHidden ? '透過' : '不透過'}`);
    });

    requestAnimationFrame(() => applyToggleChatButtonLayout());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatWindowToggle);
} else {
    initChatWindowToggle();
}

// ============================================================
// #chat レイアウト
// ============================================================
function applyChatLayout() {
    const chat = document.getElementById('chat');
    const sheld = document.getElementById('sheld');
    const form = document.getElementById('form_sheld');
    if (!chat || !sheld) return;

    // ★ image-display の explicit モード中は触らない（干渉防止）
    if (sheld.classList.contains('idp-chat-explicit') || sheld.classList.contains('idp-chat-maximized')) {
        return;
    }

    if (window.innerWidth < 1001) {
        chat.style.cssText = '';
        if (form) form.style.cssText = '';
        return;
    }

    const sheldRect = sheld.getBoundingClientRect();
    const winW = window.innerWidth;
    const contentWidth = 900;

    const sheldCenterX = sheldRect.left + sheldRect.width / 2;
    const paddingLeft = Math.max(0, sheldCenterX - contentWidth / 2);
    const paddingRight = Math.max(0, winW - sheldCenterX - contentWidth / 2);

    const chatTop = sheldRect.top;
    const chatBottom = window.innerHeight - sheldRect.bottom;

    const formRect = form ? form.getBoundingClientRect() : null;
    const formHeight = formRect ? formRect.height : 40;

    const prevScroll = chat.scrollTop;

    chat.style.position = 'fixed';
    chat.style.left = '0';
    chat.style.right = '0';
    chat.style.top = chatTop + 'px';
    chat.style.bottom = (chatBottom + formHeight) + 'px';
    chat.style.width = '100vw';
    chat.style.maxWidth = '100vw';
    chat.style.margin = '0';
    chat.style.marginLeft = '0';
    chat.style.marginRight = '0';
    chat.style.paddingLeft = paddingLeft + 'px';
    chat.style.paddingRight = paddingRight + 'px';
    chat.style.boxSizing = 'border-box';
    chat.style.overflowY = 'auto';
    chat.style.overflowX = 'hidden';
    chat.style.zIndex = '1';

    if (form) {
        form.style.position = 'fixed';
        form.style.left = '0';
        form.style.right = '0';
        form.style.top = 'auto';
        form.style.bottom = chatBottom + 'px';
        form.style.width = '100vw';
        form.style.maxWidth = '100vw';
        form.style.margin = '0';
        form.style.marginLeft = '0';
        form.style.marginRight = '0';
        form.style.paddingLeft = paddingLeft + 'px';
        form.style.paddingRight = paddingRight + 'px';
        form.style.boxSizing = 'border-box';
        form.style.zIndex = '2';
    }

    chat.scrollTop = prevScroll;
}

// ============================================================
// ★ 💡 ボタン位置: send_form の左隣に追従
// ============================================================
function applyToggleChatButtonLayout() {
    const btn = document.getElementById('toggle-chat-button');
    if (!btn) return;

    const anchor = document.getElementById('send_form') ||
                   document.getElementById('form_sheld') ||
                   document.getElementById('send_textarea');
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const gap = 5;
    const btnW = btn.offsetWidth || 50;
    const btnH = btn.offsetHeight || 50;

    // send_form の左隣、縦中央
    let left = rect.left - btnW - gap;
    let top  = rect.top + (rect.height - btnH) / 2;

    const margin = 4;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (left < margin) left = margin;
    if (left + btnW > vw - margin) left = vw - margin - btnW;
    if (top < margin) top = margin;
    if (top + btnH > vh - margin) top = vh - margin - btnH;

    btn.style.setProperty('position', 'fixed', 'important');
    btn.style.setProperty('left', Math.round(left) + 'px', 'important');
    btn.style.setProperty('top', Math.round(top) + 'px', 'important');
    btn.style.setProperty('right', 'auto', 'important');
    btn.style.setProperty('bottom', 'auto', 'important');
    btn.style.setProperty('transform', 'none', 'important');
}

setInterval(() => {
    applyChatLayout();
    applyToggleChatButtonLayout();
}, 500);

window.addEventListener('resize', () => {
    applyChatLayout();
    applyToggleChatButtonLayout();
});

setTimeout(() => {
    applyChatLayout();
    applyToggleChatButtonLayout();
}, 100);

try {
    const sendFormEl = document.getElementById('send_form');
    if (sendFormEl && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => applyToggleChatButtonLayout());
        ro.observe(sendFormEl);
    }
} catch (e) { /* ignore */ }

// ============================================================
// パディング領域のクリック透過
// ============================================================
function setupChatPaddingClickThrough() {
    const chat = document.getElementById('chat');
    if (!chat) return;
    if (chat.dataset.paddingClickThroughInstalled === 'true') return;
    chat.dataset.paddingClickThroughInstalled = 'true';

    chat.addEventListener('mousedown', (e) => {
        if (e.target !== chat) return;
        const rect = chat.getBoundingClientRect();
        const scrollbarWidth = chat.offsetWidth - chat.clientWidth;
        const isOnScrollbar = scrollbarWidth > 0 && e.clientX >= rect.right - scrollbarWidth;
        if (isOnScrollbar) return;
        e.preventDefault();
        e.stopPropagation();
        chat.style.pointerEvents = 'none';
        const below = document.elementFromPoint(e.clientX, e.clientY);
        chat.style.pointerEvents = '';
        if (below && below !== chat && !chat.contains(below)) {
            const forwarded = new MouseEvent('mousedown', {
                bubbles: true, cancelable: true, view: window,
                clientX: e.clientX, clientY: e.clientY,
                button: e.button, buttons: e.buttons,
            });
            below.dispatchEvent(forwarded);
        }
    }, true);
    console.log('[Chat Window On/Off] パディング領域のクリック透過を設定しました');
}

setupChatPaddingClickThrough();

// ============================================================
// ★ 💡 ボタン近接表示（🎨 とは独立、周囲 20px）
// ============================================================
function setupBulbHover() {
    const BULB_HOVER_MARGIN = 20;   // ★ 10 → 20 に拡張
    let _bulbIsInZone = false;
    let _lastX = -1, _lastY = -1;

    function update(x, y) {
        const btn = document.getElementById('toggle-chat-button');
        if (!btn) return;

        if (document.body.classList.contains('tsp-open') ||
            document.body.classList.contains('gallery-open') ||
            document.body.classList.contains('stj-editor-open')) {
            if (_bulbIsInZone) {
                _bulbIsInZone = false;
                document.body.classList.remove('chat-bulb-hover');
            }
            return;
        }

        if (x < 0 || y < 0) {
            if (_bulbIsInZone) {
                _bulbIsInZone = false;
                document.body.classList.remove('chat-bulb-hover');
            }
            return;
        }

        const rect = btn.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const inside =
            x >= rect.left - BULB_HOVER_MARGIN && x <= rect.right + BULB_HOVER_MARGIN &&
            y >= rect.top - BULB_HOVER_MARGIN && y <= rect.bottom + BULB_HOVER_MARGIN;

        if (inside === _bulbIsInZone) return;
        _bulbIsInZone = inside;
        document.body.classList.toggle('chat-bulb-hover', inside);
    }

    document.addEventListener('mousemove', (e) => {
        _lastX = e.clientX;
        _lastY = e.clientY;
        update(_lastX, _lastY);
    }, { passive: true });

    document.addEventListener('mouseleave', () => {
        _lastX = -1; _lastY = -1;
        update(-1, -1);
    });

    window.addEventListener('blur', () => {
        _lastX = -1; _lastY = -1;
        update(-1, -1);
    });

    setInterval(() => {
        if (_lastX >= 0) update(_lastX, _lastY);
    }, 300);

    console.log(`[Chat Window On/Off] 💡 近接表示を開始しました (margin=${BULB_HOVER_MARGIN}px)`);
}

setupBulbHover();

// ============================================================
// ギャラリー連動
// ============================================================
let _galleryOpenCache = { value: false, timestamp: 0 };
const GALLERY_OPEN_CACHE_TTL = 100;

function isGalleryOpen() {
    const now = performance.now();
    if (now - _galleryOpenCache.timestamp < GALLERY_OPEN_CACHE_TTL) {
        return _galleryOpenCache.value;
    }
    let result = false;
    const primary = document.getElementById('gallery');
    if (primary) {
        const style = window.getComputedStyle(primary);
        if (style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) !== 0) {
            const rect = primary.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) result = true;
        }
    }
    if (!result) {
        const candidates = document.querySelectorAll([
            '#gallery_container', '.gallery-container', '.gallery_container',
            '.gallery', '[data-gallery-container]', '.gallery-grid', '#gallery-grid'
        ].join(','));
        for (const el of candidates) {
            if (!el) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none') continue;
            if (style.visibility === 'hidden') continue;
            if (parseFloat(style.opacity) === 0) continue;
            if (el.offsetParent === null && style.position !== 'fixed') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            result = true;
            break;
        }
    }
    _galleryOpenCache = { value: result, timestamp: now };
    return result;
}

function isStjEditorOpen() {
    const modal = document.getElementById('stj_export_modal');
    if (!modal) return false;
    if (modal.style.display === 'block') return true;
    const cs = window.getComputedStyle(modal);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0;
}

function syncBodyStateClasses() {
    const galleryOpen = isGalleryOpen();
    const stjOpen = isStjEditorOpen();

    const hasGalleryClass = document.body.classList.contains('gallery-open');
    if (galleryOpen && !hasGalleryClass) document.body.classList.add('gallery-open');
    else if (!galleryOpen && hasGalleryClass) document.body.classList.remove('gallery-open');

    const hasStjClass = document.body.classList.contains('stj-editor-open');
    if (stjOpen && !hasStjClass) document.body.classList.add('stj-editor-open');
    else if (!stjOpen && hasStjClass) document.body.classList.remove('stj-editor-open');

    if (!galleryOpen && !stjOpen) {
        const toggleBtn = document.getElementById('toggle-chat-button');
        if (toggleBtn && toggleBtn.style.display === 'none') {
            toggleBtn.style.removeProperty('display');
        }
    }

    return { galleryOpen, stjOpen };
}

let lastGalleryStateForButtons = null;

function syncButtonsVisibilityForGallery() {
    const { galleryOpen } = syncBodyStateClasses();
    if (galleryOpen === lastGalleryStateForButtons) return;
    lastGalleryStateForButtons = galleryOpen;

    const selector = GALLERY_HIDDEN_SELECTORS.join(',');
    const targets = document.querySelectorAll(selector);

    targets.forEach(el => {
        if (galleryOpen) el.style.setProperty('display', 'none', 'important');
        else el.style.removeProperty('display');
    });
}

function setupGalleryButtonObserver() {
    setInterval(syncButtonsVisibilityForGallery, 300);
    syncButtonsVisibilityForGallery();
    console.log('[Chat Window On/Off] 📷 ギャラリー連動監視を開始しました（ポーリング方式）');
}

setupGalleryButtonObserver();

// ============================================================
// 左下のボタン起動領域（🎨 用 wake ゾーン）
// ============================================================
function setupButtonWakeZone() {
    const BASE_WAKE_W = BUTTON_WAKE_WIDTH;   // 110
    const WAKE_H = BUTTON_WAKE_HEIGHT;       // 150
    const EXTRA_W = MANUAL_SETTINGS_EXTRA_W; // 160

    let isInZone = false;
    let lastX = -1;
    let lastY = -1;

    function isManualSettingsVisible() {
        const btn = document.getElementById('manual-settings-button');
        if (!btn) return false;
        const cs = window.getComputedStyle(btn);
        if (cs.display === 'none') return false;
        if (cs.visibility === 'hidden') return false;
        return true;
    }

    function getWakeWidth() {
        return BASE_WAKE_W + (isManualSettingsVisible() ? EXTRA_W : 0);
    }

    function isInside(x, y) {
        const wakeW = getWakeWidth();
        return x >= 0 && x <= wakeW &&
               y >= window.innerHeight - WAKE_H && y <= window.innerHeight;
    }

    function isAnyOverlayActive() {
        return document.body.classList.contains('gallery-open') ||
               document.body.classList.contains('stj-editor-open');
    }

    function applyState() {
        if (isAnyOverlayActive()) {
            if (isInZone) {
                isInZone = false;
                document.body.classList.remove('gic-buttons-wake');
            }
            return;
        }
        const inside = isInside(lastX, lastY);
        if (inside === isInZone) return;
        isInZone = inside;
        document.body.classList.toggle('gic-buttons-wake', inside);
    }

    function update(x, y) { lastX = x; lastY = y; applyState(); }

    document.addEventListener('mousemove', (e) => update(e.clientX, e.clientY), { passive: true });
    document.addEventListener('mouseleave', () => update(-1, -1));
    window.addEventListener('blur', () => update(-1, -1));

    setInterval(applyState, 200);

    document.body.classList.remove('gic-buttons-wake');
    console.log(`[Chat Window On/Off] 🖱 ボタン起動領域を設定: ${BASE_WAKE_W}px × ${WAKE_H}px (左下、手動モード時 +${EXTRA_W}px)`);
}

setupButtonWakeZone();

// ============================================================
// 初期化時の残留クラス一掃
// ============================================================
(function cleanupBodyClassesOnInit() {
    const cleanup = () => {
        if (!isGalleryOpen() && document.body.classList.contains('gallery-open')) {
            document.body.classList.remove('gallery-open');
        }
        if (!isStjEditorOpen() && document.body.classList.contains('stj-editor-open')) {
            document.body.classList.remove('stj-editor-open');
        }
        if (document.body.classList.contains('lbe-aux-hover')) {
            document.body.classList.remove('lbe-aux-hover');
        }
        if (document.body.classList.contains('gic-buttons-wake')) {
            document.body.classList.remove('gic-buttons-wake');
        }
        if (document.body.classList.contains('chat-bulb-hover')) {
            document.body.classList.remove('chat-bulb-hover');
        }
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', cleanup);
    } else {
        cleanup();
    }
})();
