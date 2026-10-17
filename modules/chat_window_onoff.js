// このファイルは SillyTavern の公式拡張機能ローダー（動的 import）経由で読み込まれる前提。

const MODULE_NAME = 'chat_window_onoff';
const OLD_STORAGE_KEY = 'chatWindowHiddenState';

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
const BUTTON_WAKE_HEIGHT = 150;
const MANUAL_SETTINGS_EXTRA_W = 160;

const AUX_HOVER_BUTTON_IDS = ['gic-open-gallery-button'];
const AUX_HOVER_MARGIN = 30;

// 💡 のコンパクトサイズ（#options_button 相当）
const COMPACT_BTN_SIZE = 22;

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
            context.saveSettingsDebounced();
            localStorage.removeItem(OLD_STORAGE_KEY);
            console.log('[Chat Window On/Off] 旧localStorageからextensionSettingsへの移行完了');
        }
    } catch (e) {
        console.error('[Chat Window On/Off] localStorage移行エラー:', e);
    }
    return settings;
}

function saveSettings(settings) {
    try {
        const context = SillyTavern.getContext();
        context.extensionSettings[MODULE_NAME] = settings;
        context.saveSettingsDebounced();
    } catch (e) {
        console.error('[Chat Window On/Off] 設定保存失敗:', e);
    }
}

export async function onInstall() {
    console.log('[Chat Window On/Off] onInstall フック呼び出し');
    try { getSettings(); } catch (e) { console.error(e); }
    if (typeof toastr !== 'undefined') {
        toastr.success('Chat Window On/Off 拡張機能がインストールされました。');
    }
}

