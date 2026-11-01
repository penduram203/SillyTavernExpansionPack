// choice_click.js
// ロアブック選択肢（.lbe-choice-item）をクリック可能にする独立拡張。
//   - 通常クリック: 選択肢番号をチャット入力欄にセットして自動送信
//   - Shift+クリック: 入力欄にセットするだけ（自動送信しない）
//   - ホバー配色は Text Styling のセリフ色 (#q-text-color) から動的に導出
//   - 最初のメッセージが「ゲーム開始」ならクリック可能なボタン化して
//     クリックで "000" を自動送信する

(function () {
    'use strict';
    const LOG = '[ChoiceClick]';
    const CLICK_DEBOUNCE_MS = 1200;
    const GAME_START_NUMBER = '000';

    // ---- CSS 注入 ----
    (function injectStyle() {
        if (document.getElementById('choice-click-style')) return;
        const link = document.createElement('link');
        link.id = 'choice-click-style';
        link.rel = 'stylesheet';
        try {
            link.href = new URL('../styles/choice_click.css', import.meta.url).href;
        } catch (e) {
            link.href = 'styles/choice_click.css';
        }
        document.head.appendChild(link);
    })();

    let _lastClickTime = 0;

    function extractNumFromItem(item) {
        if (!item) return null;
        const text = (item.textContent || '').trim();
        const m = text.match(/^(\d+)/);
        return m ? m[1] : null;
    }

    function setTextareaValue(textarea, value) {
        textarea.value = value;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function sendMessage(textarea) {
        const sendBtn = document.getElementById('send_but');
        if (sendBtn) { sendBtn.click(); return true; }
        const ev = new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true,
        });
        textarea.dispatchEvent(ev);
        return false;
    }

    function flashItem(item, mode) {
        if (!item) return;
        item.classList.remove('choice-click-flash');
        void item.offsetWidth;
        item.classList.add('choice-click-flash');
        item.dataset.choiceClickMode = mode || '';
        setTimeout(() => {
            item.classList.remove('choice-click-flash');
            delete item.dataset.choiceClickMode;
        }, 600);
    }

    function handleChoiceClick(item, event) {
        if (!item) return;
        const num = item.dataset.choiceNum;
        if (!num) return;

        event.preventDefault();
        event.stopPropagation();

        const textarea = document.getElementById('send_textarea');
        if (!textarea) {
            console.warn(LOG, '#send_textarea が見つかりません');
            return;
        }

        if (event.shiftKey) {
            setTextareaValue(textarea, num);
            textarea.focus();
            flashItem(item, 'input-only');
            return;
        }

        const now = Date.now();
        if (now - _lastClickTime < CLICK_DEBOUNCE_MS) {
            console.debug(LOG, '連打防止のためスキップ');
            return;
        }
        _lastClickTime = now;

        setTextareaValue(textarea, num);
        flashItem(item, 'sending');
        sendMessage(textarea);
    }

    function bindChoiceItems() {
        document.querySelectorAll('.lbe-choice-item').forEach(item => {
            if (item.dataset.choiceClickBound === '1') return;
            const num = extractNumFromItem(item);
            if (!num) return;

            item.dataset.choiceClickBound = '1';
            item.dataset.choiceNum = num;
            item.setAttribute('role', 'button');
            item.setAttribute('tabindex', '0');
            item.setAttribute('title', `クリックで「${num}」を送信（Shift+クリックで入力のみ）`);

            item.addEventListener('click', (e) => handleChoiceClick(item, e));
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleChoiceClick(item, e);
                }
            });
        });
    }

    // ============================================================
    // ★ 開始ボタンチェックボックス連動で first message 末尾にゲーム開始ボタンを追加
    //    （first_mes の内容には依存しない）
    // ============================================================
    function isStartButtonEnabledForCurrentChar() {
        try {
            const ctx = window.SillyTavern?.getContext?.();
            const char = ctx?.characters?.[ctx?.characterId];
            const charName = char?.name;
            if (!charName) return false;
            const map = ctx?.extensionSettings?.variable_manager?.startButtonByChar || {};
            return map[charName] === true;
        } catch (e) { return false; }
    }

    function setupFirstMessageAsChoice() {
        const mesEl = document.querySelector('.mes[mesid="0"]');
        if (!mesEl) return;
        const isUser = mesEl.getAttribute('is_user') === 'true';
        if (isUser) return;

        const mesTextEl = mesEl.querySelector('.mes_text');
        if (!mesTextEl) return;

        // 既存のゲーム開始ボタンを削除
        mesTextEl.querySelectorAll(':scope > .game-start-choice').forEach(el => el.remove());

        if (!isStartButtonEnabledForCurrentChar()) {
            return;
        }

        const btn = document.createElement('div');
        btn.className = 'game-start-choice';
        btn.textContent = 'ゲーム開始';
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.setAttribute('title', `クリックで「${GAME_START_NUMBER}」を送信`);

        const handler = (e) => {
            if (e) { e.preventDefault(); e.stopPropagation(); }
            const now = Date.now();
            if (now - _lastClickTime < CLICK_DEBOUNCE_MS) return;
            _lastClickTime = now;

            const textarea = document.getElementById('send_textarea');
            if (!textarea) {
                console.warn(LOG, '#send_textarea が見つかりません');
                return;
            }
            setTextareaValue(textarea, GAME_START_NUMBER);
            flashItem(btn, 'sending');
            sendMessage(textarea);
        };

        btn.addEventListener('click', handler);
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handler(e);
            }
        });

        mesTextEl.appendChild(btn);
    }

    // ============================================================
    // ★ セリフ色 (#q-text-color) からホバー配色を動的に導出
    // ============================================================
    function hexToHsl(hex) {
        hex = String(hex || '').replace('#', '').trim();
        if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
        if (hex.length !== 6) return null;
        const r = parseInt(hex.slice(0, 2), 16) / 255;
        const g = parseInt(hex.slice(2, 4), 16) / 255;
        const b = parseInt(hex.slice(4, 6), 16) / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const l = (max + min) / 2;
        let h = 0, s = 0;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }
        return { h: h * 360, s: s * 100, l: l * 100 };
    }

    function hslCss(h, s, l, a) {
        if (a === undefined) {
            return `hsl(${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%)`;
        }
        return `hsla(${h.toFixed(1)}, ${s.toFixed(1)}%, ${l.toFixed(1)}%, ${a})`;
    }

    let _qColorInputEl = null;

    function updateChoiceColorsFromQ() {
        const input = document.getElementById('q-text-color');
        if (!input || !input.value) return;
        const hsl = hexToHsl(input.value);
        if (!hsl) return;

        // グレー系セリフ色でも色味が出るように最低彩度を確保
        const baseS = Math.max(hsl.s, 55);
        const accentS = Math.min(Math.max(hsl.s, 75), 100);
        const hue = hsl.h;

        // 背景 L=42% / 明るい枠 L=65%
        const bg        = hslCss(hue, baseS, 42);
        const border    = hslCss(hue, accentS, 65);
        const bar       = border;
        const glowSoft  = hslCss(hue, accentS, 65, 0.55);
        const glowRing  = hslCss(hue, accentS, 65, 0.40);
        const activeBg  = hslCss(hue, baseS, 34);   // 押下時: ホバーより少し暗く
        const sendingBg = hslCss(hue, baseS, 50);   // 送信40%地点
        const sendingFl = hslCss(hue, baseS, 62);   // 送信0%地点

        const root = document.documentElement.style;
        root.setProperty('--choice-hover-bg', bg);
        root.setProperty('--choice-hover-border', border);
        root.setProperty('--choice-hover-bar', bar);
        root.setProperty('--choice-hover-glow-soft', glowSoft);
        root.setProperty('--choice-hover-glow-ring', glowRing);
        root.setProperty('--choice-active-bg', activeBg);
        root.setProperty('--choice-sending-bg', sendingBg);
        root.setProperty('--choice-sending-flash-bg', sendingFl);
    }

    function watchQColorInput() {
        let _lastValue = null;
        let _logged = false;

        const check = () => {
            const input = document.getElementById('q-text-color');
            if (!input) return;
            const v = input.value || '';
            if (!v) return;
            if (v === _lastValue) return;
            _lastValue = v;
            if (!_logged) {
                _logged = true;
                console.log(LOG, '#q-text-color を検出:', v);
            }
            updateChoiceColorsFromQ();
        };

        const tryBind = () => {
            const input = document.getElementById('q-text-color');
            if (!input) return;
            if (_qColorInputEl !== input) {
                if (_qColorInputEl) {
                    _qColorInputEl.removeEventListener('input', check);
                    _qColorInputEl.removeEventListener('change', check);
                }
                input.addEventListener('input', check);
                input.addEventListener('change', check);
                _qColorInputEl = input;
            }
        };

        setInterval(() => { tryBind(); check(); }, 200);

        const obs = new MutationObserver(() => { tryBind(); check(); });
        obs.observe(document.body, { childList: true, subtree: true });

        tryBind();
        check();
    }

    // ---- 監視 ----
    let _pending = false;
    function scheduleBind() {
        if (_pending) return;
        _pending = true;
        requestAnimationFrame(() => {
            _pending = false;
            try {
                bindChoiceItems();
                setupFirstMessageAsChoice();
            } catch (e) { console.warn(LOG, e); }
        });
    }

    function setupObserver() {
        const observer = new MutationObserver(() => scheduleBind());
        observer.observe(document.body, { childList: true, subtree: true });
        console.log(LOG, 'MutationObserver を設置');
    }

    function init() {
        bindChoiceItems();
        setupFirstMessageAsChoice();
        watchQColorInput();
        window.addEventListener('variable-manager-start-changed', () => {
            setTimeout(setupFirstMessageAsChoice, 50);
        });
        setupObserver();
        console.log(LOG, '初期化完了');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.ChoiceClick = {
        bind: bindChoiceItems,
        updateColors: updateChoiceColorsFromQ,
        setupGameStart: setupFirstMessageAsChoice,
    };
})();
