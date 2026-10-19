// ★ 最初に comfy_boot.js を読み込む（fetch インターセプタを最速で設置）
import './comfy_boot.js';
import './gic_lorebook.js';
import { eventSource, event_types, saveChat, printMessages, getRequestHeaders } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';

console.log('[GIC] モジュールロード開始');

// ===== 定数 =====
const MODULE_NAME      = 'generate_image_controller';
const BUTTON_ID        = 'gic-release-override-button';
const GALLERY_BUTTON_ID = 'gic-open-gallery-button';
const LABEL_OVERRIDE   = '背景生成';
const LABEL_NORMAL     = '事前設定';
const HIDE_CLASS       = 'gic-hidden-by-text-styling';
const HIDDEN_MES_CLASS = 'gic-hidden-message';

const COMFY_CACHE_KEY = 'gic_comfyUnavailable';

const COMFYUI_PROBE_URL_CANDIDATES = [
    'http://127.0.0.1:8188',
    'http://localhost:8188',
];
const COMFYUI_PROBE_TIMEOUT_MS = 3000;

const GALLERY_WINDOW_SELECTORS = ['#gallery'];

const GALLERY_PREVIEW_SELECTORS = [
    '.galleryImageDraggable',
    '#gallery .galleryImageDraggable',
];

const GALLERY_PREVIEW_MARGIN_X = 0;
const GALLERY_PREVIEW_MARGIN_Y = 0;
const GALLERY_PREVIEW_SCALE_MULTIPLIER = 1.0;
const GALLERY_PREVIEW_MAX_WIDTH = 1440;
const GALLERY_PREVIEW_CLOSE_SCALE = 2.5;
const GALLERY_WINDOW_CLOSE_SCALE = 2.5;
const GALLERY_WINDOW_HEIGHT_DELTA = 600;
const GALLERY_WINDOW_MAX_VIEWPORT_MARGIN = 20;
const GALLERY_PAGINATION_HEIGHT = 40;
const PAGINATION_PAGE_SIZE = 10;
const PAGINATION_MAX_VISIBLE = 10;
const PAGINATION_OFFSET_LEFT = 15;
const PAGINATION_OFFSET_UP = 20;
const GALLERY_WARMUP_DELAY_MS = 2000;
const GALLERY_WARMUP_RENDER_WAIT_MS = 1000;
const GALLERY_WARMUP_PRELOAD_TIMEOUT_MS = 20000;
const GALLERY_WARMUP_HOLD_MS = 3000;
const PAGINATION_STABLE_DELAY_MS = 600;
const GALLERY_PREPARE_RETRY_INTERVAL_MS = 800;
const GALLERY_PREPARE_MAX_RETRIES = 15;

// ===== 状態 =====
let lastGeneratedImageUrl = null;
let isOverrideLocal = false;
const processedMessageKeys = new Set();

let currentPreviewEl = null;
let isApplyingLayout = false;

const galleryBaseHeightCache = new WeakMap();

let _galleryOpenCache = { value: false, timestamp: 0 };
const GALLERY_OPEN_CACHE_TTL = 100;

let _paginationSnapshot = { count: -1, since: 0, stable: false };
let _paginationWindowStart = 0;
let _paginationWindowManual = false;
let _galleryTotalPagesCache = 0;
let _lastPagerSignature = '';

let _galleryOpenInFlight = false;
let _galleryOpenInFlightSetAt = 0;
const GALLERY_OPEN_IN_FLIGHT_MS = 8000;

function markGalleryOpenInFlight() {
    _galleryOpenInFlight = true;
    _galleryOpenInFlightSetAt = Date.now();
}

function clearGalleryOpenInFlight() {
    _galleryOpenInFlight = false;
    _galleryOpenInFlightSetAt = 0;
}

function isGalleryOpenInFlight() {
    if (!_galleryOpenInFlight) return false;
    if (Date.now() - _galleryOpenInFlightSetAt > GALLERY_OPEN_IN_FLIGHT_MS) {
        clearGalleryOpenInFlight();
        return false;
    }
    return true;
}

let warmupState = 'idle';

// ===== 一括削除機能の状態 =====
let _bulkDeleteMode = false;
const _bulkDeleteSelected = new Map();
let _bulkDeleteHeaderObserver = null;
let _lastTrashToggleAt = 0;
const TRASH_TOGGLE_DEBOUNCE_MS = 1500;

let _sdSourceChecked = false;

// ===== ユーティリティ =====
function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function checkImageExists(url) {
    if (!url || typeof url !== 'string' || !url.trim()) {
        return Promise.resolve(false);
    }
    const cleanUrl = url.trim();

    return new Promise((resolve) => {
        if (cleanUrl.match(/\.(mp4|webm)$/i)) {
            const v = document.createElement('video');
            v.preload = 'metadata';
            v.onloadedmetadata = () => resolve(true);
            v.onerror = () => resolve(false);
            v.src = cleanUrl;
        } else {
            const img = new Image();
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            img.src = cleanUrl;
        }
    });
}

async function checkComfyUIAvailable() {
    const originalFetch = window.__gicOriginalFetch || window.fetch;
    for (const baseUrl of COMFYUI_PROBE_URL_CANDIDATES) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), COMFYUI_PROBE_TIMEOUT_MS);
            const resp = await originalFetch.call(window, `${baseUrl}/system_stats`, {
                method: 'GET',
                signal: controller.signal,
                mode: 'cors',
                cache: 'no-store',
            });
            clearTimeout(timeoutId);
            if (resp.ok) return true;
        } catch (e) {
            console.debug(`[GIC] ComfyUI probe ${baseUrl} → 例外: ${e.message || e}`);
        }
    }
    return false;
}

async function ensureSdSourceConsistency() {
    if (_sdSourceChecked) return;
    _sdSourceChecked = true;

    try {
        const ctx = getContext();
        const sdSettings = ctx?.extensionSettings?.sd;
        if (!sdSettings) {
            console.debug('[GIC] SD設定が見つかりません（SD拡張無効の可能性）');
            return;
        }

        const currentSource = sdSettings.source;
        if (currentSource !== 'comfy') {
            console.debug(`[GIC] SDソースは "${currentSource}" のため調整不要`);
            localStorage.setItem(COMFY_CACHE_KEY, 'false');
            return;
        }

        const comfyAvailable = await checkComfyUIAvailable();

        if (comfyAvailable) {
            console.info('[GIC] ComfyUI 接続確認 OK → SDソースは "comfy" のまま維持');
            localStorage.setItem(COMFY_CACHE_KEY, 'false');
            return;
        }

        console.warn('[GIC] ComfyUI 未検出 → SDソースを "none" に切り替えます');
        localStorage.setItem(COMFY_CACHE_KEY, 'true');

        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                sdSettings.source = 'none';
                if (typeof ctx.saveSettingsDebounced === 'function') {
                    ctx.saveSettingsDebounced();
                }
                try {
                    const scriptMod = await import('../../../../../script.js');
                    if (typeof scriptMod.saveSettings === 'function') {
                        scriptMod.saveSettings();
                    }
                } catch (e) { /* ignore */ }
            } catch (e) {
                console.warn(`[GIC] sd.source 保存試行 ${attempt} でエラー:`, e);
            }
            await wait(400);
            if (sdSettings.source === 'none') {
                console.info(`[GIC] ✅ sd.source を "none" に確定 (試行 ${attempt}回目)`);
                return;
            }
        }
        console.warn('[GIC] sd.source を "none" に設定できませんでした。次回ロード時に再試行します');
    } catch (e) {
        console.warn('[GIC] SDソース自動調整に失敗:', e);
    }
}

function loadPersistedState() {
    try {
        const ctx = getContext();
        const st = ctx?.extensionSettings?.[MODULE_NAME];
        if (!st) return;
        if (typeof st.isOverrideLocal === 'boolean') isOverrideLocal = st.isOverrideLocal;
        if (typeof st.lastGeneratedImageUrl === 'string') lastGeneratedImageUrl = st.lastGeneratedImageUrl;
        console.log(`[GIC] 永続状態を復元: isOverrideLocal=${isOverrideLocal}, lastUrl=${lastGeneratedImageUrl}`);
    } catch (e) {
        console.warn('[GIC] 永続状態の読込に失敗:', e);
    }
}

function savePersistedState() {
    try {
        const ctx = getContext();
        if (!ctx) return;
        if (!ctx.extensionSettings[MODULE_NAME]) ctx.extensionSettings[MODULE_NAME] = {};
        ctx.extensionSettings[MODULE_NAME].isOverrideLocal = isOverrideLocal;
        ctx.extensionSettings[MODULE_NAME].lastGeneratedImageUrl = lastGeneratedImageUrl;
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    } catch (e) {
        console.warn('[GIC] 永続状態の保存に失敗:', e);
    }
}

async function validatePersistedState() {
    if (!isOverrideLocal) {
        console.log('[GIC] override状態は未アクティブ（検証スキップ）');
        return;
    }

    if (!lastGeneratedImageUrl) {
        console.log('[GIC] override状態（URL未指定）を確認しました');
        return;
    }

    const exists = await checkImageExists(lastGeneratedImageUrl);
    if (!exists) {
        console.warn(`[GIC] 永続化された画像URLが存在しません。状態をリセットします: ${lastGeneratedImageUrl}`);
        lastGeneratedImageUrl = null;
        isOverrideLocal = false;
        setButtonLabel(LABEL_NORMAL);

        if (window.ImageDisplayExtension?.clearOverrideImage) {
            try {
                window.ImageDisplayExtension.clearOverrideImage();
                console.log('[GIC] Image Display の override も解除しました');
            } catch (e) {
                console.warn('[GIC] Image Display の override 解除に失敗:', e);
            }
        }

        savePersistedState();
    } else {
        console.log(`[GIC] 永続化された画像URLの存在を確認: ${lastGeneratedImageUrl}`);
    }
}

function getCurrentCharacterName() {
    try {
        const ctx = getContext();

        if (ctx?.character?.name) {
            return ctx.character.name;
        }

        if (ctx?.characters
            && ctx?.characterId !== undefined
            && ctx?.characterId !== null) {
            const c = ctx.characters[ctx.characterId];
            if (c?.name) return c.name;
        }
    } catch (e) { /* ignore */ }

    return null;
}

// ===== スタイル注入 =====
(function injectGicStyle() {
    if (document.getElementById('gic-injected-style')) return;
    const style = document.createElement('style');
    style.id = 'gic-injected-style';
    style.textContent = `
        #${BUTTON_ID}.${HIDE_CLASS} {
            display: none !important;
        }
    `;
    document.head.appendChild(style);
})();

