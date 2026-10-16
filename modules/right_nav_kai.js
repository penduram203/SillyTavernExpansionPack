(function () {
    const MODULE_NAME = 'right_nav_kai';
    const LOG_PREFIX = '[RightNavKai DEBUG]';

    // --- メディア検出結果のキャッシュ ---
    const mediaCache = new Map();

    function isVideoUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return !!url.match(/\.(mp4|webm)$/i);
    }

    // メディアの存在確認（タイムアウト付きで安全化）
    function checkMediaExists(mediaUrl) {
        return new Promise((resolve) => {
            if (!mediaUrl || typeof mediaUrl !== 'string' || !mediaUrl.trim()) return resolve(false);

            const timeout = setTimeout(() => resolve(false), 3000); // 3秒でタイムアウト

            if (isVideoUrl(mediaUrl)) {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.onloadedmetadata = () => {
                    clearTimeout(timeout);
                    resolve(true);
                };
                video.onerror = () => {
                    clearTimeout(timeout);
                    resolve(false);
                };
                video.src = mediaUrl;
            } else {
                const img = new Image();
                img.onload = () => {
                    clearTimeout(timeout);
                    resolve(true);
                };
                img.onerror = () => {
                    clearTimeout(timeout);
                    resolve(false);
                };
                img.src = mediaUrl;
            }
        });
    }

    // --- メディアDOM要素（img または video）の作成 ---
    function createMediaElement(src, altText = '') {
        if (isVideoUrl(src)) {
            const video = document.createElement('video');
            video.src = src;
            video.autoplay = true;
            video.loop = true;
            video.muted = true;
            video.playsInline = true;
            video.classList.add('right-nav-char-image');
            video.style.width = '100%';
            video.style.height = '100%';
            // objectFit を 'cover' から 'contain' に変更（長辺基準で枠内に収める）
            video.style.objectFit = 'contain';
            return video;
        } else {
            const img = document.createElement('img');
            img.src = src;
            img.alt = altText;
            img.classList.add('right-nav-char-image');
            img.style.width = '100%';
            img.style.height = '100%';
            // objectFit を 'cover' から 'contain' に変更（長辺基準で枠内に収める）
            img.style.objectFit = 'contain';
            return img;
        }
    }

    // --- キャラクター画像（サムネイル）パスの取得 ---
    async function getCharacterImageSrc(charName) {
        if (!charName) return null;

        if (mediaCache.has(charName)) {
            return mediaCache.get(charName);
        }

        // 1. _ext.json からのサムネイル/デフォルト画像検索
        try {
            const extPath = `addchara/${charName}/${charName}_ext.json`;
            const resp = await fetch(extPath);
            if (resp.ok) {
                const data = await resp.json();
                let candidate = data.thumbnail || data.default;

                if (!candidate && data.image_display_extension) {
                    candidate = data.image_display_extension.thumbnail || data.image_display_extension.default;
                }

                if (candidate) {
                    const src = Array.isArray(candidate) ? candidate[0] : candidate;
                    const exists = await checkMediaExists(src);
                    if (exists) {
                        mediaCache.set(charName, src);
                        return src;
                    }
                }
            }
        } catch (e) {
            // json読み込み失敗時は無視
        }

        // 2. フォールバック (defa.mp4)
        const fallback = `addchara/${charName}/defa.mp4`;
        const exists = await checkMediaExists(fallback);
        if (exists) {
            mediaCache.set(charName, fallback);
            return fallback;
        }

        mediaCache.set(charName, null);
        return null;
    }

    // --- 右ナビパネル内のキャラクター画像更新 ---
    async function updateCharacterImages() {
        const panel = document.querySelector('#right-nav-panel, .right-nav-panel, #rm_char_sp_mag, #character_list');
        if (!panel) return;

        // キャラクターブロックの取得（柔軟なセレクタに対応）
        const charBlocks = panel.querySelectorAll('.right-nav-char-block, .character-block, .character_select');
        if (charBlocks.length === 0) return;

        console.log(`${LOG_PREFIX} Updating character images... Found ${charBlocks.length} character blocks`);

        for (let i = 0; i < charBlocks.length; i++) {
            const block = charBlocks[i];
            
            // キャラクター名の取得
            let charName = block.dataset.name || block.getAttribute('data-name') || block.getAttribute('chid');
            if (!charName) {
                const nameEl = block.querySelector('.character-name, .char-name, .ch_name');
                if (nameEl) charName = nameEl.textContent.trim();
            }

            if (!charName) continue;

            const mediaSrc = await getCharacterImageSrc(charName);
            if (!mediaSrc) continue;

            // 既存のアバター/画像コンテナを取得または作成
            let imgContainer = block.querySelector('.right-nav-img-container, .avatar');
            if (!imgContainer) {
                imgContainer = document.createElement('div');
                imgContainer.className = 'right-nav-img-container';
                block.insertBefore(imgContainer, block.firstChild);
            }

            // 既存メディアと異なる場合のみ置き換え
            const currentMedia = imgContainer.querySelector('.right-nav-char-image');
            if (!currentMedia || currentMedia.getAttribute('data-src') !== mediaSrc) {
                imgContainer.innerHTML = '';
                const newMedia = createMediaElement(mediaSrc, charName);
                newMedia.setAttribute('data-src', mediaSrc);
                imgContainer.appendChild(newMedia);
            }
        }
    }

    // デバウンス処理
    function debounce(func, wait) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    const debouncedUpdate = debounce(updateCharacterImages, 300);

    // --- DOM監視 ---
    function setupMutationObserver() {
        const targetNode = document.body;
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.addedNodes.length > 0) {
                    const hasPanel = Array.from(mutation.addedNodes).some(node => 
                        node.nodeType === 1 && (
                            node.id === 'right-nav-panel' || 
                            node.classList.contains('right-nav-panel') || 
                            node.querySelector && node.querySelector('#right-nav-panel, .character_select')
                        )
                    );
                    if (hasPanel) {
                        debouncedUpdate();
                        break;
                    }
                }
            }
        });

        observer.observe(targetNode, { childList: true, subtree: true });
        console.log(`${LOG_PREFIX} #right-nav-panel の監視を開始しました。`);
    }

    // --- EventSource 安全監視 ---
    function setupEventSourceListeners() {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const context = SillyTavern.getContext();
            if (context && context.eventSource && context.eventTypes) {
                const { eventSource, eventTypes } = context;

                const safeOn = (eventType, handler) => {
                    if (eventType && typeof eventSource.on === 'function') {
                        eventSource.on(eventType, handler);
                    }
                };

                safeOn(eventTypes.CHAT_CHANGED, debouncedUpdate);
                safeOn(eventTypes.CHARACTER_SELECTED, debouncedUpdate);
                safeOn(eventTypes.CHARACTER_PAGE_LOADED, debouncedUpdate);

                console.log(`${LOG_PREFIX} Event listeners registered successfully`);
            }
        }
    }

    // --- 初期化 ---
    function init() {
        console.log(`${LOG_PREFIX} Right Nav Kai extension loaded`);
        console.log(`${LOG_PREFIX} Initializing Right Nav Kai extension`);
        
        setupEventSourceListeners();
        setupMutationObserver();
        debouncedUpdate();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
