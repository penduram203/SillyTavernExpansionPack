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

    // ============================================================
    // ★ 開始ボタンチェックボックス連動でゲーム開始ボタンを追加
    //    ・first_mes の内容には依存しない
    //    ・mes_text が無い場合はメッセージ内にフォールバックを作成
    //    ・mesid=0 自体が無い場合は #chat 直下に専用コンテナを作成
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

    function createGameStartButton() {
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

        return btn;
    }

    function removeGameStartButtons() {
        document.querySelectorAll('.game-start-choice').forEach(el => el.remove());
        const c = document.getElementById('game-start-button-container');
        if (c) c.remove();
        document.querySelectorAll('.gic-game-start-fallback').forEach(el => el.remove());
    }

    function setupFirstMessageAsChoice() {
        const enabled = isStartButtonEnabledForCurrentChar();

        // 無効時: すべて削除
        if (!enabled) {
            removeGameStartButtons();
            return;
        }

        const mesEl = document.querySelector('.mes[mesid="0"]');
        const isUser = mesEl?.getAttribute('is_user') === 'true';
        const mesTextEl = (mesEl && !isUser) ? mesEl.querySelector('.mes_text') : null;
        const existingContainer = document.getElementById('game-start-button-container');

        // ── ① mes_text が存在する → その末尾に配置 ──
        if (mesTextEl) {
            if (existingContainer) existingContainer.remove();
            // 他の位置のボタン/フォールバックを除去
            document.querySelectorAll('.game-start-choice').forEach(el => {
                if (el.parentNode !== mesTextEl) el.remove();
            });
            document.querySelectorAll('.gic-game-start-fallback').forEach(el => el.remove());

            if (mesTextEl.querySelectorAll(':scope > .game-start-choice').length === 0) {
                mesTextEl.appendChild(createGameStartButton());
            }
            return;
        }

        // ── ② mesid=0 はあるが mes_text が無い → フォールバックを作成 ──
        if (mesEl && !isUser) {
            if (existingContainer) existingContainer.remove();

            let fallback = mesEl.querySelector('.gic-game-start-fallback');
            if (!fallback) {
                fallback = document.createElement('div');
                fallback.className = 'mes_text gic-game-start-fallback';
                const contentEl = mesEl.querySelector('.mes_block') || mesEl;
                contentEl.appendChild(fallback);
            }

            // 他の位置のボタン/フォールバックを除去
            document.querySelectorAll('.game-start-choice').forEach(el => {
                if (el.parentNode !== fallback) el.remove();
            });
            document.querySelectorAll('.gic-game-start-fallback').forEach(el => {
                if (el !== fallback) el.remove();
            });

            if (fallback.querySelectorAll(':scope > .game-start-choice').length === 0) {
                fallback.appendChild(createGameStartButton());
            }
            return;
        }

        // ── ③ mesid=0 自体が無い → #chat 直下にコンテナを作成 ──
        document.querySelectorAll('.mes .game-start-choice').forEach(el => el.remove());
        document.querySelectorAll('.gic-game-start-fallback').forEach(el => el.remove());

        if (existingContainer) return; // 既に #chat 直下に存在

        const chatEl = document.getElementById('chat');
        if (!chatEl) return;

        const container = document.createElement('div');
        container.id = 'game-start-button-container';
        container.className = 'game-start-button-container';
        container.appendChild(createGameStartButton());

        const firstMes = chatEl.querySelector('.mes');
        if (firstMes && firstMes.parentNode === chatEl) {
            chatEl.insertBefore(container, firstMes);
        } else {
            chatEl.appendChild(container);
        }
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