// ============================================================
// ★ ギャラリー拡大プレビューを JSON編集画面(10001) より手前に表示
//   ＋ ドラッグ中のチラつき・クリック誤発動抑制
// ============================================================
(function injectGalleryLayoutStyle() {
    if (document.getElementById('gic-gallery-layout-style')) return;
    const style = document.createElement('style');
    style.id = 'gic-gallery-layout-style';

    const panelSel      = GALLERY_PREVIEW_SELECTORS.join(', ');
    const closeSel      = GALLERY_PREVIEW_SELECTORS.map(s => `${s} .dragClose`).join(', ');
    const closeHoverSel = GALLERY_PREVIEW_SELECTORS.map(s => `${s}:hover .dragClose`).join(', ');

    style.textContent = `
        ${panelSel} {
            position: fixed !important;
            top: 50% !important;
            left: 0 !important;
            right: auto !important;
            bottom: auto !important;
            transform: translateY(-50%) !important;
            transform-origin: left center !important;
            margin: 0 !important;
            visibility: hidden !important;
            z-index: 15000 !important;
        }

        ${closeSel} {
            position: fixed !important;
            left: 0 !important;
            top: 50% !important;
            transform: translateY(-50%) scale(${GALLERY_PREVIEW_CLOSE_SCALE}) !important;
            transform-origin: left center !important;
            display: inline-block !important;
            opacity: 0 !important;
            pointer-events: none !important;
            transition: opacity 0.15s ease !important;
            z-index: 15001 !important;
            margin: 0 !important;
        }

        ${closeHoverSel} {
            opacity: 1 !important;
            pointer-events: auto !important;
        }

        #gallery,
        #gallery *,
        .gic-pagination-pager,
        .gic-pagination-pager * {
            user-select: none !important;
            -webkit-user-select: none !important;
            -moz-user-select: none !important;
            -ms-user-select: none !important;
        }

        .nGY2GalleryBottom {
            display: flex !important;
            align-items: center !important;
            justify-content: flex-start !important;
            gap: 6px !important;
            width: 100% !important;
            max-width: 100% !important;
            margin-left: 0 !important;
            margin-right: auto !important;
            text-align: left !important;
        }

        .nGY2Gallery {
            text-align: left !important;
        }

        .nGY2paginationNext,
        .nGY2paginationPrev,
        [class*="paginationNext"],
        [class*="paginationPrev"],
        [class*="PaginationNext"],
        [class*="PaginationPrev"],
        [data-nanogallery2-pagination-next],
        [data-nanogallery2-pagination-prev] {
            display: none !important;
            visibility: hidden !important;
            pointer-events: none !important;
            width: 0 !important;
            height: 0 !important;
            overflow: hidden !important;
        }

        .nGY2paginationRectangle,
        .nGY2paginationRectangleCurrentPage {
            height: ${GALLERY_PAGINATION_HEIGHT}px !important;
            min-height: ${GALLERY_PAGINATION_HEIGHT}px !important;
            max-height: ${GALLERY_PAGINATION_HEIGHT}px !important;
            position: relative !important;
            background-color: transparent !important;
            background-image: none !important;
            border: none !important;
            border-color: transparent !important;
            outline: none !important;
            box-shadow: none !important;
        }
        .nGY2paginationRectangleCurrentPage::before,
        .nGY2paginationRectangleCurrentPage::after {
            display: none !important;
            content: none !important;
        }

        .gic-page-number {
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            font-weight: bold !important;
            font-size: 16px !important;
            color: #000000 !important;
            -webkit-text-stroke: 3px #ffffff !important;
            paint-order: stroke fill !important;
            pointer-events: none !important;
            z-index: 10 !important;
            line-height: 1 !important;
            user-select: none !important;
            font-family: sans-serif !important;
        }

        .nGY2paginationRectangle.gic-hidden-by-pager,
        .nGY2paginationRectangleCurrentPage.gic-hidden-by-pager {
            position: absolute !important;
            left: -9999px !important;
            top: -9999px !important;
            width: 1px !important;
            height: 1px !important;
            min-width: 1px !important;
            max-width: 1px !important;
            min-height: 1px !important;
            max-height: 1px !important;
            padding: 0 !important;
            margin: 0 !important;
            overflow: hidden !important;
            pointer-events: none !important;
            opacity: 0 !important;
            flex: 0 0 auto !important;
        }

        .gic-pagination-pager {
            position: fixed !important;
            display: flex !important;
            align-items: center !important;
            gap: 4px !important;
            z-index: 2147483647 !important;
            pointer-events: auto !important;
        }

        .gic-pagination-pager .gic-pagination-page,
        .gic-pagination-pager .gic-pagination-nav {
            width: 29px !important;
            min-width: 29px !important;
            max-width: 29px !important;
            height: 45px !important;
            min-height: 45px !important;
            max-height: 45px !important;
            padding: 0 !important;
            font-size: 14px !important;
            font-weight: bold !important;
            font-family: sans-serif !important;
            color: #000000 !important;
            background-color: rgba(255, 255, 255, 0.6) !important;
            border: 1px solid rgba(0, 0, 0, 0.3) !important;
            border-radius: 4px !important;
            cursor: pointer !important;
            user-select: none !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            line-height: 1 !important;
            box-sizing: border-box !important;
            margin: 0 !important;
            pointer-events: auto !important;
        }
        .gic-pagination-pager .gic-pagination-page:hover,
        .gic-pagination-pager .gic-pagination-nav:hover {
            background-color: rgba(255, 255, 255, 0.95) !important;
        }
        .gic-pagination-pager .gic-pagination-current {
            background-color: #0a84ff !important;
            color: #ffffff !important;
        }

        .gic-pagination-pager .gic-pagination-page.gic-pagination-disabled,
        .gic-pagination-pager .gic-pagination-nav.gic-pagination-disabled {
            opacity: 0.3 !important;
            cursor: not-allowed !important;
            pointer-events: none !important;
        }
        .gic-pagination-pager .gic-pagination-page.gic-pagination-disabled:hover,
        .gic-pagination-pager .gic-pagination-nav.gic-pagination-disabled:hover {
            background-color: rgba(255, 255, 255, 0.6) !important;
        }

        .nGY2GalleryTop,
        .nGY2GalleryHeader {
            display: none !important;
        }

        .gic-bulk-selected {
            outline: 10px solid #ff3b30 !important;
            outline-offset: -10px !important;
            box-shadow:
                0 0 24px rgba(255, 59, 48, 1),
                inset 0 0 24px rgba(255, 59, 48, 0.75) !important;
            opacity: 0.9 !important;
        }

        .gic-bulk-selected::after {
            content: '' !important;
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            width: 100% !important;
            height: 100% !important;
            background-color: rgba(255, 59, 48, 0.45) !important;
            pointer-events: none !important;
            z-index: 5 !important;
            display: block !important;
            box-sizing: border-box !important;
        }

        .gallery-folder-input.gic-bulk-shortened-input {
            flex: 0 1 290px !important;
            max-width: 290px !important;
            min-width: 180px !important;
        }

        .gic-bulk-delete-button {
            flex: 0 0 auto !important;
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            height: 28px !important;
            padding: 0 8px !important;
            margin: 0 2px !important;
            font-size: 12px !important;
            font-weight: bold !important;
            color: #ffffff !important;
            background-color: #d9534f !important;
            border: 1px solid #b52b27 !important;
            border-radius: 4px !important;
            cursor: pointer !important;
            user-select: none !important;
            box-sizing: border-box !important;
            white-space: nowrap !important;
            opacity: 1 !important;
            pointer-events: auto !important;
            transition: background-color 0.15s ease, opacity 0.15s ease !important;
        }
        .gic-bulk-delete-button:hover {
            background-color: #c9302c !important;
        }

        .gic-bulk-delete-button.gic-bulk-delete-disabled {
            opacity: 0.3 !important;
            cursor: not-allowed !important;
            pointer-events: none !important;
            background-color: #d9534f !important;
        }

        body.gic-bulk-delete-mode #gallery {
            position: fixed !important;
            outline: 5px solid #ff3b30 !important;
            outline-offset: -5px !important;
            box-shadow: 0 0 24px rgba(255, 59, 48, 0.6) inset !important;
        }

        body.gic-bulk-delete-mode #gallery::before {
            content: var(--gic-bulk-banner-text, '🗑 削除モード中 — 画像をクリックして選択、再度クリックで解除');
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            padding: 6px 12px;
            background-color: #ff3b30;
            color: #ffffff;
            font-size: 13px;
            font-weight: bold;
            font-family: sans-serif;
            text-align: center;
            z-index: 2147483646;
            pointer-events: none;
            box-sizing: border-box;
        }

        body.gic-bulk-delete-mode .fa-trash,
        body.gic-bulk-delete-mode [class*="fa-trash"],
        body.gic-bulk-delete-mode [class*="trash"] {
            color: #ff3b30 !important;
            text-shadow: 0 0 6px rgba(255, 59, 48, 0.9) !important;
        }

        body.gic-bulk-delete-mode .nGY2GThumbnail,
        body.gic-bulk-delete-mode .nGY2GThumbnail_l1 {
            cursor: crosshair !important;
        }

        .gic-bulk-removing {
            animation: gicFadeOutShrink 0.25s ease forwards !important;
        }
        @keyframes gicFadeOutShrink {
            0%   { opacity: 1; transform: scale(1); }
            100% { opacity: 0; transform: scale(0.6); }
        }

        #gic-open-gallery-button.gic-gallery-loading {
            opacity: 0.2 !important;
            pointer-events: none !important;
            cursor: wait !important;
            filter: grayscale(0.8) !important;
        }
        #gic-open-gallery-button.gic-gallery-loading:hover {
            opacity: 0.2 !important;
            background-color: #444 !important;
        }

        /* ★ ドラッグ中のサムネイルの強調表示 */
        .gic-dragging-to-json {
            opacity: 0.5 !important;
            outline: 3px solid #ffd54f !important;
            outline-offset: -3px !important;
        }

        /* ★ ドラッグ中はギャラリー内のアニメーション・トランジションを停止 */
        body.gic-dragging #gallery,
        body.gic-dragging #gallery * {
            transition: none !important;
            animation: none !important;
        }

        /* ★ ドラッグ中はページャー・ページ番号を完全無効化（クリック防止） */
        body.gic-dragging .gic-pagination-pager,
        body.gic-dragging .gic-pagination-pager * {
            pointer-events: none !important;
            user-select: none !important;
        }

        /* ★ ドラッグ中は #gallery 全体を pointer-events: none に
              → nGY2 の内部 mousemove 反応を完全遮断 ＋ 下層の JSON セルへのヒットテストを透過 */
        body.gic-dragging #gallery,
        body.gic-dragging #gallery * {
            pointer-events: none !important;
        }
    `;
    document.head.appendChild(style);
    console.log('[GIC] 🖼️ ギャラリー配置CSSを注入しました');
})();

// ===== ユーティリティ =====

function isGeneratedImageMessage(message) {
    return Array.isArray(message?.extra?.media) &&
           message.extra.media.some(m => m.source === 'generated');
}

function extractImageUrl(message) {
    if (!Array.isArray(message?.extra?.media)) return null;
    const media = message.extra.media.find(m => m.source === 'generated');
    return media?.url || null;
}

function getMessageKey(message) {
    if (message?.send_date) return message.send_date;
    return `${message?.name || 'unknown'}_${(message?.mes || '').slice(0, 80)}`;
}

function setButtonLabel(label) {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    if (btn.textContent !== label) {
        btn.textContent = label;
        console.log(`[GIC] ラベル設定: ${label}`);
    }
}

// ===== DOMマーキング =====

function markGeneratedMessagesInDom() {
    const context = getContext();
    if (!context?.chat) return;
    for (let i = 0; i < context.chat.length; i++) {
        const msg = context.chat[i];
        if (!isGeneratedImageMessage(msg)) continue;
        const el = document.querySelector(`.mes[mesid="${i}"]`);
        if (el && !el.classList.contains(HIDDEN_MES_CLASS)) {
            el.classList.add(HIDDEN_MES_CLASS);
        }
    }
}

// ===== Text_stylingパネル開閉監視 =====

function isTextStylingPanelOpen() {
    const panel = document.getElementById('text-styling-panel');
    if (!panel) return false;
    if (panel.classList.contains('hidden')) return false;
    const cs = getComputedStyle(panel);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return true;
}

let lastTextStylingState = null;

function syncButtonVisibilityForTextStyling() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    const isOpen = isTextStylingPanelOpen();
    if (isOpen === lastTextStylingState) return;
    lastTextStylingState = isOpen;

    if (isOpen) {
        btn.classList.add(HIDE_CLASS);
        console.log('[GIC] 📝 Text_stylingパネル表示中 → GICボタンを非表示');
    } else {
        btn.classList.remove(HIDE_CLASS);
        console.log('[GIC] 📝 Text_stylingパネル閉じた → GICボタンを再表示');
    }
}

function setupTextStylingObserver() {
    setInterval(syncButtonVisibilityForTextStyling, 300);
    console.log('[GIC] 📝 Text_stylingパネル監視を開始しました（ポーリング方式）');
}

// ===== 生成画像のスキャン =====

async function scanForGeneratedImages() {
    const context = getContext();
    if (!context?.chat) return;

    let newest = null;
    let newestIdx = -1;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        if (isGeneratedImageMessage(context.chat[i])) {
            newest = context.chat[i];
            newestIdx = i;
            break;
        }
    }
    if (!newest) {
        markGeneratedMessagesInDom();
        return;
    }

    const url = extractImageUrl(newest);
    if (!url) {
        markGeneratedMessagesInDom();
        return;
    }

    const key = getMessageKey(newest);
    const alreadyProcessed = processedMessageKeys.has(key);

    lastGeneratedImageUrl = url;

    if (!alreadyProcessed) {
        processedMessageKeys.add(key);

        if (!newest.is_system) {
            newest.is_system = true;
            try {
                await saveChat();
                printMessages();
            } catch (e) {
                console.error('[GIC] saveChat/printMessages エラー:', e);
            }
        }

        if (window.ImageDisplayExtension?.setOverrideImage) {
            try {
                await window.ImageDisplayExtension.setOverrideImage(url);
                isOverrideLocal = true;
                setButtonLabel(LABEL_OVERRIDE);
                savePersistedState();
                console.log(`[GIC] 🖼️ 最新の生成画像を背景に設定: ${url}`);
            } catch (e) {
                console.error('[GIC] ImageDisplayExtension エラー:', e);
            }
        }
    } else {
        if (!isOverrideLocal) {
            const ideIsOverride = window.ImageDisplayExtension?.isOverride?.();
            if (ideIsOverride) {
                isOverrideLocal = true;
                setButtonLabel(LABEL_OVERRIDE);
                savePersistedState();
            } else if (newest.is_system) {
                if (window.ImageDisplayExtension?.setOverrideImage) {
                    try {
                        await window.ImageDisplayExtension.setOverrideImage(url);
                        isOverrideLocal = true;
                        setButtonLabel(LABEL_OVERRIDE);
                        savePersistedState();
                        console.log(`[GIC] 🔄 リロード後のoverride状態を復元: ${url}`);
                    } catch (e) {
                        console.error('[GIC] override復元エラー:', e);
                    }
                }
            }
        }
    }

    for (let i = 0; i < newestIdx; i++) {
        const msg = context.chat[i];
        if (isGeneratedImageMessage(msg)) {
            processedMessageKeys.add(getMessageKey(msg));
        }
    }

    markGeneratedMessagesInDom();
}

// ===== ボタンのアクション =====

