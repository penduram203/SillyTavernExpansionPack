// Resolution-aware thumbnail output for the GIC gallery.
// The font-scale dialog stores the resolution selected by the user in
// localStorage; use that saved choice rather than guessing from innerWidth.
(function installGalleryThumbnailResolution() {
    'use strict';

    if (window.__gicGalleryThumbnailResolutionInstalled) return;
    window.__gicGalleryThumbnailResolutionInstalled = true;

    const RESOLUTION_KEY = 'exp_font_scale_resolution';
    const THUMBNAIL_SCALE_KEY = 'gic_gallery_thumbnail_scale_v1';
    const BASE_SIZE = 260;
    const MIN_SCALE = 1;
    const MAX_SCALE = 2;
    const canvasState = new WeakMap();
    const contextScale = new WeakMap();

    function getSelectedScale() {
        try {
            const saved = JSON.parse(localStorage.getItem(RESOLUTION_KEY) || 'null');
            const scale = Number(saved?.scale);
            if (Number.isFinite(scale) && scale > 0) {
                return Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
            }
        } catch (e) { /* use baseline when no valid selection has been saved */ }
        return 1;
    }

    function updateCanvasSize(canvas, state) {
        const isGicThumbnail = state.width === BASE_SIZE || state.height === BASE_SIZE;
        state.scale = isGicThumbnail ? getSelectedScale() : 1;
        state.isGicThumbnail = isGicThumbnail;
        state.scaled = false;
        contextScale.delete(canvas);

        if (!isGicThumbnail || state.scale === 1) return;
        state.scaled = true;
        state.nativeWidth.set.call(canvas, Math.max(1, Math.round(state.width * state.scale)));
        state.nativeHeight.set.call(canvas, Math.max(1, Math.round(state.height * state.scale)));
    }

    function patchDimension(property, nativeDescriptor) {
        Object.defineProperty(HTMLCanvasElement.prototype, property, {
            configurable: nativeDescriptor.configurable,
            enumerable: nativeDescriptor.enumerable,
            get: nativeDescriptor.get,
            set(value) {
                let state = canvasState.get(this);
                if (!state) {
                    state = {
                        width: nativeDescriptor.get.call(this),
                        height: property === 'width' ? this.height : this.width,
                        scale: 1,
                        isGicThumbnail: false,
                        scaled: false,
                        nativeWidth: Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width'),
                        nativeHeight: Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height'),
                    };
                    canvasState.set(this, state);
                }

                state[property] = Number(value);
                nativeDescriptor.set.call(this, value);
                updateCanvasSize(this, state);
            },
        });
    }

    try {
        const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
        const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
        if (!widthDescriptor?.get || !widthDescriptor?.set || !heightDescriptor?.get || !heightDescriptor?.set) {
            console.warn('[GIC] Canvas dimensions are not configurable; resolution-aware thumbnails unavailable.');
            return;
        }

        // Keep the original descriptors for writing scaled backing-store dimensions.
        patchDimension('width', widthDescriptor);
        patchDimension('height', heightDescriptor);

        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
            const context = originalGetContext.call(this, type, ...args);
            const state = canvasState.get(this);
            if (context && type === '2d' && state?.isGicThumbnail && state.scale > 1 &&
                contextScale.get(this) !== state.scale) {
                context.scale(state.scale, state.scale);
                contextScale.set(this, state.scale);
            }
            return context;
        };
    } catch (error) {
        console.warn('[GIC] Could not enable resolution-aware thumbnail canvases:', error);
        return;
    }

    let refreshInProgress = false;
    let lastScaleKey = null;

    async function refreshCachesIfResolutionChanged() {
        if (refreshInProgress || !window.GicApi) return;
        const scaleKey = String(Math.round(getSelectedScale() * 100) / 100);
        if (scaleKey === lastScaleKey) return;
        refreshInProgress = true;
        lastScaleKey = scaleKey;

        let savedScale = null;
        try { savedScale = localStorage.getItem(THUMBNAIL_SCALE_KEY); } catch (e) { /* ignore */ }
        if (savedScale === scaleKey) {
            refreshInProgress = false;
            return;
        }

        try {
            // Old blobs are fixed-resolution; remove them so they are recreated
            // from the originals using the selected monitor-resolution scale.
            await window.GicApi.clearThumbCache?.();
            await window.GicApi.clearImageCache?.();
            try { localStorage.setItem(THUMBNAIL_SCALE_KEY, scaleKey); } catch (e) { /* ignore */ }

            console.info(`[GIC] Thumbnail resolution scale: ${Math.round(Number(scaleKey) * 100)}%`);
            if (window.GicApi.isOpen?.()) {
                await window.GicApi.forceRefreshGallery?.();
            }
        } catch (error) {
            console.warn('[GIC] Failed to refresh thumbnails for selected resolution:', error);
        } finally {
            refreshInProgress = false;
        }
    }

    // GIC is imported immediately after this module. Wait for its API, then
    // watch for a resolution selection made later in font_scale_auto's dialog.
    const apiWait = setInterval(() => {
        if (!window.GicApi) return;
        refreshCachesIfResolutionChanged();
    }, 500);

    setTimeout(() => {
        if (!window.GicApi) {
            clearInterval(apiWait);
            console.warn('[GIC] GicApi unavailable; thumbnail cache migration skipped.');
        }
    }, 20000);
})();
