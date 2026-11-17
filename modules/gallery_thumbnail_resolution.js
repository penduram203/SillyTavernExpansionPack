// Resolution-aware thumbnail output and settings shortcut for the GIC gallery.
// GIC's existing image/video thumbnail generators draw into 260px canvases.
// Preserve their logical drawing coordinates while increasing only the backing
// store resolution, based on the resolution explicitly selected in the dialog.
(function installGalleryThumbnailResolution() {
    'use strict';

    if (window.__gicGalleryThumbnailResolutionInstalled) return;
    window.__gicGalleryThumbnailResolutionInstalled = true;

    const RESOLUTION_KEY = 'exp_font_scale_resolution';
    const THUMBNAIL_SCALE_KEY = 'gic_gallery_thumbnail_scale_v1';
    const SETTINGS_BUTTON_ID = 'gic-resolution-settings-button';
    const BASE_SIZE = 260;
    const BASE_WIDTH = 1920;
    const BASE_HEIGHT = 1080;
    const MIN_SCALE = 1;
    const MAX_SCALE = 2;

    // Capture the real browser descriptors before installing our wrappers.
    // Calling a patched descriptor from its own setter recurses and corrupts
    // canvas output (the earlier implementation caused black thumbnails).
    const nativeWidth = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
    const nativeHeight = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
    const nativeGetContext = HTMLCanvasElement.prototype.getContext;
    const canvasState = new WeakMap();
    const scaledContexts = new WeakMap();

    function readResolution() {
        try {
            const value = JSON.parse(localStorage.getItem(RESOLUTION_KEY) || 'null');
            const width = Number(value?.w);
            const height = Number(value?.h);
            if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
                return { width, height };
            }
        } catch (e) { /* use baseline when the saved choice is missing or invalid */ }
        return { width: BASE_WIDTH, height: BASE_HEIGHT };
    }

    function getSelectedScale() {
        const { width, height } = readResolution();
        const scale = Math.min(width / BASE_WIDTH, height / BASE_HEIGHT);
        return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
    }

    function isGicThumbnailSize(width, height) {
        // Image thumbnails are 260x260. Video thumbnails preserve aspect ratio
        // and have their longest edge capped at 260px.
        return Math.max(width, height) === BASE_SIZE;
    }

    function updateBackingStore(canvas, state) {
        state.scale = isGicThumbnailSize(state.width, state.height) ? getSelectedScale() : 1;
        state.isGicThumbnail = state.scale > 1;
        scaledContexts.delete(canvas);
        nativeWidth.set.call(canvas, Math.max(1, Math.round(state.width * state.scale)));
        nativeHeight.set.call(canvas, Math.max(1, Math.round(state.height * state.scale)));
    }

    function getOrCreateState(canvas) {
        let state = canvasState.get(canvas);
        if (!state) {
            state = {
                width: nativeWidth.get.call(canvas),
                height: nativeHeight.get.call(canvas),
                scale: 1,
                isGicThumbnail: false,
            };
            canvasState.set(canvas, state);
        }
        return state;
    }

    function patchDimension(property, nativeDescriptor) {
        Object.defineProperty(HTMLCanvasElement.prototype, property, {
            configurable: nativeDescriptor.configurable,
            enumerable: nativeDescriptor.enumerable,
            get: nativeDescriptor.get,
            set(value) {
                const state = getOrCreateState(this);
                const logicalValue = Number(value);
                state[property] = Number.isFinite(logicalValue) ? logicalValue : 0;
                updateBackingStore(this, state);
            },
        });
    }

    try {
        if (!nativeWidth?.get || !nativeWidth?.set || !nativeHeight?.get || !nativeHeight?.set) {
            console.warn('[GIC] Canvas dimensions are not configurable; resolution-aware thumbnails unavailable.');
            return;
        }

        patchDimension('width', nativeWidth);
        patchDimension('height', nativeHeight);

        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
            const context = nativeGetContext.call(this, type, ...args);
            const state = canvasState.get(this);
            if (context && type === '2d' && state?.isGicThumbnail &&
                scaledContexts.get(this) !== state.scale) {
                context.scale(state.scale, state.scale);
                scaledContexts.set(this, state.scale);
            }
            return context;
        };
    } catch (error) {
        console.warn('[GIC] Could not enable resolution-aware thumbnail canvases:', error);
        return;
    }

    function placeSettingsButton() {
        const languageBlock = document.getElementById('UI-language-block');
        if (!languageBlock?.parentElement) return;

        let button = document.getElementById(SETTINGS_BUTTON_ID);
        if (!button) {
            button = document.createElement('button');
            button.id = SETTINGS_BUTTON_ID;
            button.type = 'button';
            button.className = 'menu_button';
            button.textContent = '解像度確認';
            button.title = 'モニタ解像度を選び直し、サムネイルの生成サイズを更新します';
            button.style.cssText = 'margin-left:8px;white-space:nowrap;cursor:pointer;align-self:center;padding:4px 10px;font-size:13px;';
            button.addEventListener('click', () => {
                if (typeof window.FontScaleAuto?.showDialog === 'function') {
                    window.FontScaleAuto.showDialog();
                } else {
                    console.warn('[GIC] FontScaleAuto.showDialog is unavailable.');
                }
            });
        }

        if (languageBlock.nextElementSibling !== button) {
            languageBlock.insertAdjacentElement('afterend', button);
        }
    }

    function installSettingsButton() {
        placeSettingsButton();
        if (!document.body || window.__gicResolutionSettingsObserverInstalled) return;
        window.__gicResolutionSettingsObserverInstalled = true;
        const observer = new MutationObserver(placeSettingsButton);
        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installSettingsButton, { once: true });
    } else {
        installSettingsButton();
    }

    let refreshInProgress = false;
    let lastResolutionSignature = null;

    function getResolutionSignature() {
        const { width, height } = readResolution();
        return `${width}x${height}:${Math.round(getSelectedScale() * 100)}`;
    }

    async function refreshCachesForResolution() {
        if (refreshInProgress || !window.GicApi) return;
        const signature = getResolutionSignature();
        if (signature === lastResolutionSignature) return;
        lastResolutionSignature = signature;
        refreshInProgress = true;

        const scaleKey = String(Math.round(getSelectedScale() * 100) / 100);
        let savedScale = null;
        try { savedScale = localStorage.getItem(THUMBNAIL_SCALE_KEY); } catch (e) { /* ignore */ }

        try {
            if (savedScale !== scaleKey) {
                // The old fixed-size blobs cannot be enlarged without losing
                // detail. Clear them so GIC regenerates from original media.
                await window.GicApi.clearThumbCache?.();
                await window.GicApi.clearImageCache?.();
                try { localStorage.setItem(THUMBNAIL_SCALE_KEY, scaleKey); } catch (e) { /* ignore */ }
            }

            console.info(`[GIC] Selected monitor resolution ${signature}; thumbnail scale ${Math.round(Number(scaleKey) * 100)}%`);
            if (window.GicApi.isOpen?.()) {
                await window.GicApi.forceRefreshGallery?.();
            }
        } catch (error) {
            console.warn('[GIC] Failed to refresh thumbnails for selected resolution:', error);
        } finally {
            refreshInProgress = false;
        }
    }

    let apiWaitAttempts = 0;
    const apiWait = setInterval(() => {
        apiWaitAttempts++;
        if (window.GicApi) {
            refreshCachesForResolution();
        } else if (apiWaitAttempts >= 80) {
            clearInterval(apiWait);
            console.warn('[GIC] GicApi unavailable; thumbnail cache migration skipped.');
        }
    }, 500);

    // The font dialog writes localStorage in this tab (which does not emit a
    // storage event), so poll for its saved resolution as well.
    setInterval(refreshCachesForResolution, 500);
    window.addEventListener('storage', (event) => {
        if (event.key === RESOLUTION_KEY) refreshCachesForResolution();
    });
})();