// ============================================================
// 追加スタイル注入
//   ★ #toggle-chat-button は送信フォーム内で CSS 制御するため、
//      ここでは hover 無効化用のみ指定
// ============================================================
function injectExtraStyle() {
    const styleId = 'chat-window-onoff-extra-style';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
        /* Tパネル表示中は 🎨 を無効化 */
        html body.tsp-open #gic-open-gallery-button {
            pointer-events: none !important;
            opacity: 0 !important;
            cursor: default !important;
        }

        /* ギャラリー表示中は 🎨 を非表示 */
        html body.gallery-open #gic-open-gallery-button {
            display: none !important;
            pointer-events: none !important;
            opacity: 0 !important;
        }

        /* JSON編集画面表示中は画面左下の全ボタンを非表示 */
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
        }

        /* wake 時に 🎨 を他ボタンと同時表示 */
        html body.gic-buttons-wake #gic-open-gallery-button {
            opacity: 0.3 !important;
            background-color: #444 !important;
        }
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
        console.log('[Chat Window On/Off] 🔒 Tパネル表示中 → 🎨 を無効化');
    } else {
        document.body.classList.remove('tsp-open');
        console.log('[Chat Window On/Off] 🔓 Tパネル非表示 → 🎨 を有効化');
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

// ============================================================
// ★ 💡 を #leftSendForm 内の #options_button 左隣へ移動・コンパクト化
// ============================================================
function applyCompactToggleStyle(btn, isHidden) {
    btn.style.cssText = `
        position: static !important;
        left: auto !important;
        top: auto !important;
        right: auto !important;
        bottom: auto !important;
        transform: none !important;
        width: ${COMPACT_BTN_SIZE}px !important;
        height: ${COMPACT_BTN_SIZE}px !important;
        min-width: ${COMPACT_BTN_SIZE}px !important;
        max-width: ${COMPACT_BTN_SIZE}px !important;
        min-height: ${COMPACT_BTN_SIZE}px !important;
        max-height: ${COMPACT_BTN_SIZE}px !important;
        padding: 0 !important;
        margin: 0 4px 0 0 !important;
        font-size: 14px !important;
        line-height: 1 !important;
        background: transparent !important;
        background-color: transparent !important;
        border: none !important;
        box-shadow: none !important;
        color: #000 !important;
        filter: grayscale(1) contrast(1.4) ${isHidden ? 'brightness(0.7)' : 'brightness(1.1)'} !important;
        opacity: ${isHidden ? '1' : '0.7'} !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        cursor: pointer !important;
        user-select: none !important;
        vertical-align: middle !important;
        flex: 0 0 auto !important;
    `;
    // hover ハンドラ（多重登録防止）
    if (btn.dataset.idpHoverBound !== 'true') {
        btn.dataset.idpHoverBound = 'true';
        btn.addEventListener('mouseenter', () => {
            btn.style.setProperty('opacity', '1', 'important');
        });
        btn.addEventListener('mouseleave', () => {
            const hidden = document.body.classList.contains('chat-window-is-hidden');
            btn.style.setProperty('opacity', hidden ? '1' : '0.7', 'important');
        });
    }
}

function updateToggleVisibilityState() {
    const btn = document.getElementById('toggle-chat-button');
    if (!btn) return;
    const inSendForm = btn.parentElement && btn.parentElement.id === 'leftSendForm';
    if (!inSendForm) return;

    let hide = false;
    if (document.body.classList.contains('tsp-open')) hide = true;
    if (document.body.classList.contains('gallery-open')) hide = true;
    if (document.body.classList.contains('stj-editor-open')) hide = true;

    if (hide) {
        btn.style.setProperty('display', 'none', 'important');
    } else {
        btn.style.setProperty('display', 'inline-flex', 'important');
    }
}

function ensureToggleInSendForm() {
    const btn = document.getElementById('toggle-chat-button');
    if (!btn) return;

    const leftSendForm = document.getElementById('leftSendForm');
    if (!leftSendForm) return;

    const optionsButton = document.getElementById('options_button');

    // 送信フォーム内に移動（未移動の場合）
    if (btn.parentElement !== leftSendForm) {
        try {
            if (optionsButton && optionsButton.parentElement === leftSendForm) {
                leftSendForm.insertBefore(btn, optionsButton);
            } else {
                leftSendForm.appendChild(btn);
            }
            console.log('[Chat Window On/Off] 💡 を #leftSendForm 内 #options_button の左隣に移動');
        } catch (e) {
            console.warn('[Chat Window On/Off] 💡 の移動失敗:', e);
            return;
        }
    }

    // コンパクトスタイルを適用（初回のみ）
    if (btn.dataset.idpCompact !== 'true') {
        btn.dataset.idpCompact = 'true';
        const isHidden = document.body.classList.contains('chat-window-is-hidden');
        applyCompactToggleStyle(btn, isHidden);
    }

    // 表示状態を更新
    updateToggleVisibilityState();
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

        // コンパクトスタイルの見た目を再適用
        if (toggleButton.dataset.idpCompact === 'true') {
            applyCompactToggleStyle(toggleButton, isHidden);
        }
        console.log(`💡 チャットウィンドウ: ${isHidden ? '透過' : '不透過'}`);
    });

    // すぐに移動を試み、失敗したらリトライ
    ensureToggleInSendForm();
    requestAnimationFrame(() => {
        ensureToggleInSendForm();
        applyToggleChatButtonLayout();
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChatWindowToggle);
} else {
    initChatWindowToggle();
}

// ============================================================
// #chat レイアウト（image-display の explicit モード中は触らない）
// ============================================================
function applyChatLayout() {
    const chat = document.getElementById('chat');
    const sheld = document.getElementById('sheld');
    const form = document.getElementById('form_sheld');
    if (!chat || !sheld) return;

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
// 💡 フォールバック配置（送信フォーム未検出時のみ）
// ============================================================
function applyToggleChatButtonLayout() {
    const btn = document.getElementById('toggle-chat-button');
    if (!btn) return;

    // 送信フォーム内にいる場合は何もしない
    if (btn.parentElement && btn.parentElement.id === 'leftSendForm') return;

    // フォールバック: 背景生成ボタンの 5px 上（🎨 の右隣）
    const gicBtn = document.getElementById('gic-release-override-button');
    if (!gicBtn) return;
    const gicRect = gicBtn.getBoundingClientRect();
    if (gicRect.width <= 0 || gicRect.height <= 0) return;

    const gap = 5;
    const btnW = btn.offsetWidth || 50;
    const btnH = btn.offsetHeight || 50;

    let left = btnW + gap;
    let top = gicRect.top - btnH - gap;

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
    ensureToggleInSendForm();
    applyChatLayout();
    applyToggleChatButtonLayout();
}, 500);