async function handleButtonAction() {
    console.log(`[GIC] ボタンアクション: 現在=${isOverrideLocal ? '背景生成' : '事前設定'}, lastUrl=${lastGeneratedImageUrl}`);

    if (isOverrideLocal) {
        if (window.ImageDisplayExtension?.clearOverrideImage) {
            try {
                window.ImageDisplayExtension.clearOverrideImage();
                console.log('[GIC] clearOverrideImage() 成功（事前設定モードへ切替）');
            } catch (err) {
                console.error('[GIC] clearOverrideImage エラー:', err);
            }
        }
        isOverrideLocal = false;
        setButtonLabel(LABEL_NORMAL);
        savePersistedState();
        return;
    }

    const urlToUse = lastGeneratedImageUrl || '';

    if (urlToUse) {
        const exists = await checkImageExists(urlToUse);
        if (!exists) {
            console.warn(`[GIC] 保存された画像URLが存在しないため、override設定をスキップ: ${urlToUse}`);
            lastGeneratedImageUrl = null;
            isOverrideLocal = false;
            setButtonLabel(LABEL_NORMAL);
            savePersistedState();

            if (window.ImageDisplayExtension?.clearOverrideImage) {
                try {
                    window.ImageDisplayExtension.clearOverrideImage();
                } catch (e) { /* ignore */ }
            }
            return;
        }
    }

    if (window.ImageDisplayExtension?.setOverrideImage) {
        try {
            const result = await window.ImageDisplayExtension.setOverrideImage(urlToUse);

            if (result === false) {
                console.warn('[GIC] setOverrideImage が失敗を返しました。状態を事前設定のまま維持します');
                isOverrideLocal = false;
                setButtonLabel(LABEL_NORMAL);
                savePersistedState();
                return;
            }

            if (urlToUse) {
                console.log(`[GIC] setOverrideImage() 成功（背景生成モード）: ${urlToUse}`);
            } else {
                console.log('[GIC] setOverrideImage() 成功（背景生成モード・デフォルト画像）');
            }
        } catch (err) {
            console.error('[GIC] setOverrideImage エラー:', err);
            isOverrideLocal = false;
            setButtonLabel(LABEL_NORMAL);
            savePersistedState();
            return;
        }
    }

    isOverrideLocal = true;
    setButtonLabel(LABEL_OVERRIDE);
    savePersistedState();
}

function positionGalleryButton() {
    const galleryBtn = document.getElementById(GALLERY_BUTTON_ID);
    if (!galleryBtn) return;

    const gicBtn = document.getElementById('gic-release-override-button');
    if (gicBtn) {
        const gicRect = gicBtn.getBoundingClientRect();
        if (gicRect.width > 0 && gicRect.height > 0) {
            const gap = 5;
            const btnW = galleryBtn.offsetWidth || 50;
            const btnH = galleryBtn.offsetHeight || 50;

            let left = gicRect.left - 5;
            let top  = gicRect.top - btnH - gap;

            const margin = 4;
            const minLeft = -10;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            if (left < minLeft) left = minLeft;
            if (left + btnW > vw - margin) left = vw - margin - btnW;
            if (top < margin) top = margin;
            if (top + btnH > vh - margin) top = vh - margin - btnH;

            galleryBtn.style.setProperty('position', 'fixed', 'important');
            galleryBtn.style.setProperty('left', Math.round(left) + 'px', 'important');
            galleryBtn.style.setProperty('top', Math.round(top) + 'px', 'important');
            galleryBtn.style.setProperty('right', 'auto', 'important');
            galleryBtn.style.setProperty('bottom', 'auto', 'important');
            galleryBtn.style.setProperty('transform', 'none', 'important');

            positionStatusMessage();
            return;
        }
    }

    const gicBtn2 = document.getElementById(BUTTON_ID);
    if (!gicBtn2) return;
    const w = gicBtn2.offsetWidth;
    if (!w) return;
    galleryBtn.style.left = (w + 4) + 'px';

    positionStatusMessage();
}

// ===== 公式ギャラリーの開閉検知 =====

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

// ============================================================
// ★ #gallery 重複排除（コンテンツ持ち優先）
// ============================================================
function dedupeGalleryElements() {
    const galleries = Array.from(document.querySelectorAll('#gallery'));
    if (galleries.length <= 1) return galleries[0] || null;

    let keep = galleries.find(g => {
        if (g.querySelector('.nGY2Gallery')) return true;
        if (g.querySelectorAll('.nGY2GThumbnail, .nGY2GThumbnail_l1').length > 0) return true;
        return false;
    });
    if (!keep) {
        keep = galleries[galleries.length - 1];
    }

    console.log(`[GIC] 🧹 #gallery が ${galleries.length} 個検出。1つを残して削除します`);

    for (const g of galleries) {
        if (g === keep) continue;
        try { g.remove(); } catch (e) { /* ignore */ }
    }

    return keep;
}

function setupGalleryDedupeObserver() {
    if (window.__gicGalleryDedupeObserverInstalled) return;
    window.__gicGalleryDedupeObserverInstalled = true;

    const observer = new MutationObserver((mutations) => {
        let foundNewGallery = false;
        for (const m of mutations) {
            if (m.type !== 'childList') continue;
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.id === 'gallery') { foundNewGallery = true; break; }
                if (node.querySelector && node.querySelector('#gallery')) { foundNewGallery = true; break; }
            }
            if (foundNewGallery) break;
        }
        if (!foundNewGallery) return;

        dedupeGalleryElements();
        try {
            applyGalleryWindowLayout();
            styleGalleryWindowCloseButton();
        } catch (e) {
            console.warn('[GIC] 重複排除後のスタイル再適用でエラー:', e);
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[GIC] 🧹 #gallery 重複排除オブザーバを設置しました');
}

// ============================================================
// ★ ギャラリーサムネイルの個別ドラッグ
//    - draggable=false でネイティブD&D完全無効化
//    - mousedown/mousemove/mouseup を document キャプチャ段階で独占制御
//    - しきい値（5px）超えまで nGY2 にイベント素通し（クリック判定遅延防止）
//    - e.buttons === 0 で stale state 自動 cleanup
//    - window.blur / pointercancel / visibilitychange で強制 cleanup
//    - elementsFromPoint でギャラリーの下の JSON セルも検出
//    - startPostDragWatch() でドラッグ後 2 秒間の遅延ドリフト監視
//    - 通常クリック時は __gicNoLayoutUntil を設定しない（黒画面防止）
// ============================================================
function setupGalleryDragToJson() {
    if (window.__gicGalleryDragInstalled) return;
    window.__gicGalleryDragInstalled = true;

    const GALLERY_THUMB_SELECTOR = '.nGY2GThumbnail, .nGY2GThumbnail_l1, .nGY2Item';
    const DRAG_THRESHOLD = 5;

    let dragState = null;
    let ghostEl = null;
    let suppressClickUntil = 0;
    let driftRAF = null;
    let startRect = null;
    let startScroll = null;
    // ★ 再帰防止フラグ
    let isSimulatingClick = false;

    function getPathFromThumb(thumb) {
        if (!thumb) return null;
        let url = thumb.getAttribute('data-ngsrc')
               || thumb.getAttribute('data-src')
               || thumb.getAttribute('data-image');
        if (!url) {
            const img = thumb.querySelector('img');
            if (img) url = img.getAttribute('data-src') || img.getAttribute('src');
        }
        if (!url) {
            const a = thumb.querySelector('a');
            if (a) url = a.getAttribute('href');
        }
        return url ? urlToServerPath(url) : null;
    }

    function createGhost(thumb, x, y) {
        const w = thumb.offsetWidth || 100;
        const h = thumb.offsetHeight || 100;
        const imgEl = thumb.querySelector('img');

        const ghost = document.createElement('div');
        ghost.id = 'gic-drag-ghost';
        ghost.style.cssText = `
            position: fixed;
            left: ${x - w / 2}px;
            top: ${y - h / 2}px;
            width: ${w}px;
            height: ${h}px;
            pointer-events: none;
            z-index: 2147483647;
            border: 3px solid #ffd54f;
            border-radius: 6px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.6);
            overflow: hidden;
            opacity: 0.85;
            user-select: none;
        `;
        if (imgEl) {
            const img = document.createElement('img');
            img.src = imgEl.currentSrc || imgEl.src;
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;';
            ghost.appendChild(img);
        } else {
            ghost.style.backgroundColor = 'rgba(30,30,30,0.9)';
        }
        document.body.appendChild(ghost);
        return ghost;
    }

    function moveGhost(x, y) {
        if (!ghostEl) return;
        ghostEl.style.left = (x - ghostEl.offsetWidth / 2) + 'px';
        ghostEl.style.top = (y - ghostEl.offsetHeight / 2) + 'px';
    }

    function findDropCell(x, y) {
        if (typeof document.elementsFromPoint === 'function') {
            const elements = document.elementsFromPoint(x, y);
            for (const el of elements) {
                if (!el || !el.closest) continue;
                if (el.id === 'gic-drag-ghost') continue;
                const cell = el.closest('.stj-keyword-item, .stj-special-item');
                if (cell) return cell;
            }
        }
        const el = document.elementFromPoint(x, y);
        return el && el.closest ? el.closest('.stj-keyword-item, .stj-special-item') : null;
    }

    function startDriftWatch() {
        if (driftRAF) return;
        const g = document.getElementById('gallery');
        if (!g) return;
        const r = g.getBoundingClientRect();
        startRect = { left: r.left, top: r.top };
        const ng = g.querySelector('.nGY2Gallery');
        startScroll = ng ? { top: ng.scrollTop, left: ng.scrollLeft } : null;

        function check() {
            if (!dragState || !dragState.isDragging) { driftRAF = null; return; }
            const g2 = document.getElementById('gallery');
            if (!g2) { driftRAF = null; return; }
            const cur = g2.getBoundingClientRect();
            const dx = Math.abs(cur.left - startRect.left);
            const dy = Math.abs(cur.top - startRect.top);
            if (dx > 0.5 || dy > 0.5) {
                console.warn(`[GIC] gallery drift (Δx=${dx.toFixed(1)}, Δy=${dy.toFixed(1)}) → restore`);
                g2.style.setProperty('position', 'fixed', 'important');
                g2.style.setProperty('left', '0', 'important');
                g2.style.setProperty('top', '50%', 'important');
                g2.style.setProperty('transform', 'translateY(-50%)', 'important');
            }
            if (startScroll) {
                const ng2 = g2.querySelector('.nGY2Gallery');
                if (ng2) {
                    if (Math.abs(ng2.scrollTop - startScroll.top) > 2) ng2.scrollTop = startScroll.top;
                    if (Math.abs(ng2.scrollLeft - startScroll.left) > 2) ng2.scrollLeft = startScroll.left;
                }
            }
            driftRAF = requestAnimationFrame(check);
        }
        driftRAF = requestAnimationFrame(check);
    }

    function startPostDragWatch() {
        const gallery = document.getElementById('gallery');
        if (!gallery) return;
        const ngy2 = gallery.querySelector('.nGY2Gallery');
        const origScroll = ngy2 ? { top: ngy2.scrollTop, left: ngy2.scrollLeft } : null;
        const startTime = Date.now();

        function check() {
            if (Date.now() - startTime > 2000) return;
            if (window.__gicDragInProgress) return;
            const g = document.getElementById('gallery');
            if (!g) return;
            const cur = g.getBoundingClientRect();
            if (Math.abs(cur.left) > 1) {
                console.warn(`[GIC] post-drag gallery shift: Δx=${cur.left.toFixed(1)} → restore`);
                g.style.setProperty('position', 'fixed', 'important');
                g.style.setProperty('left', '0', 'important');
                g.style.setProperty('top', '50%', 'important');
                g.style.setProperty('transform', 'translateY(-50%)', 'important');
            }
            if (origScroll) {
                const n = g.querySelector('.nGY2Gallery');
                if (n) {
                    if (Math.abs(n.scrollTop - origScroll.top) > 2) n.scrollTop = origScroll.top;
                    if (Math.abs(n.scrollLeft - origScroll.left) > 2) n.scrollLeft = origScroll.left;
                }
            }
            requestAnimationFrame(check);
        }
        requestAnimationFrame(check);
    }

    function cleanup(wasDragging) {
        if (ghostEl) { ghostEl.remove(); ghostEl = null; }
        dragState = null;
        startRect = null;
        startScroll = null;
        if (driftRAF) { cancelAnimationFrame(driftRAF); driftRAF = null; }

        window.__gicDragInProgress = false;
        window.__gicDragStartTime = 0;
        document.body.classList.remove('gic-dragging');

        document.querySelectorAll('.stj-drop-target').forEach(el => el.classList.remove('stj-drop-target'));

        if (wasDragging) {
            window.__gicNoLayoutUntil = Date.now() + 200;
            startPostDragWatch();
        }
    }

    function handleDrop(x, y) {
        if (!dragState) return;
        const cell = findDropCell(x, y);
        window.dispatchEvent(new CustomEvent('gic-drop-file', {
            detail: { path: dragState.path, cell, x, y }
        }));
    }

    // ★ クリックを手動シミュレート（再帰防止フラグ付き）
    function simulateClick(thumb, x, y) {
        if (!thumb) return;
        if (isSimulatingClick) return;   // ★ 再帰防止
        isSimulatingClick = true;
        try {
            const img = thumb.querySelector('img');
            const target = img || thumb;
            const opts = {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: x,
                clientY: y,
                button: 0,
            };
            target.dispatchEvent(new MouseEvent('mousedown', opts));
            target.dispatchEvent(new MouseEvent('mouseup', opts));
            target.dispatchEvent(new MouseEvent('click', opts));
        } catch (err) { /* ignore */ }
        isSimulatingClick = false;   // ★ 同期リセット（dispatchEvent は同期実行のため）
    }

    function markThumb(thumb) {
        if (!thumb || thumb.dataset.gicDragReady === '1') return;
        thumb.dataset.gicDragReady = '1';
        thumb.setAttribute('draggable', 'false');
        thumb.querySelectorAll('img, a').forEach(el => {
            el.setAttribute('draggable', 'false');
            el.style.pointerEvents = 'none';
            try { el.style.webkitUserDrag = 'none'; } catch (_) {}
        });
    }

    // ★ 各ハンドラで isSimulatingClick をチェック

    document.addEventListener('pointerdown', (e) => {
        if (isSimulatingClick) return;
        if (e.button !== 0) return;
        const gallery = document.getElementById('gallery');
        if (!gallery || !gallery.contains(e.target)) return;
        const thumb = e.target.closest(GALLERY_THUMB_SELECTOR);
        if (!thumb) return;
        const path = getPathFromThumb(thumb);
        if (!path) return;
        e.stopImmediatePropagation();
    }, true);

    document.addEventListener('mousedown', (e) => {
        if (isSimulatingClick) return;
        if (e.button !== 0) return;
        const gallery = document.getElementById('gallery');
        if (!gallery || !gallery.contains(e.target)) return;
        const thumb = e.target.closest(GALLERY_THUMB_SELECTOR);
        if (!thumb) return;
        const path = getPathFromThumb(thumb);
        if (!path) return;

        dragState = {
            startX: e.clientX,
            startY: e.clientY,
            thumb,
            path,
            isDragging: false
        };
        e.stopImmediatePropagation();
    }, true);

    document.addEventListener('mousemove', (e) => {
        if (isSimulatingClick) return;
        if (!dragState) return;

        if (e.buttons === 0) {
            console.warn('[GIC] stale dragState を検出（buttons=0）→ cleanup');
            const wasDragging = dragState.isDragging;
            cleanup(wasDragging);
            return;
        }

        if (!dragState.isDragging) {
            const dx = e.clientX - dragState.startX;
            const dy = e.clientY - dragState.startY;
            if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;

            e.stopImmediatePropagation();
            dragState.isDragging = true;
            ghostEl = createGhost(dragState.thumb, e.clientX, e.clientY);
            window.__gicDragInProgress = true;
            window.__gicDragStartTime = Date.now();
            document.body.classList.add('gic-dragging');
            startDriftWatch();
        } else {
            e.stopImmediatePropagation();
        }

        moveGhost(e.clientX, e.clientY);

        const cell = findDropCell(e.clientX, e.clientY);
        document.querySelectorAll('.stj-drop-target').forEach(el => {
            if (el !== cell) el.classList.remove('stj-drop-target');
        });
        if (cell) cell.classList.add('stj-drop-target');
    }, true);

    document.addEventListener('pointermove', (e) => {
        if (isSimulatingClick) return;
        if (!dragState || !dragState.isDragging) return;
        e.stopImmediatePropagation();
    }, true);

    document.addEventListener('mouseup', (e) => {
        if (isSimulatingClick) return;
        if (!dragState) return;

        const wasDragging = dragState.isDragging;
        const thumb = dragState.thumb;

        if (wasDragging) {
            e.stopImmediatePropagation();
            e.preventDefault();
            suppressClickUntil = Date.now() + 250;
            handleDrop(e.clientX, e.clientY);
        } else if (thumb) {
            // クリック判定 → nGY2 のクリック動作を手動でシミュレート
            e.stopImmediatePropagation();
            e.preventDefault();
            // ★ 一括削除モードでは合成クリックを発火しない
            //    （自然クリックだけで選択をトグルさせる）
            if (!_bulkDeleteMode) {
                simulateClick(thumb, e.clientX, e.clientY);
            }
        }
        cleanup(wasDragging);
    }, true);

    document.addEventListener('pointerup', (e) => {
        if (isSimulatingClick) return;
        if (!dragState) return;
        if (dragState.isDragging) e.stopImmediatePropagation();
    }, true);

    document.addEventListener('click', (e) => {
        if (isSimulatingClick) return;
        if (Date.now() < suppressClickUntil) {
            e.stopImmediatePropagation();
            e.preventDefault();
            console.log('[GIC] ドラッグ直後のクリックを抑止');
        }
    }, true);

    document.addEventListener('mousedown', (e) => {
        if (isSimulatingClick) return;
        if (Date.now() >= suppressClickUntil) return;
        if (e.target.closest && e.target.closest('.gic-pagination-pager')) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    document.addEventListener('dragstart', (e) => {
        const gallery = document.getElementById('gallery');
        if (gallery && gallery.contains(e.target)) {
            e.preventDefault();
            e.stopImmediatePropagation();
        }
    }, true);

    window.addEventListener('blur', () => {
        if (!dragState) return;
        console.warn('[GIC] window blur → stale dragState を cleanup');
        const wasDragging = dragState.isDragging;
        cleanup(wasDragging);
    });

    window.addEventListener('pointercancel', () => {
        if (!dragState) return;
        console.warn('[GIC] pointercancel → cleanup');
        const wasDragging = dragState.isDragging;
        cleanup(wasDragging);
    });

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) return;
        if (!dragState) return;
        console.warn('[GIC] visibilitychange(hidden) → cleanup');
        const wasDragging = dragState.isDragging;
        cleanup(wasDragging);
    });

    function scanAndMarkAll() {
        const gallery = document.getElementById('gallery');
        if (!gallery) return;
        gallery.querySelectorAll(GALLERY_THUMB_SELECTOR).forEach(markThumb);
    }

    const observer = new MutationObserver(() => { scanAndMarkAll(); });
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(scanAndMarkAll, 1000);

    console.log('[GIC] 🖼️ ギャラリーサムネイルの個別ドラッグを有効化しました（nGY2完全遮断モード・再帰防止）');
}

