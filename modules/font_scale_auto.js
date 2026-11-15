// font_scale_auto.js
// v7.4-robust: ST の内部実装に依存しないバースト再適用方式
//
// ★ 戦略:
//   - キャプチャフェーズでユーザー意図を記録
//   - power_user.font_scale を 4 パス全てに即時書き込み
//   - setTimeout 0 + requestAnimationFrame で約 500ms バースト再適用
//
// ★ v7.1: 再起動時のユーザー設定尊重 / ドラッグ中バースト抑止
// ★ v7.2: 合成イベント (isTrusted=false) フィルタ / slider.value setter ガード
// ★ v7.3: _isDragging バイパス撤去 / slider 差し替え検知
// ★ v7.4: スライダードラッグ中は input を完全無視。
//         pointermove から intent を算出し、rAF 補正ループで
//         slider.value を強制維持。setAttribute('value') も監視。
//

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
        { label: '1280×720 (HD)',          w: 1280, h: 720 },
        { label: '1280×800 (WXGA)',        w: 1280, h: 800 },
        { label: '1366×768 (ノートPC)',    w: 1366, h: 768 },
        { label: '1440×900 (WXGA+)',       w: 1440, h: 900 },
        { label: '1600×900 (HD+)',         w: 1600, h: 900 },
        { label: '1680×1050 (WSXGA+)',     w: 1680, h: 1050 },
        { label: '1920×1080 (FHD / 基準)', w: 1920, h: 1080 },
        { label: '1920×1200 (WUXGA)',      w: 1920, h: 1200 },
        { label: '2560×1080 (UW-FHD)',     w: 2560, h: 1080 },
        { label: '2560×1440 (WQHD)',       w: 2560, h: 1440 },
        { label: '2560×1600 (WQXGA)',      w: 2560, h: 1600 },
        { label: '3440×1440 (UWQHD)',      w: 3440, h: 1440 },
        { label: '3840×1080 (32:9)',       w: 3840, h: 1080 },
        { label: '3840×2160 (4K UHD)',     w: 3840, h: 2160 },
        { label: '3840×2400 (WQUXGA)',     w: 3840, h: 2400 },
    ];

    const DEFAULT_IDX = 6;

    let _initApplyDone = false;
    let _userIntentScale = null;
    let _isDragging = false;
    let _lastTrustedInputAt = 0;
    const _guardedSliders = new WeakSet();
    let _sliderGuardObserver = null;
    let _verbose = false;
    let _draggingSlider = false;
    let _dragMonitorRaf = null;
    let _dragPointerId = null;
    let _sliderAttrObserver = null;

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
        if (changed && _verbose) {
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

    function _applyUserIntent(silent = false) {
        if (_userIntentScale === null) return;
        const ctx = getSTContext();
        const intended = _userIntentScale;
        const px = `${ST_BASE_FONT_PX * intended}px`;

        const paths = [
            { name: 'ctx.powerUserSettings',            obj: ctx?.powerUserSettings },
            { name: 'ctx.extensionSettings.power_user', obj: ctx?.extensionSettings?.power_user },
            { name: 'window.power_user',                obj: window.power_user },
            { name: 'window.powerUserSettings',         obj: window.powerUserSettings },
        ];

        for (const { name, obj } of paths) {
            if (obj && typeof obj === 'object') {
                const current = obj.font_scale;
                if (typeof current !== 'number' || Math.abs(current - intended) > 0.01) {
                    obj.font_scale = intended;
                    if (!silent && typeof current === 'number') {
                        console.log(`${LOG} ${name}.font_scale: ${current} → ${intended} を強制`);
                    }
                }
            }
        }

        const slider = document.getElementById('font_scale');
        if (slider) {
            const cur = parseFloat(slider.value);
            if (Math.abs(cur - intended) > 0.01) {
                try {
                    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
                        .set.call(slider, String(intended));
                } catch (e) {
                    slider.value = String(intended);
                }
                if (!silent) console.log(`${LOG} slider: ${cur} → ${intended} を強制`);
            }
        }

        const counter = document.getElementById('font_scale_counter');
        if (counter) {
            const cur = parseFloat(counter.value);
            if (Math.abs(cur - intended) > 0.01) {
                counter.value = String(intended);
                if (!silent) console.log(`${LOG} counter: ${cur} → ${intended} を強制`);
            }
        }

        const curPx = document.documentElement.style.getPropertyValue('--mainFontSize');
        if (curPx !== px) {
            document.documentElement.style.setProperty('--mainFontSize', px);
            if (!silent && curPx) console.log(`${LOG} --mainFontSize: ${curPx} → ${px} を強制`);
        }
    }

    let _burstToken = 0;
    function _scheduleEnforceBurst() {
        const myToken = ++_burstToken;
        const start = performance.now();
        let frameCount = 0;

        setTimeout(() => {
            if (_burstToken !== myToken) return;
            if (performance.now() - _lastTrustedInputAt < 100) return;
            _applyUserIntent(false);
        }, 0);

        const loop = () => {
            if (_burstToken !== myToken) return;
            frameCount++;
            if (performance.now() - _lastTrustedInputAt >= 100) {
                _applyUserIntent(false);
            }
            const elapsed = performance.now() - start;
            if (elapsed < 500 || frameCount < 30) {
                requestAnimationFrame(loop);
            }
        };
        requestAnimationFrame(loop);
    }

    function installSliderWriteGuard() {
        const slider = document.getElementById('font_scale');
        if (!slider) return;
        if (_guardedSliders.has(slider)) return;

        try {
            const proto = Object.getPrototypeOf(slider);
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (!desc || !desc.set) return;

            Object.defineProperty(slider, 'value', {
                configurable: true,
                get() { return desc.get.call(this); },
                set(v) {
                    if (_verbose) {
                        console.log(`${LOG} [setter] ${this.id} value "${v}" (intent=${_userIntentScale}, dragging=${_isDragging})`);
                    }
                    const newNum = parseFloat(v);
                    if (_userIntentScale === null ||
                        !Number.isFinite(newNum) ||
                        Math.abs(newNum - _userIntentScale) <= 0.01) {
                        return desc.set.call(this, v);
                    }
                    const caller = (() => {
                        try {
                            const stack = new Error().stack || '';
                            return stack.split('\n')[2]?.trim() || 'unknown';
                        } catch (_) { return 'unknown'; }
                    })();
                    console.log(`${LOG} [guard] ST からの slider.value=${v} をブロック (intent=${_userIntentScale}) caller=${caller}`);
                },
            });
            _guardedSliders.add(slider);
            console.log(`${LOG} slider.value setter ガードを設置しました (${document.querySelectorAll('#font_scale').length} 個の #font_scale)`);
        } catch (e) {
            console.warn(`${LOG} slider.value ガード設置失敗:`, e);
        }
    }

    function startSliderGuardObserver() {
        if (_sliderGuardObserver) return;
        _sliderGuardObserver = new MutationObserver(() => {
            const slider = document.getElementById('font_scale');
            if (slider && !_guardedSliders.has(slider)) {
                console.log(`${LOG} [observer] #font_scale が差し替えられたためガードを再設置します`);
                installSliderWriteGuard();
                if (_sliderAttrObserver) { _sliderAttrObserver.disconnect(); _sliderAttrObserver = null; }
                installSliderAttributeObserver();
            }
        });
        _sliderGuardObserver.observe(document.body, { childList: true, subtree: true });
        console.log(`${LOG} slider 差し替え監視を開始しました`);
    }

    function installSliderAttributeObserver() {
        const slider = document.getElementById('font_scale');
        if (!slider || _sliderAttrObserver) return;
        _sliderAttrObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.attributeName !== 'value') continue;
                if (_userIntentScale === null) continue;
                const attrVal = parseFloat(slider.getAttribute('value'));
                if (Number.isFinite(attrVal) && Math.abs(attrVal - _userIntentScale) > 0.01) {
                    console.log(`${LOG} [attr-guard] setAttribute('value', ${attrVal}) を検知 (intent=${_userIntentScale})`);
                    slider.setAttribute('value', String(_userIntentScale));
                }
            }
        });
        _sliderAttrObserver.observe(slider, { attributes: true, attributeFilter: ['value'] });
        console.log(`${LOG} slider.value 属性監視を開始しました`);
    }

    function setupFontScaleInterceptor() {
        installSliderWriteGuard();
        installSliderAttributeObserver();

        const isSliderTarget = (el) => {
            if (!el) return false;
            if (el.id === 'font_scale' || el.id === 'font_scale_counter') return true;
            if (el.closest) return !!el.closest('#font_scale, #font_scale_counter');
            return false;
        };

        const startDragMonitor = () => {
            if (_dragMonitorRaf !== null) return;
            const tick = () => {
                if (!_draggingSlider) {
                    _dragMonitorRaf = null;
                    return;
                }
                const slider = document.getElementById('font_scale');
                if (slider && _userIntentScale !== null) {
                    const cur = parseFloat(slider.value);
                    if (Math.abs(cur - _userIntentScale) > 0.01) {
                        try {
                            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
                                .set.call(slider, String(_userIntentScale));
                            if (_verbose) console.log(`${LOG} [drag-monitor] slider was ${cur}, forced to ${_userIntentScale}`);
                        } catch (e) { /* ignore */ }
                    }
                }
                _dragMonitorRaf = requestAnimationFrame(tick);
            };
            _dragMonitorRaf = requestAnimationFrame(tick);
        };

        document.addEventListener('pointerdown', (e) => {
            if (e.target?.id === 'font_scale') {
                _isDragging = true;
                _draggingSlider = true;
                _dragPointerId = e.pointerId ?? null;
                startDragMonitor();
            } else if (e.target?.id === 'font_scale_counter') {
                _isDragging = true;
            }
        }, true);

        document.addEventListener('pointermove', (e) => {
            if (!_draggingSlider) return;
            if (_dragPointerId !== null && e.pointerId !== undefined && e.pointerId !== _dragPointerId) return;
            const slider = document.getElementById('font_scale');
            if (!slider) return;
            const rect = slider.getBoundingClientRect();
            if (rect.width <= 0) return;
            const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const min = parseFloat(slider.min) || 0.5;
            const max = parseFloat(slider.max) || 2.0;
            const step = parseFloat(slider.step) || 0.01;
            const raw = min + (max - min) * ratio;
            const v = Math.round(raw / step) * step;
            const clamped = Math.max(min, Math.min(max, v));
            if (_userIntentScale !== null && Math.abs(clamped - _userIntentScale) < 0.005) return;
            _userIntentScale = clamped;
            _lastTrustedInputAt = performance.now();
            _applyUserIntent(true);
        }, true);

        document.addEventListener('pointerup', (e) => {
            if (_draggingSlider) {
                if (_dragPointerId !== null && e.pointerId !== undefined && e.pointerId !== _dragPointerId) return;
                _isDragging = false;
                _draggingSlider = false;
                _dragPointerId = null;
                _scheduleEnforceBurst();
            } else if (_isDragging) {
                _isDragging = false;
                _scheduleEnforceBurst();
            }
        }, true);

        document.addEventListener('pointercancel', () => {
            _isDragging = false;
            _draggingSlider = false;
            _dragPointerId = null;
        }, true);

        document.addEventListener('input', (e) => {
            const target = e.target;
            if (!target) return;
            if (target.id !== 'font_scale' && target.id !== 'font_scale_counter') return;

            if (_draggingSlider) {
                if (_verbose) console.log(`${LOG} [guard] slider drag 中の input を無視 (value=${target.value})`);
                return;
            }

            if (!e.isTrusted) {
                if (_verbose) console.log(`${LOG} [guard] 合成 input を無視 (${target.id}, value=${target.value})`);
                return;
            }

            const v = parseFloat(target.value);
            if (!Number.isFinite(v)) return;

            if (_verbose || _userIntentScale === null || Math.abs(v - _userIntentScale) > 0.01) {
                console.log(`${LOG} ユーザーが手動で Font Scale を ${v} に変更 (${target.id}) intent=${_userIntentScale}`);
            }
            _userIntentScale = v;
            _lastTrustedInputAt = performance.now();
            _applyUserIntent(true);
            if (!_isDragging) _scheduleEnforceBurst();
        }, true);

        document.addEventListener('change', (e) => {
            const target = e.target;
            if (!target || target.id !== 'font_scale') return;
            if (_draggingSlider) return;
            if (!e.isTrusted) {
                if (_verbose) console.log(`${LOG} [guard] 合成 change を無視 (${target.id}, value=${target.value})`);
                return;
            }
            const v = parseFloat(target.value);
            if (!Number.isFinite(v)) return;
            _userIntentScale = v;
            _lastTrustedInputAt = performance.now();
            _applyUserIntent(true);
            _scheduleEnforceBurst();
        }, true);
    }

    function applyFontScale(scale, options = {}) {
        const { fromInit = false } = options;
        if (fromInit && _initApplyDone) {
            console.log(`${LOG} init からの applyFontScale は既に実行済み。スキップ`);
            return true;
        }
        if (fromInit) _initApplyDone = true;
        let s = Number(scale);
        if (!Number.isFinite(s)) s = 1;
        s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
        _userIntentScale = s;
        _applyUserIntent(true);
        const ctx = getSTContext();
        if (typeof ctx?.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
        _scheduleEnforceBurst();
        console.log(`${LOG} Font Scale を ${s} に設定 (fromInit=${fromInit})`);
        return true;
    }

    function showResolutionDialog() {
        if (document.getElementById('exp-font-scale-dialog-overlay')) return;

        if (localStorage.getItem(DIALOG_SHOWN_KEY) === 'true') {
            const saved = localStorage.getItem(RESOLUTION_KEY);
            if (saved) {
                try {
                    const data = JSON.parse(saved);
                    const resolutionScale = computeScale(data.w, data.h);
                    const ctx = getSTContext();
                    const current =
                        ctx?.powerUserSettings?.font_scale ??
                        ctx?.extensionSettings?.power_user?.font_scale ??
                        window.power_user?.font_scale;
                    if (typeof current === 'number' && Math.abs(current - resolutionScale) >= 0.01) {
                        console.log(`${LOG} ST の font_scale (${current}) が解像度スケール (${resolutionScale}) と異なるため、ユーザー設定を尊重します`);
                        _userIntentScale = current;
                        _initApplyDone = true;
                    } else {
                        applyFontScale(resolutionScale, { fromInit: true });
                    }
                } catch (e) { /* ignore */ }
            }
            return;
        }

        const S = window.S || ((px) => px);
        const overlay = document.createElement('div');
        overlay.id = 'exp-font-scale-dialog-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
            background: 'rgba(0, 0, 0, 0.8)', zIndex: '2147483646',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: `${S(30)}px`, boxSizing: 'border-box',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
        });
        const box = document.createElement('div');
        Object.assign(box.style, {
            background: '#1a202c', color: '#e2e8f0',
            border: `${S(3)}px solid #4a5568`, borderRadius: `${S(18)}px`,
            padding: `${S(42)}px ${S(48)}px`,
            maxWidth: `min(${S(1200)}px, calc(100vw - 40px))`,
            width: '100%', boxShadow: `0 ${S(20)}px ${S(60)}px rgba(0, 0, 0, 0.85)`,
            boxSizing: 'border-box',
        });
        const h2 = document.createElement('h2');
        h2.textContent = 'モニタ解像度を選択してください';
        Object.assign(h2.style, {
            margin: `0 0 ${S(18)}px 0`, fontSize: `${S(49.5)}px`,
            fontWeight: '900', color: '#ffffff', letterSpacing: '0.02em',
        });
        box.appendChild(h2);
        const desc = document.createElement('p');
        desc.innerHTML = '選択した解像度に応じて、<strong style="color:#f6e05e;">フォントスケール</strong>を自動的に設定します。<br>（1920×1080 を基準として、スケール値を計算します）';
        Object.assign(desc.style, {
            margin: `0 0 ${S(24)}px 0`, fontSize: `${S(31.5)}px`,
            fontWeight: '600', lineHeight: '1.7', color: '#cbd5e0',
        });
        box.appendChild(desc);
        const hint = document.createElement('p');
        hint.textContent = '↓のドロップダウンをクリックして解像度を選択して下さい';
        Object.assign(hint.style, {
            margin: `0 0 ${S(15)}px 0`, fontSize: `${S(31.5)}px`,
            fontWeight: '900', lineHeight: '1.5', color: '#f6e05e',
        });
        box.appendChild(hint);
        const selectLabel = document.createElement('label');
        Object.assign(selectLabel.style, {
            display: 'block', marginBottom: `${S(12)}px`,
            fontSize: `${S(31.5)}px`, fontWeight: '700', color: '#e2e8f0',
        });
        selectLabel.textContent = '解像度:';
        box.appendChild(selectLabel);
        const select = document.createElement('select');
        select.id = 'exp-fs-resolution-select';
        Object.assign(select.style, {
            width: '100%', padding: `${S(15)}px ${S(18)}px`,
            background: '#2d3748', color: '#ffffff',
            border: `${S(3)}px solid #4299e1`, borderRadius: `${S(9)}px`,
            fontSize: `${S(31.5)}px`, fontWeight: '700', cursor: 'pointer',
            marginBottom: `${S(28)}px`, boxSizing: 'border-box',
            fontFamily: 'inherit', textOverflow: 'ellipsis',
        });
        let selectedIdx = DEFAULT_IDX;
        PRESETS.forEach((preset, idx) => {
            const opt = document.createElement('option');
            opt.value = String(idx);
            const s = computeScale(preset.w, preset.h);
            opt.textContent = `${preset.label}  [×${s.toFixed(2)}]`;
            if (idx === selectedIdx) opt.selected = true;
            select.appendChild(opt);
        });
        select.addEventListener('change', () => {
            selectedIdx = parseInt(select.value, 10);
            if (!Number.isFinite(selectedIdx)) selectedIdx = 0;
        });
        box.appendChild(select);
        const dontShowLabel = document.createElement('label');
        Object.assign(dontShowLabel.style, {
            display: 'flex', alignItems: 'center', gap: `${S(12)}px`,
            fontSize: `${S(29.25)}px`, fontWeight: '600',
            color: '#cbd5e0', cursor: 'pointer', marginBottom: `${S(28)}px`,
        });
        const dontShowInput = document.createElement('input');
        dontShowInput.type = 'checkbox';
        dontShowInput.id = 'exp-fs-dont-show';
        Object.assign(dontShowInput.style, {
            width: `${S(30)}px`, height: `${S(30)}px`, cursor: 'pointer', margin: '0',
        });
        dontShowLabel.appendChild(dontShowInput);
        dontShowLabel.appendChild(document.createTextNode('このメッセージを再び表示しない'));
        box.appendChild(dontShowLabel);
        const note = document.createElement('p');
        note.textContent = 'フォントサイズは、ユーザー設定の「フォントスケール」からいつでも自由に変更できます。';
        Object.assign(note.style, {
            margin: `0 0 ${S(28)}px 0`, fontSize: `${S(27)}px`,
            fontWeight: '600', lineHeight: '1.6', color: '#a0aec0', fontStyle: 'italic',
        });
        box.appendChild(note);
        const btnRow = document.createElement('div');
        Object.assign(btnRow.style, {
            display: 'flex', justifyContent: 'flex-end', gap: `${S(18)}px`,
        });
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'キャンセル';
        Object.assign(cancelBtn.style, {
            padding: `${S(15)}px ${S(36)}px`, background: '#4a5568', color: '#ffffff',
            border: 'none', borderRadius: `${S(9)}px`, cursor: 'pointer',
            fontSize: `${S(31.
