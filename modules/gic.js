// gic.js

import './comfy_boot.js';
import './gic_lorebook.js';
import { eventSource, event_types, saveChat, printMessages, getRequestHeaders } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';

console.log('[GIC] モジュールロード開始');

// ============================================================
// ★ /api/images/list で「元画像 → サムネイル」置換
//    - _img_thum.png 自体はリストから除外（2倍表示防止）
//    - 元画像 image.png を image_img_thum.png に置換（存在時のみ）
//    - これにより nanogallery2 は最初からサムネイル URL を設定する
//    - ブラウザは元画像 (1280x720) を一切 fetch しない
// ============================================================
(function installImgThumbListFilter() {
    if (window.__gicImgThumbListFilterInstalled) return;
    window.__gicImgThumbListFilterInstalled = true;

    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (!url.includes('/api/images/list')) {
            return origFetch.apply(this, arguments);
        }

        const resp = await origFetch.apply(this, arguments);
        if (!resp.ok) return resp;

        try {
            const data = await resp.clone().json();
            if (!Array.isArray(data)) return resp;

            const set = new Set(data.filter(f => typeof f === 'string'));

            let replaced = 0;
            let removed = 0;
            const filtered = [];
            for (const f of data) {
                if (typeof f !== 'string') { filtered.push(f); continue; }

                /* _img_thum.png 自体は除外（2倍表示防止） */
                if (f.endsWith('_img_thum.png')) { removed++; continue; }

                /* 元画像 → サムネイル置換（サムネが存在する時のみ） */
                if (/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(f)) {
                    const thumbName = imageFileToThumbName(f);
                    if (thumbName && set.has(thumbName)) {
                        filtered.push(thumbName);
                        replaced++;
                        continue;
                    }
                }
                filtered.push(f);
            }

            if (replaced === 0 && removed === 0) return resp;

            console.debug(`[GIC] 🚫 /api/images/list: 元画像→サムネ置換 ${replaced}件, _img_thum除外 ${removed}件`);
            return new Response(JSON.stringify(filtered), {
                status: resp.status,
                statusText: resp.statusText,
                headers: resp.headers,
            });
        } catch (e) {
            return resp;
        }
    };
    console.log('[GIC] 🚫 /api/images/list で元画像→サムネイル置換を有効化');
})();

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
const GALLERY_WINDOW_WIDTH_EXTRA = 350;
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

// === Video Thumbnail Cache ===
const THUMB_SIZE = 200;
const THUMB_SUFFIX = '_thum.png';
const THUMB_CONCURRENCY = 2;
const THUMB_GEN_TIMEOUT_MS = 30000;
const THUMB_EXIST_CACHE_TTL_MS = 60000;

// === IndexedDB Thumbnail Cache ===
const THUMB_DB_NAME = 'gic_thumbnails';
const THUMB_DB_STORE = 'thumbs';
const THUMB_DB_VERSION = 1;

// === Image Blob Cache (通常画像用) ===
const IMG_DB_NAME = 'gic_image_cache';
const IMG_DB_STORE = 'images';
const IMG_DB_VERSION = 1;
const IMG_PRELOAD_CHUNK = 3;
const IMG_PRELOAD_DELAY_MS = 50;

// === Image Thumbnail Cache (画像用 200x200 サムネイル) ===
const IMG_THUMB_SUFFIX = '_img_thum.png';
const IMG_THUMB_SIZE = 200;
const IMG_THUMB_MANIFEST_KEY = 'gic_image_thumb_manifest';

// 既知の画像サムネイル（メモリマニフェスト）
const _imgThumbKnown = new Set();

// ===== 状態 =====
let lastGeneratedImageUrl = null;
let isOverrideLocal = false;
const processedMessageKeys = new Set();

let currentPreviewEl = null;
let isApplyingLayout = false;

const galleryBaseHeightCache = new WeakMap();

const galleryBaseWidthCache = new WeakMap();
let _lastWindowWidthForGallery = 0;

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

// ===== 一括選択機能の状態 =====
let _bulkDeleteMode = false;
const _bulkDeleteSelected = new Map();
let _bulkDeleteHeaderObserver = null;
let _lastTrashToggleAt = 0;
const TRASH_TOGGLE_DEBOUNCE_MS = 1500;

let _sdSourceChecked = false;

// ★ 動画サムネイルキャッシュ状態
const _thumbExistCache = new Map();
const _thumbUrlCache = new Map();
let _thumbProcessingActive = false;
let _thumbDbPromise = null;

// ★ 画像 blob キャッシュ状態
let _imgDbPromise = null;
const _imgBlobUrlCache = new Map();
let _imgPreloading = false;

// ★ ギャラリーの開閉状態追跡
let lastGalleryStateForGic = null;

// ★ STJEditor 再オープンの状態
let _stjReopenScheduled = false;

// ★ ページ切替時のレイアウトロック
let _pageSwitchInProgress = false;
let _pageSwitchOrigVisibility = '';