// ===== ギャラリー配置・プレビュー制御 =====

function getAllPreviews() {
    const selector = GALLERY_PREVIEW_SELECTORS.join(', ');
    return Array.from(document.querySelectorAll(selector));
}

function closePreviewElement(el) {
    if (!el || !el.parentNode) return;
    const closeBtn = el.querySelector('.dragClose');
    if (closeBtn && typeof closeBtn.click === 'function') {
        try { closeBtn.click(); return; } catch (e) { /* fallback */ }
    }
    try { el.remove(); } catch (e) { /* ignore */ }
}

function closeAllPreviews() {
    const previews = getAllPreviews();
    if (previews.length === 0) {
        currentPreviewEl = null;
        return;
    }
    for (const el of previews) closePreviewElement(el);
    currentPreviewEl = null;
    console.log(`[GIC] ギャラリーが閉じたため ${previews.length} 個のプレビューを閉じました`);
}

function styleGalleryWindowCloseButton() {
    const galleryEls = document.querySelectorAll('#gallery');
    galleryEls.forEach(galleryEl => {
        const closeButtons = galleryEl.querySelectorAll('.dragClose');
        closeButtons.forEach(btn => {
            if (btn.closest('.galleryImageDraggable')) return;
            btn.style.setProperty('display', 'none', 'important');
            btn.style.setProperty('visibility', 'hidden', 'important');
            btn.style.setProperty('pointer-events', 'none', 'important');
            btn.style.setProperty('opacity', '0', 'important');
        });
    });
}

function hideGalleryUploadMessage() {
    const messages = [
        'Drag and drop images onto the gallery',
        'Images can also be found in the folder',
    ];

    document.querySelectorAll('.nGY2GalleryTop, .nGY2GalleryHeader').forEach(el => {
        el.style.setProperty('display', 'none', 'important');
    });

    const roots = [];
    const toastContainer = document.getElementById('toast-container');
    if (toastContainer) roots.push(toastContainer);
    const galleryEl = document.getElementById('gallery');
    if (galleryEl) roots.push(galleryEl);

    for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        const toHide = new Set();
        let node;
        while ((node = walker.nextNode())) {
            const t = node.textContent || '';
            let matched = false;
            for (const msg of messages) {
                if (t.includes(msg)) { matched = true; break; }
            }
            if (!matched) continue;

            let el = node.parentElement;
            let candidate = null;
            while (el && el !== document.body) {
                const text = el.textContent || '';
                if (text.length > 300) break;
                candidate = el;
                el = el.parentElement;
            }
            if (candidate) toHide.add(candidate);
        }

        toHide.forEach(el => {
            if (getComputedStyle(el).display !== 'none') {
                el.style.setProperty('display', 'none', 'important');
            }
        });
    }
}

// ★ #gallery と全子孫に draggable="false" を強制（movingUI対策）
function applyGalleryWindowLayout() {
    for (const sel of GALLERY_WINDOW_SELECTORS) {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
            el.setAttribute('draggable', 'false');
            el.querySelectorAll('*').forEach(child => {
                if (!child.hasAttribute('draggable') || child.getAttribute('draggable') === 'true') {
                    child.setAttribute('draggable', 'false');
                }
            });

            el.style.setProperty('position', 'fixed', 'important');
            el.style.setProperty('top', '50%', 'important');
            el.style.setProperty('left', '0', 'important');
            el.style.setProperty('right', 'auto', 'important');
            el.style.setProperty('bottom', 'auto', 'important');
            el.style.setProperty('transform', 'translateY(-50%)', 'important');
            el.style.setProperty('margin', '0', 'important');

            if (!galleryBaseHeightCache.has(el)) {
                const h = el.getBoundingClientRect().height;
                if (h > 0) {
                    galleryBaseHeightCache.set(el, h);
                } else {
                    continue;
                }
            }

            const base = galleryBaseHeightCache.get(el);
            const desired = Math.round(base + GALLERY_WINDOW_HEIGHT_DELTA);

            const vh = window.innerHeight;
            const maxAllowed = Math.max(100, vh - GALLERY_WINDOW_MAX_VIEWPORT_MARGIN * 2);
            const targetH = Math.min(desired, maxAllowed);

            if (el.dataset.gicHeightLogged !== 'true') {
                el.dataset.gicHeightLogged = 'true';
                console.log(`[GIC] ギャラリー高さ: ST本来=${Math.round(base)}px, 希望=${desired}px, 適用=${targetH}px (上限=${maxAllowed}px)`);
            }

            el.style.setProperty('height', targetH + 'px', 'important');
            el.style.setProperty('min-height', targetH + 'px', 'important');
            el.style.setProperty('max-height', targetH + 'px', 'important');
        }
    }
}

function resetGalleryHeightCache() {
    for (const sel of GALLERY_WINDOW_SELECTORS) {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
            if (galleryBaseHeightCache.has(el)) {
                galleryBaseHeightCache.delete(el);
                console.log('[GIC] ギャラリー高さキャッシュをリセット');
            }
            if (el.dataset.gicHeightLogged) delete el.dataset.gicHeightLogged;
        }
    }
    _paginationSnapshot = { count: -1, since: 0, stable: false };
    _paginationWindowStart = 0;
    _paginationWindowManual = false;
    _galleryTotalPagesCache = 0;
    _lastPagerSignature = '';

    const pager = document.querySelector('.gic-pagination-pager');
    if (pager) pager.remove();

    _bulkDeleteMode = false;
    _bulkDeleteSelected.clear();
    document.body.classList.remove('gic-bulk-delete-mode');
    document.querySelectorAll('.gic-bulk-selected').forEach(el => el.classList.remove('gic-bulk-selected'));
    removeBulkOverlays();
    const bulkBtn = document.getElementById('gic-bulk-delete-button');
    if (bulkBtn) bulkBtn.remove();

    const folderInput = document.querySelector('.gallery-folder-input.gic-bulk-shortened-input');
    if (folderInput) folderInput.classList.remove('gic-bulk-shortened-input');

    const galleryEl = document.getElementById('gallery');
    if (galleryEl) galleryEl.style.removeProperty('--gic-bulk-banner-text');
}

function positionPager(pager) {
    if (!pager) return;
    const galleryEl = document.getElementById('gallery');
    if (!galleryEl) return;
    const gr = galleryEl.getBoundingClientRect();
    if (gr.width === 0 || gr.height === 0) return;

    const left = gr.left + PAGINATION_OFFSET_LEFT;
    const bottom = (window.innerHeight - gr.bottom) + PAGINATION_OFFSET_UP;

    pager.style.setProperty('position', 'fixed', 'important');
    pager.style.setProperty('left', Math.round(left) + 'px', 'important');
    pager.style.setProperty('bottom', Math.round(bottom) + 'px', 'important');
    pager.style.setProperty('top', 'auto', 'important');
    pager.style.setProperty('right', 'auto', 'important');
    pager.style.setProperty('z-index', '2147483647', 'important');
}

function getGalleryTotalPages() {
    const galleryEl = document.getElementById('gallery');
    if (!galleryEl) return 0;

    const nGY2El = galleryEl.querySelector('.nGY2Gallery');
    if (nGY2El) {
        const attrs = [
            'data-nanogallery2-pagination-totalpages',
            'data-nanogallery2-totalpages',
            'data-pagination-total',
        ];
        for (const attr of attrs) {
            const v = nGY2El.getAttribute(attr);
            if (v) {
                const n = parseInt(v, 10);
                if (n > 0) return n;
            }
        }
    }

    if (_galleryTotalPagesCache > 0) {
        const dots = document.querySelectorAll('.nGY2paginationRectangle, .nGY2paginationRectangleCurrentPage');
        if (dots.length > _galleryTotalPagesCache) _galleryTotalPagesCache = dots.length;
        return _galleryTotalPagesCache;
    }

    return document.querySelectorAll('.nGY2paginationRectangle, .nGY2paginationRectangleCurrentPage').length;
}

function goToPageIndex(targetIdx, dots) {
    const dot = dots[targetIdx];
    if (!dot) {
        console.warn(`[GIC] ページ${targetIdx + 1} の dot が見つかりません`);
        return false;
    }
    try {
        dot.click();
        console.log(`[GIC] dot.click() で ページ${targetIdx + 1} に移動`);
        return true;
    } catch (e) { /* ignore */ }
    try {
        const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        dot.dispatchEvent(evt);
        console.log(`[GIC] dispatchEvent で ページ${targetIdx + 1} に移動`);
        return true;
    } catch (e) { /* ignore */ }
    return false;
}

