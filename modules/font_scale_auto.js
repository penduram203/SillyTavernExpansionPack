// font_scale_auto.js
// フォントスケール（Font Scale）の上限を 2.0 に拡張し、
// 解像度に応じて自動設定する拡張モジュール。
//
// ★ 仕組み:
//   - ST本体の power-user.js は setFontScale() で 1.5 にクランプするため、
//     DOMの max 属性を変えても 1.5 を超えられない。
//   - そこで #font_scale の input を capture フェーズで傍受し、
//     1.5 超の場合は --mainFontSize を直接設定してクランプを回避する。
//   - 解像度ダイアログで選択された解像度から scale を計算し、
//     power_user.font_scale と --mainFontSize を更新する。
//
// ★ 解像度の基準:
//   1920×1080 を 1 とする。例: 3840×2160 なら scale = 2.0。
//   アスペクト比の縦長画面でも幅基準で計算（4K縦 = 2160×3840 は scale ≈ 1.125）。
//
// ★ 起動時の挙動:
//   初回起動時のみダイアログ表示。「このメッセージを再び表示しない」を
//   チェックすると次回以降は保存された解像度から自動再適用される。
//   いつでも ST の「UI Customization → Font Scale」から手動変更可能。
//
// ★ 公開 API:
//   window.FontScaleAuto.applyScale(2.0)   → Font Scale を 2.0 に設定
//   window.FontScaleAuto.showDialog()      → 解像度ダイアログを表示
//   window.FontScaleAuto.resetDismissed()  → 既読フラグをクリア
//   window.FontScaleAuto.getCurrentScale() → 現在の scale を取得

