// gallery_thumbnail_resolution.js
// Resolution-aware thumbnail output, settings shortcut, lazy loading, and memory unloader for the GIC gallery.
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
        if (nativeWidth?.get && nativeWidth?.set && nativeHeight?.get && nativeHeight?.set) {
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
        }
    } catch (error) {
        console.warn('[GIC] Could not enable resolution-aware thumbnail canvases:', error);
    }

    // ============================================================
    // 1. ユーザー設定メニューへの「解像度確認ボタン」常設（赤い枠線付き）
    // ============================================================
    function placeSettingsButton() {
        const languageBlock = document.getElementById('UI-language-block');
        if (!languageBlock?.parentElement) return;

        let button = document.getElementById(SETTINGS_BUTTON_ID);
        if (!button) {
            button = document.createElement('button');
            button.id = SETTINGS_BUTTON_ID;
            button.type = 'button';
            button.className = 'menu_button menu_button_iconic';
            button.textContent = '解像度確認';
            button.title = 'モニタ解像度を選び直し、サムネイルの生成サイズを更新します';
            
            // ★ 暗いテーマでも埋もれないよう、明確な赤い枠線と背景・シャドウを適用
            button.style.cssText = `
                margin-left: 10px;
                padding: 6px 14px;
                cursor: pointer;
                align-self: center;
                font-weight: bold;
                white-space: nowrap;
                background-color: #2d3748;
                color: #ffffff;
                border: 2px solid #e53e3e;
                border-radius: 6px;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.4);
            `;

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

    // ============================================================
    // 2. パフォーマンス＆メモリ最適化（過剰な一括プリロード抑制・Lazy Loading・メモリ解放）
    // ============================================================
    const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    // GIC本体の一括プリロード関数をインターセプトしてメモリ爆発を防止
    function suppressAggressivePreloading() {
        if (window.GicApi && typeof window.GicApi.preloadAllImages === 'function') {
            if (!window.GicApi.__suppressed) {
                const originalPreload = window.GicApi.preloadAllImages;
                window.GicApi.preloadAllImages = async function(...args) {
                    console.info('[GalleryMemoryOpt] 🛡️ 一括バックグラウンド先読みはメモリ節約のためスキップされました。');
                    return Promise.resolve();
                };
                window.GicApi.__suppressed = true;
            }
        }
    }

    function enforceLazyLoading() {
        const gallery = document.getElementById('gallery');
        if (!gallery) return;

        gallery.querySelectorAll('img:not([loading="lazy"])').forEach(img => {
            img.setAttribute('loading', 'lazy');
            if (!img.hasAttribute('decoding')) {
                img.setAttribute('decoding', 'async');
            }
        });
    }

    let wasGalleryOpen = false;
    function monitorGalleryMemory() {
        const gallery = document.getElementById('gallery');
        if (!gallery) return;

        const isOpen = window.getComputedStyle(gallery).display !== 'none' && 
                       gallery.style.visibility !== 'hidden' &&
                       gallery.offsetParent !== null;

        if (wasGalleryOpen && !isOpen) {
            // ギャラリーが閉じられた時：画像srcを退避させてメモリを解放
            gallery.querySelectorAll('img.gic-gallery-image-cached, .nGY2GThumbnail img, #gallery img').forEach(img => {
                if (img.src && img.src !== TRANSPARENT_PIXEL && !img.src.startsWith('data:')) {
                    if (!img.dataset.gicSrcBackup) {
                        img.dataset.gicSrcBackup = img.src;
                    }
                    img.src = TRANSPARENT_PIXEL;
                }
            });
        } else if (!wasGalleryOpen && isOpen) {
            // ギャラリーが開いた時：画像を復元
            gallery.querySelectorAll('img[data-gic-src-backup]').forEach(img => {
                const backup = img.dataset.gicSrcBackup;
                if (backup) {
                    img.src = backup;
                    try { img.removeAttribute('data-gic-src-backup'); } catch (e) {}
                }
            });
        }

        wasGalleryOpen = isOpen;
    }

    function initGalleryOptimizer() {
        const observer = new MutationObserver(() => {
            suppressAggressivePreloading();
            enforceLazyLoading();
            monitorGalleryMemory();
        });
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGalleryOptimizer, { once: true });
    } else {
        initGalleryOptimizer();
    }

    // ============================================================
    // 3. キャッシュリフレッシュ & 解像度監視ループ
    // ============================================================
    let refreshInProgress = false;
    let lastResolutionSignature = null;

    function getResolutionSignature() {
        const { width, height } = readResolution();
        return `${width}x${height}:${Math.round(getSelectedScale() * 100)}`;
    }

    async function refreshCachesForResolution() {
        suppressAggressivePreloading();
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
                await window.GicApi.clearThumbCache?.();
                await window.GicApi.clearImageCache?.();
                try { localStorage.setItem(THUMBNAIL_SCALE_KEY, scaleKey); } catch (e) { /* ignore */ }
            }

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
        }
    }, 500);

    setInterval(refreshCachesForResolution, 500);
    window.addEventListener('storage', (event) => {
        if (event.key === RESOLUTION_KEY) refreshCachesForResolution();
    });
})();
