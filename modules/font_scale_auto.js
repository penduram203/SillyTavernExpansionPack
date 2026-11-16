// font_scale_auto.js
// v8.0-simple: ユーザー操作と一切競合しない設計
//
// ★ 設計
//   - ダイアログで決めた解像度スケールは「起動直後の数秒だけ」適用する
//     （ST の起動時設定読込との競合対策）
//   - ユーザーがスライダー/カウンターに触れた瞬間に自動適用は完全停止
//   - ドラッグ判定・ピクセル計算・setter ガード・強制ループは全廃
//   - 値の適用は ST 自身の input ハンドラ経由（設定保存も ST に任せる）
//   - 「再表示しない」はデフォルトでチェック済み
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
    const ST_BASE_FONT_PX = 15;
    const MIN_SCALE = 0.5;
    const MAX_SCALE = 2.0;

    // 起動直後にダイアログ値を再適用するタイミング(ms)。ユーザー操作で即キャンセルされる
    const STARTUP_REAPPLY_DELAYS_MS = [300, 1000, 2500];

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

    let _verbose = false;
    // ユーザーがスライダー/カウンターに触れたか（true なら自動適用は一切しない）
    let _userTouched = false;
    // 起動直後に再適用する予定のスケール（null なら予定なし）
    let _startupScale = null;
    let _startupTimers = [];

    function vlog(...a) { if (_verbose) console.log(LOG, ...a); }

    function getSTContext() {
        try {
            if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
                return window.SillyTavern.getContext();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function computeScale(w) {
        if (!Number.isFinite(w) || w <= 0) return 1;
        return Math.max(MIN_SCALE, Math.min(MAX_SCALE, w / BASE_W));
    }

    // ============================================================
    // power_user オブジェクト群（ST のバージョン差を吸収）
    // ============================================================
    function getPowerUserObjects() {
        const ctx = getSTContext();
        const list = [
            ctx?.powerUserSettings,
            ctx?.extensionSettings?.power_user,
            window.power_user,
            window.powerUserSettings,
        ];
        return list.filter(o => o && typeof o === 'object');
    }

    function getCurrentScale() {
        for (const o of getPowerUserObjects()) {
            if (typeof o.font_scale === 'number' && isFinite(o.font_scale)) return o.font_scale;
        }
        const slider = document.getElementById('font_scale');
        const v = parseFloat(slider?.value);
        return Number.isFinite(v) ? v : 1;
    }

    // ============================================================
    // min / max 属性を強制（ST 標準は max=1.5）
    // ============================================================
    function enforceMaxAttribute() {
        const minStr = String(MIN_SCALE);
        const maxStr = String(MAX_SCALE);
        for (const id of ['font_scale', 'font_scale_counter']) {
            const el = document.getElementById(id);
            if (!el) continue;
            if (el.getAttribute('max') !== maxStr) el.setAttribute('max', maxStr);
            if (el.getAttribute('min') !== minStr) el.setAttribute('min', minStr);
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
    // input 要素の value をネイティブ setter で書き込む
    // ============================================================
    function setNativeValue(el, v) {
        if (!el) return;
        try {
            const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            desc.set.call(el, String(v));
        } catch (e) {
            el.value = String(v);
        }
    }

    function setMainFontSize(scale) {
        const px = `${+(ST_BASE_FONT_PX * scale).toFixed(2)}px`;
        document.documentElement.style.setProperty('--mainFontSize', px);
    }

    // ============================================================
    // 起動時: ST が保持している値を UI に反映
    //   max=1.5 の状態で ST が slider.value=2.0 を設定すると 1.5 に
    //   クランプされるため、max を広げた後に power_user の値で再同期する
    // ============================================================
    function syncUiFromSettings() {
        if (_userTouched) return;
        const cur = getCurrentScale();
        const slider = document.getElementById('font_scale');
        const counter = document.getElementById('font_scale_counter');
        if (slider && Math.abs(parseFloat(slider.value) - cur) > 0.001) setNativeValue(slider, cur);
        if (counter && Math.abs(parseFloat(counter.value) - cur) > 0.001) setNativeValue(counter, cur);
        vlog(`UI を設定値 ${cur} に同期`);
    }

    // ============================================================
    // スケールを適用する
    //   dispatch=true: スライダーに input イベントを送り、ST 自身のハンドラに
    //                  power_user 更新・反映・設定保存をやらせる
    // ============================================================
    function applyScaleNow(scale, dispatch) {
        enforceMaxAttribute();

        for (const o of getPowerUserObjects()) o.font_scale = scale;

        const slider = document.getElementById('font_scale');
        const counter = document.getElementById('font_scale_counter');
        setNativeValue(slider, scale);
        setNativeValue(counter, scale);
        setMainFontSize(scale);

        if (dispatch && slider) {
            // 合成イベント(isTrusted=false)なので、こちらの trusted リスナーは反応しない
            try { slider.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* ignore */ }
        }

        try {
            const ctx = getSTContext();
            if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch (e) { /* ignore */ }
    }

    function cancelStartupReapply() {
        _startupScale = null;
        _startupTimers.forEach(t => clearTimeout(t));
        _startupTimers = [];
    }

    function applyFontScale(scale) {
        let s = Number(scale);
        if (!Number.isFinite(s)) s = 1;
        s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

        // ダイアログ適用は「ユーザーの明示操作」なので、触れた扱いをリセットして適用する
        _userTouched = false;
        cancelStartupReapply();
        applyScaleNow(s, true);

        // ST の起動時処理との競合対策として、短時間だけ再適用する
        _startupScale = s;
        STARTUP_REAPPLY_DELAYS_MS.forEach(delay => {
            const t = setTimeout(() => {
                if (_userTouched || _startupScale !== s) return;
                if (Math.abs(getCurrentScale() - s) > 0.001 ||
                    Math.abs(parseFloat(document.getElementById('font_scale')?.value) - s) > 0.001) {
                    vlog(`起動直後の再適用 (${delay}ms): ${s}`);
                    applyScaleNow(s, true);
                }
            }, delay);
            _startupTimers.push(t);
        });

        console.log(`${LOG} Font Scale を ${s} に設定`);
        return true;
    }

    // ============================================================
    // ユーザー操作の検出 → 自動適用を即停止
    //   pointerdown / keydown / wheel / trusted input / change
    // ============================================================
    function isFontScaleTarget(el) {
        return !!el && (el.id === 'font_scale' || el.id === 'font_scale_counter');
    }

    function markUserTouched(reason) {
        if (!_userTouched) {
            _userTouched = true;
            cancelStartupReapply();
            vlog(`ユーザー操作を検知 (${reason}) → 自動適用を停止`);
        }
    }

    // ユーザーがスライダーをドラッグ中か
    let _dragging = false;

    function finishDrag(reason) {
        if (!_dragging) return;
        _dragging = false;

        const slider = document.getElementById('font_scale');
        if (!slider) return;

        // ブラウザ自身が決めた最終値をそのまま採用（ピクセル計算はしない）
        let v = parseFloat(slider.value);
        if (!Number.isFinite(v)) return;
        v = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v));

        vlog(`ドラッグ終了 (${reason}): ${v}`);

        // 数値欄も同期
        setNativeValue(document.getElementById('font_scale_counter'), v);
        setMainFontSize(v);

        // ST 自身のハンドラに 1 回だけ反映・保存させる（合成イベントなので suppress 対象外）
        try {
            slider.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (e) { /* ignore */ }
        try {
            const ctx = getSTContext();
            if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch (e) { /* ignore */ }
    }

    function setupUserInteractionListeners() {
        // ── ドラッグ開始 ──
        const onDown = (e) => {
            if (!isFontScaleTarget(e.target)) return;
            markUserTouched(e.type);
            if (e.target.id === 'font_scale') _dragging = true;
        };
        ['pointerdown', 'mousedown', 'touchstart'].forEach(type => {
            document.addEventListener(type, onDown, { capture: true, passive: true });
        });

        // ── ドラッグ終了 ──
        ['pointerup', 'mouseup', 'touchend', 'pointercancel'].forEach(type => {
            window.addEventListener(type, () => finishDrag(type), { capture: true });
        });
        window.addEventListener('blur', () => finishDrag('blur'));

        // ── その他のユーザー操作（キーボード・ホイール） ──
        ['keydown', 'wheel'].forEach(type => {
            document.addEventListener(type, (e) => {
                if (isFontScaleTarget(e.target)) markUserTouched(type);
            }, { capture: true, passive: true });
        });

        // ── input: ドラッグ中は ST に渡さない（レイアウト変動によるループ防止） ──
        document.addEventListener('input', (e) => {
            if (!e.isTrusted) return;               // 合成イベントは素通し
            const t = e.target;
            if (!isFontScaleTarget(t)) return;
            markUserTouched('input');

            const v = parseFloat(t.value);
            if (!Number.isFinite(v)) return;
            const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v));

            if (_dragging && t.id === 'font_scale') {
                // ST のハンドラへ伝播させない。数値欄だけ表示用に更新
                e.stopImmediatePropagation();
                setNativeValue(document.getElementById('font_scale_counter'), clamped);
                return;
            }

            // 数値欄の直接入力・キーボード操作などは従来どおり反映
            setMainFontSize(clamped);
            vlog(`ユーザー入力 (${t.id}): ${clamped}`);
        }, true);

        // change は値を書き換えず、フォントサイズ追従のみ
        document.addEventListener('change', (e) => {
            if (!e.isTrusted) return;
            const t = e.target;
            if (!isFontScaleTarget(t)) return;
            markUserTouched('change');
            if (_dragging && t.id === 'font_scale') return;   // ドラッグ中は finishDrag に任せる
            const v = parseFloat(t.value);
            if (Number.isFinite(v)) setMainFontSize(Math.max(MIN_SCALE, Math.min(MAX_SCALE, v)));
        }, true);
    }

    // ============================================================
    // 解像度選択ダイアログ
    // ============================================================
    function showResolutionDialog() {
        if (document.getElementById('exp-font-scale-dialog-overlay')) return;

        // 既に表示済み: ST が保持している値（ユーザー設定）を尊重し、何も上書きしない
        if (localStorage.getItem(DIALOG_SHOWN_KEY) === 'true') {
            console.log(`${LOG} ダイアログ表示済み → ST の保存値 (${getCurrentScale()}) を尊重`);
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
            const s = computeScale(preset.w);
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
        dontShowInput.checked = true;   // ★ デフォルトでチェック済み（毎回の再表示・再上書きを防ぐ）
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
            fontSize: `${S(31.5)}px`, fontWeight: '900',
        });
        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.textContent = '適用';
        Object.assign(applyBtn.style, {
            padding: `${S(15)}px ${S(36)}px`, background: '#2b6cb0', color: '#ffffff',
            border: 'none', borderRadius: `${S(9)}px`, cursor: 'pointer',
            fontSize: `${S(31.5)}px`, fontWeight: '900',
        });
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(applyBtn);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        applyBtn.addEventListener('click', () => {
            const preset = PRESETS[selectedIdx];
            const scale = computeScale(preset.w);
            localStorage.setItem(RESOLUTION_KEY, JSON.stringify({
                w: preset.w, h: preset.h, scale, setAt: Date.now(),
            }));
            localStorage.setItem(RESOLUTION_LABEL_KEY, preset.label);
            if (dontShowInput.checked) localStorage.setItem(DIALOG_SHOWN_KEY, 'true');
            applyFontScale(scale);
            overlay.remove();
            console.log(`${LOG} 解像度 ${preset.label} → scale ${scale.toFixed(2)} を適用`);
        });
        cancelBtn.addEventListener('click', () => { overlay.remove(); });
    }

    // ============================================================
    // 初期化
    // ============================================================
    function init() {
        setupMaxAttributeObserver();
        setupUserInteractionListeners();

        let tries = 0;
        const timer = setInterval(() => {
            tries++;
            if (document.getElementById('font_scale')) {
                clearInterval(timer);
                enforceMaxAttribute();
                syncUiFromSettings();   // max 拡張後に、クランプされた slider を設定値へ再同期
                showResolutionDialog();
            } else if (tries > 30) {
                clearInterval(timer);
                console.warn(`${LOG} #font_scale が見つかりませんでした`);
            }
        }, 200);
    }

    function bootstrap() {
        let started = false;
        const startOnce = () => {
            if (started) return;
            started = true;
            init();
        };
        const ctx = getSTContext();
        if (ctx?.eventSource && ctx?.eventTypes?.APP_READY) {
            ctx.eventSource.on(ctx.eventTypes.APP_READY, startOnce);
            setTimeout(startOnce, 5000);
        } else {
            setTimeout(startOnce, 2000);
        }
    }

    bootstrap();

    // ============================================================
    // 公開 API
    // ============================================================
    window.FontScaleAuto = {
        applyScale: applyFontScale,
        showDialog: () => {
            localStorage.removeItem(DIALOG_SHOWN_KEY);
            showResolutionDialog();
        },
        resetDismissed: () => {
            localStorage.removeItem(DIALOG_SHOWN_KEY);
            localStorage.removeItem(RESOLUTION_KEY);
            localStorage.removeItem(RESOLUTION_LABEL_KEY);
            console.log(`${LOG} 既読フラグと解像度設定をリセットしました`);
        },
        // 互換用: 起動直後の自動適用を止める
        clearIntent: () => {
            cancelStartupReapply();
            console.log(`${LOG} 自動適用予定をクリアしました`);
        },
        getCurrentScale,
        getUserIntent: () => _startupScale,
        getSavedResolution: () => {
            try {
                const raw = localStorage.getItem(RESOLUTION_KEY);
                return raw ? JSON.parse(raw) : null;
            } catch (e) { return null; }
        },
        enableVerbose: () => { _verbose = true; console.log(`${LOG} verbose ON`); },
        disableVerbose: () => { _verbose = false; console.log(`${LOG} verbose OFF`); },
        diagnose: () => {
            const slider = document.getElementById('font_scale');
            const counter = document.getElementById('font_scale_counter');
            const ctx = getSTContext();
            return {
                version: 'v8.0-simple',
                userTouched: _userTouched,
                startupScale: _startupScale,
                currentScale: getCurrentScale(),
                powerUserSettings: ctx?.powerUserSettings?.font_scale,
                extensionSettingsPowerUser: ctx?.extensionSettings?.power_user?.font_scale,
                windowPowerUser: window.power_user?.font_scale,
                sliderValue: slider?.value,
                sliderMin: slider?.getAttribute('min'),
                sliderMax: slider?.getAttribute('max'),
                counterValue: counter?.value,
                mainFontSize: document.documentElement.style.getPropertyValue('--mainFontSize'),
            };
        },
        // 互換用: 現在の ST 設定値を UI に再同期
        forceEnforce: () => {
            _userTouched = false;
            enforceMaxAttribute();
            syncUiFromSettings();
        },
    };

    console.log(`${LOG} ✅ installed (v8.0-simple)`);
})();