(function () {
    'use strict';
    if (window.__expFontScaleAutoInstalled) return;
    window.__expFontScaleAutoInstalled = true;

    const LOG = '[FontScaleAuto]';
    const DIALOG_SHOWN_KEY = 'exp_font_scale_dialog_shown';
    const RESOLUTION_KEY = 'exp_font_scale_resolution';
    const RESOLUTION_LABEL_KEY = 'exp_font_scale_resolution_label';

    const BASE_W = 1920;
    const BASE_H = 1080;
    const ST_BASE_FONT_PX = 15;   // ST本体の --mainFontSize デフォルト
    const MIN_SCALE = 0.5;
    const MAX_SCALE = 2.0;

    const PRESETS = [
        { label: '1366×768 (ノートPC)', w: 1366, h: 768 },
        { label: '1600×900', w: 1600, h: 900 },
        { label: '1920×1080 (FHD / 基準)', w: 1920, h: 1080 },
        { label: '2560×1440 (WQHD)', w: 2560, h: 1440 },
        { label: '3840×2160 (4K / UHD)', w: 3840, h: 2160 },
        { label: '5120×2880 (5K)', w: 5120, h: 2880 },
    ];

    // ============================================================
    // ST コンテキスト取得
    // ============================================================
    function getSTContext() {
        try {
            if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
                return window.SillyTavern.getContext();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // ============================================================
    // 解像度 → scale 計算（幅基準）
    // ============================================================
    function computeScale(w, h) {
        if (!Number.isFinite(w) || w <= 0) return 1;
        const raw = w / BASE_W;
        return Math.max(MIN_SCALE, Math.min(MAX_SCALE, raw));
    }

    // ============================================================
    // #font_scale / #font_scale_counter の max 属性を 2.0 に強制
    //   ST本体が描画し直すケース（DOM再構築）にも対応
    // ============================================================
    function enforceMaxAttribute() {
        const slider = document.getElementById('font_scale');
        const counter = document.getElementById('font_scale_counter');
        let changed = false;

        if (slider && slider.getAttribute('max') !== '2.0') {
            slider.setAttribute('max', '2.0');
            changed = true;
        }
        if (counter && counter.getAttribute('max') !== '2.0') {
            counter.setAttribute('max', '2.0');
            changed = true;
        }
        if (changed) {
            console.log(`${LOG} #font_scale / #font_scale_counter の max を 2.0 に変更`);
        }
    }

    function setupMaxAttributeObserver() {
        enforceMaxAttribute();

        let pending = false;
        const mo = new MutationObserver(() => {
            if (pending) return;
            pending = true;
            requestAnimationFrame(() => {
                pending = false;
                enforceMaxAttribute();
            });
        });
        mo.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    // ============================================================
    // Font Scale を適用（STのクランプを回避）
    //   - power_user.font_scale を更新
    //   - --mainFontSize を直接設定（1.5超も反映）
    // ============================================================
    function applyFontScale(scale) {
        const ctx = getSTContext();
        if (!ctx?.extensionSettings?.power_user) {
            console.warn(`${LOG} extensionSettings.power_user が利用できません`);
            return false;
        }

        let s = Number(scale);
        if (!Number.isFinite(s)) s = 1;
        s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

        // ① ST 内部設定
        ctx.extensionSettings.power_user.font_scale = s;

        // ② UI 反映
        const slider = document.getElementById('font_scale');
        const counter = document.getElementById('font_scale_counter');
        if (slider) slider.value = String(s);
        if (counter) counter.value = String(s);

        // ③ ST の applyFontScale を呼ぶ（存在すれば）
        //    1.5 でクランプされるが、その後の上書きで対応
        if (typeof ctx.applyFontScale === 'function') {
            try { ctx.applyFontScale(); } catch (e) { /* ignore */ }
        }

        // ④ --mainFontSize を直接設定（クランプ回避）
        const fontSizePx = ST_BASE_FONT_PX * s;
        document.documentElement.style.setProperty('--mainFontSize', `${fontSizePx}px`);

        // ⑤ 保存
        if (typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }

        console.log(`${LOG} Font Scale を ${s} に設定 (--mainFontSize = ${fontSizePx}px)`);
        return true;
    }

    // ============================================================
    // #font_scale の手動変更を capture フェーズで傍受
    //   1.5 超の場合は ST のクランプを回避して --mainFontSize を強制
    // ============================================================
    function setupFontScaleInterceptor() {
        // ① input: リアルタイム反映
        document.addEventListener('input', (e) => {
            const target = e.target;
            if (!target || target.id !== 'font_scale') return;
            const v = parseFloat(target.value);
            if (!Number.isFinite(v)) return;
            if (v > 1.5) {
                document.documentElement.style.setProperty(
                    '--mainFontSize',
                    `${ST_BASE_FONT_PX * v}px`
                );
                const counter = document.getElementById('font_scale_counter');
                if (counter) counter.value = String(v);
            }
        }, true);

        // ② change: ST の input ハンドラ実行後に再上書き
        document.addEventListener('change', (e) => {
            const target = e.target;
            if (!target || target.id !== 'font_scale') return;
            const v = parseFloat(target.value);
            if (!Number.isFinite(v) || v <= 1.5) return;
            setTimeout(() => {
                document.documentElement.style.setProperty(
                    '--mainFontSize',
                    `${ST_BASE_FONT_PX * v}px`
                );
            }, 50);
        }, true);
    }

    // ============================================================
    // 解像度ダイアログ
    // ============================================================
    function showResolutionDialog() {
        // 既に表示中なら多重起動しない
        if (document.getElementById('exp-font-scale-dialog-overlay')) return;

        // 既読なら保存値から再適用
        if (localStorage.getItem(DIALOG_SHOWN_KEY) === 'true') {
            const saved = localStorage.getItem(RESOLUTION_KEY);
            if (saved) {
                try {
                    const data = JSON.parse(saved);
                    applyFontScale(computeScale(data.w, data.h));
                } catch (e) { /* ignore */ }
            }
            return;
        }

        const overlay = document.createElement('div');
        overlay.id = 'exp-font-scale-dialog-overlay';
        Object.assign(overlay.style, {
            position: 'fixed',
            top: '0', left: '0', right: '0', bottom: '0',
            background: 'rgba(0, 0, 0, 0.75)',
            zIndex: '2147483646',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
            boxSizing: 'border-box',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
        });

        const box = document.createElement('div');
        Object.assign(box.style, {
            background: '#1a202c',
            color: '#e2e8f0',
            border: '2px solid #4a5568',
            borderRadius: '12px',
            padding: '28px 32px',
            maxWidth: '600px',
            width: '100%',
            boxShadow: '0 20px 60px rgba(0, 0, 0, 0.8)',
            boxSizing: 'border-box',
        });

        box.innerHTML = `
            <h2 style="margin: 0 0 12px 0; font-size: 22px; color: #ffffff;">モニタ解像度を選択してください</h2>
            <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #a0aec0;">
                選択した解像度に応じて、フォントスケールを自動的に設定します。<br>
                （1920×1080 を基準として、スケール値を計算します）
            </p>
            <div id="exp-fs-options" style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px;"></div>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #cbd5e0; cursor: pointer; margin-bottom: 20px;">
                <input type="checkbox" id="exp-fs-dont-show" style="cursor: pointer;">
                このメッセージを再び表示しない
            </label>
            <p style="margin: 0 0 20px 0; font-size: 12px; line-height: 1.5; color: #718096;">
                フォントサイズは、ユーザー設定の「フォントスケール」からいつでも自由に変更できます。
            </p>
            <div style="display: flex; justify-content: flex-end; gap: 12px;">
                <button type="button" id="exp-fs-cancel" style="padding: 10px 24px; background: #4a5568; color: #ffffff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: bold;">キャンセル</button>
                <button type="button" id="exp-fs-apply" style="padding: 10px 24px; background: #2b6cb0; color: #ffffff; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: bold;">適用</button>
            </div>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        // ── 選択肢生成 ──
        const optionsContainer = box.querySelector('#exp-fs-options');
        let selectedIdx = 2; // デフォルト: 1920×1080

        PRESETS.forEach((preset, idx) => {
            const label = document.createElement('label');
            Object.assign(label.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '10px 14px',
                background: idx === selectedIdx ? '#2d3748' : '#1a202c',
                border: `2px solid ${idx === selectedIdx ? '#4299e1' : '#4a5568'}`,
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '14px',
                transition: 'background-color 0.15s ease, border-color 0.15s ease',
            });

            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'exp-fs-resolution';
            radio.value = String(idx);
            radio.checked = idx === selectedIdx;
            radio.style.cursor = 'pointer';

            const text = document.createElement('span');
            text.textContent = preset.label;

            const scaleInfo = document.createElement('span');
            const s = computeScale(preset.w, preset.h);
            scaleInfo.textContent = `(scale ${s.toFixed(2)})`;
            scaleInfo.style.marginLeft = 'auto';
            scaleInfo.style.fontSize = '12px';
            scaleInfo.style.color = '#a0aec0';

            label.appendChild(radio);
            label.appendChild(text);
            label.appendChild(scaleInfo);

            radio.addEventListener('change', () => {
                selectedIdx = idx;
                optionsContainer.querySelectorAll('label').forEach((l, i) => {
                    l.style.background = i === idx ? '#2d3748' : '#1a202c';
                    l.style.borderColor = i === idx ? '#4299e1' : '#4a5568';
                });
            });

            optionsContainer.appendChild(label);
        });

        // ── 適用ボタン ──
        box.querySelector('#exp-fs-apply').addEventListener('click', () => {
            const preset = PRESETS[selectedIdx];
            const scale = computeScale(preset.w, preset.h);

            localStorage.setItem(RESOLUTION_KEY, JSON.stringify({
                w: preset.w,
                h: preset.h,
                scale,
                setAt: Date.now(),
            }));
            localStorage.setItem(RESOLUTION_LABEL_KEY, preset.label);

            const dontShow = box.querySelector('#exp-fs-dont-show');
            if (dontShow?.checked) {
                localStorage.setItem(DIALOG_SHOWN_KEY, 'true');
            }

            applyFontScale(scale);
            overlay.remove();
            console.log(`${LOG} 解像度 ${preset.label} → scale ${scale.toFixed(2)} を適用`);
        });

        // ── キャンセルボタン ──
        box.querySelector('#exp-fs-cancel').addEventListener('click', () => {
            overlay.remove();
        });
    }

    // ============================================================
    // 初期化
    // ============================================================
    function init() {
        setupMaxAttributeObserver();
        setupFontScaleInterceptor();

        let tries = 0;
        const timer = setInterval(() => {
            tries++;
            if (document.getElementById('font_scale')) {
                clearInterval(timer);
                showResolutionDialog();
            } else if (tries > 30) {
                clearInterval(timer);
                console.warn(`${LOG} #font_scale が見つかりませんでした`);
            }
        }, 200);
    }

    function bootstrap() {
        const ctx = getSTContext();
        if (ctx?.eventSource && ctx?.eventTypes?.APP_READY) {
            ctx.eventSource.on(ctx.eventTypes.APP_READY, init);
            setTimeout(init, 5000);
        } else {
            setTimeout(init, 2000);
        }
    }

    bootstrap();

    // ============================================================
    // 公開 API
    // ============================================================
    window.FontScaleAuto = {
        applyScale: applyFontScale,
        showDialog: showResolutionDialog,
        resetDismissed: () => {
            localStorage.removeItem(DIALOG_SHOWN_KEY);
            localStorage.removeItem(RESOLUTION_KEY);
            localStorage.removeItem(RESOLUTION_LABEL_KEY);
            console.log(`${LOG} 既読フラグと解像度設定をリセットしました`);
        },
        getCurrentScale: () => {
            const ctx = getSTContext();
            return ctx?.extensionSettings?.power_user?.font_scale ?? 1;
        },
        getSavedResolution: () => {
            try {
                const raw = localStorage.getItem(RESOLUTION_KEY);
                return raw ? JSON.parse(raw) : null;
            } catch (e) { return null; }
        },
    };

    console.log(`${LOG} installed`);
})();