function applyPageNumbers() {
    const container = document.querySelector('.nGY2GalleryBottom');
    if (!container) return;

    if (container.dataset.gicSelectGuardInstalled !== 'true') {
        container.dataset.gicSelectGuardInstalled = 'true';
        container.addEventListener('mousedown', (e) => {
            if (e.target === container) e.preventDefault();
        }, true);
    }

    const dots = Array.from(container.querySelectorAll('.nGY2paginationRectangle, .nGY2paginationRectangleCurrentPage'));
    if (dots.length === 0) {
        const pager = document.querySelector('.gic-pagination-pager');
        if (pager) pager.remove();
        _lastPagerSignature = '';
        return;
    }

    const now = performance.now();
    const domDotsCount = dots.length;
    const totalPages = getGalleryTotalPages();
    const effectiveCount = Math.max(domDotsCount, totalPages);

    if (effectiveCount !== _paginationSnapshot.count) {
        _paginationSnapshot = { count: effectiveCount, since: now, stable: false };
    } else if (!_paginationSnapshot.stable &&
               now - _paginationSnapshot.since >= PAGINATION_STABLE_DELAY_MS) {
        _paginationSnapshot.stable = true;
    }

    if (!_paginationSnapshot.stable) return;

    const currentIdx = dots.findIndex(dot => dot.classList.contains('nGY2paginationRectangleCurrentPage'));
    const currentPage = currentIdx >= 0 ? currentIdx : 0;
    const pageSize = PAGINATION_PAGE_SIZE;
    const totalCount = effectiveCount;
    const isSmall = totalCount <= PAGINATION_MAX_VISIBLE;

    let windowStart, windowEnd;
    if (isSmall) {
        windowStart = 0; windowEnd = totalCount;
        _paginationWindowStart = 0;
    } else {
        windowStart = _paginationWindowStart;
        if (!_paginationWindowManual) {
            if (currentPage < windowStart || currentPage >= windowStart + pageSize) {
                windowStart = Math.floor(currentPage / pageSize) * pageSize;
            }
        }
        if (windowStart < 0) windowStart = 0;
        if (windowStart > totalCount - pageSize) windowStart = Math.max(0, totalCount - pageSize);
        _paginationWindowStart = windowStart;
        windowEnd = Math.min(windowStart + pageSize, totalCount);
    }

    const signature = `${totalCount}|${windowStart}|${windowEnd}|${currentPage}|${isSmall ? 1 : 0}`;
    let pager = document.querySelector('.gic-pagination-pager');
    if (signature === _lastPagerSignature && pager) {
        positionPager(pager);
        return;
    }
    _lastPagerSignature = signature;

    dots.forEach((dot) => {
        const existing = dot.querySelector('.gic-page-number');
        if (existing) existing.remove();
        dot.classList.add('gic-hidden-by-pager');
        dot.dataset.gicHiddenByPager = 'true';
    });

    if (pager) pager.remove();

    pager = document.createElement('div');
    pager.className = 'gic-pagination-pager';

    const canPrev = !isSmall && windowStart > 0;
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'gic-pagination-nav';
    prev.textContent = '<';
    if (!canPrev) {
        prev.classList.add('gic-pagination-disabled');
        prev.disabled = true;
        prev.title = '前のページ群（現在先頭）';
    } else {
        prev.title = '前のページ群（表示範囲を戻す）';
        prev.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            _paginationWindowStart = Math.max(0, windowStart - pageSize);
            _paginationWindowManual = true;
            _lastPagerSignature = '';
            applyPageNumbers();
        });
    }
    pager.appendChild(prev);

    for (let i = windowStart; i < windowEnd; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'gic-pagination-page';
        if (i === currentPage) btn.classList.add('gic-pagination-current');
        btn.textContent = String(i + 1);
        btn.title = `ページ ${i + 1}`;
        btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            if (!isSmall) _paginationWindowStart = Math.floor(i / pageSize) * pageSize;
            _paginationWindowManual = false;
            _lastPagerSignature = '';
            goToPageIndex(i, dots);
            setTimeout(() => applyPageNumbers(), 200);
        });
        pager.appendChild(btn);
    }

    const canNext = !isSmall && windowEnd < totalCount;
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'gic-pagination-nav';
    next.textContent = '>';
    if (!canNext) {
        next.classList.add('gic-pagination-disabled');
        next.disabled = true;
        next.title = '次のページ群（現在末尾）';
    } else {
        next.title = '次のページ群（表示範囲を進める）';
        next.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            _paginationWindowStart = Math.min(Math.max(0, totalCount - pageSize), windowStart + pageSize);
            _paginationWindowManual = true;
            _lastPagerSignature = '';
            applyPageNumbers();
        });
    }
    pager.appendChild(next);

    document.body.appendChild(pager);
    positionPager(pager);
}

function fitPreviewToViewport(panel) {
    if (!panel) return;
    const img = panel.querySelector('img');
    const header = panel.querySelector('.panelControlBar');
    const closeBtn = panel.querySelector('.dragClose');
    if (!img) return;

    if (header) header.style.setProperty('flex', '0 0 auto', 'important');

    const applySize = () => {
        const nw = img.naturalWidth || 0;
        const nh = img.naturalHeight || 0;
        if (!nw || !nh) return;

        const galleryEl = document.getElementById('gallery');
        let galleryRight = 0;
        if (galleryEl) {
            const gr = galleryEl.getBoundingClientRect();
            galleryRight = Math.round(gr.right);
        }

        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const availableW = Math.max(100, vw - galleryRight - GALLERY_PREVIEW_MARGIN_X);
        const availableH = Math.max(100, vh - GALLERY_PREVIEW_MARGIN_Y * 2);

        const fitScale = Math.min(availableW / nw, availableH / nh);
        const desiredScale = fitScale * GALLERY_PREVIEW_SCALE_MULTIPLIER;
        const maxScaleByWidth = GALLERY_PREVIEW_MAX_WIDTH / nw;
        const finalScale = Math.min(desiredScale, maxScaleByWidth);

        const finalW = Math.max(1, Math.floor(nw * finalScale));
        const finalH = Math.max(1, Math.floor(nh * finalScale));

        panel.style.setProperty('position', 'fixed', 'important');
        panel.style.setProperty('left', galleryRight + 'px', 'important');
        panel.style.setProperty('top', '50%', 'important');
        panel.style.setProperty('right', 'auto', 'important');
        panel.style.setProperty('bottom', 'auto', 'important');
        panel.style.setProperty('transform', 'translateY(-50%)', 'important');
        panel.style.setProperty('transform-origin', 'left center', 'important');
        panel.style.setProperty('margin', '0', 'important');
        panel.style.setProperty('padding', '0', 'important');
        panel.style.setProperty('box-sizing', 'border-box', 'important');
        panel.style.setProperty('overflow', 'visible', 'important');
        panel.style.setProperty('display', 'flex', 'important');
        panel.style.setProperty('flex-direction', 'column', 'important');
        panel.style.setProperty('width', finalW + 'px', 'important');
        panel.style.setProperty('height', 'auto', 'important');
        panel.style.setProperty('max-width', 'none', 'important');
        panel.style.setProperty('max-height', 'none', 'important');
        panel.style.setProperty('visibility', 'visible', 'important');
        panel.style.setProperty('z-index', '15000', 'important');

        img.style.setProperty('width', finalW + 'px', 'important');
        img.style.setProperty('height', finalH + 'px', 'important');
        img.style.setProperty('max-width', 'none', 'important');
        img.style.setProperty('max-height', 'none', 'important');
        img.style.setProperty('object-fit', 'contain', 'important');
        img.style.setProperty('display', 'block', 'important');
        img.style.setProperty('flex', '0 0 auto', 'important');

        if (closeBtn) {
            closeBtn.style.setProperty('position', 'fixed', 'important');
            closeBtn.style.setProperty('left', '0', 'important');
            closeBtn.style.setProperty('top', '50%', 'important');
            closeBtn.style.setProperty('transform', `translateY(-50%) scale(${GALLERY_PREVIEW_CLOSE_SCALE})`, 'important');
            closeBtn.style.setProperty('transform-origin', 'left center', 'important');
            closeBtn.style.setProperty('margin', '0', 'important');
            closeBtn.style.setProperty('z-index', '15001', 'important');
        }
    };

    if (img.complete && img.naturalWidth) {
        applySize();
    } else {
        if (img.dataset.gicFitBound !== 'true') {
            img.dataset.gicFitBound = 'true';
            img.addEventListener('load', () => {
                if (document.body.contains(panel)) fitPreviewToViewport(panel);
            });
        }
    }
}

// ===== 一括削除機能 =====

function findGalleryHeaderControls() {
    const result = { header: null, trashIcon: null, checkIcon: null, refreshIcon: null, dropdown: null, folderInput: null, folderRow: null };
    const gallery = document.getElementById('gallery');
    if (!gallery) return result;

    const folderInput = gallery.querySelector('.gallery-folder-input');
    if (folderInput) {
        result.folderInput = folderInput;
        result.folderRow = folderInput.parentElement;
    }

    const headerCandidates = [
        gallery.querySelector('.dragTitle'),
        gallery.querySelector('.panelControlBar'),
        gallery.querySelector('.nGY2GalleryTop'),
    ].filter(Boolean);
    result.header = headerCandidates[0] || gallery;
    result.dropdown = result.header.querySelector('select');

    const iconCandidates = result.header.querySelectorAll('i[class*="fa-"], button, .menu_button, [role="button"], div[title], span');
    iconCandidates.forEach(el => {
        const cls = (el.className || '').toString().toLowerCase();
        const title = (el.getAttribute('title') || '').toLowerCase();
        const text = (el.textContent || '').trim();

        if (!result.trashIcon &&
            (cls.includes('fa-trash') || cls.includes('trash') ||
             title.includes('削除') || title.includes('delete') ||
             text === '🗑' || text === '🗑️')) {
            result.trashIcon = el.closest('button, .menu_button, [role="button"], div') || el;
            return;
        }
        if (!result.checkIcon &&
            (cls.includes('fa-check') || cls.includes('check') ||
             title.includes('確認') || title.includes('confirm') ||
             text === '✓' || text === '✔')) {
            result.checkIcon = el.closest('button, .menu_button, [role="button"], div') || el;
            return;
        }
        if (!result.refreshIcon &&
            (cls.includes('fa-rotate') || cls.includes('fa-sync') ||
             cls.includes('fa-redo') || cls.includes('refresh') ||
             title.includes('更新') || title.includes('refresh') ||
             text === '♺' || text === '🔄')) {
            result.refreshIcon = el.closest('button, .menu_button, [role="button"], div') || el;
            return;
        }
    });

    return result;
}

function extractImagePathFromItem(item) {
    if (!item) return null;
    const dataSrc = item.getAttribute('data-ngsrc') || item.getAttribute('data-src') || item.getAttribute('data-image');
    if (dataSrc) return urlToServerPath(dataSrc);
    const img = item.querySelector('img');
    if (img) {
        const src = img.getAttribute('data-src') || img.getAttribute('src');
        if (src) return urlToServerPath(src);
    }
    const link = item.querySelector('a');
    if (link && link.getAttribute('href')) return urlToServerPath(link.getAttribute('href'));
    return null;
}

function urlToServerPath(url) {
    if (!url || typeof url !== 'string') return null;
    let path = url;
    try {
        const u = new URL(url, window.location.origin);
        path = u.pathname;
    } catch (e) { /* ignore */ }
    if (path.startsWith('/')) path = path.slice(1);
    try { path = decodeURIComponent(path); } catch (e) { /* ignore */ }
    return path;
}

function enterBulkDeleteMode() {
    if (_bulkDeleteMode) return;
    _bulkDeleteMode = true;
    _bulkDeleteSelected.clear();
    document.body.classList.add('gic-bulk-delete-mode');
    console.log('[GIC-Bulk] 一括削除モード開始');
    showBulkDeleteToast('削除モード開始 — 画像をクリックして選択してください');
    updateBulkDeleteButton();
    updateBulkDeleteBanner();
}

function exitBulkDeleteMode() {
    if (!_bulkDeleteMode) return;
    _bulkDeleteMode = false;
    _bulkDeleteSelected.clear();
    document.body.classList.remove('gic-bulk-delete-mode');
    document.querySelectorAll('.gic-bulk-selected').forEach(el => el.classList.remove('gic-bulk-selected'));
    showBulkDeleteToast('削除モード終了');
    updateBulkDeleteButton();
    console.log('[GIC-Bulk] 一括削除モード終了');
}

function showBulkDeleteToast(message) {
    try {
        if (typeof window.toastr !== 'undefined' && typeof window.toastr.info === 'function') {
            window.toastr.info(message, 'Generate Image Controller', { timeOut: 2500, positionClass: 'toast-top-center' });
            return;
        }
    } catch (e) { /* fallthrough */ }

    const existing = document.getElementById('gic-bulk-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'gic-bulk-toast';
    toast.textContent = message;
    Object.assign(toast.style, {
        position: 'fixed', top: '80px', left: '50%', transform: 'translateX(-50%)',
        padding: '10px 20px', backgroundColor: '#ff3b30', color: '#ffffff',
        fontSize: '14px', fontWeight: 'bold', fontFamily: 'sans-serif',
        borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        zIndex: '2147483647', pointerEvents: 'none',
        transition: 'opacity 0.3s ease', opacity: '1',
    });
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 350);
    }, 2500);
}

