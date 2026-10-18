/**
 * Media Controller
 * キャラクター作成時に public/addchara/{キャラクター名}/ フォルダを自動作成
 * サーバープラグイン未導入時はセットアップガイドを自動表示
 */
(function () {
    'use strict';

    console.log('[MediaController] 初期化開始');

    // ═══════════════════════════════════════════════════════════
    // 定数
    // ═══════════════════════════════════════════════════════════
    const MODULE_NAME = 'media_controller';
    const FOLDER_BASE = 'addchara';
    const PLUGIN_ID = 'expansion-pack';
    const HEALTH_ENDPOINT = `/api/plugins/${PLUGIN_ID}/health`;
    const CREATE_FOLDER_ENDPOINT = `/api/plugins/${PLUGIN_ID}/create-folder`;
    const POLL_INTERVAL = 200;
    const POLL_TIMEOUT = 30000; // 15s → 30s に延長
    const STATUS_DISPLAY_DURATION = 4000;
    const HEALTH_CHECK_CACHE_TTL = 60000;
    const PLACEHOLDER_NAMES = ['SillyTavern System', 'System', ''];

    // ═══════════════════════════════════════════════════════════
    // 状態
    // ═══════════════════════════════════════════════════════════
    let isWatching = false;
    let statusEl = null;
    let statusTimer = null;
    let setupModalEl = null;
    let healthCache = { available: null, timestamp: 0 };
    let lastCreatedName = null; // 検出済みキャラ名（二重処理防止）

    // ═══════════════════════════════════════════════════════════
    // ユーティリティ
    // ═══════════════════════════════════════════════════════════

    function isPlaceholderName(name) {
        if (!name || typeof name !== 'string') return true;
        return PLACEHOLDER_NAMES.includes(name.trim());
    }

    /**
     * 現在選択中のキャラクター名を取得
     * ★ チェック順序を修正: ctx.characters[ctx.characterId] を最優先
     */
    function getCurrentCharacterName() {
        try {
            if (typeof SillyTavern !== 'undefined') {
                const ctx = SillyTavern.getContext();
                if (ctx) {
                    // ★ 1. ctx.characters[ctx.characterId] を最優先
                    //    （キャラ作成後、ctx.character.name は古いまま残るため）
                    if (ctx.characters && typeof ctx.characterId !== 'undefined' &&
                        ctx.characters[ctx.characterId]) {
                        const cName = ctx.characters[ctx.characterId].name;
                        if (cName && !isPlaceholderName(cName)) return cName;
                    }
                    // 2. ctx.character.name（プレースホルダ除外）
                    if (ctx.character?.name && !isPlaceholderName(ctx.character.name)) {
                        return ctx.character.name;
                    }
                    // 3. ctx.name2
                    if (ctx.name2 && !isPlaceholderName(ctx.name2)) return ctx.name2;
                }
            }
        } catch (e) {
            console.warn('[MediaController] getCurrentCharacterName (context) エラー:', e);
        }

        // 4. DOM フォールバック（option.value も確認）
        try {
            const selected = document.querySelector(
                '#character_select option:checked, select[name="character"] option:checked'
            );
            if (selected) {
                // value（アバターファイル名）から拡張子を除去
                const val = selected.value?.replace(/\.(png|jpg|jpeg|webp|gif)$/i, '');
                if (val && !isPlaceholderName(val)) return val;
                // textContent も確認
                const text = selected.textContent?.trim();
                if (text && !isPlaceholderName(text)) return text;
            }
        } catch (e) { /* ignore */ }

        return null;
    }

    /**
     * キャラクターリストから「新しく追加されたキャラ」を検出
     * （ctx.characterId が更新されない場合の保険）
     */
    function findNewCharacterFromList(knownAvatars) {
        try {
            if (typeof SillyTavern === 'undefined') return null;
            const ctx = SillyTavern.getContext();
            if (!ctx?.characters) return null;
            const newChar = ctx.characters.find(c => c && c.avatar && !knownAvatars.has(c.avatar));
            return newChar?.name || null;
        } catch (e) { return null; }
    }

    /**
     * 現在のキャラクターリストのアバターセットを取得
     */
    function getCurrentAvatarSet() {
        const set = new Set();
        try {
            if (typeof SillyTavern === 'undefined') return set;
            const ctx = SillyTavern.getContext();
            if (!ctx?.characters) return set;
            ctx.characters.forEach(c => { if (c?.avatar) set.add(c.avatar); });
        } catch (e) { /* ignore */ }
        return set;
    }

    function checkDangerousChars(name) {
        if (!name) return false;
        return /[<>:"/\\|?*\x00-\x1F]/.test(name);
    }

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
    // ヘルスチェック
    // ═══════════════════════════════════════════════════════════

    async function checkEndpointAvailability(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && healthCache.available !== null &&
            (now - healthCache.timestamp) < HEALTH_CHECK_CACHE_TTL) {
            return healthCache.available;
        }

        try {
            const resp = await fetch(HEALTH_ENDPOINT, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined,
            });
            if (resp.ok) {
                const data = await resp.json().catch(() => ({}));
                const available = data.ok === true;
                healthCache = { available, timestamp: now };
                console.log(`[MediaController] ヘルスチェック: ${available ? '✅ 利用可能' : '❌ 応答異常'}`);
                return available;
            }
            healthCache = { available: false, timestamp: now };
            console.log(`[MediaController] ヘルスチェック: ❌ HTTP ${resp.status}`);
            return false;
        } catch (e) {
            healthCache = { available: false, timestamp: now };
            console.log(`[MediaController] ヘルスチェック: ❌ 通信失敗 (${e.message})`);
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // フォルダ作成 API
    // ═══════════════════════════════════════════════════════════

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
                    path: folderPath,
                    base: 'public',
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
            console.warn(`[MediaController] ❌ 通信失敗:`, e.message);
            showStatus('❌ サーバーとの通信に失敗しました', 'error');
        }
        return false;
    }

    async function createCharacterFolderWithCheck(charName) {
        if (lastCreatedName === charName) {
            console.log(`[MediaController] 同一キャラの二重処理をスキップ: ${charName}`);
            return false;
        }
        lastCreatedName = charName;

        const available = await checkEndpointAvailability();
        if (!available) {
            console.warn('[MediaController] サーバープラグイン未導入 → セットアップガイド表示');
            showSetupGuide();
            showStatus('⚠️ サーバープラグインが未導入です', 'warning');
            return false;
        }
        return await createCharacterFolder(charName);
    }

    // ═══════════════════════════════════════════════════════════
    // セットアップガイド（モーダル）
    // ═══════════════════════════════════════════════════════════

    const PLUGIN_CODE = `const fs = require('fs');
const path = require('path');

async function init(router) {
    router.get('/health', (req, res) => {
        res.json({ ok: true, plugin: 'expansion-pack' });
    });

    router.post('/create-folder', (req, res) => {
        try {
            const { path: relPath, base } = req.body || {};
            if (!relPath || base !== 'public') {
                return res.status(400).send('invalid request');
            }
            const normalized = path.normalize(relPath).replace(/^(\\.\\.[\\/\\\\])+/, '');
            const targetDir = path.join(process.cwd(), 'public', normalized);
            const publicRoot = path.join(process.cwd(), 'public') + path.sep;
            if (!targetDir.startsWith(publicRoot)) {
                return res.status(403).send('forbidden');
            }
            fs.mkdirSync(targetDir, { recursive: true });
            res.json({ ok: true, path: targetDir });
        } catch (error) {
            res.status(500).send(error.message);
        }
    });
}

module.exports = {
    init,
    info: { id: 'expansion-pack', name: 'Expansion Pack', description: 'Media folder helper' },
};`;

    function buildSetupGuideHTML() {
        const escapedCode = PLUGIN_CODE
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        return `
            <div class="mc-setup-modal-backdrop"></div>
            <div class="mc-setup-modal-content">
                <div class="mc-setup-modal-header">
                    <span class="mc-setup-modal-title">🔧 サーバープラグインのセットアップ</span>
                    <button class="mc-setup-modal-close" title="閉じる">×</button>
                </div>
                <div class="mc-setup-modal-body">
                    <p class="mc-setup-intro">
                        <strong>Media Controller</strong> がキャラクター名フォルダを自動作成するには、
                        SillyTavern サーバー側に専用プラグインが必要です。<br>
                        以下の手順に従ってセットアップしてください。
                    </p>
                    <ol class="mc-setup-steps">
                        <li>
                            <div class="mc-step-title">📁 プラグインフォルダを作成</div>
                            <div class="mc-step-desc">
                                SillyTavernのインストール先に以下のフォルダを作成：
                                <code class="mc-path">{SillyTavern}/plugins/expansion-pack/</code>
                            </div>
                        </li>
                        <li>
                            <div class="mc-step-title">📝 プラグインファイルを配置</div>
                            <div class="mc-step-desc">
                                作成したフォルダ内に <code>index.js</code> を作成し、以下のコードを貼り付け：
                            </div>
                            <div class="mc-code-wrapper">
                                <pre class="mc-code-block"><code>${escapedCode}</code></pre>
                                <button class="mc-copy-button" data-copy-target="plugin">📋 コピー</button>
                            </div>
                        </li>
                        <li>
                            <div class="mc-step-title">⚙️ config.yaml を編集</div>
                            <div class="mc-step-desc">
                                <code>{SillyTavern}/config.yaml</code> を開き、以下を設定：
                                <pre class="mc-code-block mc-code-inline"><code>enableServerPlugins: true</code></pre>
                            </div>
                        </li>
                        <li>
                            <div class="mc-step-title">🔄 SillyTavern を再起動</div>
                            <div class="mc-step-desc">
                                サーバーを再起動すると、プラグインが自動的に読み込まれます。
                            </div>
                        </li>
                    </ol>
                    <div class="mc-setup-note">
                        <strong>💡 ヒント:</strong>
                        セットアップ完了後、このモーダルの「再チェック」ボタンで
                        導入状況を確認できます。
                    </div>
                </div>
                <div class="mc-setup-modal-footer">
                    <button class="mc-setup-recheck-button">🔄 再チェック</button>
                    <button class="mc-setup-close-button">閉じる</button>
                </div>
            </div>
        `;
    }

    function showSetupGuide() {
        if (setupModalEl) {
            setupModalEl.classList.add('mc-visible');
            return;
        }

        setupModalEl = document.createElement('div');
        setupModalEl.id = 'mc-setup-modal';
        setupModalEl.innerHTML = buildSetupGuideHTML();
        document.body.appendChild(setupModalEl);

        setupModalEl.querySelector('.mc-setup-modal-close')
            .addEventListener('click', hideSetupGuide);
        setupModalEl.querySelector('.mc-setup-close-button')
            .addEventListener('click', hideSetupGuide);
        setupModalEl.querySelector('.mc-setup-modal-backdrop')
            .addEventListener('click', hideSetupGuide);

        setupModalEl.querySelector('.mc-copy-button')
            .addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                try {
                    await navigator.clipboard.writeText(PLUGIN_CODE);
                    btn.textContent = '✅ コピー完了';
                    btn.classList.add('mc-copied');
                    setTimeout(() => {
                        btn.textContent = '📋 コピー';
                        btn.classList.remove('mc-copied');
                    }, 2000);
                } catch (err) {
                    btn.textContent = '❌ コピー失敗';
                    setTimeout(() => { btn.textContent = '📋 コピー'; }, 2000);
                }
            });

        setupModalEl.querySelector('.mc-setup-recheck-button')
            .addEventListener('click', async (e) => {
                const btn = e.currentTarget;
                btn.disabled = true;
                btn.textContent = '⏳ チェック中...';
                const available = await checkEndpointAvailability(true);
                if (available) {
                    btn.textContent = '✅ 導入済み';
                    btn.classList.add('mc-success');
                    showStatus('✅ サーバープラグインを検出しました', 'success');
                    setTimeout(() => hideSetupGuide(), 1200);
                } else {
                    btn.textContent = '❌ 未検出';
                    btn.classList.add('mc-error');
                    showStatus('⚠️ まだプラグインを検出できません', 'warning');
                    setTimeout(() => {
                        btn.disabled = false;
                        btn.textContent = '🔄 再チェック';
                        btn.classList.remove('mc-error');
                    }, 2500);
                }
            });

        requestAnimationFrame(() => {
            setupModalEl.classList.add('mc-visible');
        });
    }

    function hideSetupGuide() {
        if (!setupModalEl) return;
        setupModalEl.classList.remove('mc-visible');
    }

    // ═══════════════════════════════════════════════════════════
    // キャラクター作成の検出（ポーリング + リスト差分）
    // ═══════════════════════════════════════════════════════════

    function startWatchingCreation() {
        if (isWatching) return;
        isWatching = true;

        const oldName = getCurrentCharacterName();
        const knownAvatars = getCurrentAvatarSet(); // ★ キャラリストのスナップショット
        console.log(
            `[MediaController] キャラ作成監視開始 ` +
            `(旧キャラ: ${oldName ?? 'なし'}, 既知キャラ数: ${knownAvatars.size})`
        );
        const startTime = Date.now();
        let pollCount = 0;

        const timer = setInterval(async () => {
            pollCount++;
            if (Date.now() - startTime > POLL_TIMEOUT) {
                clearInterval(timer);
                isWatching = false;
                console.warn(`[MediaController] キャラ作成の検出タイムアウト (${pollCount}回ポーリング)`);
                return;
            }

            // ★ 方法1: 現在名の変化を検出
            const newName = getCurrentCharacterName();
            if (newName && newName !== oldName) {
                clearInterval(timer);
                isWatching = false;
                console.log(`[MediaController] 🎉 新キャラ検出(名前変化): ${newName} (poll=${pollCount})`);
                await createCharacterFolderWithCheck(newName);
                return;
            }

            // ★ 方法2: キャラリストの増加を検出（フォールバック）
            const listNewName = findNewCharacterFromList(knownAvatars);
            if (listNewName) {
                clearInterval(timer);
                isWatching = false;
                console.log(`[MediaController] 🎉 新キャラ検出(リスト差分): ${listNewName} (poll=${pollCount})`);
                await createCharacterFolderWithCheck(listNewName);
                return;
            }

            // ★ デバッグログ（10回に1回だけ出力）
            if (pollCount % 10 === 1) {
                console.log(
                    `[MediaController] poll#${pollCount}: ` +
                    `newName="${newName}", chars=${getCurrentAvatarSet().size}`
                );
            }
        }, POLL_INTERVAL);
    }

    // ═══════════════════════════════════════════════════════════
    // イベントリスナー登録
    // ═══════════════════════════════════════════════════════════

    function setupCreateInterception() {
        document.addEventListener('click', (e) => {
            const btn = e.target?.closest?.('#create_button_label, #create_button');
            if (!btn) return;
            console.log('[MediaController] キャラ作成ボタンクリック検知');
            startWatchingCreation();
        }, true);
    }

    /**
     * ★ 保険: SillyTavern のイベントでも検出
     *    ポーリングが間に合わない/失敗するケースをカバー
     */
    function setupEventFallback() {
        try {
            if (typeof SillyTavern === 'undefined') return;
            const ctx = SillyTavern.getContext();
            if (!ctx?.eventSource || !ctx?.eventTypes) return;
            const { eventSource, eventTypes } = ctx;

            const onCharacterAppeared = () => {
                if (!isWatching) return;
                // 少し待ってから名前を確認（コンテキスト更新待ち）
                setTimeout(() => {
                    const name = getCurrentCharacterName();
                    if (name && name !== lastCreatedName) {
                        console.log(`[MediaController] 🎉 新キャラ検出(イベント): ${name}`);
                        createCharacterFolderWithCheck(name);
                    }
                }, 500);
            };

            ['CHARACTER_PAGE_LOADED', 'CHARACTER_SELECTED', 'CHAT_CHANGED', 'CHARACTER_EDITED']
                .forEach(evName => {
                    const evType = eventTypes[evName];
                    if (evType && typeof eventSource.on === 'function') {
                        eventSource.on(evType, onCharacterAppeared);
                        console.log(`[MediaController] イベントフォールバック登録: ${evName}`);
                    }
                });
        } catch (e) {
            console.warn('[MediaController] イベントフォールバック登録失敗:', e);
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 初期化
    // ═══════════════════════════════════════════════════════════

    async function init() {
        setupCreateInterception();
        setupEventFallback();
        const initialName = getCurrentCharacterName();
        console.log(`[MediaController] 初期キャラ: ${initialName ?? 'なし'}`);

        checkEndpointAvailability().then(available => {
            if (available) {
                console.log('[MediaController] ✅ サーバープラグイン検出済み');
            } else {
                console.warn(
                    '[MediaController] ⚠️ サーバープラグイン未検出。' +
                    'キャラ作成時にセットアップガイドが表示されます。'
                );
            }
        });

        console.log('[MediaController] ✅ 初期化完了');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ═══════════════════════════════════════════════════════════
    // 公開API
    // ═══════════════════════════════════════════════════════════
    window.MediaController = {
        getCurrentCharacterName,
        createCharacterFolder,
        createCharacterFolderWithCheck,
        checkEndpointAvailability,
        showSetupGuide,
        hideSetupGuide,
        showStatus,
        config: {
            FOLDER_BASE,
            PLUGIN_ID,
            HEALTH_ENDPOINT,
            CREATE_FOLDER_ENDPOINT,
        },
    };

    console.log('✅ MediaController API を window.MediaController に公開しました');
})();