// ===== ユーティリティ =====
function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function isVideoFile(url) {
    if (!url || typeof url !== 'string') return false;
    return /\.(mp4|webm)(\?|#|$)/i.test(url);
}

function fullUrlFromPath(path) {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    return '/' + path.replace(/^\/+/, '');
}

function checkImageExists(url) {
    if (!url || typeof url !== 'string' || !url.trim()) {
        return Promise.resolve(false);
    }
    const cleanUrl = url.trim();

    return new Promise((resolve) => {
        if (isVideoFile(cleanUrl)) {
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
            transform: scale(${GALLERY_PREVIEW_CLOSE_SCALE}) !important;
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
            width: 38px !important;
            min-width: 38px !important;
            max-width: 38px !important;
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
            content: var(--gic-bulk-banner-text, '一括選択モード — 画像クリックで選択');
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

        .gic-dragging-to-json {
            opacity: 0.5 !important;
            outline: 3px solid #ffd54f !important;
            outline-offset: -3px !important;
        }

        body.gic-dragging #gallery,
        body.gic-dragging #gallery * {
            transition: none !important;
            animation: none !important;
        }

        body.gic-dragging .gic-pagination-pager,
        body.gic-dragging .gic-pagination-pager * {
            pointer-events: none !important;
            user-select: none !important;
        }

        body.gic-dragging #gallery,
        body.gic-dragging #gallery * {
            pointer-events: none !important;
        }

        /* ============================================================
           ★ 動画サムネイル用 🎬 バッジ
           ============================================================ */
        .gic-video-badge {
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            font-size: 24px !important;
            line-height: 1 !important;
            pointer-events: none !important;
            z-index: 10 !important;
            opacity: 0.95 !important;
            user-select: none !important;
            -webkit-user-select: none !important;
            filter:
                drop-shadow(1px 0 0 #ffffff)
                drop-shadow(-1px 0 0 #ffffff)
                drop-shadow(0 1px 0 #ffffff)
                drop-shadow(0 -1px 0 #ffffff)
                drop-shadow(1px 1px 0 #ffffff)
                drop-shadow(-1px -1px 0 #ffffff)
                drop-shadow(1px -1px 0 #ffffff)
                drop-shadow(-1px 1px 0 #ffffff)
                drop-shadow(0 2px 3px rgba(0, 0, 0, 0.9)) !important;
        }

        /* ============================================================
           ★ ギャラリーサムネイル: 正方形
           ============================================================ */
        #gallery .nGY2GThumbnail,
        #gallery .nGY2GThumbnail_l1,
        #gallery .nGY2Item {
            background-color: #000 !important;
            box-sizing: border-box !important;
            overflow: hidden !important;
            opacity: 1 !important;
            border: 0 !important;
            padding: 0 !important;
            margin: 0 !important;
        }

        #gallery .nGY2GThumbnail::before,
        #gallery .nGY2GThumbnail_l1::before,
        #gallery .nGY2Item::before {
            display: none !important;
        }

        #gallery .nGY2GThumbnailSub {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            height: 100% !important;
            max-width: 100% !important;
            max-height: 100% !important;
            padding: 0 !important;
            margin: 0 !important;
            border: 0 !important;
            box-sizing: border-box !important;
            overflow: hidden !important;
        }

        #gallery .nGY2TnImg {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            height: 100% !important;
            max-width: 100% !important;
            max-height: 100% !important;
            background-image: none !important;
            background-size: contain !important;
            background-position: center center !important;
            background-repeat: no-repeat !important;
            background-color: transparent !important;
            z-index: 1 !important;
            visibility: visible !important;
            transform: none !important;
            margin: 0 !important;
            padding: 0 !important;
            border: 0 !important;
            box-sizing: border-box !important;
        }

        #gallery .nGY2TnImgBack {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            height: 100% !important;
            max-width: 100% !important;
            max-height: 100% !important;
            background-image: none !important;
            background-color: transparent !important;
            z-index: 0 !important;
            opacity: 0 !important;
            visibility: hidden !important;
            transform: none !important;
            margin: 0 !important;
            padding: 0 !important;
            border: 0 !important;
            box-sizing: border-box !important;
        }

        #gallery .nGY2GThumbnailImg,
        #gallery .nGY2TnImg2 {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            height: 100% !important;
            max-width: 100% !important;
            max-height: 100% !important;
            object-fit: contain !important;
            padding: 0 !important;
            margin: 0 !important;
            border: 0 !important;
            box-sizing: border-box !important;
            display: none !important;
            opacity: 0 !important;
            visibility: hidden !important;
        }

        #gallery .nGY2GThumbnail > img,
        #gallery .nGY2GThumbnail_l1 > img,
        #gallery .gic-gallery-thumb-img {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            height: 100% !important;
            max-width: 100% !important;
            max-height: 100% !important;
            object-fit: contain !important;
            display: block !important;
            z-index: 2 !important;
            opacity: 1 !important;
            visibility: visible !important;
            pointer-events: none !important;
            transform: none !important;
            margin: 0 !important;
            padding: 0 !important;
            background-color: transparent !important;
        }

        #gallery .gic-gallery-image-cached {
            position: absolute !important;
            top: 0 !important;
            left: 0 !important;
            width: 100% !important;
            height: 100% !important;
            max-width: 100% !important;
            max-height: 100% !important;
            object-fit: contain !important;
            display: block !important;
            z-index: 2 !important;
            opacity: 1 !important;
            visibility: visible !important;
            pointer-events: none !important;
            margin: 0 !important;
            padding: 0 !important;
            background-color: transparent !important;
        }

        #gallery.gic-page-switching .nGY2GThumbnail,
        #gallery.gic-page-switching .nGY2GThumbnail_l1,
        #gallery.gic-page-switching .nGY2Item,
        #gallery.gic-page-switching .nGY2GallerySub,
        #gallery.gic-page-switching .nGY2GallerySub * {
            transition: none !important;
            animation: none !important;
            visibility: hidden !important;
        }

        body.gic-bulk-delete-mode #gallery .dragTitle {
            visibility: hidden !important;
            pointer-events: none !important;
        }

        body.gic-bulk-delete-mode #gallery .dragTitle > [title="Delete mode"],
        body.gic-bulk-delete-mode #gallery .dragTitle > .fa-trash,
        body.gic-bulk-delete-mode #gallery .dragTitle > [class*="fa-trash"] {
            visibility: visible !important;
            pointer-events: auto !important;
        }

        body.gic-bulk-delete-mode #gallery::before {
            right: auto !important;
            left: 0 !important;
            text-align: left !important;
        }

        #gic-floating-bulk-exit {
            display: none;
            position: fixed;
            align-items: center;
            justify-content: center;
            height: 28px;
            padding: 0 8px;
            font-size: 12px;
            font-weight: bold;
            font-family: inherit;
            color: #ffffff;
            background-color: #d9534f;
            border: 2px solid #ffffff;
            border-radius: 4px;
            cursor: pointer;
            user-select: none;
            box-sizing: border-box;
            white-space: nowrap;
            pointer-events: auto;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
            z-index: 2147483647;
            transition: background-color 0.15s ease;
        }
        body.gic-bulk-delete-mode #gic-floating-bulk-exit {
            display: inline-flex;
        }
        #gic-floating-bulk-exit:hover {
            background-color: #c9302c;
        }
    `;
    document.head.appendChild(style);
    console.log('[GIC] 🖼️ ギャラリー配置CSSを注入しました');
})();

// ============================================================
// ★ 画像サムネイルマニフェストを localStorage から復元
// ============================================================
(function loadImgThumbManifest() {
    try {
        const raw = localStorage.getItem(IMG_THUMB_MANIFEST_KEY);
        if (!raw) return;
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach(k => _imgThumbKnown.add(k));
        console.log(`[GIC] 画像サムネイルマニフェスト復元: ${_imgThumbKnown.size} 件`);
    } catch (e) { /* ignore */ }
})();

function saveImgThumbManifest() {
    try {
        localStorage.setItem(IMG_THUMB_MANIFEST_KEY, JSON.stringify([..._imgThumbKnown]));
    } catch (e) { /* ignore */ }
}

function imageFileToThumbName(fileName) {
    if (!fileName || typeof fileName !== 'string') return null;
    const m = fileName.match(/^(.+)\.(png|jpe?g|webp|gif|avif|bmp)$/i);
    if (!m) return null;
    return `${m[1]}${IMG_THUMB_SUFFIX}`;
}

function isImageThumbName(name) {
    return typeof name === 'string' && name.endsWith(IMG_THUMB_SUFFIX);
}

function imgThumbNameToOriginal(thumbName) {
    if (!thumbName || typeof thumbName !== 'string') return null;
    if (!thumbName.endsWith(IMG_THUMB_SUFFIX)) return null;
    return thumbName.slice(0, -IMG_THUMB_SUFFIX.length) + '.png';
}

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

function isGalleryOpen() {
    const primary = document.getElementById('gallery');

    if (primary && primary.classList.contains('gic-page-switching')) {
        return true;
    }

    const now = performance.now();
    if (now - _galleryOpenCache.timestamp < GALLERY_OPEN_CACHE_TTL) {
        return _galleryOpenCache.value;
    }

    let result = false;

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
// ★ 動画サムネイル・キャッシュ機構
// ============================================================
function videoFileToThumbName(videoFileName) {
    if (!videoFileName || typeof videoFileName !== 'string') return null;
    const m = videoFileName.match(/^(.+)\.(mp4|webm)$/i);
    if (!m) return null;
    return `${m[1]}_${m[2].toLowerCase()}${THUMB_SUFFIX}`;
}

function isThumbFileName(name) {
    return typeof name === 'string' && name.endsWith(THUMB_SUFFIX);
}

async function checkFileExists(url, useCache = true) {
    if (useCache) {
        const c = _thumbExistCache.get(url);
        if (c && Date.now() - c.ts < THUMB_EXIST_CACHE_TTL_MS) return c.exists;
    }
    let exists = false;
    try {
        const resp = await fetch(url, { method: 'HEAD' });
        if (resp.ok) {
            const ct = (resp.headers.get('content-type') || '').toLowerCase();
            exists = !ct.includes('text/html');
        }
    } catch (e) { /* ignore */ }
    _thumbExistCache.set(url, { exists, ts: Date.now() });
    return exists;
}

async function generateVideoThumbnailBlob(videoUrl, size = THUMB_SIZE) {
    return new Promise((resolve) => {
        const video = document.createElement('video');
        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('muted', '');
        video.setAttribute('playsinline', '');
        video.setAttribute('webkit-playsinline', '');
        video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:100px;height:100px;opacity:0.01;pointer-events:none;';
        document.body.appendChild(video);

        let done = false;
        let frameExtracted = false;

        const cleanup = () => {
            try { video.pause(); } catch (e) { /* ignore */ }
            try { video.remove(); } catch (e) { /* ignore */ }
        };
        const finish = (r) => {
            if (done) return;
            done = true;
            cleanup();
            resolve(r);
        };

        const timeout = setTimeout(() => {
            console.warn(`[GIC] ❌ thumbnail gen timeout (${THUMB_GEN_TIMEOUT_MS}ms): ${videoUrl} (readyState=${video.readyState}, networkState=${video.networkState})`);
            finish(null);
        }, THUMB_GEN_TIMEOUT_MS);

        const extractFrame = () => {
            if (frameExtracted || done) return;
            frameExtracted = true;
            try {
                const vw = video.videoWidth || 0;
                const vh = video.videoHeight || 0;
                if (!vw || !vh) {
                    console.warn('[GIC] ❌ video dimensions are 0:', videoUrl, `(${vw}x${vh})`);
                    clearTimeout(timeout);
                    return finish(null);
                }
                const scale = Math.min(size / vw, size / vh);
                const w = Math.max(1, Math.round(vw * scale));
                const h = Math.max(1, Math.round(vh * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    console.warn('[GIC] ❌ canvas 2d context unavailable');
                    clearTimeout(timeout);
                    return finish(null);
                }
                ctx.drawImage(video, 0, 0, w, h);
                canvas.toBlob((blob) => {
                    clearTimeout(timeout);
                    if (!blob) {
                        console.warn('[GIC] ❌ canvas.toBlob returned null:', videoUrl);
                        return finish(null);
                    }
                    console.log(`[GIC] ✅ thumbnail generated: ${videoUrl} → ${w}x${h}, ${blob.size} bytes`);
                    finish(blob);
                }, 'image/png', 0.85);
            } catch (e) {
                console.warn('[GIC] ❌ extractFrame error:', e);
                clearTimeout(timeout);
                finish(null);
            }
        };

        video.addEventListener('loadeddata', () => {
            console.log(`[GIC] 📹 loadeddata: ${videoUrl}, readyState=${video.readyState}, duration=${video.duration}`);
            if (video.readyState >= 2) extractFrame();
        }, { once: true });

        video.addEventListener('canplay', () => {
            if (!frameExtracted) {
                console.log(`[GIC] 📹 canplay fallback: ${videoUrl}`);
                extractFrame();
            }
        }, { once: true });

        video.addEventListener('seeked', () => {
            if (!frameExtracted) {
                console.log(`[GIC] 📹 seeked fallback: ${videoUrl}`);
                extractFrame();
            }
        }, { once: true });

        video.addEventListener('error', () => {
            console.warn(`[GIC] ❌ video error: ${videoUrl}`, video.error?.code, video.error?.message);
            clearTimeout(timeout);
            finish(null);
        }, { once: true });

        video.src = videoUrl;
        try { video.load(); } catch (e) { /* ignore */ }
    });
}

// ============================================================
// ★ IndexedDB ベースの動画サムネイル永続キャッシュ
// ============================================================
function openThumbDB() {
    if (_thumbDbPromise) return _thumbDbPromise;
    _thumbDbPromise = new Promise((resolve, reject) => {
        try {
            const req = indexedDB.open(THUMB_DB_NAME, THUMB_DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(THUMB_DB_STORE)) {
                    db.createObjectStore(THUMB_DB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => { _thumbDbPromise = null; reject(req.error); };
        } catch (e) {
            _thumbDbPromise = null;
            reject(e);
        }
    });
    return _thumbDbPromise;
}

async function getThumbFromDB(key) {
    try {
        const db = await openThumbDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(THUMB_DB_STORE, 'readonly');
            const req = tx.objectStore(THUMB_DB_STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch (e) { return null; }
}

async function putThumbInDB(key, blob) {
    try {
        const db = await openThumbDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(THUMB_DB_STORE, 'readwrite');
            tx.objectStore(THUMB_DB_STORE).put(blob, key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { return false; }
}

async function deleteThumbFromDB(key) {
    try {
        const db = await openThumbDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(THUMB_DB_STORE, 'readwrite');
            tx.objectStore(THUMB_DB_STORE).delete(key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { return false; }
}

async function clearAllThumbCache() {
    try {
        const db = await openThumbDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(THUMB_DB_STORE, 'readwrite');
            tx.objectStore(THUMB_DB_STORE).clear();
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
        _thumbUrlCache.clear();
        console.log('[GIC] 🧹 IndexedDB サムネイルキャッシュを全消去しました');
        return true;
    } catch (e) {
        console.warn('[GIC] サムネイルキャッシュ消去に失敗:', e);
        return false;
    }
}

async function getThumbCacheStats() {
    try {
        const db = await openThumbDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(THUMB_DB_STORE, 'readonly');
            const store = tx.objectStore(THUMB_DB_STORE);
            const keysReq = store.getAllKeys();
            const countReq = store.count();
            let keys = [], count = 0;
            keysReq.onsuccess = () => { keys = keysReq.result || []; };
            countReq.onsuccess = () => { count = countReq.result || 0; };
            tx.oncomplete = () => resolve({ count, keys });
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { return { count: 0, keys: [] }; }
}

// ============================================================
// ★ 通常画像用 IndexedDB blob キャッシュ
// ============================================================
function openImgDB() {
    if (_imgDbPromise) return _imgDbPromise;
    _imgDbPromise = new Promise((resolve, reject) => {
        try {
            const req = indexedDB.open(IMG_DB_NAME, IMG_DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IMG_DB_STORE)) {
                    db.createObjectStore(IMG_DB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => { _imgDbPromise = null; reject(req.error); };
        } catch (e) {
            _imgDbPromise = null;
            reject(e);
        }
    });
    return _imgDbPromise;
}

async function getImgFromDB(key) {
    try {
        const db = await openImgDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IMG_DB_STORE, 'readonly');
            const req = tx.objectStore(IMG_DB_STORE).get(key);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch (e) { return null; }
}

async function putImgInDB(key, blob) {
    try {
        const db = await openImgDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IMG_DB_STORE, 'readwrite');
            tx.objectStore(IMG_DB_STORE).put(blob, key);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) { return false; }
}

async function clearAllImageCache() {
    try {
        const db = await openImgDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IMG_DB_STORE, 'readwrite');
            tx.objectStore(IMG_DB_STORE).clear();
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
        _imgBlobUrlCache.forEach(url => {
            try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
        });
        _imgBlobUrlCache.clear();
        _imgThumbKnown.clear();
        localStorage.removeItem(IMG_THUMB_MANIFEST_KEY);
        window.__gicCacheWarmedFor = null;
        console.log('[GIC] 🧹 画像 blob キャッシュを全消去しました');
        return true;
    } catch (e) {
        console.warn('[GIC] 画像キャッシュ消去に失敗:', e);
        return false;
    }
}

async function fetchAndCacheImage(charName, fileName) {
    if (!charName || !fileName) return null;
    const cacheKey = `${charName}:${fileName}`;

    if (_imgBlobUrlCache.has(cacheKey)) {
        return _imgBlobUrlCache.get(cacheKey);
    }

    const cachedBlob = await getImgFromDB(cacheKey);
    if (cachedBlob) {
        const url = URL.createObjectURL(cachedBlob);
        _imgBlobUrlCache.set(cacheKey, url);
        return url;
    }

    const url = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(fileName);
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const blob = await resp.blob();
        await putImgInDB(cacheKey, blob);
        const blobUrl = URL.createObjectURL(blob);
        _imgBlobUrlCache.set(cacheKey, blobUrl);
        return blobUrl;
    } catch (e) {
        return null;
    }
}

function getUploadHeaders() {
    try {
        const headers = { ...getRequestHeaders() };
        Object.keys(headers).forEach(k => {
            if (k.toLowerCase() === 'content-type') delete headers[k];
        });
        return headers;
    } catch (e) { return {}; }
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

async function uploadThumbnailBlob(charName, blob, thumbName) {
    if (!blob || !thumbName || !charName) return false;
    try {
        const dataUrl = await blobToBase64(blob);
        const base64Data = String(dataUrl).split(',')[1];
        if (!base64Data) return false;

        const filenameNoExt = thumbName.replace(/\.png$/i, '');
        const resp = await fetch('/api/images/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                image: base64Data,
                format: 'png',
                filename: filenameNoExt,
                ch_name: charName,
            }),
        });
        if (!resp.ok) {
            let text = '';
            try { text = await resp.text(); } catch (e) { /* ignore */ }
            console.warn(`[GIC] thumbnail upload failed: ${resp.status} body="${text.slice(0, 300)}"`);
            return false;
        }
        console.log(`[GIC] ✅ thumbnail uploaded: ${charName}/${thumbName}`);
        return true;
    } catch (e) {
        console.warn('[GIC] thumbnail upload error:', e);
        return false;
    }
}

async function ensureThumbnailForVideo(videoFileName, charName = getCurrentCharacterName()) {
    if (!videoFileName || !charName) return null;
    const cacheKey = `${charName}:${videoFileName}`;

    if (_thumbUrlCache.has(cacheKey)) {
        const cached = _thumbUrlCache.get(cacheKey);
        if (cached) return cached;
        _thumbUrlCache.delete(cacheKey);
    }

    const cachedBlob = await getThumbFromDB(cacheKey);
    if (cachedBlob) {
        const url = URL.createObjectURL(cachedBlob);
        _thumbUrlCache.set(cacheKey, url);
        console.log(`[GIC] ⚡ thumbnail from IndexedDB: ${cacheKey}`);

        const thumbName = videoFileToThumbName(videoFileName);
        if (thumbName) {
            const diskUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(thumbName);
            if (!(await checkFileExists(diskUrl))) {
                console.log(`[GIC] 💾 IndexedDB → ディスク書き出し: ${thumbName}`);
                await uploadThumbnailBlob(charName, cachedBlob, thumbName);
                _thumbExistCache.delete(diskUrl);
            }
        }
        return url;
    }

    const thumbName = videoFileToThumbName(videoFileName);
    if (thumbName) {
        const thumbUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(thumbName);
        if (await checkFileExists(thumbUrl)) {
            _thumbUrlCache.set(cacheKey, thumbUrl);
            return thumbUrl;
        }
    }

    const videoUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(videoFileName);
    console.log(`[GIC] 🎬 generating thumbnail: ${cacheKey}`);
    const blob = await generateVideoThumbnailBlob(videoUrl, THUMB_SIZE);
    if (!blob) {
        console.warn(`[GIC] ❌ thumbnail generation failed: ${cacheKey}`);
        return null;
    }

    const saved = await putThumbInDB(cacheKey, blob);
    if (!saved) console.warn(`[GIC] ⚠️ IndexedDB save failed: ${cacheKey}`);

    if (thumbName) {
        const ok = await uploadThumbnailBlob(charName, blob, thumbName);
        if (ok) {
            const diskUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(thumbName);
            _thumbExistCache.delete(diskUrl);
        }
    }

    const url = URL.createObjectURL(blob);
    _thumbUrlCache.set(cacheKey, url);
    return url;
}

// ============================================================
// ★ 画像サムネイル（200x200）の生成・キャッシュ
//    ★ ディスク保存も行う（/api/images/list 置換に必須）
// ============================================================
async function generateImageThumbnailBlob(imageUrl, size = IMG_THUMB_SIZE) {
    return new Promise((resolve) => {
        const img = new Image();
        /* ★ crossOrigin は不要（同一オリジン）なので削除 */
        img.onload = () => {
            try {
                const vw = img.naturalWidth;
                const vh = img.naturalHeight;
                if (!vw || !vh) return resolve(null);

                const scale = Math.min(size / vw, size / vh);
                const w = Math.max(1, Math.round(vw * scale));
                const h = Math.max(1, Math.round(vh * scale));

                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                if (!ctx) return resolve(null);

                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, size, size);

                const offsetX = (size - w) / 2;
                const offsetY = (size - h) / 2;
                ctx.drawImage(img, offsetX, offsetY, w, h);

                canvas.toBlob((blob) => {
                    resolve(blob);
                }, 'image/png', 0.85);
            } catch (e) {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = imageUrl;
    });
}

async function ensureImageThumbnail(imageFileName, charName) {
    if (!imageFileName || !charName) return null;

    const manifestKey = `${charName}:${imageFileName}`;
    const cacheKey = `${charName}:${imageFileName}:imgthumb`;

    /* ★ メモリキャッシュヒット時もディスク存在確認 + 書き出し */
    if (_imgBlobUrlCache.has(cacheKey)) {
        const url = _imgBlobUrlCache.get(cacheKey);
        const thumbName = imageFileToThumbName(imageFileName);
        if (thumbName) {
            const diskUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(thumbName);
            if (!(await checkFileExists(diskUrl))) {
                try {
                    const blob = await getImgFromDB(cacheKey);
                    if (blob) {
                        console.log(`[GIC] 💾 メモリキャッシュ → ディスク書き出し: ${thumbName}`);
                        await uploadThumbnailBlob(charName, blob, thumbName);
                        _thumbExistCache.delete(diskUrl);
                    }
                } catch (e) { /* ignore */ }
            }
        }
        return url;
    }

    const cachedBlob = await getImgFromDB(cacheKey);
    if (cachedBlob) {
        const url = URL.createObjectURL(cachedBlob);
        _imgBlobUrlCache.set(cacheKey, url);
        if (!_imgThumbKnown.has(manifestKey)) {
            _imgThumbKnown.add(manifestKey);
            saveImgThumbManifest();
        }
        /* ★ IndexedDB にあるがディスクに無い場合は書き出す */
        const thumbName = imageFileToThumbName(imageFileName);
        if (thumbName) {
            const diskUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(thumbName);
            if (!(await checkFileExists(diskUrl))) {
                console.log(`[GIC] 💾 IndexedDB → ディスク書き出し: ${thumbName}`);
                await uploadThumbnailBlob(charName, cachedBlob, thumbName);
                _thumbExistCache.delete(diskUrl);
            }
        }
        return url;
    }

    const imageUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(imageFileName);
    const blob = await generateImageThumbnailBlob(imageUrl, IMG_THUMB_SIZE);
    if (!blob) return null;

    await putImgInDB(cacheKey, blob);

    /* ★ ディスク保存（/api/images/list 置換に必須） */
    const thumbName = imageFileToThumbName(imageFileName);
    if (thumbName) {
        const ok = await uploadThumbnailBlob(charName, blob, thumbName);
        if (ok) {
            const diskUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(thumbName);
            _thumbExistCache.delete(diskUrl);
        }
    }

    _imgThumbKnown.add(manifestKey);
    saveImgThumbManifest();

    const url = URL.createObjectURL(blob);
    _imgBlobUrlCache.set(cacheKey, url);
    return url;
}

// ============================================================
// ★ 動画サムネイルに 🎬 バッジを付与
// ============================================================
function isVideoThumbnail(thumb) {
    if (!thumb) return false;
    const title = (thumb.getAttribute('title') || '').trim();

    if (title.endsWith('_img_thum.png')) return false;

    if (/_thum\.png$/i.test(title)) return true;
    if (thumb.querySelector('.gic-gallery-thumb-img')) return true;
    if (thumb.querySelector('video.gic-gallery-video')) return true;
    return false;
}

function syncVideoBadgeForThumb(thumb) {
    if (!thumb) return;

    const title = (thumb.getAttribute('title') || '').trim();
    if (title.endsWith('_img_thum.png')) {
        thumb.querySelectorAll('.gic-video-badge').forEach(el => el.remove());
        return;
    }

    const isVid = isVideoThumbnail(thumb);
    const badges = thumb.querySelectorAll('.gic-video-badge');

    if (isVid) {
        if (badges.length === 1) return;
        badges.forEach(el => el.remove());

        const cs = window.getComputedStyle(thumb);
        if (cs.position === 'static') {
            thumb.style.setProperty('position', 'relative', 'important');
        }

        const badge = document.createElement('div');
        badge.className = 'gic-video-badge';
        badge.textContent = '🎬';
        thumb.appendChild(badge);
    } else if (badges.length > 0) {
        badges.forEach(el => el.remove());
    }
}

function scanAndSyncVideoBadges() {
    const gallery = document.getElementById('gallery');
    if (!gallery) return;
    const selector = '.nGY2GThumbnail, .nGY2GThumbnail_l1, .nGY2Item';
    gallery.querySelectorAll(selector).forEach(syncVideoBadgeForThumb);
}

// ============================================================
// ★ サムネの background-image を「即座にブロック → blob 適用」
// ============================================================
function applyThumbnailBlobImmediately(thumb, blobUrl) {
    if (!thumb || !blobUrl) return;

    thumb.querySelectorAll('.nGY2TnImg, .nGY2TnImgBack, .nGY2TnImg2, .nGY2GThumbnailImg').forEach(el => {
        el.style.setProperty('background-image', 'none', 'important');
        el.style.setProperty('opacity', '0', 'important');
        if (el.tagName === 'IMG') {
            el.style.setProperty('display', 'none', 'important');
            el.style.setProperty('visibility', 'hidden', 'important');
        }
    });

    thumb.querySelectorAll('.gic-gallery-image-cached').forEach(el => el.remove());

    const img = document.createElement('img');
    img.className = 'gic-gallery-image-cached';
    img.src = blobUrl;
    img.style.cssText =
        'position:absolute;top:0;left:0;width:100%;height:100%;' +
        'object-fit:contain;pointer-events:none;z-index:2;background:transparent;';
    thumb.appendChild(img);
}

async function processGalleryImageThumb(thumb, fileName, charName) {
    if (!thumb || !fileName || !charName) return;

    const thumbUrl = await ensureImageThumbnail(fileName, charName);

    if (!thumbUrl) {
        try {
            const origUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(fileName);
            thumb.querySelectorAll('.nGY2TnImg, .nGY2TnImgBack').forEach(el => {
                el.style.setProperty('background-image', `url("${origUrl}")`, 'important');
                el.style.setProperty('opacity', '1', 'important');
            });
        } catch (e) { /* ignore */ }
        thumb.dataset.gicImageReady = '1';
        return;
    }

    applyThumbnailBlobImmediately(thumb, thumbUrl);
    thumb.dataset.gicImageReady = '1';
}

async function setupGalleryVideoThumbs() {
    if (_thumbProcessingActive) return;
    const gallery = document.getElementById('gallery');
    if (!gallery) return;
    const charName = getCurrentCharacterName();
    if (!charName) return;

    _thumbProcessingActive = true;
    try {
        try { scanAndSyncVideoBadges(); } catch (e) { /* ignore */ }

        const tasks = [];
        gallery.querySelectorAll('.nGY2GThumbnail, .nGY2GThumbnail_l1').forEach(thumb => {
            const title = (thumb.getAttribute('title') || '').trim();
            if (!title) return;

            if (title.endsWith('_img_thum.png')) return;

            if (isVideoFile(title)) {
                if (thumb.dataset.gicVideoReady === '1') return;
                thumb.dataset.gicVideoReady = '1';
                tasks.push({ type: 'video', thumb, title });
            } else if (/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(title)) {
                if (thumb.dataset.gicImageReady === '1') return;
                tasks.push({ type: 'image', thumb, title });
            }
        });
        if (tasks.length === 0) return;

        const queue = [...tasks];
        const workers = [];
        for (let i = 0; i < THUMB_CONCURRENCY; i++) {
            workers.push((async () => {
                while (queue.length > 0) {
                    const item = queue.shift();
                    if (!item) break;
                    try {
                        if (item.type === 'video') {
                            await processGalleryVideoThumb(item.thumb, item.title, charName);
                        } else {
                            await processGalleryImageThumb(item.thumb, item.title, charName);
                        }
                    } catch (e) {
                        console.warn('[GIC] gallery thumb error:', e);
                    }
                }
            })());
        }
        await Promise.all(workers);
    } finally {
        _thumbProcessingActive = false;
    }
}

async function processGalleryVideoThumb(thumb, videoFileName, charName) {
    thumb.querySelectorAll('video').forEach(v => {
        try { v.pause(); } catch (e) { /* ignore */ }
        v.remove();
    });

    const bgEls = thumb.querySelectorAll('.nGY2TnImg, .nGY2TnImgBack');
    bgEls.forEach(el => {
        el.dataset.gicOriginalOpacity = el.style.opacity || '';
        el.style.setProperty('opacity', '0', 'important');
    });

    const thumbUrl = await ensureThumbnailForVideo(videoFileName, charName);

    thumb.querySelectorAll('.gic-gallery-thumb-img, .gic-gallery-video').forEach(el => el.remove());

    if (thumbUrl) {
        const img = document.createElement('img');
        img.className = 'gic-gallery-thumb-img';
        img.src = thumbUrl;
        img.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:100%;' +
            'object-fit:contain;pointer-events:none;z-index:2;background:transparent;';
        thumb.appendChild(img);
        return;
    }

    const videoUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(videoFileName);
    const video = document.createElement('video');
    video.className = 'gic-gallery-video';
    video.src = videoUrl;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.style.cssText =
        'position:absolute;top:0;left:0;width:100%;height:100%;' +
        'object-fit:contain;pointer-events:none;z-index:2;background:transparent;';
    video.addEventListener('loadeddata', () => {
        try {
            if (Number.isFinite(video.duration) && video.duration > 0.1) {
                video.currentTime = Math.min(1, video.duration * 0.1);
            }
        } catch (e) { /* ignore */ }
    }, { once: true });
    thumb.appendChild(video);
}

// ============================================================
// ★ 全画像のバックグラウンド先読み（元画像 + サムネイル両方）
//    ★ 引数順序修正: ensureImageThumbnail(f, charName)
// ============================================================
async function preloadGalleryImagesInBackground() {
    if (_imgPreloading) return;
    _imgPreloading = true;

    try {
        const charName = getCurrentCharacterName();
        if (!charName) return;

        let files = [];
        try {
            const resp = await fetch('/api/images/list', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ folder: charName })
            });
            if (resp.ok) files = await resp.json();
        } catch (e) { return; }

        if (!Array.isArray(files)) return;

        const images = files.filter(f =>
            typeof f === 'string' &&
            /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(f) &&
            !/_thum\.png$/i.test(f) &&
            !/_img_thum\.png$/i.test(f)
        );
        if (images.length === 0) return;

        let alreadyCached = 0;
        for (const f of images) {
            if (_imgThumbKnown.has(`${charName}:${f}`) && _imgBlobUrlCache.has(`${charName}:${f}:imgthumb`)) {
                alreadyCached++;
            }
        }
        const remaining = images.length - alreadyCached;
        if (remaining === 0) {
            console.log(`[GIC] ✅ 全 ${images.length} 枚の画像サムネイルはキャッシュ済みです`);
            return;
        }

        console.log(`[GIC] 📥 ${remaining} 枚の画像サムネイルをバックグラウンド先読み開始（全${images.length}枚中）`);

        for (let i = 0; i < images.length; i += IMG_PRELOAD_CHUNK) {
            if (!isGalleryOpen()) break;
            const chunk = images.slice(i, i + IMG_PRELOAD_CHUNK);
            await Promise.all(chunk.map(async f => {
                /* 元画像の blob キャッシュ（プレビュー用） */
                await fetchAndCacheImage(charName, f);
                /* ★ 200×200 サムネイル生成（引数順序修正: f, charName） */
                await ensureImageThumbnail(f, charName);
            }));
            await wait(IMG_PRELOAD_DELAY_MS);
        }

        console.log('[GIC] ✅ 画像サムネイル先読み完了');
    } finally {
        _imgPreloading = false;
    }
}

// ============================================================
// ★ IndexedDB から全 blob を読み込み、メモリキャッシュに展開
// ============================================================
async function warmupImageMemoryCacheForChar(charName) {
    if (!charName) return;
    if (window.__gicCacheWarmedFor === charName) return;
    window.__gicCacheWarmedFor = charName;

    try {
        const db = await openImgDB();
        const keys = await new Promise((resolve, reject) => {
            const tx = db.transaction(IMG_DB_STORE, 'readonly');
            const req = tx.objectStore(IMG_DB_STORE).getAllKeys();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });

        const prefix = `${charName}:`;
        const matchingKeys = keys.filter(k => k.startsWith(prefix));
        if (matchingKeys.length === 0) return;

        let loaded = 0;
        let thumbLoaded = 0;
        for (const key of matchingKeys) {
            if (_imgBlobUrlCache.has(key)) continue;
            try {
                const blob = await new Promise((resolve, reject) => {
                    const tx = db.transaction(IMG_DB_STORE, 'readonly');
                    const req = tx.objectStore(IMG_DB_STORE).get(key);
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
                if (blob) {
                    _imgBlobUrlCache.set(key, URL.createObjectURL(blob));
                    if (key.endsWith(':imgthumb')) thumbLoaded++;
                    else loaded++;
                }
            } catch (e) { /* skip */ }
        }

        console.log(`[GIC] 🔥 メモリキャッシュウォームアップ: ${charName} (元画像 ${loaded}件, サムネ ${thumbLoaded}件)`);
    } catch (e) {
        console.warn('[GIC] メモリキャッシュウォームアップ失敗:', e);
    }
}

// ============================================================
// ★ MutationObserver でサムネ追加を即検知し、キャッシュがあれば即座に swap
// ============================================================
function setupImmediateThumbCacheInterceptor() {
    if (window.__gicImmediateThumbCacheInstalled) return;
    window.__gicImmediateThumbCacheInstalled = true;

    const processing = new WeakSet();

    async function processThumb(thumb) {
        if (!thumb || processing.has(thumb)) return;

        const existing = thumb.querySelector('.gic-gallery-image-cached');
        if (existing && existing.src && existing.src.startsWith('blob:')) {
            thumb.dataset.gicImageReady = '1';
            return;
        }

        const title = (thumb.getAttribute('title') || '').trim();
        if (!title) return;
        if (!/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(title)) return;
        if (/_thum\.png$/i.test(title) || /_img_thum\.png$/i.test(title)) return;

        const charName = getCurrentCharacterName();
        if (!charName) return;

        processing.add(thumb);

        try {
            const thumbUrl = await ensureImageThumbnail(title, charName);
            if (thumbUrl) {
                applyThumbnailBlobImmediately(thumb, thumbUrl);
            } else {
                const origUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(title);
                thumb.querySelectorAll('.nGY2TnImg, .nGY2TnImgBack').forEach(el => {
                    el.style.setProperty('background-image', `url("${origUrl}")`, 'important');
                    el.style.setProperty('opacity', '1', 'important');
                });
            }
            thumb.dataset.gicImageReady = '1';
        } catch (e) {
            console.warn('[GIC] processThumb error:', e);
        } finally {
            processing.delete(thumb);
        }
    }

    const childObserver = new MutationObserver(() => {
        const gallery = document.getElementById('gallery');
        if (!gallery) return;
        gallery.querySelectorAll('.nGY2GThumbnail, .nGY2GThumbnail_l1').forEach(processThumb);
    });
    childObserver.observe(document.body, { childList: true, subtree: true });

    const styleObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type !== 'attributes' || m.attributeName !== 'style') continue;
            const el = m.target;
            if (!el.classList) continue;
            if (!el.classList.contains('nGY2TnImg') && !el.classList.contains('nGY2TnImgBack')) continue;

            const bg = el.style.backgroundImage;
            if (!bg) continue;
            if (!bg.includes('user/images/')) continue;
            if (bg.includes('_thum.png') || bg.includes('_img_thum.png')) continue;
            if (bg.includes('blob:')) continue;

            const thumb = el.closest('.nGY2GThumbnail, .nGY2GThumbnail_l1, .nGY2Item');
            if (!thumb) continue;

            const title = (thumb.getAttribute('title') || '').trim();
            if (!title) continue;

            const charName = getCurrentCharacterName();
            if (!charName) continue;

            const cacheKey = `${charName}:${title}:imgthumb`;
            const cachedUrl = _imgBlobUrlCache.get(cacheKey);

            if (cachedUrl) {
                el.style.setProperty('background-image', 'none', 'important');
                el.style.setProperty('opacity', '0', 'important');
                applyThumbnailBlobImmediately(thumb, cachedUrl);
                thumb.dataset.gicImageReady = '1';
            } else {
                el.style.setProperty('background-image', 'none', 'important');
                el.style.setProperty('opacity', '0', 'important');
                ensureImageThumbnail(title, charName).then(url => {
                    if (url) {
                        applyThumbnailBlobImmediately(thumb, url);
                        thumb.dataset.gicImageReady = '1';
                    } else {
                        const origUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(title);
                        el.style.setProperty('background-image', `url("${origUrl}")`, 'important');
                        el.style.setProperty('opacity', '1', 'important');
                        thumb.dataset.gicImageReady = '1';
                    }
                }).catch(() => {
                    el.style.removeProperty('background-image');
                    el.style.removeProperty('opacity');
                });
            }
        }
    });
    styleObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['style'],
        subtree: true
    });

    console.log('[GIC] ⚡ 画像サムネイル即時適用インターセプタを設置しました');
}

// ============================================================
// ★ 既存 IndexedDB サムネイルを一括でディスクに書き出す（一回限りの移行）
// ============================================================
async function migrateCacheToDisk() {
    const charName = getCurrentCharacterName();
    if (!charName) return { migrated: 0, failed: 0, skipped: 0 };

    console.log(`[GIC] 🔄 キャッシュ→ディスク移行開始: ${charName}`);

    let migrated = 0;
    let failed = 0;
    let skipped = 0;

    try {
        const db = await openImgDB();
        const keys = await new Promise((resolve, reject) => {
            const tx = db.transaction(IMG_DB_STORE, 'readonly');
            const req = tx.objectStore(IMG_DB_STORE).getAllKeys();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });

        const prefix = `${charName}:`;
        const thumbKeys = keys.filter(k =>
            k.startsWith(prefix) && k.endsWith(':imgthumb')
        );

        console.log(`[GIC] 🔄 対象サムネイル: ${thumbKeys.length} 件`);

        for (const key of thumbKeys) {
            /* key = "charName:imageFileName:imgthumb" → imageFileName を抽出 */
            const mid = key.slice(prefix.length, -(':imgthumb'.length));
            const imageFileName = mid;

            const thumbName = imageFileToThumbName(imageFileName);
            if (!thumbName) { skipped++; continue; }

            const diskUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(thumbName);

            /* 既にディスクに存在すればスキップ */
            if (await checkFileExists(diskUrl, false)) { skipped++; continue; }

            try {
                const blob = await new Promise((resolve, reject) => {
                    const tx = db.transaction(IMG_DB_STORE, 'readonly');
                    const req = tx.objectStore(IMG_DB_STORE).get(key);
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });

                if (!blob) { failed++; continue; }

                const ok = await uploadThumbnailBlob(charName, blob, thumbName);
                if (ok) {
                    migrated++;
                    _thumbExistCache.delete(diskUrl);
                    if (migrated % 20 === 0) {
                        console.log(`[GIC] 🔄 進捗: ${migrated}/${thumbKeys.length}`);
                    }
                } else {
                    failed++;
                }
            } catch (e) {
                failed++;
            }
        }

        console.log(`[GIC] ✅ 移行完了: 成功 ${migrated}件 / 失敗 ${failed}件 / スキップ ${skipped}件`);
        return { migrated, failed, skipped };
    } catch (e) {
        console.warn('[GIC] 移行エラー:', e);
        return { migrated, failed, skipped, error: e.message };
    }
}

// ============================================================
// ★ 既存の _img_thum.png をディスクから自動削除
//    ※ 現在は保存する方針のため呼び出さない
// ============================================================
async function cleanupExistingImgThumbs() {
    const charName = getCurrentCharacterName();
    if (!charName) return;

    try {
        const origFetch = window.__gicOriginalFetch || window.fetch;
        const resp = await origFetch.call(window, '/api/images/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ folder: charName })
        });
        if (!resp.ok) return;

        const files = await resp.json();
        if (!Array.isArray(files)) return;

        const thumbs = files.filter(f =>
            typeof f === 'string' && f.endsWith('_img_thum.png')
        );
        if (thumbs.length === 0) return;

        console.log(`[GIC] 🧹 既存の _img_thum.png ${thumbs.length}件を削除します`);

        for (const t of thumbs) {
            try {
                await origFetch.call(window, '/api/images/delete', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ path: `/user/images/${charName}/${t}` })
                });
            } catch (e) { /* ignore */ }
        }

        console.log(`[GIC] ✅ _img_thum.png の自動削除完了`);
    } catch (e) {
        console.warn('[GIC] _img_thum.png 自動削除でエラー:', e);
    }
}

// ============================================================
// ★ ギャラリーサムネイルの個別ドラッグ
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
    let isSimulatingClick = false;

    function getPathFromThumb(thumb) {
        if (!thumb) return null;

        const title = (thumb.getAttribute('title') || '').trim();
        if (title && !title.startsWith('data:')) {
            return urlToServerPath(title);
        }

        let url = thumb.getAttribute('data-ngsrc')
               || thumb.getAttribute('data-src')
               || thumb.getAttribute('data-image');
        if (url && url.startsWith('data:')) url = null;
        if (!url) {
            const img = thumb.querySelector('img');
            if (img) {
                url = img.getAttribute('data-src') || img.getAttribute('src');
                if (url && url.startsWith('data:')) url = null;
            }
        }
        if (!url) {
            const a = thumb.querySelector('a');
            if (a) {
                url = a.getAttribute('href');
                if (url && url.startsWith('data:')) url = null;
            }
        }
        return url ? urlToServerPath(url) : null;
    }

    function createGhost(thumb, x, y) {
        const w = thumb.offsetWidth || 100;
        const h = thumb.offsetHeight || 100;
        const imgEl = thumb.querySelector('.gic-gallery-thumb-img') || thumb.querySelector('.gic-gallery-image-cached') || thumb.querySelector('img');
        const videoEl = thumb.querySelector('video.gic-gallery-video');

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
            background: #000;
        `;
        if (imgEl) {
            const img = document.createElement('img');
            img.src = imgEl.currentSrc || imgEl.src;
            img.style.cssText = 'width:100%;height:100%;object-fit:contain;pointer-events:none;background:#000;';
            ghost.appendChild(img);
        } else if (videoEl) {
            const v = videoEl.cloneNode(true);
            v.style.cssText = 'width:100%;height:100%;object-fit:contain;pointer-events:none;background:#000;';
            ghost.appendChild(v);
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
                g2.style.setProperty('top', '0', 'important');
                g2.style.setProperty('transform', 'none', 'important');
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
                g.style.setProperty('top', '0', 'important');
                g.style.setProperty('transform', 'none', 'important');
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

        let paths = [dragState.path];
        if (_bulkDeleteMode && _bulkDeleteSelected.size > 0) {
            const selectedPaths = [];
            _bulkDeleteSelected.forEach(p => { if (p) selectedPaths.push(p); });
            if (selectedPaths.length > 0) paths = selectedPaths;
        }

        window.dispatchEvent(new CustomEvent('gic-drop-file', {
            detail: { paths, path: paths[0], cell, x, y }
        }));
    }

    function simulateClick(thumb, x, y) {
        if (!thumb) return;
        if (isSimulatingClick) return;
        isSimulatingClick = true;
        try {
            const img = thumb.querySelector('.gic-gallery-thumb-img') || thumb.querySelector('.gic-gallery-image-cached') || thumb.querySelector('img');
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
        isSimulatingClick = false;
    }

    function markThumb(thumb) {
        if (!thumb || thumb.dataset.gicDragReady === '1') return;
        thumb.dataset.gicDragReady = '1';
        thumb.setAttribute('draggable', 'false');
        thumb.querySelectorAll('img, a, video').forEach(el => {
            el.setAttribute('draggable', 'false');
            if (el.tagName === 'IMG') {
                el.style.pointerEvents = 'none';
            }
            try { el.style.webkitUserDrag = 'none'; } catch (_) { /* ignore */ }
        });
    }

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
            e.stopImmediatePropagation();
            e.preventDefault();
            if (!_bulkDeleteMode) {
                const title = (thumb.getAttribute('title') || '').trim();
                let previewTitle = title;
                let isVid = isVideoFile(title);

                if (!isVid && title.match(/_thum\.png$/i) && !title.endsWith('_img_thum.png')) {
                    const m = title.match(/^(.+)_(mp4|webm)_thum\.png$/i);
                    if (m) {
                        previewTitle = `${m[1]}.${m[2].toLowerCase()}`;
                        isVid = true;
                    }
                }

                /* ★ 画像サムネイル → 元画像名に変換（念のため） */
                if (!isVid && title.endsWith(IMG_THUMB_SUFFIX)) {
                    previewTitle = title.slice(0, -IMG_THUMB_SUFFIX.length) + '.png';
                }

                const charName = getCurrentCharacterName();
                window.__gicPendingPreview = (isVid && charName && previewTitle) ? {
                    title: previewTitle,
                    charName,
                } : null;
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
    window.__gicPendingPreview = null;
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

function applyGalleryWindowLayout() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (vw !== _lastWindowWidthForGallery) {
        _lastWindowWidthForGallery = vw;
        for (const sel of GALLERY_WINDOW_SELECTORS) {
            document.querySelectorAll(sel).forEach(el => {
                if (galleryBaseWidthCache.has(el)) {
                    galleryBaseWidthCache.delete(el);
                }
            });
        }
    }

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
            el.style.setProperty('top', '0', 'important');
            el.style.setProperty('bottom', '0', 'important');
            el.style.setProperty('left', '0', 'important');
            el.style.setProperty('right', 'auto', 'important');
            el.style.setProperty('transform', 'none', 'important');
            el.style.setProperty('margin', '0', 'important');

            el.style.setProperty('height', vh + 'px', 'important');
            el.style.setProperty('min-height', vh + 'px', 'important');
            el.style.setProperty('max-height', vh + 'px', 'important');

            if (el.dataset.gicHeightLogged !== 'true') {
                el.dataset.gicHeightLogged = 'true';
                console.log(`[GIC] ギャラリー高さ: viewport=${vh}px（上下いっぱい）`);
            }

            if (!galleryBaseWidthCache.has(el)) {
                el.style.removeProperty('width');
                el.style.removeProperty('max-width');
                const w = el.getBoundingClientRect().width;
                if (w > 0) {
                    galleryBaseWidthCache.set(el, w);
                    console.log(`[GIC] ギャラリー幅: ST本来=${Math.round(w)}px`);
                }
            }

            if (galleryBaseWidthCache.has(el)) {
                const baseW = galleryBaseWidthCache.get(el);
                const maxW = Math.max(100, vw - GALLERY_WINDOW_MAX_VIEWPORT_MARGIN);
                const targetW = Math.min(maxW, Math.round(baseW + GALLERY_WINDOW_WIDTH_EXTRA));
                el.style.setProperty('width', targetW + 'px', 'important');
                el.style.setProperty('max-width', targetW + 'px', 'important');
            }
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
            if (galleryBaseWidthCache.has(el)) {
                galleryBaseWidthCache.delete(el);
            }
            el.style.removeProperty('width');
            el.style.removeProperty('max-width');

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
    const floatingBtn = document.getElementById('gic-floating-bulk-exit');
    if (floatingBtn) floatingBtn.remove();

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

    /* ★ ギャラリー右端から何 px 内側に置くか（右寄せ） */
    const rightInset = (window.innerWidth - gr.right) + PAGINATION_OFFSET_LEFT;
    const bottom     = (window.innerHeight - gr.bottom) + PAGINATION_OFFSET_UP;

    pager.style.setProperty('position', 'fixed', 'important');
    pager.style.setProperty('right', Math.round(rightInset) + 'px', 'important');
    pager.style.setProperty('left', 'auto', 'important');
    pager.style.setProperty('bottom', Math.round(bottom) + 'px', 'important');
    pager.style.setProperty('top', 'auto', 'important');
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

// ============================================================
// ★ 画像プレビュー: サムネイル(_img_thum.png) → 元画像(.png) 変換
// ============================================================
function fitPreviewToViewport(panel) {
    if (!panel) return;

    /* ★ パネル内の img が _img_thum.png を指していたら元画像名に変換
          （拡大ビューではオリジナル画像を表示する） */
    try {
        panel.querySelectorAll('img').forEach(img => {
            const src = img.src || '';
            if (src.endsWith(IMG_THUMB_SUFFIX)) {
                const origSrc = src.slice(0, -IMG_THUMB_SUFFIX.length) + '.png';
                if (img.src !== origSrc) {
                    img.src = origSrc;
                    img.dataset.gicFitBound = '';
                    console.log(`[GIC] 🔍 プレビュー画像を元画像に変換: ${origSrc}`);
                }
            }
        });
    } catch (e) { /* ignore */ }

    if (window.__gicPendingPreview) {
        fitVideoPreview(panel, window.__gicPendingPreview);
        return;
    }

    panel.querySelectorAll('video').forEach(v => {
        try { v.pause(); } catch (e) { /* ignore */ }
        try { v.remove(); } catch (e) { /* ignore */ }
    });

    const img = panel.querySelector(':scope > img') || panel.querySelector('img');
    const header = panel.querySelector('.panelControlBar');
    const closeBtn = panel.querySelector('.dragClose');
    if (!img) return;

    if (header) {
        header.style.removeProperty('height');
        header.style.removeProperty('min-height');
        header.style.removeProperty('max-height');
        header.style.removeProperty('padding');
        header.style.removeProperty('margin');
        header.style.removeProperty('overflow');
        header.style.removeProperty('background');
        header.style.removeProperty('border');
        header.style.setProperty('flex', '0 0 auto', 'important');
        header.querySelectorAll('*').forEach(child => {
            child.style.removeProperty('display');
        });
    }

    if (closeBtn) {
        const btnH = closeBtn.offsetHeight || 30;
        closeBtn.style.setProperty('position', 'fixed', 'important');
        closeBtn.style.setProperty('left', '0', 'important');
        closeBtn.style.setProperty('top', `calc(50% - ${Math.round(btnH / 2)}px)`, 'important');
        closeBtn.style.setProperty('transform', `scale(${GALLERY_PREVIEW_CLOSE_SCALE})`, 'important');
        closeBtn.style.setProperty('transform-origin', 'left center', 'important');
        closeBtn.style.setProperty('margin', '0', 'important');
        closeBtn.style.setProperty('z-index', '15001', 'important');
    }

    img.style.setProperty('display', 'block', 'important');

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
            const btnH = closeBtn.offsetHeight || 30;
            closeBtn.style.setProperty('position', 'fixed', 'important');
            closeBtn.style.setProperty('left', '0', 'important');
            closeBtn.style.setProperty('top', `calc(50% - ${Math.round(btnH / 2)}px)`, 'important');
            closeBtn.style.setProperty('transform', `scale(${GALLERY_PREVIEW_CLOSE_SCALE})`, 'important');
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

function fitVideoPreview(panel, pending) {
    if (!panel || !pending || !pending.title || !pending.charName) return;

    const expectedSrc = '/user/images/' + encodeURIComponent(pending.charName) + '/' + encodeURIComponent(pending.title);

    panel.querySelectorAll('img').forEach(img => {
        img.style.setProperty('display', 'none', 'important');
    });

    panel.querySelectorAll('video').forEach(v => {
        if (!v.classList.contains('gic-gallery-preview-video')) {
            try { v.pause(); } catch (e) { /* ignore */ }
            try { v.remove(); } catch (e) { /* ignore */ }
        }
    });

    document.querySelectorAll('video.gic-gallery-preview-video').forEach(v => {
        if (!panel.contains(v)) {
            try { v.pause(); } catch (e) { /* ignore */ }
            try { v.remove(); } catch (e) { /* ignore */ }
        }
    });

    panel.querySelectorAll('video.gic-gallery-preview-video').forEach(v => {
        if (v.dataset.gicSrc !== expectedSrc) {
            try { v.pause(); } catch (e) { /* ignore */ }
            try { v.remove(); } catch (e) { /* ignore */ }
        }
    });

    let video = null;
    panel.querySelectorAll('video.gic-gallery-preview-video').forEach(v => {
        if (v.dataset.gicSrc === expectedSrc) video = v;
    });

    if (!video) {
        video = document.createElement('video');
        video.className = 'gic-gallery-preview-video';
        video.dataset.gicSrc = expectedSrc;
        video.src = expectedSrc;
        video.controls = true;
        video.autoplay = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.muted = false;
        panel.appendChild(video);

        video.play().catch(() => {
            video.muted = true;
            video.play().catch(() => {});
        });

        video.addEventListener('loadedmetadata', () => {
            if (document.body.contains(panel) && document.body.contains(video)) {
                fitVideoPreview(panel, pending);
            }
        }, { once: true });
    }

    const nw = video.videoWidth || 0;
    const nh = video.videoHeight || 0;
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
    const finalW = Math.max(1, Math.floor(nw * fitScale));
    const finalH = Math.max(1, Math.floor(nh * fitScale));
    const topPx = Math.max(0, Math.round((vh - finalH) / 2));

    panel.style.setProperty('position', 'fixed', 'important');
    panel.style.setProperty('left', galleryRight + 'px', 'important');
    panel.style.setProperty('top', topPx + 'px', 'important');
    panel.style.setProperty('right', 'auto', 'important');
    panel.style.setProperty('bottom', 'auto', 'important');
    panel.style.setProperty('transform', 'translateY(0)', 'important');
    panel.style.setProperty('transform-origin', 'left top', 'important');
    panel.style.setProperty('margin', '0', 'important');
    panel.style.setProperty('padding', '0', 'important');
    panel.style.setProperty('box-sizing', 'border-box', 'important');
    panel.style.setProperty('overflow', 'hidden', 'important');
    panel.style.setProperty('display', 'block', 'important');
    panel.style.setProperty('width', finalW + 'px', 'important');
    panel.style.setProperty('height', finalH + 'px', 'important');
    panel.style.setProperty('max-width', 'none', 'important');
    panel.style.setProperty('max-height', 'none', 'important');
    panel.style.setProperty('visibility', 'visible', 'important');
    panel.style.setProperty('z-index', '15000', 'important');

    video.style.setProperty('position', 'absolute', 'important');
    video.style.setProperty('left', '0', 'important');
    video.style.setProperty('top', '0', 'important');
    video.style.setProperty('width', '100%', 'important');
    video.style.setProperty('height', '100%', 'important');
    video.style.setProperty('max-width', 'none', 'important');
    video.style.setProperty('max-height', 'none', 'important');
    video.style.setProperty('object-fit', 'contain', 'important');
    video.style.setProperty('display', 'block', 'important');
    video.style.setProperty('z-index', '1', 'important');

    const header = panel.querySelector('.panelControlBar');
    if (header) {
        header.style.setProperty('height', '0', 'important');
        header.style.setProperty('min-height', '0', 'important');
        header.style.setProperty('max-height', '0', 'important');
        header.style.setProperty('padding', '0', 'important');
        header.style.setProperty('margin', '0', 'important');
        header.style.setProperty('overflow', 'visible', 'important');
        header.style.setProperty('background', 'transparent', 'important');
        header.style.setProperty('border', 'none', 'important');
        header.querySelectorAll('*').forEach(child => {
            if (!child.classList.contains('dragClose')) {
                child.style.setProperty('display', 'none', 'important');
            }
        });
    }

    const closeBtn = panel.querySelector('.dragClose');
    if (closeBtn) {
        closeBtn.style.setProperty('display', 'inline-block', 'important');
        const btnH = closeBtn.offsetHeight || 30;
        closeBtn.style.setProperty('position', 'fixed', 'important');
        closeBtn.style.setProperty('left', '0', 'important');
        closeBtn.style.setProperty('top', `calc(50% - ${Math.round(btnH / 2)}px)`, 'important');
        closeBtn.style.setProperty('transform', `scale(${GALLERY_PREVIEW_CLOSE_SCALE})`, 'important');
        closeBtn.style.setProperty('transform-origin', 'left center', 'important');
        closeBtn.style.setProperty('margin', '0', 'important');
        closeBtn.style.setProperty('z-index', '15001', 'important');
    }
}

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
    const title = item.getAttribute('title');
    if (title) return urlToServerPath(title);
    return null;
}

function urlToServerPath(url) {
    if (!url || typeof url !== 'string') return null;
    if (url.startsWith('data:')) return null;
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
    console.log('[GIC-Bulk] 一括選択モード開始');
    showBulkDeleteToast('一括選択モード — 画像クリックで選択');
    updateBulkDeleteButton();
    updateBulkDeleteBanner();

    ensureFloatingBulkButton();
    requestAnimationFrame(() => positionFloatingBulkButton());
}

function exitBulkDeleteMode() {
    if (!_bulkDeleteMode) return;
    _bulkDeleteMode = false;
    _bulkDeleteSelected.clear();
    document.body.classList.remove('gic-bulk-delete-mode');
    document.querySelectorAll('.gic-bulk-selected').forEach(el => el.classList.remove('gic-bulk-selected'));
    showBulkDeleteToast('一括選択モードを終了しました');
    updateBulkDeleteButton();
    console.log('[GIC-Bulk] 一括選択モード終了');
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
    const floatingBtn = document.getElementById('gic-floating-bulk-exit');

    const text = _bulkDeleteMode
        ? (_bulkDeleteSelected.size > 0 ? `選択終了 (${_bulkDeleteSelected.size})` : '選択終了')
        : '一括選択';

    if (btn) {
        btn.classList.remove('gic-bulk-delete-disabled');
        btn.disabled = false;
        btn.textContent = text;
    }
    if (floatingBtn) {
        floatingBtn.textContent = text;
    }
}

function updateBulkDeleteBanner() {
    if (!_bulkDeleteMode) return;
    const gallery = document.getElementById('gallery');
    if (!gallery) return;
    const count = _bulkDeleteSelected.size;
    const text = count > 0
        ? `一括選択中 — ${count} 枚（🗑 で削除 / ドラッグでまとめて登録）`
        : '一括選択モード — 画像クリックで選択';
    gallery.style.setProperty('--gic-bulk-banner-text', `"${text}"`);
}

function createBulkDeleteButton() {
    let btn = document.getElementById('gic-bulk-delete-button');
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = 'gic-bulk-delete-button';
    btn.type = 'button';
    btn.className = 'gic-bulk-delete-button';
    btn.textContent = '一括選択';
    btn.title = '一括選択モードの開始／終了';
    btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        if (_bulkDeleteMode) {
            exitBulkDeleteMode();
        } else {
            enterBulkDeleteMode();
        }
    });
    return btn;
}

