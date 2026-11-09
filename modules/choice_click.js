// choice_click.js
// ロアブック選択肢（.lbe-choice-item）をクリック可能にする独立拡張。
//   - 通常クリック: 選択肢番号をチャット入力欄にセットして自動送信
//   - Shift+クリック: 入力欄にセットするだけ（自動送信しない）
//   - ホバー配色は Text Styling のセリフ色 (#q-text-color) から動的に導出
//   - 選択肢モードでは最初に「ゲーム開始」ボタンを first_mes 末尾に表示し、
//     一度押すと「リセット」ボタンに変化する。
//     リセットボタンを押すと ST の「新しいチャットを開始」と同じ動作を実行し、
//     ゲーム開始ボタンに戻る。
//
// ★ リセット時のダイアログ自動解決:
//   ST の「新しいチャットを開始」はダイアログを挟むが、本拡張では
//   armDialogAutoResolver() によりダイアログを検出した瞬間に
//   「Also delete the current chat file」を ON にし「はい」を自動クリックする。
//   そのためユーザーはリセットボタン押下のみで完結する。

(function () {
    'use strict';
    const LOG = '[ChoiceClick]';
    const CLICK_DEBOUNCE_MS = 1200;
    const GAME_START_NUMBER = '000';
    const STATE_KEY = 'choice_click';

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

    // ============================================================
    // コンテキスト・状態ヘルパー
    // ============================================================
    function _getCtx() {
        try {
            return window.SillyTavern?.getContext?.() || null;
        } catch (e) { return null; }
    }

    function _getCurrentCharName() {
        try {
            const ctx = _getCtx();
            return ctx?.characters?.[ctx?.characterId]?.name || null;
        } catch (e) { return null; }
    }

    function getStartState(charName) {
        if (!charName) return 'initial';
        const ctx = _getCtx();
        if (!ctx?.extensionSettings) return 'initial';
        const m = ctx.extensionSettings[STATE_KEY]?.startStateByChar || {};
        return m[charName] === 'clicked' ? 'clicked' : 'initial';
    }

    function setStartState(charName, state) {
        if (!charName) return;
        const ctx = _getCtx();
        if (!ctx?.extensionSettings) return;
        if (!ctx.extensionSettings[STATE_KEY]) ctx.extensionSettings[STATE_KEY] = {};
        if (!ctx.extensionSettings[STATE_KEY].startStateByChar) {
            ctx.extensionSettings[STATE_KEY].startStateByChar = {};
        }
        ctx.extensionSettings[STATE_KEY].startStateByChar[charName] =
            state === 'clicked' ? 'clicked' : 'initial';
        if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    }

    function isStartButtonEnabledForCurrentChar() {
        try {
            const charName = _getCurrentCharName();
            if (!charName) return false;
            if (window.VariableManager?.isStartButtonEnabledForChar) {
                return window.VariableManager.isStartButtonEnabledForChar(charName) === true;
            }
            return false;
        } catch (e) { return false; }
    }

    // ============================================================
    // 汎用ヘルパー
    // ============================================================
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

    // ============================================================
    // 選択肢クリック処理
    // ============================================================
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
    // ★ ST「Start new chat?」ダイアログ自動解決
    //   - armDialogAutoResolver() で数秒間だけ MutationObserver を有効化
    //   - #del_chat_checkbox を持つダイアログ（= Start new chat?）を検出したら
    //     チェックを ON にして .popup-button-ok[data-result="1"] をクリック
    //   - 解決済みダイアログは WeakSet で記録し二重クリックを防止
    // ============================================================
    const _resolvedDialogs = new WeakSet();
    let _dialogResolverObserver = null;
    let _dialogResolverTimer = null;

    function isNewChatDialog(dialog) {
        if (!dialog) return false;
        // #del_chat_checkbox を持つ = 「Start new chat?」確定
        if (dialog.querySelector('#del_chat_checkbox')) return true;
        // フォールバック: テキストで判定
        const text = (dialog.textContent || '').toLowerCase();
        return /start new chat|新しいチャット/.test(text) &&
               dialog.querySelector('.popup-button-ok[data-result="1"]') !== null;
    }

    function resolveNewChatDialog(dialog) {
        if (!dialog) return false;

        // チェックボックスを ON
        const cb = dialog.querySelector('#del_chat_checkbox');
        if (cb && !cb.checked) {
            cb.checked = true;
            try {
                cb.dispatchEvent(new Event('input', { bubbles: true }));
                cb.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e) { /* ignore */ }
        }

        // 「はい」をクリック
        const ok = dialog.querySelector('.popup-button-ok[data-result="1"]')
                || dialog.querySelector('.popup-controls [data-result="1"]');
        if (ok) {
            ok.click();
            return true;
        }
        return false;
    }

    function scanAndResolveDialogs() {
        const dialogs = document.querySelectorAll('dialog.popup[open], dialog[open]');
        for (const d of dialogs) {
            if (_resolvedDialogs.has(d)) continue;
            if (!isNewChatDialog(d)) continue;
            if (resolveNewChatDialog(d)) {
                _resolvedDialogs.add(d);
                console.log(LOG, 'Start new chat ダイアログを自動解決しました');
            }
        }
    }

    function armDialogAutoResolver(durationMs = 5000) {
        if (_dialogResolverObserver) {
            _dialogResolverObserver.disconnect();
            _dialogResolverObserver = null;
        }
        if (_dialogResolverTimer) {
            clearTimeout(_dialogResolverTimer);
            _dialogResolverTimer = null;
        }

        // 即座に 1 回スキャン
        scanAndResolveDialogs();

        // DOM 変化を監視
        _dialogResolverObserver = new MutationObserver(() => {
            scanAndResolveDialogs();
        });
        _dialogResolverObserver.observe(document.body, { childList: true, subtree: true });

        // 一定時間後に停止
        _dialogResolverTimer = setTimeout(() => {
            if (_dialogResolverObserver) {
                _dialogResolverObserver.disconnect();
                _dialogResolverObserver = null;
            }
            _dialogResolverTimer = null;
        }, durationMs);
    }

    // ============================================================
    // ゲーム開始 / リセットボタン
    // ============================================================
    function createGameButton(isReset) {
        const btn = document.createElement('div');
        btn.className = 'game-start-choice';
        if (isReset) btn.classList.add('game-reset-choice');
        btn.textContent = isReset ? 'リセット' : 'ゲーム開始';
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.setAttribute('title', isReset
            ? 'クリックでチャットをリセットしてゲームを最初からやり直す'
            : `クリックで「${GAME_START_NUMBER}」を送信`);

        const handler = (e) => {
            if (e) { e.preventDefault(); e.stopPropagation(); }
            const now = Date.now();
            if (now - _lastClickTime < CLICK_DEBOUNCE_MS) return;
            _lastClickTime = now;

            if (isReset) {
                handleResetClick(btn);
            } else {
                const charName = _getCurrentCharName();
                if (charName) {
                    setStartState(charName, 'clicked');
                    try { setupFirstMessageAsChoice(); } catch (err) { /* ignore */ }
                }

                const textarea = document.getElementById('send_textarea');
                if (!textarea) {
                    console.warn(LOG, '#send_textarea が見つかりません');
                    return;
                }
                setTextareaValue(textarea, GAME_START_NUMBER);
                flashItem(btn, 'sending');
                sendMessage(textarea);
            }
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

    async function handleResetClick(btn) {
        const charName = _getCurrentCharName();
        if (!charName) return;

        // バトル中なら終了させておく
        try {
            if (window.VariableManager?.isBattleActive?.()) {
                window.VariableManager.endBattle();
            }
        } catch (e) { /* ignore */ }

        // ボタンを一時的に隠す
        btn.style.display = 'none';

        const success = await triggerNewChat();

        if (!success) {
            console.warn(LOG, 'リセットに失敗しました。ボタンを復元します');
            try { setupFirstMessageAsChoice(); } catch (e) { /* ignore */ }
            return;
        }

        // state 更新とボタン再生成は CHAT_CHANGED ハンドラ
        // (checkAndResetStateOnChatChanged) に一任する。
        // ただし 5 秒経っても反映されない場合は明示的に再生成。
        const startTime = Date.now();
        const watch = () => {
            if (getStartState(charName) === 'initial') {
                try { setupFirstMessageAsChoice(); } catch (e) { /* ignore */ }
                return;
            }
            if (Date.now() - startTime > 5000) {
                console.warn(LOG, 'リセット完了を検出できませんでした。ボタンを復元します');
                try { setupFirstMessageAsChoice(); } catch (e) { /* ignore */ }
                return;
            }
            setTimeout(watch, 200);
        };
        setTimeout(watch, 200);
    }

    async function triggerNewChat() {
        // ★ ダイアログ自動解決を有効化（メニューアイテム経由で
        //   「Start new chat?」ダイアログが出ても自動で「はい」まで進める）
        armDialogAutoResolver(5000);

        // ① メニューアイテム経由（ST 標準のリセットフロー。ダイアログは resolver が解決）
        try {
            const menuItem = document.getElementById('option_start_new_chat');
            if (menuItem) {
                menuItem.click();
                return true;
            }
        } catch (e) { /* fall through */ }

        // ② Slash command 経由（ダイアログを出さずに直接実行できる場合）
        try {
            const ctx = _getCtx();
            if (ctx?.executeSlashCommandsWithOptions) {
                await ctx.executeSlashCommandsWithOptions('/newchat delete=true');
                return true;
            }
        } catch (e) { /* fall through */ }

        // ③ Slash command 経由（window グローバル）
        try {
            if (typeof window.executeSlashCommandsWithOptions === 'function') {
                await window.executeSlashCommandsWithOptions('/newchat delete=true');
                return true;
            }
        } catch (e) { /* fall through */ }

        return false;
    }

    function removeGameStartButtons() {
        document.querySelectorAll('.game-start-choice').forEach(el => el.remove());
        const c = document.getElementById('game-start-button-container');
        if (c) c.remove();
        document.querySelectorAll('.gic-game-start-fallback').forEach(el => el.remove());
    }

    // ============================================================
    // first_mes 末尾へのボタン配置
    // ============================================================
    function setupFirstMessageAsChoice() {
        const enabled = isStartButtonEnabledForCurrentChar();

        if (!enabled) {
            removeGameStartButtons();
            return;
        }

        const charName = _getCurrentCharName();
        const state = getStartState(charName);
        const needsReset = state === 'clicked';

        const mesEl = document.querySelector('.mes[mesid="0"]');
        const isUser = mesEl?.getAttribute('is_user') === 'true';
        const mesTextEl = (mesEl && !isUser) ? mesEl.querySelector('.mes_text') : null;
        const existingContainer = document.getElementById('game-start-button-container');

        // 対象要素に正しい種別のボタンが入っていることを保証するヘルパ
        const ensureButton = (target) => {
            if (!target) return;
            const existing = target.querySelector(':scope > .game-start-choice');
            if (existing) {
                const isReset = existing.classList.contains('game-reset-choice');
                if (isReset === needsReset) {
                    // 既に正しい種別 → display:none だけクリア
                    existing.style.removeProperty('display');
                    return;
                }
                existing.remove();
            }
            target.querySelectorAll(':scope > .game-start-choice').forEach(el => el.remove());
            target.appendChild(createGameButton(needsReset));
        };

        // ── ① mes_text が存在する → その末尾に配置 ──
        if (mesTextEl) {
            if (existingContainer) existingContainer.remove();
            document.querySelectorAll('.game-start-choice').forEach(el => {
                if (!mesTextEl.contains(el)) el.remove();
            });
            document.querySelectorAll('.gic-game-start-fallback').forEach(el => el.remove());
            ensureButton(mesTextEl);
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

            document.querySelectorAll('.game-start-choice').forEach(el => {
                if (!fallback.contains(el)) el.remove();
            });
            document.querySelectorAll('.gic-game-start-fallback').forEach(el => {
                if (el !== fallback) el.remove();
            });

            ensureButton(fallback);
            return;
        }

        // ── ③ mesid=0 自体が無い → #chat 直下にコンテナを作成 ──
        document.querySelectorAll('.mes .game-start-choice').forEach(el => el.remove());
        document.querySelectorAll('.gic-game-start-fallback').forEach(el => el.remove());

        if (existingContainer) {
            ensureButton(existingContainer);
            return;
        }

        const chatEl = document.getElementById('chat');
        if (!chatEl) return;

        const container = document.createElement('div');
        container.id = 'game-start-button-container';
        container.className = 'game-start-button-container';
        container.appendChild(createGameButton(needsReset));

        const firstMes = chatEl.querySelector('.mes');
        if (firstMes && firstMes.parentNode === chatEl) {
            chatEl.insertBefore(container, firstMes);
        } else {
            chatEl.appendChild(container);
        }
    }

    // ============================================================
    // セリフ色 (#q-text-color) からホバー配色を動的に導出
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

        const baseS = Math.max(hsl.s, 55);
        const accentS = Math.min(Math.max(hsl.s, 75), 100);
        const hue = hsl.h;

        const bg = hslCss(hue, baseS, 42);
        const border = hslCss(hue, accentS, 65);
        const bar = border;
        const glowSoft = hslCss(hue, accentS, 65, 0.55);
        const glowRing = hslCss(hue, accentS, 65, 0.40);
        const activeBg = hslCss(hue, baseS, 34);
        const sendingBg = hslCss(hue, baseS, 50);
        const sendingFl = hslCss(hue, baseS, 62);

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

    // ============================================================
    // 新規チャット検出時の state リセット
    // ============================================================
    function checkAndResetStateOnChatChanged() {
        try {
            const ctx = _getCtx();
            if (!ctx?.chat) return;
            const charName = _getCurrentCharName();
            if (!charName) return;

            const nonSystem = ctx.chat.filter(m => !m.is_system).length;
            if (nonSystem <= 1) {
                if (getStartState(charName) !== 'initial') {
                    setStartState(charName, 'initial');
                    console.log(LOG, `新しいチャットを検出: state を initial にリセット (char="${charName}")`);
                    setTimeout(() => {
                        try { setupFirstMessageAsChoice(); } catch (e) { /* ignore */ }
                    }, 100);
                }
            }
        } catch (e) { /* ignore */ }
    }

    (function setupChatChangedListeners() {
        const tryInstall = () => {
            const ctx = _getCtx();
            if (!ctx?.eventSource || !ctx?.eventTypes) {
                setTimeout(tryInstall, 500);
                return;
            }
            const et = ctx.eventTypes;
            const es = ctx.eventSource;
            const on = (name, fn) => {
                if (et[name] && typeof es.on === 'function') es.on(et[name], fn);
            };
            on('CHAT_CHANGED', () => {
                setTimeout(checkAndResetStateOnChatChanged, 200);
            });
            on('CHARACTER_SELECTED', () => {
                setTimeout(checkAndResetStateOnChatChanged, 300);
            });
        };
        tryInstall();
    })();

    // ============================================================
    // MutationObserver + 初期化
    // ============================================================
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

    // ============================================================
    // 公開 API
    // ============================================================
    window.ChoiceClick = {
        bind: bindChoiceItems,
        updateColors: updateChoiceColorsFromQ,
        setupGameStart: setupFirstMessageAsChoice,
        getStartState,
        setStartState,
        // ★ デバッグ用: ダイアログを手動でスキャンして解決
        _resolveDialogOnce: () => {
            scanAndResolveDialogs();
        },
    };
})();