function toggleBulkSelection(itemEl, evt) {
    if (!itemEl) return;
    if (evt) {
        if (evt.__gicBulkToggled) return;
        evt.__gicBulkToggled = true;
    }
    const path = extractImagePathFromItem(itemEl);
    if (_bulkDeleteSelected.has(itemEl)) {
        _bulkDeleteSelected.delete(itemEl);
        itemEl.classList.remove('gic-bulk-selected');
        console.log(`[GIC-Bulk] 選択解除: ${path || '(unknown)'}`);
    } else {
        _bulkDeleteSelected.set(itemEl, path);
        itemEl.classList.add('gic-bulk-selected');
        console.log(`[GIC-Bulk] 選択: ${path || '(unknown)'}`);
    }
    updateBulkDeleteButton();
    updateBulkDeleteBanner();
}

function updateBulkDeleteButton() {
    const btn = document.getElementById('gic-bulk-delete-button');
    if (!btn) return;
    if (_bulkDeleteSelected.size > 0) {
        btn.classList.remove('gic-bulk-delete-disabled');
        btn.disabled = false;
        btn.textContent = `一括削除 (${_bulkDeleteSelected.size})`;
    } else {
        btn.classList.add('gic-bulk-delete-disabled');
        btn.disabled = true;
        btn.textContent = '一括削除';
    }
}

function updateBulkDeleteBanner() {
    if (!_bulkDeleteMode) return;
    const gallery = document.getElementById('gallery');
    if (!gallery) return;
    const count = _bulkDeleteSelected.size;
    const text = count > 0
        ? `🗑 削除モード中 — ${count} 枚選択中（クリックで選択解除）`
        : '🗑 削除モード中 — 画像をクリックして選択、再度クリックで解除';
    gallery.style.setProperty('--gic-bulk-banner-text', `"${text}"`);
}

function createBulkDeleteButton() {
    let btn = document.getElementById('gic-bulk-delete-button');
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = 'gic-bulk-delete-button';
    btn.type = 'button';
    btn.className = 'gic-bulk-delete-button gic-bulk-delete-disabled';
    btn.textContent = '一括削除';
    btn.disabled = true;
    btn.title = '選択した画像を一括削除';
    btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        executeBulkDelete();
    });
    return btn;
}

function placeBulkDeleteButton(controls) {
    const { folderInput, folderRow, dropdown, header } = controls;
    const btn = createBulkDeleteButton();
    if (btn.parentElement) { updateBulkDeleteButton(); return; }

    if (folderInput && folderInput.parentElement) {
        folderInput.classList.add('gic-bulk-shortened-input');
        folderInput.insertAdjacentElement('afterend', btn);
        console.log('[GIC-Bulk] 一括削除ボタンをフォルダ入力欄の直後に挿入');
        updateBulkDeleteButton();
        return;
    }
    if (folderRow) {
        folderRow.appendChild(btn);
        console.log('[GIC-Bulk] 一括削除ボタンをフォルダ行末尾に挿入');
        updateBulkDeleteButton();
        return;
    }
    if (dropdown && dropdown.parentElement) {
        dropdown.classList.add('gic-bulk-shrunk-dropdown');
        dropdown.parentElement.insertBefore(btn, dropdown);
        console.log('[GIC-Bulk] 一括削除ボタンをドロップダウンの直前に挿入');
        updateBulkDeleteButton();
        return;
    }
    if (header) {
        header.appendChild(btn);
        console.log('[GIC-Bulk] 一括削除ボタンをヘッダー末尾に挿入');
        updateBulkDeleteButton();
    }
}

async function tryDeleteImage(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return { ok: false };
    const cleaned = rawPath.replace(/^\/+/, '');
    const noPrefix = cleaned.replace(/^user\/images\//, '');
    const justFile = noPrefix.split('/').pop();
    const candidates = [cleaned, '/' + cleaned, noPrefix, justFile];
    const seen = new Set();
    const uniqueCandidates = [];
    for (const c of candidates) {
        if (!c || seen.has(c)) continue;
        seen.add(c);
        uniqueCandidates.push(c);
    }

    for (const candidate of uniqueCandidates) {
        try {
            const resp = await fetch('/api/images/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ path: candidate }),
            });
            if (resp.ok) {
                let data = null;
                try { data = await resp.json(); } catch (e) { /* ignore */ }
                if (data && data.error) {
                    console.log(`[GIC-Bulk] path="${candidate}" → APIエラー:`, data);
                    continue;
                }
                return { ok: true, usedPath: candidate };
            }
        } catch (e) { /* ignore */ }
    }
    return { ok: false };
}

async function executeBulkDelete() {
    if (_bulkDeleteSelected.size === 0) { console.warn('[GIC-Bulk] 選択された画像がありません'); return; }
    const count = _bulkDeleteSelected.size;
    if (!window.confirm(`選択した ${count} 枚の画像を削除しますか？\nこの操作は取り消せません。`)) return;

    const paths = [];
    _bulkDeleteSelected.forEach(path => { if (path) paths.push(path); });
    if (paths.length === 0) { console.warn('[GIC-Bulk] 有効なパスがありません'); return; }

    let successCount = 0, failCount = 0;
    for (const path of paths) {
        const result = await tryDeleteImage(path);
        if (result.ok) successCount++; else failCount++;
    }
    console.log(`[GIC-Bulk] 完了: 成功 ${successCount} / 失敗 ${failCount}`);

    if (lastGeneratedImageUrl) {
        const targetNormalized = (() => {
            try { return decodeURIComponent(lastGeneratedImageUrl); } catch { return lastGeneratedImageUrl; }
        })();
        for (const p of paths) {
            const pNormalized = (() => {
                try { return decodeURIComponent(p); } catch { return p; }
            })();
            if (targetNormalized.includes(pNormalized) || pNormalized.includes(targetNormalized)) {
                lastGeneratedImageUrl = null;
                if (isOverrideLocal) { isOverrideLocal = false; setButtonLabel(LABEL_NORMAL); }
                savePersistedState();
                if (window.ImageDisplayExtension?.clearOverrideImage) {
                    try { window.ImageDisplayExtension.clearOverrideImage(); } catch (e) { /* ignore */ }
                }
                break;
            }
        }
    }

    exitBulkDeleteMode();
    await refreshGalleryAfterBulkDelete();
}

async function refreshGalleryAfterBulkDelete() {
    const galleryEl = document.getElementById('gallery');
    if (!galleryEl) return;
    const savedState = captureGalleryUiState();
    const wasOpen = isGalleryOpen();
    if (wasOpen) closeGalleryProgrammatically();

    _galleryOpenCache = { value: false, timestamp: 0 };
    lastGalleryStateForGic = null;
    clearGalleryOpenInFlight();
    await wait(400);

    _galleryOpenCache = { value: false, timestamp: 0 };
    lastGalleryStateForGic = null;
    clearGalleryOpenInFlight();
    openGalleryFromGic();
    await wait(900);
    await restoreGalleryUiState(savedState);

    _paginationSnapshot = { count: -1, since: 0, stable: false };
    _lastPagerSignature = '';
    _galleryTotalPagesCache = 0;
    applyPageNumbers();
    applyGalleryLayout();
}

function captureGalleryUiState() {
    const state = { pageIndex: 0, scrollTop: 0, pagerWindowStart: _paginationWindowStart };
    const dots = document.querySelectorAll('.nGY2paginationRectangle, .nGY2paginationRectangleCurrentPage');
    const currentIdx = Array.from(dots).findIndex(d => d.classList.contains('nGY2paginationRectangleCurrentPage'));
    state.pageIndex = currentIdx >= 0 ? currentIdx : 0;
    const ng2 = document.querySelector('.nGY2Gallery');
    if (ng2) state.scrollTop = ng2.scrollTop || 0;
    return state;
}

async function restoreGalleryUiState(state) {
    if (!state) return;
    const dots = document.querySelectorAll('.nGY2paginationRectangle, .nGY2paginationRectangleCurrentPage');
    if (dots.length > 0) {
        const targetIdx = Math.max(0, Math.min(state.pageIndex, dots.length - 1));
        const dot = dots[targetIdx];
        if (dot && !dot.classList.contains('nGY2paginationRectangleCurrentPage')) {
            try {
                dot.click();
                await wait(300);
            } catch (e) { /* ignore */ }
        }
    }
    if (state.scrollTop) {
        const ng2 = document.querySelector('.nGY2Gallery');
        if (ng2) ng2.scrollTop = state.scrollTop;
    }
    if (typeof state.pagerWindowStart === 'number') _paginationWindowStart = state.pagerWindowStart;
}

function installBulkDeleteDocumentHandlers() {
    const FLAG = 'gicBulkDocHandlersInstalled';
    if (document.body.dataset[FLAG] === 'true') return;
    document.body.dataset[FLAG] = 'true';

    const TRASH_SELECTOR = [
        'i.fa-trash', 'i.fa-trash-can', 'i[class*="fa-trash"]', '[class*="trash"]',
        'button[title*="elete"]', 'button[title*="rash"]', 'button[title*="削除"]',
        'div[title*="elete"]', 'div[title*="rash"]', 'div[title*="削除"]',
    ].join(',');

    const inGallery = (el) => {
        const gallery = document.getElementById('gallery');
        return gallery && el && gallery.contains(el);
    };

    const SKIP_UI_SELECTOR = [
        '.dragTitle', '.panelControlBar', '.right_menu_button', '.menu_button',
        'button', 'input', 'select', '.nGY2GalleryBottom',
        '.nGY2ConsoleParent', '.gallery-sort-select',
        '.gic-bulk-delete-button', '.dragClose'
    ].join(',');

    const findItem = (target, clientX, clientY) => {
        const gallery = document.getElementById('gallery');
        if (!gallery) return null;
        if (target && target !== gallery && gallery.contains(target)) {
            const thumb = target.closest('.nGY2GThumbnail, .nGY2GThumbnail_l1, .nGY2Item, [data-ngsrc]');
            if (thumb && thumb !== gallery && gallery.contains(thumb)) return thumb;
        }
        if (clientX != null && clientY != null) {
            const candidates = gallery.querySelectorAll('.nGY2GThumbnail, .nGY2GThumbnail_l1');
            for (const el of candidates) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0 &&
                    clientX >= r.left && clientX <= r.right &&
                    clientY >= r.top && clientY <= r.bottom) return el;
            }
        }
        return null;
    };

    window.addEventListener('click', (e) => {
        // ★ 合成クリック（simulateClick 由来）は無視。自然クリックのみ処理する
        if (!e.isTrusted) return;
        if (!inGallery(e.target)) return;
        const isBulkBtn = e.target.closest('.gic-bulk-delete-button');
        const trash = e.target.closest(TRASH_SELECTOR);
        if (!isBulkBtn && trash && !trash.classList.contains('dragClose')) {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            const now = Date.now();
            if (now - _lastTrashToggleAt < TRASH_TOGGLE_DEBOUNCE_MS) return;
            _lastTrashToggleAt = now;
            if (_bulkDeleteMode) exitBulkDeleteMode();
            else enterBulkDeleteMode();
            return;
        }
        if (_bulkDeleteMode) {
            if (e.target.closest(SKIP_UI_SELECTOR)) return;
            const item = findItem(e.target, e.clientX, e.clientY);
            if (item) {
                // ★ 一括削除モードでは nGY2 のプレビューが開かないよう伝播を止める
                e.stopPropagation();
                e.preventDefault();
                toggleBulkSelection(item, e);
            }
        }
    }, true);

    console.log('[GIC-Bulk] クリックハンドラをインストール');
}

function removeBulkOverlays() {
    document.querySelectorAll('.gic-bulk-overlay').forEach(el => el.remove());
}

function setupBulkDelete() {
    const gallery = document.getElementById('gallery');
    if (!gallery) return;
    const controls = findGalleryHeaderControls();
    placeBulkDeleteButton(controls);

    if (!_bulkDeleteHeaderObserver && controls.header) {
        _bulkDeleteHeaderObserver = new MutationObserver(() => {
            const c = findGalleryHeaderControls();
            if (!document.getElementById('gic-bulk-delete-button') &&
                (c.folderInput || c.folderRow || c.dropdown)) {
                placeBulkDeleteButton(c);
            }
        });
        _bulkDeleteHeaderObserver.observe(controls.header, { childList: true, subtree: true });
    }

    if (controls.folderRow && !controls.folderRow.dataset.gicBulkRowObserved) {
        controls.folderRow.dataset.gicBulkRowObserved = 'true';
        const rowObserver = new MutationObserver(() => {
            if (!document.getElementById('gic-bulk-delete-button')) {
                const c = findGalleryHeaderControls();
                if (c.folderInput || c.folderRow) placeBulkDeleteButton(c);
            }
        });
        rowObserver.observe(controls.folderRow, { childList: true, subtree: true });
    }
}

