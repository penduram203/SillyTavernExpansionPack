// font_scale_auto.js
// フォントスケール（Font Scale）の上限を 2.0 に拡張し、
// 解像度に応じて自動設定する拡張モジュール。
//
// ★ v2 修正:
//   - 初回ダイアログを 1.5倍サイズ・太字に拡大
//   - power_user.font_scale を複数パス（ctx.powerUserSettings / window.power_user /
//     ctx.extensionSettings.power_user）で更新
//   - --mainFontSize と slider の値を多段階で再適用（DOM再描画対策）
//   - ユーザーが手動変更するまで --mainFontSize を守るガードループ

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
    const ST_BASE_FONT_PX = 15;
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

    let _targetFontScale = null;
    let _guardStarted = false;

    function getSTContext() {
        try {
            if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
                return window.SillyTavern.getContext();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function computeScale(w, h) {
        if (!Number.isFinite(w) || w <= 0) return 1;
        const raw = w / BASE_W;
        return Math.max(MIN_SCALE, Math.min(MAX_SCALE, raw));
    }

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
        mo.observe(document.body, { childList: true, subtree: true });
    }

    // ============================================================
    // Font Scale の適用（多重パス・多段階反映）
    // ============================================================
    function applyFontScale(scale) {
        let s = Number(scale);
        if (!Number.isFinite(s)) s = 1;
        s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

        const ctx = getSTContext();
        const targetPx = ST_BASE_FONT_PX * s;

        // ① power_user.font_scale を複数パスで更新
        const paths = [
            { obj: ctx?.powerUserSettings, name: 'ctx.powerUserSettings' },
            { obj: ctx?.extensionSettings?.power_user, name: 'ctx.extensionSettings.power_user' },
            { obj: window.power_user, name: 'window.power_user' },
            { obj: window.powerUserSettings, name: 'window.powerUserSettings' },
        ];
        const updatedPaths = [];
        for (const { obj, name } of paths) {
            if (obj && typeof obj === 'object') {
                obj.font_scale = s;
                updatedPaths.push(name);
            }
        }
        if (updatedPaths.length > 0) {
            console.log(`${LOG} power_user.font_scale = ${s} (paths: ${updatedPaths.join(', ')})`);
        } else {
            console.warn(`${LOG} power_user オブジェクトが見つかりません。--mainFontSize のみで反映します`);
        }

        // ② --mainFontSize を強制
        document.documentElement.style.setProperty('--mainFontSize', `${targetPx}px`);

        // ③ UI 反映
        const slider = document.getElementById('font_scale');
        const counter = document.getElementById('font_scale_counter');
        if (slider) slider.value = String(s);
        if (counter) counter.value = String(s);

        // ④ ST の applyFontScale を呼ぶ（候補を全部試す）
        const applyFns = [ctx?.applyFontScale, window.applyFontScale];
        for (const fn of applyFns) {
            if (typeof fn === 'function') {
                try { fn(); break; } catch (e) { /* ignore */ }
            }
        }

        // ⑤ ST が上書きした場合の保険として再設定
        document.documentElement.style.setProperty('--mainFontSize', `${targetPx}px`);
        if (slider) slider.value = String(s);
        if (counter) counter.value = String(s);

        // ⑥ 保存
        if (typeof ctx?.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }

        // ⑦ 目標値として記録（ガードループ用）
        _targetFontScale = s;
        startFontScaleGuard();

        // ⑧ 遅延再適用（DOM再描画対策）
        setTimeout(() => {
            if (_targetFontScale !== s) return;
            document.documentElement.style.setProperty('--mainFontSize', `${targetPx}px`);
            if (slider) slider.value = String(s);
            if (counter) counter.value = String(s);
        }, 200);
        setTimeout(() => {
            if (_targetFontScale !== s) return;
            document.documentElement.style.setProperty('--mainFontSize', `${targetPx}px`);
            if (slider) slider.value = String(s);
            if (counter) counter.value = String(s);
        }, 600);

        console.log(`${LOG} Font Scale を ${s} に設定 (--mainFontSize = ${targetPx}px)`);
        return true;
    }

    // ============================================================
    // ガードループ: --mainFontSize / slider の値を目標値に保つ
    //   ユーザーが手動で font_scale を変更したらガード解除
    // ============================================================
    function startFontScaleGuard() {
        if (_guardStarted) return;
        _guardStarted = true;

        setInterval(() => {
            if (_targetFontScale === null) return;

            const ctx = getSTContext();
            const currentPU =
                ctx?.powerUserSettings?.font_scale ??
                ctx?.extensionSettings?.power_user?.font_scale ??
                window.power_user?.font_scale ??
                window.powerUserSettings?.font_scale;

            if (typeof currentPU === 'number' && Math.abs(currentPU - _targetFontScale) > 0.01) {
                console.log(`${LOG} ユーザーが手動で Font Scale を ${currentPU} に変更 → ガード解除`);
                _targetFontScale = null;
                return;
            }

            const expectedPx = `${ST_BASE_FONT_PX * _targetFontScale}px`;
            const nowPx = document.documentElement.style.getPropertyValue('--mainFontSize');
            if (nowPx !== expectedPx) {
                document.documentElement.style.setProperty('--mainFontSize', expectedPx);
            }

            const slider = document.getElementById('font_scale');
            if (slider && Math.abs(parseFloat(slider.value) - _targetFontScale) > 0.01) {
                slider.value = String(_targetFontScale);
            }
        }, 1000);
    }

    // ============================================================
    // #font_scale 手動変更のキャプチャ（1.5超対応）
    // ============================================================
    function setupFontScaleInterceptor() {
        document.addEventListener('input', (e) => {
            const target = e.target;
            if (!target || target.id !== 'font_scale') return;
            const v = parseFloat(target.value);
            if (!Number.isFinite(v)) return;

            if (_targetFontScale !== null && Math.abs(v - _targetFontScale) > 0.01) {
                _targetFontScale = null;
            }

            if (v > 1.5) {
                document.documentElement.style.setProperty(
                    '--mainFontSize',
                    `${ST_BASE_FONT_PX * v}px`
                );
                const counter = document.getElementById('font_scale_counter');
                if (counter) counter.value = String(v);
            }
        }, true);

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
    // 解像度ダイアログ（1.5倍サイズ・太字）
    // ============================================================
    function showResolutionDialog() {
        if (document.getElementById('exp-font-scale-dialog-overlay')) return;

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

        const S = window.S || ((px) => px);

        const overlay = document.createElement('div');
        overlay.id = 'exp-font-scale-dialog-overlay';
        Object.assign(overlay.style, {
            position: 'fixed',
            top: '0', left: '0', right: '0', bottom: '0',
            background: 'rgba(0, 0, 0, 0.8)',
            zIndex: '2147483646',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: `${S(30)}px`,
            boxSizing: 'border-box',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
        });

        const box = document.createElement('div');
        Object.assign(box.style, {
            background: '#1a202c',
            color: '#e2e8f0',
            border: `${S(3)}px solid #4a5568`,
            borderRadius: `${S(18)}px`,
            padding: `${S(42)}px ${S(48)}px`,
            maxWidth: `min(${S(900)}px, calc(100vw - 40px))`,
            width: '100%',
            boxShadow: `0 ${S(20)}px ${S(60)}px rgba(0, 0, 0, 0.85)`,
            boxSizing: 'border-box',
        });

        // ── タイトル ──
        const h2 = document.createElement('h2');
        h2.textContent = 'モニタ解像度を選択してください';
        Object.assign(h2.style, {
            margin: `0 0 ${S(18)}px 0`,
            fontSize: `${S(33)}px`,
            fontWeight: '900',
            color: '#ffffff',
            letterSpacing: '0.02em',
        });
        box.appendChild(h2);

        // ── 説明 ──
        const desc = document.createElement('p');
        desc.innerHTML = '選択した解像度に応じて、<strong style="color:#f6e05e;">フォントスケール</strong>を自動的に設定します。<br>（1920×1080 を基準として、スケール値を計算します）';
        Object.assign(desc.style, {
            margin: `0 0 ${S(28)}px 0`,
            fontSize: `${S(21)}px`,
            fontWeight: '600',
            lineHeight: '1.7',
            color: '#cbd5e0',
        });
        box.appendChild(desc);

        // ── 選択肢 ──
        const optionsContainer = document.createElement('div');
        Object.assign(optionsContainer.style, {
            display: 'flex',
            flexDirection: 'column',
            gap: `${S(12)}px`,
            marginBottom: `${S(28)}px`,
        });
        box.appendChild(optionsContainer);

        let selectedIdx = 2; // デフォルト: 1920×1080

        PRESETS.forEach((preset, idx) => {
            const label = document.createElement('label');
            Object.assign(label.style, {
                display: 'flex',
                alignItems: 'center',
                gap: `${S(15)}px`,
                padding: `${S(15)}px ${S(21)}px`,
                background: idx === selectedIdx ? '#2d3748' : '#1a202c',
                border: `${S(3)}px solid ${idx === selectedIdx ? '#4299e1' : '#4a5568'}`,
                borderRadius: `${S(9)}px`,
                cursor: 'pointer',
                fontSize: `${S(21)}px`,
                fontWeight: '700',
                transition: 'background-color 0.15s ease, border-color 0.15s ease',
            });

            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'exp-fs-resolution';
            radio.value = String(idx);
            radio.checked = idx === selectedIdx;
            Object.assign(radio.style, {
                width: `${S(24)}px`,
                height: `${S(24)}px`,
                cursor: 'pointer',
                margin: '0',
            });

            const text = document.createElement('span');
            text.textContent = preset.label;

            const scaleInfo = document.createElement('span');
            const s = computeScale(preset.w, preset.h);
            scaleInfo.textContent = `(scale ${s.toFixed(2)})`;
            Object.assign(scaleInfo.style, {
                marginLeft: 'auto',
                fontSize: `${S(18)}px`,
                fontWeight: '600',
                color: '#a0aec0',
            });

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

        // ── 「再表示しない」チェックボックス ──
        const dontShowLabel = document.createElement('label');
        Object.assign(dontShowLabel.style, {
            display: 'flex',
            alignItems: 'center',
            gap: `${S(12)}px`,
            fontSize: `${S(19.5)}px`,
            fontWeight: '600',
            color: '#cbd5e0',
            cursor: 'pointer',
            marginBottom: `${S(28)}px`,
        });
        const dontShowInput = document.createElement('input');
        dontShowInput.type = 'checkbox';
        dontShowInput.id = 'exp-fs-dont-show';
        Object.assign(dontShowInput.style, {
            width: `${S(24)}px`,
            height: `${S(24)}px`,
            cursor: 'pointer',
            margin: '0',
        });
        dontShowLabel.appendChild(dontShowInput);
        dontShowLabel.appendChild(document.createTextNode('このメッセージを再び表示しない'));
        box.appendChild(dontShowLabel);

        // ── 注記 ──
        const note = document.createElement('p');
        note.textContent = 'フォントサイズは、ユーザー設定の「フォントスケール」からいつでも自由に変更できます。';
        Object.assign(note.style, {
            margin: `0 0 ${S(28)}px 0`,
            fontSize: `${S(18)}px`,
            fontWeight: '600',
            lineHeight: '1.6',
            color: '#a0aec0',
            fontStyle: 'italic',
        });
        box.appendChild(note);

        // ── ボタン ──
        const btnRow = document.createElement('div');
        Object.assign(btnRow.style, {
            display: 'flex',
            justifyContent: 'flex-end',
            gap: `${S(18)}px`,
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'キャンセル';
        Object.assign(cancelBtn.style, {
            padding: `${S(15)}px ${S(36)}px`,
            background: '#4a5568',
            color: '#ffffff',
            border: 'none',
            borderRadius: `${S(9)}px`,
            cursor: 'pointer',
            fontSize: `${S(21)}px`,
            fontWeight: '900',
        });

        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.textContent = '適用';
        Object.assign(applyBtn.style, {
            padding: `${S(15)}px ${S(36)}px`,
            background: '#2b6cb0',
            color: '#ffffff',
            border: 'none',
            borderRadius: `${S(9)}px`,
            cursor: 'pointer',
            fontSize: `${S(21)}px`,
            fontWeight: '900',
        });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(applyBtn);
        box.appendChild(btnRow);

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        // ── イベント ──
        applyBtn.addEventListener('click', () => {
            const preset = PRESETS[selectedIdx];
            const scale = computeScale(preset.w, preset.h);

            localStorage.setItem(RESOLUTION_KEY, JSON.stringify({
                w: preset.w,
                h: preset.h,
                scale,
                setAt: Date.now(),
            }));
            localStorage.setItem(RESOLUTION_LABEL_KEY, preset.label);

            if (dontShowInput.checked) {
                localStorage.setItem(DIALOG_SHOWN_KEY, 'true');
            }

            applyFontScale(scale);
            overlay.remove();
            console.log(`${LOG} 解像度 ${preset.label} → scale ${scale.toFixed(2)} を適用`);
        });

        cancelBtn.addEventListener('click', () => {
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
            return ctx?.powerUserSettings?.font_scale ??
                   ctx?.extensionSettings?.power_user?.font_scale ??
                   window.power_user?.font_scale ??
                   1;
        },
        getSavedResolution: () => {
            try {
                const raw = localStorage.getItem(RESOLUTION_KEY);
                return raw ? JSON.parse(raw) : null;
            } catch (e) { return null; }
        },
        getTargetScale: () => _targetFontScale,
        diagnose: () => {
            const ctx = getSTContext();
            return {
                targetScale: _targetFontScale,
                powerUserSettings: ctx?.powerUserSettings?.font_scale,
                extensionSettingsPowerUser: ctx?.extensionSettings?.power_user?.font_scale,
                windowPowerUser: window.power_user?.font_scale,
                windowPowerUserSettings: window.powerUserSettings?.font_scale,
                hasApplyFontScaleCtx: typeof ctx?.applyFontScale === 'function',
                hasApplyFontScaleWin: typeof window.applyFontScale === 'function',
                sliderValue: document.getElementById('font_scale')?.value,
                sliderMax: document.getElementById('font_scale')?.getAttribute('max'),
                mainFontSize: document.documentElement.style.getPropertyValue('--mainFontSize'),
            };
        },
    };

    console.log(`${LOG} installed`);
})();
