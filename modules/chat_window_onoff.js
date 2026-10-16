// このファイルは SillyTavern の公式拡張機能ローダー（動的 import）経由で読み込まれる前提。
// classic <script> タグでの直接読み込みは行わないこと（export構文が構文エラーになるため）。

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
const BUTTON_WAKE_HEIGHT = 80;

const AUX_HOVER_BUTTON_IDS = ['toggle-chat-button', 'gic-open-gallery-button'];
const AUX_HOVER_MARGIN = 30;

function getSettings() {
    const context = SillyTavern.getContext();

    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = {
            isHidden: false,
        };
    }

    const settings = context.extensionSettings[MODULE_NAME];

    try {
        const oldState = localStorage.getItem(OLD_STORAGE_KEY);
        if (oldState !== null) {
            settings.isHidden = (oldState === 'true');
            context.saveSettingsDebounced();
            localStorage.removeItem(OLD_STORAGE_KEY);
            console.log('[Chat Window On/Off] 旧localStorageからextensionSettingsへの移行を完了しました。');
        }
    } catch (e) {
        console.error('[Chat Window On/Off] localStorageからのデータ移行中にエラーが発生しました:', e);
    }

    return settings;
}

function saveSettings(settings) {
    try {
        const context = SillyTavern.getContext();
        context.extensionSettings[MODULE_NAME] = settings;
        context.saveSettingsDebounced();
    } catch (e) {
        console.error('[Chat Window On/Off] 設定の保存に失敗しました:', e);
    }
}

export async function onInstall() {
    console.log('[Chat Window On/Off] onInstall フックが呼び出されました。初回セットアップを行います。');
    try {
        getSettings();
    } catch (e) {
        console.error('[Chat Window On/Off] onInstall中の初期化に失敗しました:', e);
    }
    if (typeof toastr !== 'undefined') {
        toastr.success('Chat Window On/Off 拡張機能がインストールされました。');
    }
}

