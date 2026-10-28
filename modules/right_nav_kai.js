// right_nav_kai.js
(function () {
    const MODULE_NAME = 'right_nav_kai';
    const LOG_PREFIX = '[RightNavKai DEBUG]';

    // --- メディア検出結果のキャッシュ ---
    // --- メディア検出結果のキャッシュ ---
    const mediaCache = new Map();
    // ★ _ext.json をこのセッションで既に試行したキャラのセット
    const _extJsonAttemptedInSession = new Set();
    // ★ 新システム(character.data.extensions)が使用中と確認できたか
    //    一度でも image_display_extension キーを検出したら true になり、
    //    以降は _ext.json フォールバックを完全スキップする
    let _newSystemConfirmed = false;

    function isVideoUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return !!url.match(/\.(mp4|webm)$/i);
    }

    // メディアの存在確認（タイムアウト付きで安全化）
    function checkMediaExists(mediaUrl) {
        return new Promise((resolve) => {
            if (!mediaUrl || typeof mediaUrl !== 'string' || !mediaUrl.trim()) return resolve(false);

            const timeout = setTimeout(() => resolve(false), 1500); // 3秒 → 1.5秒

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

        // ── ① character.data を最優先（全キャラ対象・現在キャラに限定しない）──
        //    ★ character.data が未ロードのケースに備え、2秒(10回×200ms)のリトライを行う
        let extKeyExists = false;
        let charDataLoaded = false;

        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                const ctx = SillyTavern.getContext();
                const allChars = ctx?.characters || [];
                const matchedChar = allChars.find(c => c?.name === charName);
                if (matchedChar?.data) {
                    charDataLoaded = true;
                    const ext = matchedChar.data.extensions?.image_display_extension;
                    extKeyExists = ext !== undefined;
                    if (extKeyExists) {
                        // ★ 新システム使用中を確認 → 以降の _ext.json を全スキップ
                        _newSystemConfirmed = true;
                    }
                    if (ext && typeof ext === 'object') {
                        for (const key of ['thumbnail', 'default']) {
                            const candidate = ext[key];
                            if (!candidate) continue;
                            const src = Array.isArray(candidate) ? candidate[0] : candidate;
                            if (await checkMediaExists(src)) {
                                if (mediaCache.get(charName) !== src) {
                                    mediaCache.set(charName, src);
                                }
                                return src;
                            }
                        }
                    }
                    if (extKeyExists) break;  // キー確定 → リトライ不要
                }
            } catch (e) { /* ignore */ }
            if (attempt < 9) await new Promise(r => setTimeout(r, 200));
        }

        // ── ② キャッシュチェック ──
        if (mediaCache.has(charName)) {
            return mediaCache.get(charName);
        }

        // ── ③ _ext.json フォールバック（旧システムからの移行用・1回のみ）──
        if (!extKeyExists && !_newSystemConfirmed && !_extJsonAttemptedInSession.has(charName)) {
            _extJsonAttemptedInSession.add(charName);
            try {
                const extPath = `user/images/${charName}/${charName}_ext.json`;
                const resp = await fetch(extPath);
                if (resp.ok) {
                    const data = await resp.json();
                    let candidate = data.thumbnail || data.default;
                    if (!candidate && data.image_display_extension) {
                        candidate = data.image_display_extension.thumbnail || data.image_display_extension.default;
                    }
                    if (candidate) {
                        const src = Array.isArray(candidate) ? candidate[0] : candidate;
                        if (await checkMediaExists(src)) {
                            mediaCache.set(charName, src);
                            return src;
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        }

        // ── ④ defa.mp4 フォールバックは完全削除 ──
        //    ★ 理由: defa.mp4 が存在する環境で誤って「登録済み」扱いになり、
        //      character.data の正しいサムネイルを上書きしてしまうため。
        //      character.data / _ext.json にサムネイルが無い場合は null を返し、
        //      呼び出し側でST本来のアバターを維持する。

        // ★ charDataLoaded が true（=character.data はロード済みだがサムネなし）の場合のみ
        //   mediaCache に null を保存する。未ロードの場合は保存せず、次回リトライを許容する。
        if (charDataLoaded) {
            mediaCache.set(charName, null);
        }
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

                // ★ キャラ切替時に mediaCache をクリア（古い defa.mp4 等の残留防止）
                const clearCacheAndUpdate = () => {
                    mediaCache.clear();
                    debouncedUpdate();
                };

                safeOn(eventTypes.CHAT_CHANGED, clearCacheAndUpdate);
                safeOn(eventTypes.CHARACTER_SELECTED, clearCacheAndUpdate);
                safeOn(eventTypes.CHARACTER_PAGE_LOADED, clearCacheAndUpdate);

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
