// chat_window_onoff.js
// このファイルは SillyTavern の公式拡張機能ローダー（動的 import）経由で読み込まれる前提。
// classic <script> タグでの直接読み込みは行わないこと（export構文が構文エラーになるため）。
//
// ★ 解像度スケーリング対応 (cssvar モード):
//   1920×962 基準で設計。他の解像度では --exp-scale / window.S() で比例スケール。
//   - 💡 ボタン位置: left = vw * 250/1920, top = vh - S(91)
//   - T/中央: 💡 の真下・左 getWcbLeftOffsetPx()
//   - 全 GAP / サイズ fallback は window.S() 経由

const MODULE_NAME = 'chat_window_onoff';
const OLD_STORAGE_KEY = 'chatWindowHiddenState';

// ============================================================
// ★ 設定準備完了フラグ（Settings not ready 対策）
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

// ============================================================
// ★ レイアウト定数（解像度スケーリング用）
// ============================================================
// 💡 の固定位置: 1920px 幅で left=250px
const TOGGLE_LEFT_BASE = 250;
const TOGGLE_LEFT_BASE_VW = 1920;
// 💡 の下端からの固定余白: 1920×962 で top = vh - 91
// （4K では vh - S(91) にスケール）
const TOGGLE_BOTTOM_OFFSET_BASE = 91;

// 削除/解除ボタンの概算幅（padding 0 S(8)px + "削除"/"解除" の文字幅）
const WCB_BTN_WIDTH_ESTIMATE = 48;
const WCB_GAP = 5;

function getWcbLeftOffsetPx() {
    const base = WCB_BTN_WIDTH_ESTIMATE + WCB_GAP;   // 53
    return window.S ? window.S(base) : base;
}

// 💡 ボタン位置のキャッシュ（無駄な style 操作を避ける）
let _lastToggleBtnLeft = -1;
let _lastToggleBtnTop  = -1;

// ============================================================
// 設定
// ============================================================
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
// ★ 💡 ボタン位置: 固定座標（チャットウィンドウ位置に非依存）
//
//   - left: vw * 250 / 1920  (1920px 幅で 250px)
//   - top : vh - S(91)       (962 高で 871px)
//
//   S() = window.S (resolution_scale.js)。未ロード時は恒等関数。
//   left を比率化、top を S(91) でスケールすることで
//   1920 / 2560 / 3840 どの解像度でも比率通りの位置になる。
// ============================================================
function applyToggleChatButtonLayout() {
    const btn = document.getElementById('toggle-chat-button');
    if (!btn) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 4;

    const S = window.S || ((px) => px);

    // left: 1920px 幅で 250px になる比率
    let left = Math.round(vw * TOGGLE_LEFT_BASE / TOGGLE_LEFT_BASE_VW);
    // top: 下端から S(91)px 上
    let top  = Math.round(vh - S(TOGGLE_BOTTOM_OFFSET_BASE));

    const btnW = btn.offsetWidth || S(50);
    const btnH = btn.offsetHeight || S(50);
    if (left < margin) left = margin;
    if (left + btnW > vw - margin) left = vw - margin - btnW;
    if (top < margin) top = margin;
    if (top + btnH > vh - margin) top = vh - margin - btnH;

    // 位置が変わらなければ style 再設定をスキップ（無駄な再レイアウトを抑止）
    if (left === _lastToggleBtnLeft && top === _lastToggleBtnTop) {
        window.__cwToggleLastLeft = left;
        window.__cwToggleLastTop  = top;
        return;
    }
    _lastToggleBtnLeft = left;
    _lastToggleBtnTop  = top;

    btn.style.setProperty('position', 'fixed', 'important');
    btn.style.setProperty('left', left + 'px', 'important');
    btn.style.setProperty('top', top + 'px', 'important');
    btn.style.setProperty('right', 'auto', 'important');
    btn.style.setProperty('bottom', 'auto', 'important');
    btn.style.setProperty('transform', 'none', 'important');

    // グローバル位置キャッシュ（gic.js の positionGalleryButton が参照）
    window.__cwToggleLastLeft = left;
    window.__cwToggleLastTop  = top;
}