window.addEventListener('resize', () => {
    ensureToggleInSendForm();
    applyChatLayout();
    applyToggleChatButtonLayout();
});

setTimeout(() => {
    ensureToggleInSendForm();
    applyChatLayout();
    applyToggleChatButtonLayout();
}, 100);

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
// 🎨 の hover（💡 は送信フォーム内で独立して hover）
// ============================================================
function setupAuxButtonHover() {
    function getAuxButtonsRect() {
        const btns = AUX_HOVER_BUTTON_IDS
            .map(id => document.getElementById(id))
            .filter(el => {
                if (!el) return false;
                if (el.style.display === 'none') return false;
                if (window.getComputedStyle(el).display === 'none') return false;
                return true;
            });
        if (btns.length === 0) return null;

        let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
        let anyValid = false;
        for (const b of btns) {
            const r = b.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            anyValid = true;
            if (r.left < minL) minL = r.left;
            if (r.top < minT) minT = r.top;
            if (r.right > maxR) maxR = r.right;
            if (r.bottom > maxB) maxB = r.bottom;
        }
        if (!anyValid) return null;
        return { left: minL, top: minT, right: maxR, bottom: maxB };
    }

    let isInZone = false;

    function isAnyOverlayActive() {
        return document.body.classList.contains('tsp-open') ||
               document.body.classList.contains('gallery-open') ||
               document.body.classList.contains('stj-editor-open');
    }

    function update(x, y) {
        if (isAnyOverlayActive()) {
            if (isInZone) { isInZone = false; document.body.classList.remove('lbe-aux-hover'); }
            return;
        }
        const r = getAuxButtonsRect();
        if (!r) {
            if (isInZone) { isInZone = false; document.body.classList.remove('lbe-aux-hover'); }
            return;
        }
        const inside =
            x >= r.left - AUX_HOVER_MARGIN && x <= r.right + AUX_HOVER_MARGIN &&
            y >= r.top - AUX_HOVER_MARGIN && y <= r.bottom + AUX_HOVER_MARGIN;
        if (inside === isInZone) return;
        isInZone = inside;
        document.body.classList.toggle('lbe-aux-hover', inside);
    }

    document.addEventListener('mousemove', (e) => update(e.clientX, e.clientY), { passive: true });
    document.addEventListener('mouseleave', () => update(-1, -1));
    window.addEventListener('blur', () => update(-1, -1));

    setInterval(() => {
        if (isAnyOverlayActive() && isInZone) {
            isInZone = false;
            document.body.classList.remove('lbe-aux-hover');
        }
    }, 200);

    console.log(`[Chat Window On/Off] 🎯 🎨 hover 判定を開始 (margin=${AUX_HOVER_MARGIN}px)`);
}

setupAuxButtonHover();

// ============================================================
// ギャラリー連動 / 状態クラス
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

    // 💡 の表示状態を再評価
    updateToggleVisibilityState();

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
    console.log('[Chat Window On/Off] 📷 ギャラリー連動監視を開始しました');
}

setupGalleryButtonObserver();

// ============================================================
// 左下のボタン起動領域（hover 統合）
// ============================================================
function setupButtonWakeZone() {
    const BASE_WAKE_W = BUTTON_WAKE_WIDTH;
    const WAKE_H = BUTTON_WAKE_HEIGHT;
    const EXTRA_W = MANUAL_SETTINGS_EXTRA_W;

    let isInZone = false;
    let lastX = -1, lastY = -1;

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
    console.log(`[Chat Window On/Off] 🖱 ボタン起動領域: ${BASE_WAKE_W}px × ${WAKE_H}px (手動モード時 +${EXTRA_W}px)`);
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
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', cleanup);
    } else {
        cleanup();
    }
})();