// ============================================================
// CSS ファイル依存を回避するための <style> 注入
//   ※ #send_form の透過は Tパネル側のスライダーが担当するため、
//      ここでは扱わない。
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
    `;
    document.head.appendChild(style);
    console.log('[Chat Window On/Off] 追加スタイルを注入しました');
}

// ============================================================
// Text_styling パネルの開閉を監視
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

        const mo = new MutationObserver(() => {
            syncTspOpenClass();
        });
        mo.observe(panel, {
            attributes: true,
            attributeFilter: ['class', 'style'],
        });
    };

    const bodyMo = new MutationObserver(() => {
        observePanel();
        syncTspOpenClass();
    });
    bodyMo.observe(document.body, { childList: true, subtree: false });

    observePanel();
    setInterval(() => {
        observePanel();
        syncTspOpenClass();
    }, 300);

    syncTspOpenClass();
    console.log('[Chat Window On/Off] 🎨 Tパネル監視を開始しました');
}

function initChatWindowToggle() {
    console.log('チャットウィンドウ透過切り替え拡張機能: 初期化開始');

    if (document.getElementById('toggle-chat-button')) {
        return;
    }

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

/**
 * #chatを画面に固定する
 */
function applyChatLayout() {
    const chat = document.getElementById('chat');
    const sheld = document.getElementById('sheld');
    const form = document.getElementById('form_sheld');
    if (!chat || !sheld) return;

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

function applyToggleChatButtonLayout() {
    const btn = document.getElementById('toggle-chat-button');
    if (!btn) return;

    const anchor =
        document.getElementById('send_form') ||
        document.getElementById('form_sheld') ||
        document.getElementById('send_textarea');

    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const gap = 0;
    const btnW = btn.offsetWidth || 50;   // ★ 49 → 50
    const btnH = btn.offsetHeight || 50;  // ★ 49 → 50

    let left = rect.left - btnW - gap;
    let top = rect.top + (rect.height - btnH) / 2;

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
        const ro = new ResizeObserver(() => {
            applyToggleChatButtonLayout();
        });
        ro.observe(sendFormEl);
    }
} catch (e) { /* ignore */ }

function setupChatPaddingClickThrough() {
    const chat = document.getElementById('chat');
    if (!chat) {
        console.log('[Chat Window On/Off] #chat が見つかりません');
        return;
    }

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
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: e.clientX,
                clientY: e.clientY,
                button: e.button,
                buttons: e.buttons,
            });
            below.dispatchEvent(forwarded);
        }
    }, true);

    console.log('[Chat Window On/Off] パディング領域のクリック透過を設定しました');
}

setupChatPaddingClickThrough();

// ============================================================
// 統合 hover 判定
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

    function update(x, y) {
        if (document.body.classList.contains('tsp-open')) {
            if (isInZone) {
                isInZone = false;
                document.body.classList.remove('lbe-aux-hover');
            }
            return;
        }

        const r = getAuxButtonsRect();
        if (!r) {
            if (isInZone) {
                isInZone = false;
                document.body.classList.remove('lbe-aux-hover');
            }
            return;
        }

        const inside =
            x >= r.left - AUX_HOVER_MARGIN &&
            x <= r.right + AUX_HOVER_MARGIN &&
            y >= r.top - AUX_HOVER_MARGIN &&
            y <= r.bottom + AUX_HOVER_MARGIN;

        if (inside === isInZone) return;
        isInZone = inside;
        document.body.classList.toggle('lbe-aux-hover', inside);
    }

    document.addEventListener('mousemove', (e) => {
        update(e.clientX, e.clientY);
    }, { passive: true });

    document.addEventListener('mouseleave', () => {
        update(-1, -1);
    });
    window.addEventListener('blur', () => {
        update(-1, -1);
    });

    setInterval(() => {
        if (document.body.classList.contains('tsp-open') && isInZone) {
            isInZone = false;
            document.body.classList.remove('lbe-aux-hover');
        }
    }, 200);

    console.log(`[Chat Window On/Off] 🎯 統合 hover 判定を開始しました (💡 + 🎨, margin=${AUX_HOVER_MARGIN}px)`);
}

setupAuxButtonHover();

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
        if (style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity) !== 0) {
            const rect = primary.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                result = true;
            }
        }
    }

    if (!result) {
        const candidates = document.querySelectorAll([
            '#gallery_container',
            '.gallery-container',
            '.gallery_container',
            '.gallery',
            '[data-gallery-container]',
            '.gallery-grid',
            '#gallery-grid',
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

let lastGalleryStateForButtons = null;

function syncButtonsVisibilityForGallery() {
    const galleryOpen = isGalleryOpen();
    if (galleryOpen === lastGalleryStateForButtons) return;
    lastGalleryStateForButtons = galleryOpen;

    const selector = GALLERY_HIDDEN_SELECTORS.join(',');
    const targets = document.querySelectorAll(selector);

    targets.forEach(el => {
        if (galleryOpen) {
            el.style.setProperty('display', 'none', 'important');
        } else {
            el.style.removeProperty('display');
        }
    });

    if (galleryOpen) {
        console.log(`[Chat Window On/Off] 📷 ギャラリー表示中 → ${targets.length} 個の対象要素を非表示`);
    } else {
        console.log(`[Chat Window On/Off] 📷 ギャラリー非表示 → ${targets.length} 個の対象要素を再表示`);
    }
}

function setupGalleryButtonObserver() {
    setInterval(syncButtonsVisibilityForGallery, 300);
    syncButtonsVisibilityForGallery();
    console.log('[Chat Window On/Off] 📷 ギャラリー連動監視を開始しました（ポーリング方式）');
}

setupGalleryButtonObserver();

// ============================================================
// 左下のボタン起動領域
// ============================================================

function setupButtonWakeZone() {
    const WAKE_W = BUTTON_WAKE_WIDTH;
    const WAKE_H = BUTTON_WAKE_HEIGHT;
    let isInZone = false;

    function isInside(x, y) {
        return x >= 0 && x <= WAKE_W &&
               y >= window.innerHeight - WAKE_H && y <= window.innerHeight;
    }

    function update(x, y) {
        const inside = isInside(x, y);
        if (inside === isInZone) return;
        isInZone = inside;
        document.body.classList.toggle('gic-buttons-wake', inside);
    }

    document.addEventListener('mousemove', (e) => {
        update(e.clientX, e.clientY);
    }, { passive: true });

    document.addEventListener('mouseleave', () => {
        update(-1, -1);
    });
    window.addEventListener('blur', () => {
        update(-1, -1);
    });

    document.body.classList.remove('gic-buttons-wake');
    console.log(`[Chat Window On/Off] 🖱 ボタン起動領域を設定: ${WAKE_W}px × ${WAKE_H}px (左下)`);
}

setupButtonWakeZone();
