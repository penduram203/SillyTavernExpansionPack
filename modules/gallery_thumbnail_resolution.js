// gallery_thumbnail_resolution.js
// Resolution-aware thumbnail output and settings shortcut for the GIC gallery.
// 軽量化版: サムネイル生成を廃止し、元画像ベースの直接縮小表示へ移行 ＆ 解像度確認ボタンの視認性改善（赤枠付）
(function installGalleryThumbnailResolution() {
    'use strict';

    if (window.__gicGalleryThumbnailResolutionInstalled) return;
    window.__gicGalleryThumbnailResolutionInstalled = true;

    const RESOLUTION_KEY = 'exp_font_scale_resolution';
    const SETTINGS_BUTTON_ID = 'gic-resolution-settings-button';

    // ============================================================
    // 1. ユーザー設定メニューへの「解像度確認ボタン」常設（赤い枠線で視認性向上）
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
            button.title = 'モニタ解像度を選び直し、表示スケールを更新します';
            
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
    // 2. ギャラリー描画の軽量化（重いサムネイル生成をスキップし、元画像直接縮小へ）
    // ============================================================
    try {
        if (window.GicApi) {
            // サムネイルキャッシュの強制生成や無駄なバックグラウンド処理を抑制
            window.GicApi.skipHeavyThumbnailGeneration = true;
        }
    } catch (e) {
        // ignore
    }

    console.info('[GIC] Gallery thumbnail resolution optimized: Lightweight direct image scaling & red-border settings button enabled.');
})();