// ============================================================
// ★ applyGalleryLayout
//    __gicDragInProgress が 5秒以上 → 強制リセット（黒画面対策）
// ============================================================
function applyGalleryLayout() {
    if (isApplyingLayout) return;

    if (window.__gicDragInProgress) {
        if (!window.__gicDragStartTime) {
            window.__gicDragStartTime = Date.now();
        } else if (Date.now() - window.__gicDragStartTime > 5000) {
            console.warn('[GIC] __gicDragInProgress が5秒以上継続 → 強制リセット');
            window.__gicDragInProgress = false;
            window.__gicDragStartTime = 0;
            document.body.classList.remove('gic-dragging');
        } else {
            return;
        }
    }

    if (Date.now() < (window.__gicNoLayoutUntil || 0)) return;
    isApplyingLayout = true;
    try {
        if (!isGalleryOpen()) {
            closeAllPreviews();
            return;
        }

        dedupeGalleryElements();
        applyGalleryWindowLayout();
        styleGalleryWindowCloseButton();

        document.querySelectorAll('.nGY2paginationRectangle, .nGY2paginationRectangleCurrentPage').forEach(el => {
            el.style.setProperty('height', GALLERY_PAGINATION_HEIGHT + 'px', 'important');
            el.style.setProperty('min-height', GALLERY_PAGINATION_HEIGHT + 'px', 'important');
            el.style.setProperty('max-height', GALLERY_PAGINATION_HEIGHT + 'px', 'important');
            el.style.setProperty('position', 'relative', 'important');
        });

        applyPageNumbers();

        const pager = document.querySelector('.gic-pagination-pager');
        if (pager) positionPager(pager);

        try { setupBulkDelete(); } catch (e) { /* ignore */ }
        hideGalleryUploadMessage();

        const previews = getAllPreviews();
        if (previews.length === 0) { currentPreviewEl = null; return; }

        const latest = previews[previews.length - 1];
        if (latest !== currentPreviewEl) {
            for (const el of previews) {
                if (el === latest) continue;
                closePreviewElement(el);
            }
            currentPreviewEl = latest;
        }
        fitPreviewToViewport(latest);
    } finally {
        setTimeout(() => { isApplyingLayout = false; }, 0);
    }
}

let lastGalleryStateForGic = null;

function syncGalleryButtonVisibility() {
    const galleryOpen = isGalleryOpen();
    if (galleryOpen === lastGalleryStateForGic) return;
    const wasOpen = lastGalleryStateForGic === true;
    lastGalleryStateForGic = galleryOpen;

    if (_galleryOpenInFlight) clearGalleryOpenInFlight();

    if (galleryOpen) dedupeGalleryElements();

    const btn = document.getElementById(GALLERY_BUTTON_ID);
    if (btn) {
        if (galleryOpen) {
            btn.style.setProperty('display', 'none', 'important');
        } else {
            btn.style.removeProperty('display');
        }
    }

    if (galleryOpen) {
        applyGalleryLayout();
        if (warmupState !== 'running') {
            setTimeout(() => {
                if (isGalleryOpen() && window.STJEditor?.open) {
                    try { window.STJEditor.open(); } catch (e) { /* ignore */ }
                }
            }, 300);
        }
    } else {
        resetGalleryHeightCache();
        closeAllPreviews();
        if (wasOpen && window.STJEditor?.isOpen?.()) {
            try { window.STJEditor.close({ fromGallery: true, force: true }); } catch (e) { /* ignore */ }
        }
    }
}

function setupGalleryObserverForGic() {
    setInterval(() => {
        syncGalleryButtonVisibility();
        applyGalleryLayout();
        hideGalleryUploadMessage();
    }, 300);

    syncGalleryButtonVisibility();
    applyGalleryLayout();
    hideGalleryUploadMessage();
}

function openGalleryFromGic() {
    if (isGalleryOpen()) { clearGalleryOpenInFlight(); return true; }
    if (isGalleryOpenInFlight()) return false;
    markGalleryOpenInFlight();

    try {
        const ctx = getContext();
        if (ctx && typeof ctx.openGallery === 'function') {
            ctx.openGallery();
            console.log('[GIC] ギャラリーを開きました (ctx.openGallery)');
            setTimeout(() => dedupeGalleryElements(), 50);
            return true;
        }
    } catch (e) { /* ignore */ }

    const directSelectors = ['#gallery_button', '#gallery-button', '#open-gallery-button', '.gallery-button', '.open-gallery'];
    for (const sel of directSelectors) {
        const el = document.querySelector(sel);
        if (el && typeof el.click === 'function') {
            el.click();
            setTimeout(() => dedupeGalleryElements(), 50);
            return true;
        }
    }

    const menu = document.querySelector('#extensionsMenu');
    if (menu) {
        const items = menu.querySelectorAll('a, button, .list-group-item, [role="menuitem"]');
        for (const item of items) {
            const text = (item.textContent || '').trim().toLowerCase();
            if (text === 'gallery' || text === 'ギャラリー' || text.includes('gallery') || text.includes('ギャラリー')) {
                item.click();
                setTimeout(() => dedupeGalleryElements(), 50);
                return true;
            }
        }
    }

    const allClickable = document.querySelectorAll('button, a');
    for (const el of allClickable) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (text === 'gallery' || text === 'ギャラリー') {
            el.click();
            setTimeout(() => dedupeGalleryElements(), 50);
            return true;
        }
    }

    clearGalleryOpenInFlight();
    return false;
}

function hideGalleryAttachmentsImmediately(reason = '') {
    if (reason) console.log(`[GIC] 🚪 付属UIを即座に非表示 (${reason})`);

    const pager = document.querySelector('.gic-pagination-pager');
    if (pager) { pager.remove(); _lastPagerSignature = ''; }

    const previews = getAllPreviews();
    for (const el of previews) {
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
        el.style.setProperty('opacity', '0', 'important');
        try { el.remove(); } catch (e) { /* ignore */ }
    }
    currentPreviewEl = null;
    hideStatusMessage();

    if (_bulkDeleteMode) {
        document.body.classList.remove('gic-bulk-delete-mode');
        _bulkDeleteMode = false;
        _bulkDeleteSelected.clear();
    }

    for (const sel of GALLERY_WINDOW_SELECTORS) {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
            if (galleryBaseHeightCache.has(el)) galleryBaseHeightCache.delete(el);
        }
    }

    _paginationSnapshot = { count: -1, since: 0, stable: false };
    _paginationWindowStart = 0;
    _paginationWindowManual = false;
    _galleryTotalPagesCache = 0;

    if (window.STJEditor?.isOpen?.()) {
        try { window.STJEditor.close({ fromGallery: true, force: true }); } catch (e) { /* ignore */ }
    }
}

function installGalleryCloseInterceptor() {
    if (window.__gicCloseInterceptorInstalled) return;
    window.__gicCloseInterceptorInstalled = true;

    const isInsideGallery = (el) => {
        const gallery = document.getElementById('gallery');
        return gallery && el && gallery.contains(el);
    };

    const handleClose = (e) => {
        const target = e.target;
        if (!target || !target.closest) return;
        const closeBtn = target.closest('.dragClose');
        if (!closeBtn) return;
        if (!isInsideGallery(closeBtn)) return;
        if (closeBtn.closest('.galleryImageDraggable')) return;
        hideGalleryAttachmentsImmediately('close button click');
    };

    document.addEventListener('click', handleClose, true);
    document.addEventListener('pointerdown', handleClose, true);

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const gallery = document.getElementById('gallery');
        if (!gallery) return;
        const style = window.getComputedStyle(gallery);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        hideGalleryAttachmentsImmediately('Escape key');
    }, true);

    console.log('[GIC] 🚪 ギャラリー閉じるインターセプタを設置しました');
}

function closeGalleryProgrammatically() {
    hideGalleryAttachmentsImmediately('closeGalleryProgrammatically');

    let closed = false;
    try {
        const esc = new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
            bubbles: true, cancelable: true,
        });
        document.dispatchEvent(esc);
        clearGalleryOpenInFlight();
        closed = true;
    } catch (e) { /* ignore */ }

    if (closed) {
        setTimeout(() => {
            if (!isGalleryOpen()) return;
            const g = document.getElementById('gallery');
            if (!g) return;
            const btn = g.querySelector(':scope > .dragClose') || g.querySelector(':scope > .panelControlBar .dragClose');
            if (btn) { try { btn.click(); } catch (e) { /* ignore */ } }
        }, 100);
    }
    return closed;
}

async function preloadGalleryImages(timeoutMs = GALLERY_WARMUP_PRELOAD_TIMEOUT_MS) {
    const galleryEl = document.getElementById('gallery');
    if (!galleryEl) return 0;

    const urls = new Set();
    const collectUrls = () => {
        galleryEl.querySelectorAll('img').forEach(img => {
            if (img.src && img.src.startsWith('http')) urls.add(img.src);
            if (img.dataset && img.dataset.src) urls.add(img.dataset.src);
        });
    };
    collectUrls();

    if (urls.size === 0) {
        for (let i = 0; i < 5 && urls.size === 0; i++) {
            await wait(300);
            collectUrls();
        }
    }
    if (urls.size === 0) return 0;

    let loaded = 0;
    const promises = [...urls].map(url => new Promise(resolve => {
        const img = new Image();
        const timer = setTimeout(() => resolve(), timeoutMs);
        img.onload = () => { clearTimeout(timer); loaded++; resolve(); };
        img.onerror = () => { clearTimeout(timer); resolve(); };
        img.src = url;
    }));
    await Promise.race([Promise.all(promises), wait(timeoutMs)]);
    return loaded;
}

async function warmUpGallery() {
    if (warmupState !== 'idle') return;
    if (isGalleryOpen()) { warmupState = 'done'; return; }

    warmupState = 'running';

    const hideStyle = document.createElement('style');
    hideStyle.id = 'gic-gallery-warmup-hide';
    hideStyle.textContent = `
        #gallery, .nGY2Gallery, .nGY2GalleryTop, .nGY2GalleryBottom, [forchar="gallery"] {
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }
    `;
    document.head.appendChild(hideStyle);

    try {
        if (!openGalleryFromGic()) {
            warmupState = 'idle';
            hideStyle.remove();
            return;
        }

        let galleryEl = null;
        for (let round = 0; round < 3 && !galleryEl; round++) {
            if (warmupState === 'aborted') { hideStyle.remove(); return; }
            const appearStart = Date.now();
            while (Date.now() - appearStart < 8000) {
                if (warmupState === 'aborted') { hideStyle.remove(); return; }
                galleryEl = document.getElementById('gallery');
                if (galleryEl) break;
                await wait(200);
            }
            if (galleryEl) break;
            closeGalleryProgrammatically();
            await wait(700);
            clearGalleryOpenInFlight();
            _galleryOpenCache = { value: false, timestamp: 0 };
            lastGalleryStateForGic = null;
            openGalleryFromGic();
            await wait(1500);
        }

        if (!galleryEl) {
            warmupState = 'idle';
            hideStyle.remove();
            closeGalleryProgrammatically();
            return;
        }

        const contentStart = Date.now();
        while (Date.now() - contentStart < 15000) {
            if (warmupState === 'aborted') { hideStyle.remove(); return; }
            const ng2 = galleryEl.querySelector('.nGY2Gallery');
            const thumbs = galleryEl.querySelectorAll('.nGY2GThumbnail, .nGY2GThumbnail_l1');
            if (ng2 || thumbs.length > 0) break;
            await wait(200);
        }

        await preloadGalleryImages();
        if (warmupState === 'aborted') { hideStyle.remove(); return; }

        await wait(GALLERY_WARMUP_HOLD_MS);
        if (warmupState === 'aborted') { hideStyle.remove(); return; }

        closeGalleryProgrammatically();
        setTimeout(() => {
            hideStyle.remove();
            hideGalleryUploadMessage();
        }, 500);
        warmupState = 'done';
    } catch (e) {
        warmupState = 'idle';
        try { hideStyle.remove(); } catch (_) {}
    }
}

// ===== ステータスメッセージ =====
const STATUS_MESSAGE_ID = 'gic-status-message';
const STATUS_MESSAGE_STYLE_ID = 'gic-status-message-style';
let _statusMessageHideTimer = null;

