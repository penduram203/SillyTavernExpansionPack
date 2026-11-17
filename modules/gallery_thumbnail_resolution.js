// Resolution-aware thumbnail output and settings shortcut for the GIC gallery.
// The font-scale dialog's explicit monitor-resolution selection is the source
// of truth; viewport size and devicePixelRatio are intentionally not inferred.
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

    const canvases = new WeakMap();
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
        // GIC creates square image thumbnails and aspect-preserving video
        // thumbnails whose longest canvas edge is BASE_SIZE.
        return Math.max(width, height) === BASE_SIZE;
    }

    const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
    const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'height');
    const originalGetContext = HTMLCanvasElement.prototype.getContext;

    function updateCanvasBackingStore(canvas, state) {
        state.scale = isGicThumbnailSize(state.width, state.height) ? getSelectedScale() : 1;
        state.isGicThumbnail = state.scale > 1;
        scaledContexts.delete(canvas);
        widthDescriptor.set.call(canvas, Math.max(1, Math.round(state.width * state.scale)));
        heightDescriptor.set.call(canvas, Math.max(1, Math.round(state.height * state.scale)));
    }

    function patchDimension(property, descriptor) {
        Object.defineProperty(HTMLCanvasElement.prototype, property, {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            get: descriptor.get,
            set(value) {
                let state = canvases.get(this);
                if (!state) {
                    state = {
                        width: widthDescriptor.get.call(this),
                        height: heightDescriptor.get.call(this),
                        scale: 1,
                        isGicThumbnail: false,
                    };
                    canvases.set(this, state);
                }
                const logicalValue = Number(value);
                state[property] = Number.isFinite(logicalValue) ? logicalValue : 0;
                updateCanvasBackingStore(this, state);
            },
        });
    }

    try {
        if (!widthDescriptor?.get || !widthDescriptor?.set || !heightDescriptor?.get || !heightDescriptor?.set) {
            console.warn('[GIC] Canvas dimensions are not configurable; resolution-aware thumbnails unavailable.');
            return;
        }

        patchDimension('width', widthDescriptor);
        patchDimension('height', heightDescriptor);

        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
            const context = originalGetContext.call(this, type, ...args);
            const state = canvases.get(this);
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
            button.textContent = '解像度確認';
            button.title = 'モニタ解像度を選び直し、サムネイルの生成サイズを更新します';
            button.className = 'menu_button';
            button.style.cssText = [
                'margin-left:8px', 'white-space:nowrap', 'cursor:pointer',
                'align-self:center', 'padding:4px 10px', 'font-size:13px',
            ].join(';');
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

    let settingsObserver = null;
    function installSettingsButton() {
        placeSettingsButton();
        if (settingsObserver || !document.body) return;
        settingsObserver = new MutationObserver(placeSettingsButton);
        settingsObserver.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', installSettingsButton, { once: true });
    } else {
        installSettingsButton();
    }

    let refreshInProgress = false;
    let lastResolutionSignature = null;

    function resolutionSignature() {
        const { width, height } = readResolution();
        return `${width}x${height}:${Math.round(getSelectedScale() * 100)}`;
    }

    async function refreshCachesForResolution() {
        if (refreshInProgress || !window.GicApi) return;
        const signature = resolutionSignature();
        if (signature === lastResolutionSignature) return;
        lastResolutionSignature = signature;
        refreshInProgress = true;

        const scaleKey = String(Math.round(getSelectedScale() * 100) / 100);
        let savedScale = null;
        try { savedScale = localStorage.getItem(THUMBNAIL_SCALE_KEY); } catch (e) { /* ignore */ }
        try {
            // Old blobs have insufficient pixel data. Clear them so both image
            // and video thumbnail generation reruns at the newly selected size.
            if (savedScale !== scaleKey) {
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

    // The font dialog stores its selection in localStorage. Detect both the
    // initial choice and subsequent choices made from the settings shortcut.
    let apiWaitAttempts = 0;
    const apiWait = setInterval(() => {
        apiWaitAttempts++;
        if (!window.GicApi) {
            if (apiWaitAttempts >= 80) clearInterval(apiWait);
            return;
        }
        refreshCachesForResolution();
    }, 500);

    window.addEventListener('storage', (event) => {
        if (event.key === RESOLUTION_KEY) refreshCachesForResolution();
    });
})();