function ensureFloatingBulkButton() {
    let btn = document.getElementById('gic-floating-bulk-exit');
    if (btn) return btn;

    btn = document.createElement('button');
    btn.id = 'gic-floating-bulk-exit';
    btn.type = 'button';
    btn.textContent = '選択終了';
    btn.title = '一括選択モードを終了';
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (_bulkDeleteMode) exitBulkDeleteMode();
    });
    document.body.appendChild(btn);
    return btn;
}

function positionFloatingBulkButton() {
    if (!_bulkDeleteMode) return;
    const btn = document.getElementById('gic-floating-bulk-exit');
    const original = document.getElementById('gic-bulk-delete-button');
    if (!btn || !original) return;

    const rect = original.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    btn.style.setProperty('position', 'fixed', 'important');
    btn.style.setProperty('top', Math.round(rect.top) + 'px', 'important');
    btn.style.setProperty('left', Math.round(rect.left) + 'px', 'important');
    btn.style.setProperty('right', 'auto', 'important');
    btn.style.setProperty('bottom', 'auto', 'important');
    btn.style.setProperty('min-width', Math.round(rect.width) + 'px', 'important');
    btn.style.setProperty('height', Math.round(rect.height) + 'px', 'important');
    btn.style.setProperty('z-index', '2147483647', 'important');
}

