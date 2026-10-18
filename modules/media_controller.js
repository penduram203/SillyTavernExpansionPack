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

    // ユーザー指定のメッセージ文言（変更しないこと）
    const MESSAGE_TEXT =
        'キャラ名をコピーしました。addcharaフォルダ内に新規フォルダを作成し、フォルダ名にキャラ名を貼り付けて下さい。';

    // ---------- ユーティリティ ----------

    /**
     * キャラクター名入力欄から値を取得する（input/textarea/contenteditable 両対応）
     */
    function getCharacterName() {
        for (const sel of NAME_INPUT_SELECTORS) {
            const el = document.querySelector(sel);
            if (!el) continue;
            // <input>/<textarea>
            if (typeof el.value === 'string' && el.value.trim()) {
                return el.value.trim();
            }
            // contenteditable
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
     * メッセージ表示（toastr 優先、無ければカスタムトースト）
     */
    function showMessage(message, name) {
        const title = name ? `キャラ名: ${name}` : 'フォルダ作成のお願い';

        if (typeof toastr !== 'undefined' && typeof toastr.info === 'function') {
            toastr.info(message, title, {
                timeOut: 15000,          // 15秒表示
                extendedTimeOut: 10000,  // hover時さらに10秒延長
                closeButton: true,
                progressBar: true,
                positionClass: 'toast-top-center',
                escapeHtml: true,
            });
            return;
        }

        showCustomToast(message, title);
    }

    /**
     * カスタムトースト（toastr 非対応環境用フォールバック）
     */
    function showCustomToast(message, title) {
        document.querySelectorAll('.mc-toast').forEach(el => el.remove());
        const toast = document.createElement('div');
        toast.className = 'mc-toast';

        const header = document.createElement('div');
        header.className = 'mc-toast-header';
        header.textContent = title;

        const body = document.createElement('div');
        body.className = 'mc-toast-body';
        body.textContent = message;

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
     *   1) キャラ名をクリップボードへ自動保存
     *   2) addchara フォルダ作成を促すメッセージを表示
     */
    async function handleCreateCharacter() {
        const name = getCharacterName();
        if (!name) {
            console.log('[MediaController] キャラ名未入力のためスキップ');
            return;
        }
        console.log('[MediaController] キャラクター作成を検出:', name);

        // 1) クリップボードへコピー
        const copied = await copyToClipboard(name);

        // 2) メッセージ表示
        if (copied) {
            showMessage(MESSAGE_TEXT, name);
        } else {
            showMessage(
                `クリップボードへの自動コピーに失敗しました。\n` +
                `以下のキャラ名を手動でコピーし、addcharaフォルダ内に新規フォルダを作成して、` +
                `フォルダ名に貼り付けて下さい。\n\nキャラ名: ${name}`,
                '手動コピーが必要です'
            );
        }
    }

    // ---------- イベント登録 ----------

    /**
     * #create_button_label のクリックをキャプチャフェーズで検出
     * （SillyTavern本体の処理より先にキャラ名入力欄を読み取るため）
     */
    function setupClickListener() {
        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!target || typeof target.closest !== 'function') return;
            const btn = target.closest('#create_button_label');
            if (!btn) return;

            // SillyTavern 本体の処理を妨げないよう、マイクロタスクで非同期実行
            Promise.resolve().then(handleCreateCharacter);
        }, true);
    }

    /**
     * CSS未読込時のフォールバック（toastrメッセージの改行描画保証）
     */
    function injectCriticalCSS() {
        if (document.getElementById('mc-critical-css')) return;
        const style = document.createElement('style');
        style.id = 'mc-critical-css';
        style.textContent = `
            #toast-container .toast-message {
                white-space: pre-line !important;
                line-height: 1.5 !important;
                word-break: break-word !important;
            }
            #toast-container.toast-top-center > div {
                max-width: min(90vw, 640px) !important;
            }
        `;
        document.head.appendChild(style);
    }

    function init() {
        injectCriticalCSS();
        setupClickListener();
        console.log('[MediaController] 初期化完了');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // デバッグ・他モジュール連携用API
    window.MediaController = {
        getCharacterName,
        copyToClipboard,
        showMessage,
        handleCreateCharacter,
    };
})();
