/**
 * Media Controller
 * SillyTavern キャラクター作成時に、キャラ名をクリップボードへ自動保存し
 * ローカルディスクの addchara フォルダ内に新規フォルダ作成を促す通知を表示する。
 */
(function () {
    'use strict';
    console.log('[MediaController] 初期化開始');

    const MODULE_NAME = 'media_controller';

    // キャラクター名入力フィールドの候補セレクタ（新旧SillyTavern対応）
    const NAME_INPUT_SELECTORS = [
        '#character_name_pole',
        '#character_name',
        '#character_name_text',
    ];

    // メッセージ本文（改行は \n で表現し、CSS の white-space: pre-line で描画）
    const MESSAGE_TEXT =
        'キャラ名をクリップボードにコピーしました。\n' +
        'addcharaフォルダ内に新規フォルダを作成し、フォルダ名に貼り付けて下さい。';

    // 重複クリック防止用（ラベル＋内部inputの二重発火対策）
    let lastCreateClickTime = 0;
    const CREATE_DEBOUNCE_MS = 500;

    // ---------- ユーティリティ ----------

    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    /**
     * キャラクター名入力欄から値を取得する（input/textarea/contenteditable 両対応）
     */
    function getCharacterName() {
        for (const sel of NAME_INPUT_SELECTORS) {
            const el = document.querySelector(sel);
            if (!el) continue;
            if (typeof el.value === 'string' && el.value.trim()) {
                return el.value.trim();
            }
            if (el.isContentEditable && typeof el.textContent === 'string' && el.textContent.trim()) {
                return el.textContent.trim();
            }
        }
        return null;
    }

    /**
     * クリップボードへコピー（Clipboard API → execCommand フォールバック）
     */
    async function copyToClipboard(text) {
        if (!text) return false;
        try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                await navigator.clipboard.writeText(text);
                console.log('[MediaController] クリップボードへコピー成功:', text);
                return true;
            }
        } catch (e) {
            console.warn('[MediaController] Clipboard API 失敗、フォールバック試行:', e);
        }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            if (ok) console.log('[MediaController] execCommand でコピー成功');
            return ok;
        } catch (e) {
            console.warn('[MediaController] フォールバックコピー失敗:', e);
            return false;
        }
    }

    /**
     * タイトルHTML（キャラ名を強調表示）
     */
    function buildTitleHtml(name) {
        if (!name) return '<span class="mc-toast-icon">📁</span> フォルダ作成のお願い';
        return `<span class="mc-toast-icon">📁</span> キャラ名: <span class="mc-toast-name">${escapeHtml(name)}</span>`;
    }

    /**
     * 本文HTML（\n は CSS の white-space: pre-line で改行表示）
     */
    function buildBodyHtml(message) {
        return `<div class="mc-toast-body-text">${escapeHtml(message)}</div>`;
    }

    /**
     * メッセージ表示（toastr 優先、無ければカスタムトースト）
     */
    function showMessage(message, name) {
        const titleHtml = buildTitleHtml(name);
        const bodyHtml = buildBodyHtml(message);

        if (typeof toastr !== 'undefined' && typeof toastr.info === 'function') {
            toastr.info(bodyHtml, titleHtml, {
                timeOut: 15000,
                extendedTimeOut: 10000,
                closeButton: true,
                progressBar: true,
                positionClass: 'toast-top-center',
                escapeHtml: false, // HTMLを有効化（キャラ名は escapeHtml 済み）
                newestOnTop: false,
            });
            return;
        }
        showCustomToast(bodyHtml, titleHtml);
    }

    /**
     * カスタムトースト（toastr 非対応環境用フォールバック）
     */
    function showCustomToast(bodyHtml, titleHtml) {
        document.querySelectorAll('.mc-toast').forEach(el => el.remove());
        const toast = document.createElement('div');
        toast.className = 'mc-toast';

        const header = document.createElement('div');
        header.className = 'mc-toast-header';
        header.innerHTML = titleHtml;

        const body = document.createElement('div');
        body.className = 'mc-toast-body';
        body.innerHTML = bodyHtml;

        toast.appendChild(header);
        toast.appendChild(body);
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('mc-toast-hide');
            setTimeout(() => toast.remove(), 400);
        }, 15000);
    }

    /**
     * キャラクター作成ボタン押下時のメイン処理
     */
    async function handleCreateCharacter() {
        const name = getCharacterName();
        if (!name) {
            console.log('[MediaController] キャラ名未入力のためスキップ');
            return;
        }
        console.log('[MediaController] キャラクター作成を検出:', name);

        const copied = await copyToClipboard(name);

        if (copied) {
            showMessage(MESSAGE_TEXT, name);
        } else {
            showMessage(
                'クリップボードへの自動コピーに失敗しました。\n' +
                '以下のキャラ名を手動でコピーし、addcharaフォルダ内に\n' +
                '新規フォルダを作成して、フォルダ名に貼り付けて下さい。\n\n' +
                `キャラ名: ${name}`,
                '手動コピーが必要です'
            );
        }
    }

    // ---------- イベント登録 ----------

    function setupClickListener() {
        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!target || typeof target.closest !== 'function') return;
            const btn = target.closest('#create_button_label');
            if (!btn) return;

            const now = Date.now();
            if (now - lastCreateClickTime < CREATE_DEBOUNCE_MS) {
                console.log('[MediaController] 重複クリックをスキップ');
                return;
            }
            lastCreateClickTime = now;

            Promise.resolve().then(handleCreateCharacter);
        }, true);
    }

    /**
     * CSS未読込時のフォールバック（toastrの装飾が最低限効くように）
     */
    function injectCriticalCSS() {
        if (document.getElementById('mc-critical-css')) return;
        const style = document.createElement('style');
        style.id = 'mc-critical-css';
        style.textContent = `
            #toast-container .toast-info {
                background-color: #1e1e1e !important;
                border-left: 6px solid #4caf50 !important;
                border-radius: 10px !important;
                box-shadow: 0 8px 32px rgba(0,0,0,0.65) !important;
                padding: 16px 20px !important;
                opacity: 0.98 !important;
            }
            #toast-container .toast-title {
                font-size: 18px !important;
                font-weight: bold !important;
                color: #7ee787 !important;
                margin-bottom: 10px !important;
                border-bottom: 1px solid rgba(255,255,255,0.12);
                padding-bottom: 8px;
            }
            #toast-container .toast-message {
                font-size: 15px !important;
                line-height: 1.8 !important;
                color: #e8e8e8 !important;
                white-space: pre-line !important;
                word-break: break-word !important;
            }
            .mc-toast-name {
                color: #ffd54f !important;
                font-size: 20px !important;
                font-weight: bold !important;
                background: rgba(255, 213, 79, 0.15);
                padding: 2px 10px;
                border-radius: 6px;
                border: 1px solid rgba(255, 213, 79, 0.5);
                margin-left: 4px;
            }
        `;
        document.head.appendChild(style);
    }

    // ============================================================
    // 🎨 ギャラリーボタンのホバー不透明化
    //   gic.js が生成するボタンは .drawer-icon ではないため、
    //   座標監視方式で個別に opacity を制御する
    // ============================================================
    function setupGalleryButtonHoverControl() {
        const OPACITY_HOVER = '1';
        let lastX = -1, lastY = -1;
        let currentBtn = null;

        /**
         * 🎨 ボタンを探索（複数の候補セレクタ → 絵文字テキスト検索の順）
         */
        function findGalleryButton() {
            // DOM に残っている既存参照を優先
            if (currentBtn && document.body.contains(currentBtn)) return currentBtn;

            const selectors = [
                '#gic-gallery-button',
                '#gallery-button',
                '#gic_button',
                '[id*="gic"][id*="button"]',
                '[id*="gallery"][id*="button"]',
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) { currentBtn = el; return el; }
            }

            // フォールバック: 子要素なし・テキストが 🎨 の要素を探索
            const candidates = document.querySelectorAll(
                'button, div, span, a, [role="button"]'
            );
            for (const el of candidates) {
                if (el.children.length > 0) continue;
                const txt = (el.textContent || '').trim();
                if (txt !== '🎨') continue;
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    currentBtn = el;
                    return el;
                }
            }
            return null;
        }

        /**
         * 🎨 ボタン上にマウスがあるかを判定し opacity を更新
         */
        function updateHoverOpacity() {
            const btn = findGalleryButton();
            if (!btn) return;

            // ボタンが表示されていない場合はスキップ
            const rect = btn.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;

            const inside =
                lastX >= 0 && lastY >= 0 &&
                lastX >= rect.left && lastX <= rect.right &&
                lastY >= rect.top  && lastY <= rect.bottom;

            if (inside) {
                btn.style.setProperty('opacity', OPACITY_HOVER, 'important');
                btn.dataset.mcGalleryHovered = '1';
            } else if (btn.dataset.mcGalleryHovered === '1') {
                // 自分で付けた opacity のみ解除（gic.js 側の値を尊重）
                btn.style.removeProperty('opacity');
                btn.dataset.mcGalleryHovered = '0';
            }
        }

        // マウス座標を記録
        document.addEventListener('mousemove', (e) => {
            lastX = e.clientX;
            lastY = e.clientY;
            updateHoverOpacity();
        }, { passive: true });

        // ウィンドウ外に出たらホバー解除
        document.addEventListener('mouseleave', () => {
            lastX = -1;
            lastY = -1;
            updateHoverOpacity();
        });

        // 🎨 ボタンが後から追加／再生成されるケースに対応
        // 100ms 間隔で座標判定を再評価（軽量）
        setInterval(updateHoverOpacity, 100);

        // DOM 追加を検出したら即評価
        const observer = new MutationObserver(() => {
            currentBtn = null; // 参照をリセットして再探索
            if (lastX >= 0 && lastY >= 0) updateHoverOpacity();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        console.log('[MediaController] 🎨 ギャラリーボタンのホバー制御を開始しました');
    }
    
    function init() {
        injectCriticalCSS();
        setupClickListener();
        setupGalleryButtonHoverControl();   // ← この1行を追加
        console.log('[MediaController] 初期化完了');
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.MediaController = {
        getCharacterName,
        copyToClipboard,
        showMessage,
        handleCreateCharacter,
    };
})();