function placeBulkDeleteButton(controls) {
    const { folderInput, folderRow, dropdown, header } = controls;
    const btn = createBulkDeleteButton();
    if (btn.parentElement) { updateBulkDeleteButton(); return; }

    if (folderInput && folderInput.parentElement) {
        folderInput.classList.add('gic-bulk-shortened-input');
        folderInput.insertAdjacentElement('afterend', btn);
        console.log('[GIC-Bulk] 一括選択ボタンをフォルダ入力欄の直後に挿入');
        updateBulkDeleteButton();
        return;
    }
    if (folderRow) {
        folderRow.appendChild(btn);
        console.log('[GIC-Bulk] 一括選択ボタンをフォルダ行末尾に挿入');
        updateBulkDeleteButton();
        return;
    }
    if (dropdown && dropdown.parentElement) {
        dropdown.classList.add('gic-bulk-shrunk-dropdown');
        dropdown.parentElement.insertBefore(btn, dropdown);
        console.log('[GIC-Bulk] 一括選択ボタンをドロップダウンの直前に挿入');
        updateBulkDeleteButton();
        return;
    }
    if (header) {
        header.appendChild(btn);
        console.log('[GIC-Bulk] 一括選択ボタンをヘッダー末尾に挿入');
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
    if (_bulkDeleteSelected.size === 0) {
        console.warn('[GIC-Bulk] 選択された画像がありません');
        showBulkDeleteToast('削除する画像が選択されていません');
        return;
    }
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
            try { return decodeURIComponent(lastGeneratedImageUrl); } catch (e) { return lastGeneratedImageUrl; }
        })();
        for (const p of paths) {
            const pNormalized = (() => {
                try { return decodeURIComponent(p); } catch (e) { return p; }
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
        if (!e.isTrusted) return;
        if (Date.now() < (window.__gicNoLayoutUntil || 0)) return;
        if (!inGallery(e.target)) return;

        const isBulkBtn = e.target.closest('.gic-bulk-delete-button');
        const trash = e.target.closest(TRASH_SELECTOR);
        if (!isBulkBtn && trash && !trash.classList.contains('dragClose')) {
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            const now = Date.now();
            if (now - _lastTrashToggleAt < TRASH_TOGGLE_DEBOUNCE_MS) return;
            _lastTrashToggleAt = now;
            if (_bulkDeleteSelected.size > 0) {
                executeBulkDelete();
            } else if (_bulkDeleteMode) {
                showBulkDeleteToast('削除する画像を選択してください');
            } else {
                showBulkDeleteToast('先に「一括選択」ボタンで画像を選択してください');
            }
            return;
        }
        if (_bulkDeleteMode) {
            if (e.target.closest(SKIP_UI_SELECTOR)) return;
            const item = findItem(e.target, e.clientX, e.clientY);
            if (item) {
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

function restructureGalleryHeader() {
    const gallery = document.getElementById('gallery');
    if (!gallery) return;

    const dragTitle = gallery.querySelector('.dragTitle');
    if (!dragTitle) return;

    dragTitle.querySelectorAll(':scope > span').forEach(span => {
        const txt = (span.textContent || '').trim();
        if (/^image\s*gallery$/i.test(txt)) {
            span.remove();
        }
    });

    const folderInput = gallery.querySelector('.gallery-folder-input');
    const bulkBtn     = document.getElementById('gic-bulk-delete-button');
    const checkBtn    = gallery.querySelector('.right_menu_button[title="Change gallery folder"]');
    const trashBtn    = gallery.querySelector('.right_menu_button[title="Delete mode"]');
    const recycleBtn  = gallery.querySelector('.right_menu_button[title="Restore gallery folder"]');

    const elements = [folderInput, bulkBtn, checkBtn, trashBtn, recycleBtn].filter(Boolean);
    if (elements.length === 0) return;

    let alreadyInPlace = elements.length <= dragTitle.children.length;
    if (alreadyInPlace) {
        for (let i = 0; i < elements.length; i++) {
            if (dragTitle.children[i] !== elements[i]) {
                alreadyInPlace = false;
                break;
            }
        }
    }

    if (!alreadyInPlace) {
        const managed = new Set(elements);
        const anchor  = Array.from(dragTitle.children).find(c => !managed.has(c)) || null;

        const frag = document.createDocumentFragment();
        elements.forEach(el => frag.appendChild(el));
        dragTitle.insertBefore(frag, anchor);
    }

    gallery.querySelectorAll('.flex-container.alignItemsCenter').forEach(c => {
        if (c.children.length === 0 && !c.textContent.trim()) {
            c.remove();
        }
    });

    elements.forEach(el => {
        el.style.setProperty('position', 'relative', 'important');
        el.style.setProperty('z-index', '200', 'important');
        el.style.setProperty('pointer-events', 'auto', 'important');
    });
}

function enforceGalleryGridLayout() {
    const gallery = document.getElementById('gallery');
    if (!gallery) return;

    gallery.querySelectorAll(
        '.dragTitle, .panelControlBar, .nGY2GalleryTop, .nGY2GalleryHeader, ' +
        '.gallery-folder-input, .gallery-sort-select, .gic-bulk-delete-button, ' +
        '.right_menu_button, .menu_button, ' +
        'button[title*="elete"], button[title*="rash"], button[title*="削除"], ' +
        'i.fa-trash, i[class*="fa-trash"], [class*="trash"]'
    ).forEach(h => {
        h.style.setProperty('position', 'relative', 'important');
        h.style.setProperty('z-index', '200', 'important');
        h.style.setProperty('pointer-events', 'auto', 'important');
    });

    const allThumbs = Array.from(gallery.querySelectorAll('.nGY2GThumbnail, .nGY2GThumbnail_l1, .nGY2Item'));
    if (allThumbs.length === 0) return;

    allThumbs.forEach(thumb => {
        if (thumb.dataset.gicOffscreen === '1') {
            thumb.style.removeProperty('left');
            thumb.style.removeProperty('top');
            delete thumb.dataset.gicOffscreen;
        }
    });

    const visibleThumbs = allThumbs.filter(thumb => {
        const title = (thumb.getAttribute('title') || '').trim();

        if (title.endsWith('_img_thum.png')) {
            thumb.style.setProperty('display', 'none', 'important');
            return false;
        }

        const cs = window.getComputedStyle(thumb);
        if (cs.display === 'none') return false;
        if (thumb.offsetWidth === 0 || thumb.offsetHeight === 0) return false;
        return true;
    });
    if (visibleThumbs.length === 0) return;

    const COLS          = 4;
    const MAX_ROWS      = 4;
    const H_GAP         = 0;
    const V_GAP         = 0;
    const RIGHT_EXTRA   = 10;
    const TOP_PADDING   = 6;
    const PAGER_RESERVE = 70;
    const THUMB_MAX     = 200;
    const THUMB_MIN     = 120;

    const galleryRect0 = gallery.getBoundingClientRect();
    const halfH = galleryRect0.height / 2;
    let headerBottom = 0;
    [
        '.dragTitle', '.panelControlBar', '.nGY2GalleryTop', '.nGY2GalleryHeader',
        '.gallery-folder-input', '.gallery-sort-select', '.gic-bulk-delete-button'
    ].forEach(sel => {
        gallery.querySelectorAll(sel).forEach(h => {
            const r = h.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                const b = r.bottom - galleryRect0.top;
                if (b > 0 && b < halfH && b > headerBottom) headerBottom = b;
            }
        });
    });
    const headerH = Math.max(40, Math.ceil(headerBottom) + 6);

    const containerW = Math.max(100, Math.round(galleryRect0.width)  || 830);
    const containerH = Math.max(100, Math.round(galleryRect0.height) || 922);

    const availH      = containerH - headerH - PAGER_RESERVE;
    const maxThumbByH = Math.floor((containerH - headerH - (MAX_ROWS - 1) * V_GAP) / MAX_ROWS);
    const THUMB       = Math.min(THUMB_MAX, Math.max(THUMB_MIN, maxThumbByH));

    const totalRows = Math.min(Math.ceil(visibleThumbs.length / COLS), MAX_ROWS);
    const gridW = COLS * THUMB + (COLS - 1) * H_GAP;
    const gridH = totalRows * THUMB + Math.max(0, totalRows - 1) * V_GAP;

    const usableW = Math.max(gridW, containerW - RIGHT_EXTRA);
    const offsetX = Math.max(0, Math.floor((usableW - gridW) / 2));

    const offsetY = TOP_PADDING;

    const containerInnerH = Math.max(gridH + offsetY, availH);

    const parent    = visibleThumbs[0].parentElement;
    const galleryEl = gallery.querySelector('.nGY2Gallery');
    const subEl     = gallery.querySelector('.nGY2GallerySub');

    if (galleryEl) {
        galleryEl.style.setProperty('position', 'absolute', 'important');
        galleryEl.style.setProperty('top', headerH + 'px', 'important');
        galleryEl.style.setProperty('left', '0', 'important');
        galleryEl.style.setProperty('right', 'auto', 'important');
        galleryEl.style.setProperty('bottom', 'auto', 'important');
        galleryEl.style.setProperty('width', containerW + 'px', 'important');
        galleryEl.style.setProperty('min-width', containerW + 'px', 'important');
        galleryEl.style.setProperty('max-width', containerW + 'px', 'important');
        galleryEl.style.setProperty('height', containerInnerH + 'px', 'important');
        galleryEl.style.setProperty('min-height', containerInnerH + 'px', 'important');
        galleryEl.style.setProperty('max-height', containerInnerH + 'px', 'important');
        galleryEl.style.setProperty('margin', '0', 'important');
        galleryEl.style.setProperty('padding', '0', 'important');
        galleryEl.style.setProperty('overflow', 'hidden', 'important');
        galleryEl.style.setProperty('box-sizing', 'border-box', 'important');
    }

    [subEl, parent].forEach(el => {
        if (!el || el === galleryEl) return;
        el.style.setProperty('position', 'relative', 'important');
        el.style.setProperty('top', '0', 'important');
        el.style.setProperty('left', '0', 'important');
        el.style.setProperty('right', 'auto', 'important');
        el.style.setProperty('bottom', 'auto', 'important');
        el.style.setProperty('width', containerW + 'px', 'important');
        el.style.setProperty('min-width', containerW + 'px', 'important');
        el.style.setProperty('max-width', containerW + 'px', 'important');
        el.style.setProperty('height', containerInnerH + 'px', 'important');
        el.style.setProperty('min-height', containerInnerH + 'px', 'important');
        el.style.setProperty('max-height', containerInnerH + 'px', 'important');
        el.style.setProperty('margin', '0', 'important');
        el.style.setProperty('padding', '0', 'important');
        el.style.setProperty('overflow', 'hidden', 'important');
        el.style.setProperty('box-sizing', 'border-box', 'important');
    });

    visibleThumbs.forEach((thumb, i) => {
        const row = Math.floor(i / COLS);
        const col = i % COLS;

        if (row >= MAX_ROWS) {
            thumb.style.setProperty('position', 'absolute', 'important');
            thumb.style.setProperty('left', '-9999px', 'important');
            thumb.style.setProperty('top', '-9999px', 'important');
            thumb.dataset.gicOffscreen = '1';
            return;
        }

        const left = offsetX + col * (THUMB + H_GAP);
        const top  = offsetY + row * (THUMB + V_GAP);

        thumb.style.setProperty('position', 'absolute', 'important');
        thumb.style.setProperty('left', left + 'px', 'important');
        thumb.style.setProperty('top', top + 'px', 'important');
        thumb.style.setProperty('right', 'auto', 'important');
        thumb.style.setProperty('bottom', 'auto', 'important');
        thumb.style.setProperty('width', THUMB + 'px', 'important');
        thumb.style.setProperty('height', THUMB + 'px', 'important');
        thumb.style.setProperty('min-width', THUMB + 'px', 'important');
        thumb.style.setProperty('min-height', THUMB + 'px', 'important');
        thumb.style.setProperty('max-width', THUMB + 'px', 'important');
        thumb.style.setProperty('max-height', THUMB + 'px', 'important');
        thumb.style.setProperty('margin', '0', 'important');
        thumb.style.setProperty('padding', '0', 'important');
        thumb.style.setProperty('transform', 'none', 'important');
        thumb.style.setProperty('overflow', 'hidden', 'important');
        thumb.style.setProperty('box-sizing', 'border-box', 'important');
        thumb.style.setProperty('background-color', '#000', 'important');
        thumb.style.setProperty('opacity', '1', 'important');
    });

    /* ★ サムネ再適用保証 */
    try {
        const charName = getCurrentCharacterName();
        if (charName) {
            visibleThumbs.forEach(thumb => {
                const title = (thumb.getAttribute('title') || '').trim();
                if (!title || isVideoFile(title)) return;
                if (title.endsWith('_img_thum.png')) return;
                if (!/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(title)) return;

                const hasCached = thumb.querySelector('.gic-gallery-image-cached');
                if (hasCached && hasCached.src && hasCached.src.startsWith('blob:')) return;

                const cacheKey = `${charName}:${title}:imgthumb`;
                const cachedUrl = _imgBlobUrlCache.get(cacheKey);
                if (cachedUrl) {
                    applyThumbnailBlobImmediately(thumb, cachedUrl);
                    thumb.dataset.gicImageReady = '1';
                }
            });
        }
    } catch (e) { /* ignore */ }

    visibleThumbs.forEach(thumb => {
        const innerSel = '.nGY2GThumbnailSub, .nGY2TnImg, .nGY2TnImgBack, .nGY2TnImg2, .nGY2GThumbnailImg';
        thumb.querySelectorAll(innerSel).forEach(el => {
            el.style.setProperty('width', THUMB + 'px', 'important');
            el.style.setProperty('height', THUMB + 'px', 'important');
            el.style.setProperty('min-width', THUMB + 'px', 'important');
            el.style.setProperty('min-height', THUMB + 'px', 'important');
            el.style.setProperty('max-width', THUMB + 'px', 'important');
            el.style.setProperty('max-height', THUMB + 'px', 'important');
            el.style.setProperty('top', '0', 'important');
            el.style.setProperty('left', '0', 'important');
            el.style.setProperty('padding', '0', 'important');
            el.style.setProperty('margin', '0', 'important');
            el.style.setProperty('border', '0', 'important');
            el.style.setProperty('box-sizing', 'border-box', 'important');
        });
    });

    if (gallery.dataset.gicLayoutLogged !== 'true') {
        gallery.dataset.gicLayoutLogged = 'true';
        console.log(`[GIC] レイアウト: headerH=${headerH}px, containerW=${containerW}px, containerH=${containerH}px, THUMB=${THUMB}px`);
    }
}

async function handlePageSwitchAsync() {
    if (_pageSwitchInProgress) return;
    _pageSwitchInProgress = true;

    const gallery = document.getElementById('gallery');
    if (!gallery) { _pageSwitchInProgress = false; return; }

    gallery.querySelectorAll('.nGY2GThumbnail, .nGY2GThumbnail_l1, .nGY2Item').forEach(t => {
        t.style.removeProperty('visibility');
    });

    gallery.classList.add('gic-page-switching');

    const thumbContainer = gallery.querySelector('.nGY2GallerySub')
                        || gallery.querySelector('.nGY2Gallery');
    let origVisibility = '';
    if (thumbContainer) {
        origVisibility = thumbContainer.style.getPropertyValue('visibility') || '';
        thumbContainer.style.setProperty('visibility', 'hidden', 'important');
    }

    try {
        const startTime = Date.now();
        const MAX_WAIT = 2000;
        let lastSig = '';
        let stableFrames = 0;

        while (Date.now() - startTime < MAX_WAIT) {
            await new Promise(r => requestAnimationFrame(r));

            const allThumbs = Array.from(gallery.querySelectorAll(
                '.nGY2GThumbnail, .nGY2GThumbnail_l1, .nGY2Item'
            ));
            const visibleThumbs = allThumbs.filter(thumb => {
                const title = (thumb.getAttribute('title') || '').trim();
                if (title.endsWith('_img_thum.png')) return false;

                const cs = window.getComputedStyle(thumb);
                if (cs.display === 'none') return false;
                if (thumb.offsetWidth === 0 || thumb.offsetHeight === 0) return false;
                return true;
            });

            const sig = visibleThumbs
                .map(t => (t.getAttribute('title') || '').slice(0, 40))
                .join('|');

            if (visibleThumbs.length > 0 && sig === lastSig) {
                stableFrames++;
                if (stableFrames >= 3) break;
            } else {
                stableFrames = 0;
            }
            lastSig = sig;
        }

        try { enforceGalleryGridLayout(); } catch (_) {}
        try { scanAndSyncVideoBadges(); } catch (_) {}

        try {
            const charName = getCurrentCharacterName();
            if (charName) {
                gallery.querySelectorAll('.nGY2GThumbnail, .nGY2GThumbnail_l1').forEach(thumb => {
                    const title = (thumb.getAttribute('title') || '').trim();
                    if (!title || isVideoFile(title)) return;
                    if (title.endsWith('_img_thum.png')) return;
                    if (!/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(title)) return;
                    const cacheKey = `${charName}:${title}:imgthumb`;
                    const cachedUrl = _imgBlobUrlCache.get(cacheKey);
                    if (cachedUrl) {
                        thumb.dataset.gicImageReady = '1';
                        applyThumbnailBlobImmediately(thumb, cachedUrl);
                    }
                });
            }
        } catch (_) { /* ignore */ }

        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    } finally {
        if (thumbContainer) {
            if (origVisibility) {
                thumbContainer.style.setProperty('visibility', origVisibility, 'important');
            } else {
                thumbContainer.style.removeProperty('visibility');
            }
        }
        gallery.classList.remove('gic-page-switching');
        _pageSwitchInProgress = false;
    }
}

function applyGalleryLayout() {
    if (isApplyingLayout) return;
    if (_pageSwitchInProgress) return;

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
        const previewsAll = getAllPreviews();
        if (previewsAll.length > 0) {
            const latest = previewsAll[previewsAll.length - 1];
            if (latest !== currentPreviewEl) {
                for (const el of previewsAll) {
                    if (el === latest) continue;
                    closePreviewElement(el);
                }
                currentPreviewEl = latest;
            }
            fitPreviewToViewport(latest);
            return;
        }

        if (!isGalleryOpen()) {
            closeAllPreviews();
            return;
        }

        dedupeGalleryElements();
        applyGalleryWindowLayout();
        styleGalleryWindowCloseButton();

        try { enforceGalleryGridLayout(); } catch (e) { /* ignore */ }

        document.querySelectorAll('.nGY2paginationRectangle, .nGY2paginationRectangleCurrentPage').forEach(el => {
            el.style.setProperty('height', GALLERY_PAGINATION_HEIGHT + 'px', 'important');
            el.style.setProperty('min-height', GALLERY_PAGINATION_HEIGHT + 'px', 'important');
            el.style.setProperty('max-height', GALLERY_PAGINATION_HEIGHT + 'px', 'important');
            el.style.setProperty('position', 'relative', 'important');
        });

        applyPageNumbers();

        try { scanAndSyncVideoBadges(); } catch (e) { /* ignore */ }

        const pager = document.querySelector('.gic-pagination-pager');
        if (pager) positionPager(pager);

        try { setupBulkDelete(); } catch (e) { /* ignore */ }
        restructureGalleryHeader();
        hideGalleryUploadMessage();

        currentPreviewEl = null;
    } finally {
        setTimeout(() => { isApplyingLayout = false; }, 0);
    }
}

function scheduleSTJEditorReopen() {
    if (_stjReopenScheduled) return;
    _stjReopenScheduled = true;

    const startTime = Date.now();
    const MAX_WAIT_MS = 5000;

    const tryOpen = () => {
        if (Date.now() - startTime > MAX_WAIT_MS) {
            console.warn('[GIC] ⚠️ STJEditor reopen timeout');
            _stjReopenScheduled = false;
            return;
        }

        if (!isGalleryOpen()) {
            setTimeout(tryOpen, 200);
            return;
        }

        if (!window.STJEditor?.open) {
            _stjReopenScheduled = false;
            return;
        }

        if (window.STJEditor?.isOpen?.()) {
            console.log('[GIC] ✅ STJEditor は既に開いています');
            _stjReopenScheduled = false;
            return;
        }

        try {
            window.STJEditor.open();
            console.log('[GIC] ✅ STJEditor を再オープンしました');
            _stjReopenScheduled = false;
        } catch (e) {
            console.warn('[GIC] STJEditor 再オープン失敗（リトライ）:', e);
            setTimeout(tryOpen, 200);
        }
    };

    setTimeout(tryOpen, 300);
}

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

        const charName = getCurrentCharacterName();
        if (charName) {
            warmupImageMemoryCacheForChar(charName).catch(() => {});
        }

        setTimeout(() => {
            if (!isGalleryOpen()) return;
            setupGalleryVideoThumbs().catch(e => console.warn('[GIC] video thumbs setup error:', e));
            preloadGalleryImagesInBackground().catch(e => console.warn('[GIC] preload error:', e));
        }, 100);

        if (warmupState !== 'running') {
            scheduleSTJEditorReopen();
        }
    } else {
        const previewsAll = getAllPreviews();
        if (previewsAll.length > 0) return;

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
        if (_bulkDeleteMode) positionFloatingBulkButton();
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

    window.__gicPendingPreview = null;

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
    const floatingBtn = document.getElementById('gic-floating-bulk-exit');
    if (floatingBtn) floatingBtn.remove();

    for (const sel of GALLERY_WINDOW_SELECTORS) {
        const elements = document.querySelectorAll(sel);
        for (const el of elements) {
            if (galleryBaseHeightCache.has(el)) galleryBaseHeightCache.delete(el);
            if (galleryBaseWidthCache.has(el)) galleryBaseWidthCache.delete(el);
        }
    }

    _paginationSnapshot = { count: -1, since: 0, stable: false };
    _paginationWindowStart = 0;
    _paginationWindowManual = false;
    _galleryTotalPagesCache = 0;

    if (window.STJEditor?.isOpen?.()) {
        try { window.STJEditor.close({ fromGallery: true, force: true }); } catch (e) { /* ignore */ }
    }

    lastGalleryStateForGic = null;
    _galleryOpenCache = { value: false, timestamp: 0 };
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
        try { hideStyle.remove(); } catch (_) { /* ignore */ }
    }
}

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
            setTimeout(() => {
                const charName = getCurrentCharacterName();
                if (charName) {
                    warmupImageMemoryCacheForChar(charName).catch(() => {});
                }
                prepareGalleryForCharacter().catch(() => {});
            }, 500);
        });
    }
    if (event_types.CHARACTER_SELECTED) {
        safeOn(event_types.CHARACTER_SELECTED, () => {
            _galleryPreparedFor = null;
            _galleryPreloadState = 'idle';
            setTimeout(() => {
                const charName = getCurrentCharacterName();
                if (charName) {
                    warmupImageMemoryCacheForChar(charName).catch(() => {});
                }
                prepareGalleryForCharacter().catch(() => {});
            }, 300);
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

        ensureThumbnailForVideo,
        generateVideoThumbnailBlob,
        videoFileToThumbName,
        isThumbFileName,
        getUploadHeaders,
        getCharName: getCurrentCharacterName,

        ensureImageThumbnail,
        generateImageThumbnailBlob,
        imageFileToThumbName,
        isImageThumbName,
        cleanupExistingImgThumbs,
        migrateCacheToDisk,

        clearThumbCache: clearAllThumbCache,
        getThumbCacheStats: getThumbCacheStats,

        clearImageCache: clearAllImageCache,
        preloadImages: () => preloadGalleryImagesInBackground(),
        getImageCacheStats: async () => {
            const charName = getCurrentCharacterName();
            if (!charName) return { error: 'no charName' };
            let count = 0;
            try {
                const db = await openImgDB();
                count = await new Promise((resolve, reject) => {
                    const tx = db.transaction(IMG_DB_STORE, 'readonly');
                    const req = tx.objectStore(IMG_DB_STORE).count();
                    req.onsuccess = () => resolve(req.result || 0);
                    req.onerror = () => reject(req.error);
                });
            } catch (e) { /* ignore */ }
            return {
                charName,
                indexedDBCount: count,
                memoryBlobUrlCount: _imgBlobUrlCache.size,
                manifestCount: _imgThumbKnown.size,
            };
        },
        warmupCache: () => {
            const charName = getCurrentCharacterName();
            if (charName) return warmupImageMemoryCacheForChar(charName);
            return Promise.resolve();
        },

        debugThumbState: async (charName) => {
            charName = charName || getCurrentCharacterName();
            if (!charName) return { error: 'no charName' };
            const stats = await getThumbCacheStats();
            const charKeys = stats.keys.filter(k => k.startsWith(charName + ':'));
            return {
                charName,
                indexedDBCount: charKeys.length,
                indexedDBKeys: charKeys,
                urlCacheSize: _thumbUrlCache.size,
            };
        },

        forceGridLayout: () => enforceGalleryGridLayout(),
    };

    window.GicDebugPageBlack = function() {
        const gallery = document.getElementById('gallery');
        if (!gallery) { console.log('[GicDebug] no gallery'); return; }
        const thumbs = gallery.querySelectorAll('.nGY2GThumbnail, .nGY2GThumbnail_l1');
        console.log(`[GicDebug] thumbs=${thumbs.length}`);
        thumbs.forEach((thumb, i) => {
            if (i > 4) return;
            const rect = thumb.getBoundingClientRect();
            const vis = rect.width > 0 && rect.height > 0;
            const thumbStyle = window.getComputedStyle(thumb);
            const nGY2TnImg = thumb.querySelector('.nGY2TnImg');
            const nGY2TnImgBack = thumb.querySelector('.nGY2TnImgBack');
            const nGY2TnImg2 = thumb.querySelector('.nGY2TnImg2');
            const imgEl = thumb.querySelector('.gic-gallery-image-cached') || thumb.querySelector('img');
            console.log(`[GicDebug] thumb[${i}] visible=${vis}`, {
                thumb: {
                    size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
                    bg: thumbStyle.backgroundColor,
                    opacity: thumbStyle.opacity,
                    display: thumbStyle.display,
                    title: thumb.getAttribute('title'),
                },
                nGY2TnImg: nGY2TnImg ? {
                    bgImage: window.getComputedStyle(nGY2TnImg).backgroundImage.slice(0, 80),
                    opacity: window.getComputedStyle(nGY2TnImg).opacity,
                    display: window.getComputedStyle(nGY2TnImg).display,
                    zIndex: window.getComputedStyle(nGY2TnImg).zIndex,
                } : null,
                nGY2TnImgBack: nGY2TnImgBack ? {
                    bgColor: window.getComputedStyle(nGY2TnImgBack).backgroundColor,
                    bgImage: window.getComputedStyle(nGY2TnImgBack).backgroundImage.slice(0, 80),
                    opacity: window.getComputedStyle(nGY2TnImgBack).opacity,
                    display: window.getComputedStyle(nGY2TnImgBack).display,
                    zIndex: window.getComputedStyle(nGY2TnImgBack).zIndex,
                } : null,
                nGY2TnImg2: nGY2TnImg2 ? {
                    src: nGY2TnImg2.src?.slice(0, 80),
                    display: window.getComputedStyle(nGY2TnImg2).display,
                    visibility: window.getComputedStyle(nGY2TnImg2).visibility,
                    opacity: window.getComputedStyle(nGY2TnImg2).opacity,
                } : null,
                img: imgEl ? {
                    src: imgEl.src.slice(0, 80),
                    complete: imgEl.complete,
                    naturalWidth: imgEl.naturalWidth,
                    opacity: window.getComputedStyle(imgEl).opacity,
                    display: window.getComputedStyle(imgEl).display,
                    zIndex: window.getComputedStyle(imgEl).zIndex,
                } : null,
            });
        });
    };

    console.log('[GIC] ✅ window.GicApi を公開しました');
}

// ============================================================
// ★ nanogallery2 の galleryMaxRows を 4 に強制
// ============================================================
(function patchNanogallery2For4Rows() {
    if (window.__gicNG2Patched) return;
    if (typeof window.$ === 'undefined' || !window.$.fn || typeof window.$.fn.nanogallery2 !== 'function') {
        setTimeout(patchNanogallery2For4Rows, 500);
        return;
    }
    window.__gicNG2Patched = true;
    const orig = window.$.fn.nanogallery2;
    window.$.fn.nanogallery2 = function(options) {
        try {
            if (options && typeof options === 'object' && !Array.isArray(options)) {
                if (typeof options.galleryMaxRows === 'number' && options.galleryMaxRows > 4) {
                    console.log('[GIC] 🎯 galleryMaxRows:', options.galleryMaxRows, '→ 4');
                    options.galleryMaxRows = 4;
                }
                options.thumbnailWidth = '180px';
                options.thumbnailHeight = 180;
            }
        } catch (e) { /* ignore */ }
        return orig.apply(this, arguments);
    };
    console.log('[GIC] ✅ nanogallery2 patch installed (galleryMaxRows ≤ 4, thumbnailWidth = 180px)');
})();

// ============================================================
// ★ #dragGallery 幅を 760px に事前固定（4列分）
// ============================================================
(function installDragGalleryWidthForcer() {
    if (window.__gicDragGalleryWidthForcer) return;
    window.__gicDragGalleryWidthForcer = true;

    const PARENT_W = 760;

    const forceWidth = (dg) => {
        if (!dg) return;
        dg.style.setProperty('width', PARENT_W + 'px', 'important');
        dg.style.setProperty('min-width', PARENT_W + 'px', 'important');
        dg.style.setProperty('max-width', PARENT_W + 'px', 'important');
        dg.style.setProperty('box-sizing', 'border-box', 'important');
    };

    forceWidth(document.getElementById('dragGallery'));

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.id === 'dragGallery') {
                    forceWidth(node);
                    continue;
                }
                if (node.querySelector) {
                    const dg = node.querySelector('#dragGallery');
                    if (dg) forceWidth(dg);
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    console.log('[GIC] ✅ #dragGallery 幅事前固定オブザーバを設置しました (4列対応: 760px)');
})();

function initializeGIC() {
    console.log('[GIC] 初期化開始');
    loadPersistedState();
    installBulkDeleteDocumentHandlers();
    installGalleryCloseInterceptor();
    setupImmediateThumbCacheInterceptor();

    const charName = getCurrentCharacterName();
    if (charName) {
        warmupImageMemoryCacheForChar(charName).catch(() => {});
    }

    document.addEventListener('click', (e) => {
        if (!e.target) return;
        const isPager = e.target.closest(
            '.nGY2paginationRectangle, .nGY2paginationRectangleCurrentPage, .gic-pagination-page, .gic-pagination-nav'
        );
        if (!isPager) return;
        handlePageSwitchAsync().catch(err => console.warn('[GIC] page switch error:', err));
    }, true);

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

    setInterval(() => {
        if (window.__gicDragInProgress) return;
        if (Date.now() < (window.__gicNoLayoutUntil || 0)) return;
        const g = document.getElementById('gallery');
        if (!g) return;
        const cs = getComputedStyle(g);
        if (cs.position !== 'fixed' || cs.left !== '0px' || cs.top !== '0px') {
            g.style.setProperty('position', 'fixed', 'important');
            g.style.setProperty('left', '0', 'important');
            g.style.setProperty('top', '0', 'important');
            g.style.setProperty('bottom', '0', 'important');
            g.style.setProperty('transform', 'none', 'important');
        }
    }, 100);

    scanForGeneratedImages();
    syncButtonVisibilityForTextStyling();
    syncGalleryButtonVisibility();
    applyGalleryLayout();
    try { setupGalleryVideoThumbs(); } catch (e) { /* ignore */ }

    /* ★ 起動 2秒後に、IndexedDB の既存サムネイルをディスクに一括書き出し
          （過去バージョンで生成された 207件等を一度だけ移行）
          移行が完了したら、この setTimeout は削除して構いません */
    setTimeout(() => {
        migrateCacheToDisk().catch(e => console.warn('[GIC] 移行失敗:', e));
    }, 2000);
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
    setupImmediateThumbCacheInterceptor();
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