function ensureStatusMessageStyle() {
    if (document.getElementById(STATUS_MESSAGE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STATUS_MESSAGE_STYLE_ID;
    style.textContent = `
        #${STATUS_MESSAGE_ID} {
            position: fixed; padding: 8px 16px;
            background-color: rgba(20, 20, 20, 0.92); color: #ffffff;
            font-size: 13px; font-weight: bold; font-family: sans-serif;
            border: 1px solid #666; border-radius: 6px; z-index: 15001;
            pointer-events: none; opacity: 0; transition: opacity 0.3s ease;
            box-shadow: 0 4px 20px rgba(0,0,0,0.7);
            text-align: center; white-space: nowrap;
            left: -9999px; top: -9999px;
        }
        #${STATUS_MESSAGE_ID}.gic-visible { opacity: 1; }
    `;
    document.head.appendChild(style);
}

function getStatusMessageEl() {
    ensureStatusMessageStyle();
    let el = document.getElementById(STATUS_MESSAGE_ID);
    if (!el) {
        el = document.createElement('div');
        el.id = STATUS_MESSAGE_ID;
        document.body.appendChild(el);
    }
    return el;
}

function positionStatusMessage() {
    const el = document.getElementById(STATUS_MESSAGE_ID);
    if (!el) return;
    if (!el.classList.contains('gic-visible')) return;
    const btn = document.getElementById(GALLERY_BUTTON_ID);
    if (!btn) return;
    const bRect = btn.getBoundingClientRect();
    if (bRect.width === 0 || bRect.height === 0) return;
    const margin = 8;
    const elW = el.offsetWidth || 200;
    const elH = el.offsetHeight || 36;
    let left = bRect.left - elW - margin;
    let top = bRect.top + (bRect.height - elH) / 2;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (left < margin) left = margin;
    if (left + elW > vw - margin) left = vw - margin - elW;
    if (top < margin) top = margin;
    if (top + elH > vh - margin) top = vh - margin - elH;
    el.style.setProperty('position', 'fixed', 'important');
    el.style.setProperty('left', Math.round(left) + 'px', 'important');
    el.style.setProperty('top', Math.round(top) + 'px', 'important');
    el.style.setProperty('right', 'auto', 'important');
    el.style.setProperty('bottom', 'auto', 'important');
    el.style.setProperty('transform', 'none', 'important');
}

function showStatusMessage(text, autoHideMs = 0) {
    if (_statusMessageHideTimer) { clearTimeout(_statusMessageHideTimer); _statusMessageHideTimer = null; }
    const el = getStatusMessageEl();
    el.textContent = text;
    void el.offsetWidth;
    el.classList.add('gic-visible');
    positionStatusMessage();
    requestAnimationFrame(positionStatusMessage);
    if (autoHideMs > 0) {
        _statusMessageHideTimer = setTimeout(() => {
            el.classList.remove('gic-visible');
            _statusMessageHideTimer = null;
        }, autoHideMs);
    }
}

function hideStatusMessage() {
    if (_statusMessageHideTimer) { clearTimeout(_statusMessageHideTimer); _statusMessageHideTimer = null; }
    const el = document.getElementById(STATUS_MESSAGE_ID);
    if (el) el.classList.remove('gic-visible');
}

// ===== ギャラリー準備 =====
let _galleryPreloadState = 'idle';
let _galleryPreparedFor = null;
let _galleryPrepareRetries = 0;

function setGalleryButtonLoading(loading) {
    const btn = document.getElementById(GALLERY_BUTTON_ID);
    if (!btn) return;
    if (loading) {
        btn.classList.add('gic-gallery-loading');
        btn.disabled = true;
        btn.title = 'ギャラリーを読み込み中です…';
    } else {
        btn.classList.remove('gic-gallery-loading');
        btn.disabled = false;
        btn.title = 'SillyTavern公式ギャラリーを開く';
    }
}

async function prepareGalleryForCharacter() {
    if (_galleryPreloadState === 'loading') return;
    if (_galleryPreloadState !== 'ready') {
        setGalleryButtonLoading(true);
        showStatusMessage('ギャラリーを読み込み中です…', 0);
    }

    let charName = getCurrentCharacterName();
    _galleryPrepareRetries = 0;
    while (!charName && _galleryPrepareRetries < GALLERY_PREPARE_MAX_RETRIES) {
        _galleryPrepareRetries++;
        await wait(GALLERY_PREPARE_RETRY_INTERVAL_MS);
        charName = getCurrentCharacterName();
    }

    if (!charName) {
        hideStatusMessage();
        _galleryPreloadState = 'idle';
        setGalleryButtonLoading(true);
        return;
    }

    if (_galleryPreparedFor === charName && _galleryPreloadState === 'ready') {
        setGalleryButtonLoading(false);
        hideStatusMessage();
        return;
    }

    _galleryPreloadState = 'loading';
    try {
        while (warmupState === 'running') await wait(100);
        warmupState = 'idle';
        await warmUpGallery();
        clearGalleryOpenInFlight();
        _galleryPreparedFor = charName;
        _galleryPreloadState = 'ready';
        showStatusMessage('読み込み完了', 1500);
        setGalleryButtonLoading(false);
    } catch (e) {
        _galleryPreloadState = 'idle';
        showStatusMessage('読み込みに失敗しました', 2000);
        setGalleryButtonLoading(false);
    }
}

// ===== ボタン生成 =====
function createReleaseButton() {
    const existing = document.getElementById(BUTTON_ID);
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.title = '事前設定モード（キーワードマッチ）と背景生成モード（生成画像）を切り替える';
    btn.textContent = isOverrideLocal ? LABEL_OVERRIDE : LABEL_NORMAL;

    Object.assign(btn.style, {
        position: 'fixed', left: '0', bottom: '49px', zIndex: '15000',
        padding: '6px 12px', fontSize: '12px', color: '#ffffff',
        backgroundColor: '#444', border: '1px solid #666',
        borderLeft: 'none', borderTopRightRadius: '6px', borderBottomRightRadius: '6px',
        cursor: 'pointer', opacity: '0.12',
        transition: 'opacity 0.15s ease, background-color 0.15s ease',
        userSelect: 'none', outline: 'none', whiteSpace: 'nowrap',
        pointerEvents: 'auto', touchAction: 'manipulation',
    });

    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; btn.style.backgroundColor = '#666'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.12'; btn.style.backgroundColor = '#444'; });

    let flashTimer = null;
    const flashBlue = () => {
        if (flashTimer) clearTimeout(flashTimer);
        btn.style.backgroundColor = '#0a84ff';
        btn.style.opacity = '1';
        flashTimer = setTimeout(() => {
            const hovering = btn.matches(':hover');
            btn.style.backgroundColor = hovering ? '#666' : '#444';
            btn.style.opacity = hovering ? '1' : '0.12';
            flashTimer = null;
        }, 250);
    };

    let lastActionTime = 0;
    const triggerAction = (source) => {
        const now = Date.now();
        if (now - lastActionTime < 200) return;
        lastActionTime = now;
        flashBlue();
        Promise.resolve(handleButtonAction()).catch(e => console.error('[GIC] handleButtonAction エラー:', e));
    };

    btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); triggerAction('pointerdown'); }, true);
    btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); triggerAction('click'); }, true);

    document.body.appendChild(btn);
    setButtonLabel(isOverrideLocal ? LABEL_OVERRIDE : LABEL_NORMAL);
    syncButtonVisibilityForTextStyling();
    requestAnimationFrame(positionGalleryButton);
}

function createGalleryButton() {
    const existing = document.getElementById(GALLERY_BUTTON_ID);
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.id = GALLERY_BUTTON_ID;
    btn.type = 'button';
    btn.title = 'SillyTavern公式ギャラリーを開く';
    btn.textContent = '🎨';

    Object.assign(btn.style, {
        position: 'fixed', left: '-9999px', top: '-9999px', zIndex: '15000',
        width: '50px', height: '50px', padding: '0', margin: '0',
        boxSizing: 'border-box', fontSize: '26px', lineHeight: '1',
        color: '#ffffff', backgroundColor: '#444',
        border: '1px solid #666', borderRadius: '4px',
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        opacity: '0.12', transition: 'opacity 0.15s ease, background-color 0.15s ease',
        userSelect: 'none', outline: 'none', whiteSpace: 'nowrap',
        pointerEvents: 'auto', touchAction: 'manipulation',
    });

    btn.classList.add('gic-gallery-loading');
    btn.disabled = true;

    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; btn.style.backgroundColor = '#666'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.12'; btn.style.backgroundColor = '#444'; });

    let flashTimer = null;
    const flashBlue = () => {
        if (flashTimer) clearTimeout(flashTimer);
        btn.style.backgroundColor = '#0a84ff';
        btn.style.opacity = '1';
        flashTimer = setTimeout(() => {
            const hovering = btn.matches(':hover');
            btn.style.backgroundColor = hovering ? '#666' : '#444';
            btn.style.opacity = hovering ? '1' : '0.12';
            flashTimer = null;
        }, 250);
    };

    let lastActionTime = 0;
    const triggerAction = () => {
        if (btn.classList.contains('gic-gallery-loading') || btn.disabled) return;
        const now = Date.now();
        if (now - lastActionTime < 200) return;
        lastActionTime = now;
        if (warmupState === 'running') {
            warmupState = 'aborted';
            clearGalleryOpenInFlight();
            const hs = document.getElementById('gic-gallery-warmup-hide');
            if (hs) hs.remove();
        }
        if (!isGalleryOpen() && warmupState !== 'running') clearGalleryOpenInFlight();
        flashBlue();
        openGalleryFromGic();
    };

    btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); triggerAction(); }, true);
    btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); triggerAction(); }, true);

    document.body.appendChild(btn);
    requestAnimationFrame(positionGalleryButton);
    syncGalleryButtonVisibility();
}

// ===== イベント登録 =====
function setupListeners() {
    const safeOn = (type, handler) => { if (type && eventSource?.on) eventSource.on(type, handler); };
    safeOn(event_types.MESSAGE_RECEIVED, scanForGeneratedImages);
    safeOn(event_types.CHARACTER_MESSAGE_RENDERED, scanForGeneratedImages);
    safeOn(event_types.USER_MESSAGE_RENDERED, scanForGeneratedImages);
    if (event_types.MESSAGE_UPDATED) safeOn(event_types.MESSAGE_UPDATED, scanForGeneratedImages);
    if (event_types.MESSAGE_SWIPED) safeOn(event_types.MESSAGE_SWIPED, scanForGeneratedImages);

    if (event_types.CHAT_CHANGED) {
        safeOn(event_types.CHAT_CHANGED, () => {
            scanForGeneratedImages();
            _galleryPreparedFor = null;
            _galleryPreloadState = 'idle';
            setTimeout(() => prepareGalleryForCharacter().catch(() => {}), 500);
        });
    }
    if (event_types.CHARACTER_SELECTED) {
        safeOn(event_types.CHARACTER_SELECTED, () => {
            _galleryPreparedFor = null;
            _galleryPreloadState = 'idle';
            setTimeout(() => prepareGalleryForCharacter().catch(() => {}), 300);
        });
    }
}

window.GicDumpGallery = function () {
    const gallery = document.getElementById('gallery');
    if (!gallery) { console.log('[GicDumpGallery] #gallery が見つかりません'); return; }
    const lines = [];
    const walk = (el, depth) => {
        if (depth > 6) return;
        const cls = (el.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
        const attrs = [];
        if (el.id) attrs.push(`#${el.id}`);
        if (el.hasAttribute('data-ngsrc')) attrs.push('[data-ngsrc]');
        if (el.hasAttribute('data-src')) attrs.push('[data-src]');
        const rect = el.getBoundingClientRect();
        const size = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
        lines.push(`${'  '.repeat(depth)}${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${attrs.join('')} ${size}`);
        if (depth < 6) Array.from(el.children).slice(0, 10).forEach(c => walk(c, depth + 1));
    };
    walk(gallery, 0);
    console.log('[GicDumpGallery] ギャラリーDOM構造:\n' + lines.join('\n'));
};

function exposeGicApi() {
    window.GicApi = {
        openGallery: () => openGalleryFromGic(),
        closeGallery: () => closeGalleryProgrammatically(),
        isOpen: () => isGalleryOpen(),
    };
    console.log('[GIC] ✅ window.GicApi を公開しました');
}

function initializeGIC() {
    console.log('[GIC] 初期化開始');
    loadPersistedState();
    installBulkDeleteDocumentHandlers();
    installGalleryCloseInterceptor();
    setupGalleryDedupeObserver();
    setupGalleryDragToJson();

    createReleaseButton();
    createGalleryButton();
    setupListeners();
    setupTextStylingObserver();
    setupGalleryObserverForGic();
    exposeGicApi();

    validatePersistedState().catch(e => console.warn('[GIC] 永続化状態の検証に失敗:', e));
    ensureSdSourceConsistency().catch(e => console.warn('[GIC] SDソース整合性チェックに失敗:', e));

    setInterval(() => {
        scanForGeneratedImages();
        syncButtonVisibilityForTextStyling();
        syncGalleryButtonVisibility();
        markGeneratedMessagesInDom();
        positionGalleryButton();
        positionStatusMessage();
        applyGalleryLayout();
        hideGalleryUploadMessage();
        const pager = document.querySelector('.gic-pagination-pager');
        if (pager) positionPager(pager);
    }, 1500);

    // ★ 100ms 毎にギャラリー位置を強制チェック（movingUIリセット等への保険）
    setInterval(() => {
        if (window.__gicDragInProgress) return;
        if (Date.now() < (window.__gicNoLayoutUntil || 0)) return;
        const g = document.getElementById('gallery');
        if (!g) return;
        const cs = getComputedStyle(g);
        if (cs.position !== 'fixed' || cs.left !== '0px') {
            g.style.setProperty('position', 'fixed', 'important');
            g.style.setProperty('left', '0', 'important');
            g.style.setProperty('top', '50%', 'important');
            g.style.setProperty('transform', 'translateY(-50%)', 'important');
        }
    }, 100);

    scanForGeneratedImages();
    syncButtonVisibilityForTextStyling();
    syncGalleryButtonVisibility();
    applyGalleryLayout();
}

function bootstrapGIC() {
    let started = false;
    const startOnce = () => {
        if (started) return;
        started = true;
        try {
            if (document.body) initializeGIC();
            else setTimeout(() => {
                if (document.body) initializeGIC();
                else document.addEventListener('DOMContentLoaded', initializeGIC);
            }, 100);
        } catch (e) {
            console.error('[GIC] 初期化中に例外:', e);
        }
    };

    if (eventSource && event_types && event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, startOnce);
        setTimeout(startOnce, 5000);
    } else {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startOnce);
        else startOnce();
    }
}

bootstrapGIC();

export async function activate() {
    console.log('[GIC] activate() が呼ばれました');
    loadPersistedState();
    installBulkDeleteDocumentHandlers();
    installGalleryCloseInterceptor();
    setupGalleryDedupeObserver();
    setupGalleryDragToJson();
    createReleaseButton();
    createGalleryButton();
    setupGalleryObserverForGic();
    applyGalleryLayout();
    exposeGicApi();
    ensureSdSourceConsistency().catch(() => {});
    validatePersistedState().catch(() => {});
    console.log('[GIC] ✅ Generate Image Controller: アクティベート完了');
}
