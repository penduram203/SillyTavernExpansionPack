// choice_click.js
// ロアブック選択肢（.lbe-choice-item）をクリック可能にする独立拡張。
//   - 通常クリック: 選択肢番号をチャット入力欄にセットして自動送信
//   - Shift+クリック: 入力欄にセットするだけ（自動送信しない）
//   - ホバー/フォーカス/クリック時の視覚効果は CSS 側で付与

(function () {
    'use strict';
    const LOG = '[ChoiceClick]';
    const CLICK_DEBOUNCE_MS = 1200;

    // ---- CSS 注入（styles/choice_click.css を読み込む） ----
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
        // SillyTavern の自動リサイズ・パワーユーザー処理を発火させる
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function sendMessage(textarea) {
        const sendBtn = document.getElementById('send_but');
        if (sendBtn) {
            sendBtn.click();
            return true;
        }
        // フォールバック: Enter キーイベント
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
        void item.offsetWidth; // リフロー強制でアニメーションをリセット
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

        // Shift+クリック: 入力欄にセットするだけ
        if (event.shiftKey) {
            setTextareaValue(textarea, num);
            textarea.focus();
            flashItem(item, 'input-only');
            return;
        }

        // 連打防止（二重送信対策）
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

    // ---- 監視（選択肢ブロックは頻繁に再生成されるため rAF で間引き） ----
    let _pending = false;
    function scheduleBind() {
        if (_pending) return;
        _pending = true;
        requestAnimationFrame(() => {
            _pending = false;
            try { bindChoiceItems(); } catch (e) { console.warn(LOG, e); }
        });
    }

    function setupObserver() {
        const observer = new MutationObserver(() => scheduleBind());
        observer.observe(document.body, { childList: true, subtree: true });
        console.log(LOG, 'MutationObserver を設置');
    }

    function init() {
        bindChoiceItems();
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
    };
})();
