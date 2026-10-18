/**
 * media_controller.js
 *
 * キャラクター作成時に以下を実行:
 *   1. キャラ名をクリップボードへコピー
 *   2. SillyTavern/public/addchara/ をファイルマネージャで自動的に開く
 *   3. 「キャラ名をコピーしました…」メッセージを表示
 */
(function () {
    'use strict';

    const LOG_PREFIX = '[MediaController]';
    const EXTENSION_BASE = '/scripts/extensions/third-party/SillyTavernExpansionPack';
    const CSS_URL = `${EXTENSION_BASE}/styles/media_controller.css`;

    // 対象 DOM
    const CHAR_NAME_INPUT_ID = 'character_name_pole';
    const CREATE_LABEL_ID     = 'create_button_label';
    const CREATE_BUTTON_ID    = 'create_button';

    // addchara フォルダ（SillyTavern プロセスの作業ディレクトリ基準の相対パス）
    const ADDHARA_RELATIVE_PATH = 'public/addchara';

    function log(...args)  { console.log(LOG_PREFIX, ...args); }
    function warn(...args) { console.warn(LOG_PREFIX, ...args); }

    // ────────────────────────────────────────────────────────
    // CSS 読み込み
    // ────────────────────────────────────────────────────────
    function injectCSS() {
        if (document.getElementById('mc-styles')) return;
        const link = document.createElement('link');
        link.id = 'mc-styles';
        link.rel = 'stylesheet';
        link.type = 'text/css';
        link.href = CSS_URL;
        link.onerror = () => warn('CSS の読み込みに失敗しました:', CSS_URL);
        document.head.appendChild(link);
        log('CSS を読み込みました:', CSS_URL);
    }

    // ────────────────────────────────────────────────────────
    // ユーティリティ
    // ────────────────────────────────────────────────────────
    function escapeHtml(str) {
        return String(str).replace(/[&<>"']/g, ch => (
            { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]
        ));
    }

    function getCharName() {
        const input = document.getElementById(CHAR_NAME_INPUT_ID);
        return input ? input.value.trim() : '';
    }

    async function copyToClipboard(text) {
        if (!text) return false;

        // 1) Clipboard API
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) {
            warn('Clipboard API 失敗:', e);
        }

        // 2) フォールバック (execCommand)
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(ta);
            return ok;
        } catch (e) {
            warn('execCommand コピー失敗:', e);
            return false;
        }
    }

    // ────────────────────────────────────────────────────────
    // トースト表示
    // ────────────────────────────────────────────────────────
    function showMessage(text, timeout = 15000) {
        document.querySelectorAll('.mc-toast').forEach(el => el.remove());

        const toast = document.createElement('div');
        toast.className = 'mc-toast';
        toast.setAttribute('role', 'status');
        toast.innerHTML = `
            <div class="mc-toast-icon" aria-hidden="true">📁</div>
            <div class="mc-toast-body">
                <div class="mc-toast-title">新しいキャラクターフォルダを作成してください</div>
                <div class="mc-toast-text">${escapeHtml(text)}</div>
                <div class="mc-toast-hint">addchara フォルダを開いています…</div>
            </div>
            <button class="mc-toast-close" type="button" aria-label="閉じる">×</button>
        `;
        document.body.appendChild(toast);

        const close = () => {
            toast.classList.add('mc-toast-hiding');
            setTimeout(() => toast.remove(), 300);
        };
        toast.querySelector('.mc-toast-close').addEventListener('click', close);
        if (timeout > 0) setTimeout(close, timeout);
    }

    // ────────────────────────────────────────────────────────
    // フォルダを開く（/sys コマンド経由）
    // ────────────────────────────────────────────────────────
    function detectOS() {
        const p = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
        if (p.includes('win')) return 'win';
        if (p.includes('mac')) return 'mac';
        return 'linux';
    }

    function buildOpenCommand() {
        const os = detectOS();
        const dir = ADDHARA_RELATIVE_PATH;
        if (os === 'win') return `explorer "${dir}"`;
        if (os === 'mac') return `open "${dir}"`;
        // Linux: GNOME は gio、その他は xdg-open
        return `(gio open "${dir}" >/dev/null 2>&1 || xdg-open "${dir}" >/dev/null 2>&1) &`;
    }

    async function tryOpenFolder() {
        const command = buildOpenCommand();
        log('フォルダを開くコマンドを送信:', command);

        const context = (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : null;
        if (!context) {
            warn('SillyTavern コンテキストが取得できません');
            return false;
        }

        // ── 方法 1: executeSlashCommandsWithOptions + quiet ──
        try {
            if (typeof context.executeSlashCommandsWithOptions === 'function') {
                await context.executeSlashCommandsWithOptions(
                    `/sys ${command}`,
                    { quiet: true }          // ★ チャットへの出力を抑制
                );
                log('/sys (quiet) 経由でフォルダオープン要求を送信しました');
                return true;
            }
        } catch (e) {
            warn('executeSlashCommandsWithOptions 経由失敗:', e);
        }

        // ── 方法 2: SlashCommandParser.commands.sys.callback を直接呼ぶ（quiet 指定） ──
        try {
            const parser = context.SlashCommandParser || window.SlashCommandParser;
            const sysCmd = parser?.commands?.sys;
            if (sysCmd && typeof sysCmd.callback === 'function') {
                await sysCmd.callback({ quiet: 'true' }, command);
                log('/sys callback 経由でフォルダオープン要求を送信しました（quiet）');
                return true;
            }
        } catch (e) {
            warn('SlashCommandParser 経由失敗:', e);
        }

        // ── 方法 3: executeSlashCommands（互換用） ──
        try {
            if (typeof context.executeSlashCommands === 'function') {
                await context.executeSlashCommands(`/sys quiet=true ${command}`);
                log('executeSlashCommands 経由で送信しました（quiet=true 埋め込み）');
                return true;
            }
        } catch (e) {
            warn('executeSlashCommands 経由失敗:', e);
        }

        warn('フォルダを自動で開けませんでした。手動で開いてください。');
        return false;
    }

    // ────────────────────────────────────────────────────────
    // クリックハンドラ
    // ────────────────────────────────────────────────────────
    let isHandling = false;

    async function handleCreateClick() {
        // label → button の二重発火を防ぐ
        if (isHandling) return;
        isHandling = true;
        setTimeout(() => { isHandling = false; }, 400);

        const charName = getCharName();
        if (!charName) {
            log('キャラ名が未入力のためスキップ');
            return;
        }
        log('キャラクター作成を検知。名前:', charName);

        // 並列で走らせる
        const copyPromise = copyToClipboard(charName);
        const openPromise = tryOpenFolder().catch(err => { warn('フォルダオープン失敗:', err); return false; });

        const copied = await copyPromise;

        // 要件どおりのメッセージを表示
        const message = copied
            ? `キャラ名「${charName}」をコピーしました。新規フォルダを作成しフォルダ名に貼り付けて下さい。`
            : `キャラ名「${charName}」をクリップボードにコピーできませんでした。手動でコピーしてください。`;

        showMessage(message, 20000);

        // open の結果はバックグラウンドで待つ（ログのみ）
        openPromise.then(ok => {
            if (!ok) log('フォルダは手動で開く必要があります');
        });
    }

    // ────────────────────────────────────────────────────────
    // リスナー登録
    // ────────────────────────────────────────────────────────
    function attachClickListener() {
        const handler = (e) => {
            try { handleCreateClick(); }
            catch (err) { warn('ハンドラ内エラー:', err); }
        };

        const label  = document.getElementById(CREATE_LABEL_ID);
        const button = document.getElementById(CREATE_BUTTON_ID);

        // capture フェーズで拾い、ST 側の作成処理より先に走らせる
        if (label && !label.dataset.mcBound) {
            label.addEventListener('click', handler, true);
            label.dataset.mcBound = '1';
            log(`#${CREATE_LABEL_ID} に capture-click を登録`);
        }
        if (button && !button.dataset.mcBound) {
            button.addEventListener('click', handler, true);
            button.dataset.mcBound = '1';
            log(`#${CREATE_BUTTON_ID} に capture-click を登録`);
        }
    }

    // キャラ作成ダイアログが動的に生成されるケースに備え DOM を監視
    function setupObserver() {
        const observer = new MutationObserver(() => attachClickListener());
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ────────────────────────────────────────────────────────
    // 初期化
    // ────────────────────────────────────────────────────────
    injectCSS();

    function init() {
        log('初期化開始');
        attachClickListener();
        setupObserver();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // デバッグ・手動テスト用 API
    window.MediaController = {
        getCharName,
        copyCharName: () => copyToClipboard(getCharName()),
        openAddcharaFolder: tryOpenFolder,
        showTestMessage: () => showMessage('キャラ名「テスト」をコピーしました。新規フォルダを作成しフォルダ名に貼り付けて下さい。'),
    };

    log('モジュールを読み込みました');
})();
