/**
 * Media Controller
 * キャラクター作成時に public/addchara/{キャラクター名}/ フォルダを自動作成
 * 将来的なメディア管理機能の基盤
 */
(function () {
    'use strict';

    console.log('[MediaController] 初期化開始');

    // ═══════════════════════════════════════════════════════════
    // 定数
    // ═══════════════════════════════════════════════════════════
    const MODULE_NAME = 'media_controller';
    const FOLDER_BASE = 'addchara';                      // public/ 以下のベースパス
    const CREATE_FOLDER_ENDPOINT = '/api/expansion/create-folder';
    const POLL_INTERVAL = 200;                           // キャラ検出ポーリング間隔 (ms)
    const POLL_TIMEOUT = 15000;                          // 検出タイムアウト (ms)
    const STATUS_DISPLAY_DURATION = 4000;

    // ═══════════════════════════════════════════════════════════
    // 状態
    // ═══════════════════════════════════════════════════════════
    let isWatching = false;
    let statusEl = null;
    let statusTimer = null;

    // ═══════════════════════════════════════════════════════════
    // ユーティリティ
    // ═══════════════════════════════════════════════════════════

    /**
     * 現在選択中のキャラクター名を取得
     * （image-display.js と同じ取得方式に統一）
     */
    function getCurrentCharacterName() {
        try {
            if (typeof SillyTavern !== 'undefined') {
                const ctx = SillyTavern.getContext();
                if (ctx) {
                    if (ctx.character?.name) return ctx.character.name;
                    if (ctx.name2) return ctx.name2;
                    if (ctx.characters && typeof ctx.characterId !== 'undefined' && ctx.characters[ctx.characterId]) {
                        const cName = ctx.characters[ctx.characterId].name;
                        if (cName) return cName;
                    }
                }
            }
        } catch (e) { /* ignore */ }

        const selected = document.querySelector(
            '#character_select option:checked, select[name="character"] option:checked'
        );
        if (selected) {
            const text = selected.textContent?.trim();
            if (text && text !== 'SillyTavern System') return text;
        }
        return null;
    }

    /**
     * フォルダ名として危険な文字を検出（警告用）
     * ※ 実際のファイル名は image-display.js と揃えるため、生の名前を使用する
     */
    function checkDangerousChars(name) {
        if (!name) return false;
        return /[<>:"/\\|?*\x00-\x1F]/.test(name);
    }

    /**
     * ステータス表示（画面右下にトースト表示）
     */
    function showStatus(message, type = 'info') {
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.id = 'mc-status-indicator';
            document.body.appendChild(statusEl);
        }
        statusEl.textContent = message;
        statusEl.className = 'mc-visible';
        if (type === 'error')   statusEl.classList.add('mc-error');
        if (type === 'warning') statusEl.classList.add('mc-warning');
        if (type === 'success') statusEl.classList.add('mc-success');

        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => {
            statusEl.classList.remove('mc-visible');
        }, STATUS_DISPLAY_DURATION);
    }

    // ═══════════════════════════════════════════════════════════
    // フォルダ作成 API
    // ═══════════════════════════════════════════════════════════

    /**
     * キャラクター名フォルダを public/addchara/ 以下に作成
     * @param {string} charName キャラクター名（生の名前）
     * @returns {Promise<boolean>} 成功時 true
     */
    async function createCharacterFolder(charName) {
        if (!charName || typeof charName !== 'string') {
            console.warn('[MediaController] 無効なキャラクター名:', charName);
            return false;
        }

        if (checkDangerousChars(charName)) {
            console.warn(
                `[MediaController] ⚠️ キャラクター名に特殊文字が含まれています: "${charName}"\n` +
                '  → フォルダ名も同名になるため、パス解決に失敗する可能性があります'
            );
        }

        const folderPath = `${FOLDER_BASE}/${charName}`;
        console.log(`[MediaController] フォルダ作成要求: public/${folderPath}`);
        showStatus(`📁 フォルダ作成中: ${charName}...`);

        try {
            const resp = await fetch(CREATE_FOLDER_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: folderPath,           // 例: "addchara/キャラ名"
                    base: 'public',             // public/ 直下に作成
                    characterName: charName,
                }),
            });

            if (resp.ok) {
                const data = await resp.json().catch(() => ({}));
                console.log(`[MediaController] ✅ フォルダ作成成功: public/${folderPath}`, data);
                showStatus(`✅ フォルダ作成完了: ${charName}`, 'success');
                return true;
            }

            const errText = await resp.text().catch(() => '');
            console.warn(`[MediaController] ❌ サーバーエラー (${resp.status}):`, errText);
            showStatus(`❌ フォルダ作成失敗 (HTTP ${resp.status})`, 'error');
        } catch (e) {
            console.warn(`[MediaController] ❌ フォルダ作成API未実装/通信失敗:`, e.message);
            showStatus('⚠️ サーバー側エンドポイント未実装', 'warning');
            console.warn(
                '[MediaController] ヒント: SillyTavern サーバー側に ' +
                `${CREATE_FOLDER_ENDPOINT} を実装してください。`
            );
        }
        return false;
    }

    // ═══════════════════════════════════════════════════════════
    // キャラクター作成の検出
    // ═══════════════════════════════════════════════════════════

    function startWatchingCreation() {
        if (isWatching) return;
        isWatching = true;

        const oldName = getCurrentCharacterName();
        console.log(`[MediaController] キャラ作成監視開始 (旧キャラ: ${oldName ?? 'なし'})`);
        const startTime = Date.now();

        const timer = setInterval(async () => {
            if (Date.now() - startTime > POLL_TIMEOUT) {
                clearInterval(timer);
                isWatching = false;
                console.warn('[MediaController] キャラ作成の検出タイムアウト');
                return;
            }

            const newName = getCurrentCharacterName();
            if (newName && newName !== oldName) {
                clearInterval(timer);
                isWatching = false;
                console.log(`[MediaController] 🎉 新キャラ検出: ${newName}`);
                await createCharacterFolder(newName);
            }
        }, POLL_INTERVAL);
    }

    // ═══════════════════════════════════════════════════════════
    // イベントリスナー登録
    // ═══════════════════════════════════════════════════════════

    function setupCreateInterception() {
        // キャプチャフェーズでクリックを検知（SillyTavern の処理より前）
        document.addEventListener('click', (e) => {
            const btn = e.target?.closest?.('#create_button_label, #create_button');
            if (!btn) return;
            console.log('[MediaController] キャラ作成ボタンクリック検知');
            startWatchingCreation();
        }, true);
    }

    // ═══════════════════════════════════════════════════════════
    // 初期化
    // ═══════════════════════════════════════════════════════════

    function init() {
        setupCreateInterception();
        const initialName = getCurrentCharacterName();
        console.log(`[MediaController] 初期キャラ: ${initialName ?? 'なし'}`);
        console.log('[MediaController] ✅ 初期化完了');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ═══════════════════════════════════════════════════════════
    // 公開API（将来の拡張用）
    // ═══════════════════════════════════════════════════════════
    window.MediaController = {
        getCurrentCharacterName,
        createCharacterFolder,
        showStatus,
        config: {
            FOLDER_BASE,
            CREATE_FOLDER_ENDPOINT,
        },
    };

    console.log('✅ MediaController API を window.MediaController に公開しました');
})();