// ============================================================
// ★ T（#restore-panel-button）と 中央（#window-control-buttons）の配置
//   - T   = 💡 の真下・左 getWcbLeftOffsetPx()
//   - 中央 = T の右隣・T の縦センター
//   - GAP / 各サイズ fallback は window.S() でスケール
// ============================================================
let _wcbLayoutApplied = false;

function applyWindowControlButtonsLayout() {
    const toggleBtn  = document.getElementById('toggle-chat-button');
    const wcb        = document.getElementById('window-control-buttons');
    const restoreBtn = document.getElementById('restore-panel-button');
    const centerBtn  = document.getElementById('center-button');

    if (!toggleBtn || !wcb || !restoreBtn || !centerBtn) return;

    const clearInline = () => {
        ['left', 'top', 'right', 'bottom', 'transform'].forEach(p => {
            wcb.style.removeProperty(p);
            restoreBtn.style.removeProperty(p);
        });
    };

    // ── toggle が display:none / visibility:hidden の間は触らない ──
    const toggleCs = window.getComputedStyle(toggleBtn);
    const toggleHidden =
        toggleCs.display === 'none' ||
        toggleCs.visibility === 'hidden' ||
        toggleBtn.offsetWidth === 0 ||
        toggleBtn.offsetHeight === 0;

    if (toggleHidden) {
        if (!_wcbLayoutApplied) clearInline();
        return;
    }

    const toggleRect = toggleBtn.getBoundingClientRect();
    if (toggleRect.width <= 0 || toggleRect.height <= 0 ||
        toggleRect.left < 0 || toggleRect.top < 0) {
        if (!_wcbLayoutApplied) clearInline();
        return;
    }

    const S = window.S || ((px) => px);
    const GAP = S(5);
    const margin = 4;
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    const restoreW = restoreBtn.offsetWidth || S(32);
    const restoreH = restoreBtn.offsetHeight || S(32);

    // ── T の X: 💡 の左端から getWcbLeftOffsetPx() 左へ ──
    let restoreLeft = toggleRect.left - getWcbLeftOffsetPx();
    if (restoreLeft < margin) restoreLeft = margin;

    // ── T の Y: 💡 の真下（GAP もスケール済み） ──
    let restoreTop = toggleRect.top + toggleRect.height + GAP;
    if (restoreTop + restoreH > vh - margin) restoreTop = vh - margin - restoreH;
    if (restoreTop < margin) restoreTop = margin;

    restoreBtn.style.setProperty('position', 'fixed', 'important');
    restoreBtn.style.setProperty('left', Math.round(restoreLeft) + 'px', 'important');
    restoreBtn.style.setProperty('top', Math.round(restoreTop) + 'px', 'important');
    restoreBtn.style.setProperty('right', 'auto', 'important');
    restoreBtn.style.setProperty('bottom', 'auto', 'important');
    restoreBtn.style.setProperty('transform', 'none', 'important');

    // ── 中央ボタン: T の右隣・T の縦センター ──
    const wcbW = wcb.offsetWidth || centerBtn.offsetWidth || S(50);
    const wcbH = wcb.offsetHeight || centerBtn.offsetHeight || S(28);
    let wcbLeft = restoreLeft + restoreW + GAP;
    let wcbTop  = restoreTop + (restoreH - wcbH) / 2;

    if (wcbLeft + wcbW > vw - margin) wcbLeft = vw - margin - wcbW;
    if (wcbLeft < margin) wcbLeft = margin;
    if (wcbTop < margin) wcbTop = margin;
    if (wcbTop + wcbH > vh - margin) wcbTop = vh - margin - wcbH;

    wcb.style.setProperty('position', 'fixed', 'important');
    wcb.style.setProperty('left', Math.round(wcbLeft) + 'px', 'important');
    wcb.style.setProperty('top', Math.round(wcbTop) + 'px', 'important');
    wcb.style.setProperty('right', 'auto', 'important');
    wcb.style.setProperty('bottom', 'auto', 'important');
    wcb.style.setProperty('transform', 'none', 'important');

    // ★ 一度でも成功したら以降は removeProperty を呼ばない
    _wcbLayoutApplied = true;
}

// ============================================================
// ★ body のクラス変化で T/中央 を再同期（保険）
// ============================================================
(function installWcbClassSync() {
    if (window.__wcbClassSyncInstalled) return;
    window.__wcbClassSyncInstalled = true;

    let raf = null;
    const sync = () => {
        raf = null;
        try { applyWindowControlButtonsLayout(); } catch (e) { /* ignore */ }
    };

    const observer = new MutationObserver(() => {
        if (raf !== null) return;
        raf = requestAnimationFrame(sync);
    });
    observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class'],
    });
})();

setInterval(() => {
    applyChatLayout();
    applyToggleChatButtonLayout();
    applyWindowControlButtonsLayout();
}, 500);

window.addEventListener('resize', () => {
    // 位置キャッシュを無効化して比率計算を強制再実行
    _lastToggleBtnLeft = -1;
    _lastToggleBtnTop  = -1;
    applyChatLayout();
    applyToggleChatButtonLayout();
    applyWindowControlButtonsLayout();
});

setTimeout(() => {
    applyChatLayout();
    applyToggleChatButtonLayout();
    applyWindowControlButtonsLayout();
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
// ★ 統合ホバーゾーン: 全ボタンを内包する矩形領域内にマウスが入ると
//   全ボタンを同時に表示する。
//   後方互換のため chat-bulb-hover / gic-buttons-wake も同時に付与する。
//
//   ★ 右側のみ MARGIN を加算しない
//     （🎨/💡 の右端より右にはホバー範囲を広げない）
// ============================================================
function setupAllButtonsHover() {
    const MARGIN = 30;
    const RIGHT_MARGIN = 0;   // ★ 右側のみ余白なし

    let isInZone = false;
    let lastX = -1, lastY = -1;

    function computeZone() {
        const ids = [
            'toggle-chat-button',
            'gic-open-gallery-button',
            'gic-unregister-button',
            'gic-delete-image-button',
            'restore-panel-button',
            'window-control-buttons',
            'center-button',
        ];
        let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
        let found = false;
        for (const id of ids) {
            const el = document.getElementById(id);
            if (!el) continue;
            const cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            if (r.left   < minL) minL = r.left;
            if (r.top    < minT) minT = r.top;
            if (r.right  > maxR) maxR = r.right;
            if (r.bottom > maxB) maxB = r.bottom;
            found = true;
        }
        return found ? { left: minL, top: minT, right: maxR, bottom: maxB } : null;
    }

    function clearAll() {
        if (!isInZone) return;
        isInZone = false;
        document.body.classList.remove('gic-all-buttons-visible');
        document.body.classList.remove('chat-bulb-hover');
        document.body.classList.remove('gic-buttons-wake');
    }

    function update(x, y) {
        if (x < 0 || y < 0) { clearAll(); return; }

        // フルスクリーン系オーバーレイ中は抑止
        if (document.body.classList.contains('gallery-open') ||
            document.body.classList.contains('stj-editor-open') ||
            document.body.classList.contains('variable-battle-active')) {
            clearAll();
            return;
        }

        const zone = computeZone();
        if (!zone) return;

        // ★ 右側のみ RIGHT_MARGIN (= 0)
        const inside =
            x >= zone.left   - MARGIN &&
            x <= zone.right  + RIGHT_MARGIN &&
            y >= zone.top    - MARGIN &&
            y <= zone.bottom + MARGIN;

        if (inside === isInZone) return;
        isInZone = inside;
        document.body.classList.toggle('gic-all-buttons-visible', inside);
        document.body.classList.toggle('chat-bulb-hover', inside);
        document.body.classList.toggle('gic-buttons-wake', inside);
    }

    document.addEventListener('mousemove', (e) => {
        lastX = e.clientX; lastY = e.clientY;
        update(lastX, lastY);
    }, { passive: true });

    document.addEventListener('mouseleave', () => {
        lastX = -1; lastY = -1; update(-1, -1);
    });

    window.addEventListener('blur', () => {
        lastX = -1; lastY = -1; update(-1, -1);
    });

    // ボタン移動・再生成に追従
    setInterval(() => { if (lastX >= 0) update(lastX, lastY); }, 150);

    console.log('[Chat Window On/Off] 🔍 統合ホバーゾーンを開始しました (margin=30px, right=0)');
}

setupAllButtonsHover();

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
