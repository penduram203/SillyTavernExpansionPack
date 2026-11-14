// image-display.js
(function () {
    console.log("Image Display: 初期化を開始します。");
    const MODULE_NAME = 'image_display';
    const OLD_STORAGE_KEY = 'imageDisplayState';
    const mediaExistsCache = new Map();
    const DEFAULT_WIDTH = 300, DEFAULT_HEIGHT = 200, DEFAULT_LEFT = 100, DEFAULT_TOP = 100, DEFAULT_BG_COLOR = '#000000';
    const defaultImageMap = { "default": "user/images/default" };
    let currentCharacter = null;
    let currentImageMap = defaultImageMap;
    let currentImageUrl = null;
    let currentMode = 'normal';
    let preNormalState = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, left: DEFAULT_LEFT, top: DEFAULT_TOP };
    let isDragging = false, isResizing = false, offsetX, offsetY, isCustomWindowOpen = false;
    const imageMapCache = new Map();
    let isDefaultImageFailed = false;
    let chatDomObserver = null;
    // ★ 送信時に確定したキーワード画像をロック（事前設定モード用）
    let _lastSentKeywordImage = null;
    // ★ バトルモード中の背景画像ロック
    //   VariableManager がバトルモード変数=1 を検知した時にロックし、
    //   バトル終了時に解除する。ロック中は updateImage() が同じ画像を維持する。
    let _battleImageLock = null;
    let lastMatchCache = { signature: null, url: null, timestamp: 0 };
    const MATCH_CACHE_TTL = 1500;
    const parsedConditionCache = new Map();
    let sortedKeywordEntriesCache = null;
    let sortedKeywordEntriesCacheSource = null;
    const MAX_MESSAGE_SCAN = 20;
    let isSendInterceptionInstalled = false;

    const Z_INDEX_BODY = '0';
    const Z_INDEX_HEADER_DEFAULT = '15000';
    const HEADER_HEIGHT = 30;
    const CHAT_HEADER_HEIGHT = 30;

    let headerVisible = false;

    let imageManualMode = 'normal';
    let savedCustomWindowOpen = false;

    let chatPreState = null;
    let chatCurrentMode = 'normal';
    let isDraggingChat = false;
    let isResizingChat = false;
    let chatDragOffsetX = 0;
    let chatDragOffsetY = 0;
    let chatResizeStartX = 0;
    let chatResizeStartY = 0;
    let chatResizeStartW = 0;
    let chatResizeStartH = 0;

    function getTextSignature(text) {
        if (!text || typeof text !== 'string') return '';
        return text.slice(-200);
    }

    // ============================================================
    // ★ バトルモード用の背景画像ロック
    //   - バトルモード中は現在表示中の画像を維持し、自動更新をスキップする
    //   - VariableManager から lockBattleImage() / unlockBattleImage() が明示的に呼ばれる
    //   - isBattleModeActive() による自動検知も併用する（保険）
    // ============================================================
    function isBattleModeActive() {
        try {
            return window.VariableManager?.isBattleActive?.() === true;
        } catch (e) { return false; }
    }

    function lockBattleImage() {
        if (_battleImageLock) return; // 既にロック済み
        _battleImageLock = currentImageUrl || null;
        if (_battleImageLock) {
            // 現在表示中の画像を強制ロック
            _lastSentKeywordImage = _battleImageLock;
        }
        console.log(`[ImageDisplay] 🔒 バトル背景画像をロック: ${_battleImageLock}`);
    }

    function unlockBattleImage() {
        if (!_battleImageLock) return;
        const lockedUrl = _battleImageLock;
        _battleImageLock = null;
        // 解除後も同じ画像を維持するため、_lastSentKeywordImage に固定
        if (lockedUrl) {
            _lastSentKeywordImage = lockedUrl;
        }
        console.log(`[ImageDisplay] 🔓 バトル背景画像ロックを解除（画像維持: ${lockedUrl}）`);
    }
    
    function invalidateMatchCache() {
        lastMatchCache = { signature: null, url: null, timestamp: 0 };
    }

    function invalidateSortedEntriesCache() {
        sortedKeywordEntriesCache = null;
        sortedKeywordEntriesCacheSource = null;
    }

    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    function hexToRgbString(hex) {
        if (!hex || typeof hex !== 'string') return '0, 0, 0';
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (!m) return '0, 0, 0';
        return `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}`;
    }

    function getTextStylingLayoutMode() {
        try {
            const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
            const ts = context?.extensionSettings?.text_styling;
            return ts?.layoutMode || null;
        } catch (e) { return null; }
    }

    const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'mp4', 'webm'];

    function isVideoUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return !!url.match(/\.(mp4|webm)$/i);
    }

    async function detectImageExtension(imagePath) {
        if (!imagePath || typeof imagePath !== 'string' || !imagePath.trim()) return null;
        const cleanPath = imagePath.trim();
        if (cleanPath.match(/\.(png|jpg|jpeg|webp|gif|avif|bmp|mp4|webm)$/i)) return cleanPath;
        for (const ext of ALLOWED_EXTENSIONS) {
            const p = `${cleanPath}.${ext}`;
            if (await checkMediaExists(p)) return p;
        }
        return null;
    }

    function checkMediaExists(mediaUrl) {
        if (!mediaUrl || typeof mediaUrl !== 'string' || !mediaUrl.trim()) return Promise.resolve(false);
        const cleanUrl = mediaUrl.trim();
        if (mediaExistsCache.has(cleanUrl)) return Promise.resolve(mediaExistsCache.get(cleanUrl));
        return new Promise((resolve) => {
            if (isVideoUrl(cleanUrl)) {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.onloadedmetadata = () => { mediaExistsCache.set(cleanUrl, true); resolve(true); };
                video.onerror = () => { mediaExistsCache.set(cleanUrl, false); resolve(false); };
                video.src = cleanUrl;
            } else {
                const img = new Image();
                img.onload = () => { mediaExistsCache.set(cleanUrl, true); resolve(true); };
                img.onerror = () => { mediaExistsCache.set(cleanUrl, false); resolve(false); };
                img.src = cleanUrl;
            }
        });
    }

    async function detectImageMapExtensions(imageMap) {
        if (!imageMap) return imageMap;
        const detectedMap = {};
        for (const [key, value] of Object.entries(imageMap)) {
            if (Array.isArray(value)) {
                const arr = [];
                for (const p of value) { const d = await detectImageExtension(p); if (d) arr.push(d); }
                detectedMap[key] = arr.length > 0 ? arr : value;
            } else if (typeof value === 'string') {
                const d = await detectImageExtension(value);
                detectedMap[key] = d || value;
            } else { detectedMap[key] = value; }
        }
        return detectedMap;
    }

    function preloadCharacterImages(imageMap) {
        if (!imageMap) return;
        const urls = new Set();
        for (const [key, value] of Object.entries(imageMap)) {
            if (key === 'thumbnail') continue;
            if (Array.isArray(value)) value.forEach(u => { if (typeof u === 'string' && u.trim()) urls.add(u.trim()); });
            else if (typeof value === 'string' && value.trim()) urls.add(value.trim());
        }
        urls.forEach(url => {
            // ★ 動画はプリロードしない（クリック時に初めて読み込む）
            if (isVideoUrl(url)) return;
            const img = new Image();
            img.src = url;
        });
    }

    (function removeSheldHeader() {
        try {
            const sh = document.getElementById('sheldheader');
            if (sh && sh.parentNode) sh.parentNode.removeChild(sh);
        } catch (e) { /* ignore */ }
        if (!document.getElementById('idp-hide-sheldheader-css')) {
            const style = document.createElement('style');
            style.id = 'idp-hide-sheldheader-css';
            style.textContent = `#sheldheader { display: none !important; }`;
            document.head.appendChild(style);
        }
    })();

    // ============================================================
    // #top-bar / #top-settings-holder: 常時表示・背景透過
    //   ★ WIDrawerIcon の stale な openIcon / drawerPinnedOpen 状態を視覚的に矯正
    // ============================================================
    (function injectTopBarCSS() {
        if (document.getElementById('idp-topbar-extra-css')) return;
        const style = document.createElement('style');
        style.id = 'idp-topbar-extra-css';
        style.textContent = `
            /* 常時表示 */
            #top-bar, #top-settings-holder {
                opacity: 1 !important;
            }
            /* #top-bar のみ pointer-events を明示 */
            #top-bar {
                pointer-events: auto !important;
                transition: background-color 0.2s ease, box-shadow 0.2s ease !important;
            }
            /* #top-settings-holder は CSS で背景透過のみ。pointer-events は触らない */
            #top-settings-holder {
                background-color: transparent !important;
                background-image: none !important;
                backdrop-filter: none !important;
                -webkit-backdrop-filter: none !important;
            }

            /* ── 全ドロワーアイコンを常時ほぼ透明に ── */
            .drawer-icon.closedIcon,
            .drawer-icon.openIcon {
                opacity: 0.01 !important;
                transition: opacity 0.15s ease !important;
            }

            /* ── #top-bar ホバー判定が有効な時は 0.4 に ── */
            body.top-bar-hover .drawer-icon.closedIcon,
            body.top-bar-hover .drawer-icon.openIcon {
                opacity: 0.4 !important;
            }

            /* ── 個別アイコンにマウスが乗った時は完全不透明 ── */
            body.top-bar-hover .drawer-icon.closedIcon:hover,
            body.top-bar-hover .drawer-icon.openIcon:hover {
                opacity: 1 !important;
            }
        `;
        document.head.appendChild(style);
    })();

    (function injectHeaderExtraCSS() {
        if (document.getElementById('image-display-header-extra-css')) return;
        const style = document.createElement('style');
        style.id = 'image-display-header-extra-css';
        style.textContent = `
            #image-display-container { position: absolute; z-index: ${Z_INDEX_BODY} !important; }
            #image-display-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                gap: 6px !important; padding: 0 8px !important; box-sizing: border-box !important;
                height: ${HEADER_HEIGHT}px !important; min-height: ${HEADER_HEIGHT}px !important; max-height: ${HEADER_HEIGHT}px !important;
                overflow: visible !important; position: fixed !important; z-index: ${Z_INDEX_HEADER_DEFAULT} !important;
                background-color: #333 !important; color: #fff !important; border-bottom: 1px solid #555 !important;
                cursor: grab; user-select: none !important; opacity: 0 !important; pointer-events: none !important;
                transition: opacity 0.15s ease !important;
            }
            #image-display-header.idp-visible { opacity: 1 !important; pointer-events: auto !important; }
            #image-display-title { flex: 1 1 auto !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; min-width: 0 !important; pointer-events: none !important; font-size: 13px !important; font-weight: bold !important; }
            #image-display-header-controls { flex: 0 0 auto !important; display: flex !important; align-items: center !important; gap: 4px !important; pointer-events: auto !important; z-index: 4 !important; position: relative !important; }
            #bg-color-picker, #image-display-restore-btn, #image-display-maximize-btn { pointer-events: auto !important; z-index: 5 !important; position: relative !important; }
            #bg-color-picker { width: 22px !important; height: 22px !important; padding: 0 !important; border: 1px solid #888 !important; border-radius: 3px !important; cursor: pointer !important; box-sizing: border-box !important; flex: 0 0 auto !important; background-color: transparent !important; }
            #image-display-restore-btn, #image-display-maximize-btn {
                width: 22px !important; height: 22px !important; padding: 0 !important; background-color: #444 !important;
                color: #fff !important; border: 1px solid #666 !important; border-radius: 3px !important; cursor: pointer !important;
                font-size: 13px !important; line-height: 1 !important; display: flex !important; align-items: center !important;
                justify-content: center !important; box-sizing: border-box !important; flex: 0 0 auto !important; user-select: none !important;
            }
            #image-display-restore-btn:hover, #image-display-maximize-btn:hover { background-color: #666 !important; }
            #image-display-restore-btn.size-btn-disabled, #image-display-maximize-btn.size-btn-disabled { opacity: 0.3 !important; cursor: not-allowed !important; pointer-events: none !important; }
        `;
        document.head.appendChild(style);
    })();

    (function injectChatHeaderCSS() {
        if (document.getElementById('idp-chat-header-css')) return;
        const style = document.createElement('style');
        style.id = 'idp-chat-header-css';
        style.textContent = `
            #sheld.idp-chat-explicit,
            #sheld.idp-chat-maximized {
                display: flex !important;
                flex-direction: column !important;
                padding: ${CHAT_HEADER_HEIGHT}px 0 0 0 !important;
                box-sizing: border-box !important;
            }
            #sheld.idp-chat-explicit {
                position: fixed !important;
                inset: auto !important;
                left: var(--idp-chat-left, 100px) !important;
                top: var(--idp-chat-top, 100px) !important;
                right: auto !important; bottom: auto !important;
                width: var(--idp-chat-width, 50vw) !important;
                height: var(--idp-chat-height, 100vh) !important;
                margin: 0 !important; resize: none !important;
                max-width: none !important; max-height: none !important;
            }
            #sheld.idp-chat-maximized {
                position: fixed !important;
                inset: auto !important;
                left: 0 !important; top: 0 !important;
                right: auto !important; bottom: auto !important;
                width: 100vw !important; height: 100vh !important;
                margin: 0 !important; resize: none !important;
                max-width: none !important; max-height: none !important;
            }
            #sheld.idp-chat-explicit #chat,
            #sheld.idp-chat-maximized #chat {
                flex: 1 1 auto !important;
                min-height: 0 !important;
                min-width: 0 !important;
                position: static !important;
                inset: auto !important;
                width: 100% !important;
                max-width: none !important;
                padding: 0 !important;
                padding-left: 0 !important;
                padding-right: 0 !important;
                margin: 0 !important;
                overflow-y: auto !important;
                box-sizing: border-box !important;
                z-index: 1 !important;
            }
            #sheld.idp-chat-explicit #form_sheld {
                flex: 0 0 auto !important;
                position: static !important;
                inset: auto !important;
                width: 100% !important;
                max-width: none !important;
                padding-left: 0 !important;
                padding-right: 0 !important;
                margin: 0 !important;
                box-sizing: border-box !important;
                z-index: 2 !important;
            }
            #sheld.idp-chat-maximized #form_sheld {
                flex: 0 0 auto !important;
                position: static !important;
                inset: auto !important;
                width: 100% !important;
                max-width: var(--idp-form-max-width, 100%) !important;
                min-width: 0 !important;
                padding-left: 0 !important;
                padding-right: 0 !important;
                margin: 0 auto !important;
                box-sizing: border-box !important;
                z-index: 2 !important;
                align-self: center !important;
            }

            #idp-chat-window-header {
                display: flex !important; align-items: center !important; justify-content: space-between !important;
                gap: 6px !important; padding: 0 8px !important; box-sizing: border-box !important;
                height: ${CHAT_HEADER_HEIGHT}px !important; min-height: ${CHAT_HEADER_HEIGHT}px !important; max-height: ${CHAT_HEADER_HEIGHT}px !important;
                overflow: visible !important; position: fixed !important;
                background-color: #333 !important; color: #fff !important; border-bottom: 1px solid #555 !important;
                cursor: grab; user-select: none !important; opacity: 0 !important; pointer-events: none !important;
                transition: opacity 0.15s ease !important; z-index: ${Z_INDEX_HEADER_DEFAULT} !important;
                -webkit-user-drag: none !important; touch-action: none !important;
            }
            #idp-chat-window-header.idp-visible { opacity: 1 !important; pointer-events: auto !important; }
            #idp-chat-window-title { flex: 1 1 auto !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; min-width: 0 !important; pointer-events: none !important; font-size: 13px !important; font-weight: bold !important; }
            #idp-chat-window-controls { flex: 0 0 auto !important; display: flex !important; align-items: center !important; gap: 4px !important; pointer-events: auto !important; z-index: 4 !important; position: relative !important; }
            #idp-chat-color-picker, #idp-chat-restore-btn, #idp-chat-maximize-btn { pointer-events: auto !important; z-index: 5 !important; position: relative !important; }
            #idp-chat-color-picker { width: 22px !important; height: 22px !important; padding: 0 !important; border: 1px solid #888 !important; border-radius: 3px !important; cursor: pointer !important; box-sizing: border-box !important; flex: 0 0 auto !important; background-color: transparent !important; }
            #idp-chat-restore-btn, #idp-chat-maximize-btn {
                width: 22px !important; height: 22px !important; padding: 0 !important; background-color: #444 !important;
                color: #fff !important; border: 1px solid #666 !important; border-radius: 3px !important; cursor: pointer !important;
                font-size: 13px !important; line-height: 1 !important; display: flex !important; align-items: center !important;
                justify-content: center !important; box-sizing: border-box !important; flex: 0 0 auto !important; user-select: none !important;
            }
            #idp-chat-restore-btn:hover, #idp-chat-maximize-btn:hover { background-color: #666 !important; }
            #idp-chat-restore-btn.size-btn-disabled, #idp-chat-maximize-btn.size-btn-disabled { opacity: 0.3 !important; cursor: not-allowed !important; pointer-events: none !important; }
            #idp-chat-resize-handle {
                position: fixed !important; width: 20px !important; height: 20px !important; background: #666 !important;
                cursor: nwse-resize !important; border-radius: 3px 0 0 0 !important; z-index: 14999 !important;
                display: none !important; box-shadow: -1px -1px 2px rgba(0,0,0,0.2) !important; touch-action: none !important;
            }
            #idp-chat-resize-handle.idp-visible { display: block !important; }
        `;
        document.head.appendChild(style);
    })();

    const imageContainer = document.createElement('div');
    imageContainer.id = 'image-display-container';
    imageContainer.style.setProperty('z-index', Z_INDEX_BODY, 'important');
    document.body.appendChild(imageContainer);

    const header = document.createElement('div');
    header.id = 'image-display-header';
    document.body.appendChild(header);

    const titleSpan = document.createElement('span');
    titleSpan.id = 'image-display-title';
    titleSpan.textContent = 'メディア表示エリア (ドラッグで移動)';
    header.appendChild(titleSpan);

    const headerControls = document.createElement('div');
    headerControls.id = 'image-display-header-controls';
    header.appendChild(headerControls);

    const colorPicker = document.createElement('input');
    colorPicker.type = 'color';
    colorPicker.id = 'bg-color-picker';
    colorPicker.value = DEFAULT_BG_COLOR;
    colorPicker.title = '背景色を変更';
    headerControls.appendChild(colorPicker);

    const restoreSizeBtn = document.createElement('button');
    restoreSizeBtn.id = 'image-display-restore-btn';
    restoreSizeBtn.type = 'button';
    restoreSizeBtn.textContent = '❐';
    restoreSizeBtn.title = '元のサイズと位置に戻す';
    headerControls.appendChild(restoreSizeBtn);

    const maximizeSizeBtn = document.createElement('button');
    maximizeSizeBtn.id = 'image-display-maximize-btn';
    maximizeSizeBtn.type = 'button';
    maximizeSizeBtn.textContent = '⛶';
    maximizeSizeBtn.title = '最大化';
    headerControls.appendChild(maximizeSizeBtn);

    [headerControls, colorPicker, restoreSizeBtn, maximizeSizeBtn].forEach(el => {
        el.addEventListener('mousedown', (e) => e.stopPropagation());
        el.addEventListener('pointerdown', (e) => e.stopPropagation());
    });

    const mediaContainer = document.createElement('div');
    mediaContainer.id = 'media-element-container';
    mediaContainer.style.width = '100%';
    mediaContainer.style.height = '100%';
    imageContainer.appendChild(mediaContainer);

    const resizeHandle = document.createElement('div');
    resizeHandle.id = 'resize-handle';
    imageContainer.appendChild(resizeHandle);

    const controlContainer = document.createElement('div');
    controlContainer.id = 'image-control-container';
    document.body.appendChild(controlContainer);

    const customButton = document.createElement('button');
    customButton.id = 'custom-button';
    customButton.textContent = '手動';

    const maximizeButton = document.createElement('button');
    maximizeButton.id = 'maximize-button';
    maximizeButton.textContent = 'フル';
    maximizeButton.classList.add('enabled');

    const halfMaximizeButton = document.createElement('button');
    halfMaximizeButton.id = 'half-maximize-button';
    halfMaximizeButton.textContent = '左半分';
    halfMaximizeButton.classList.add('enabled');

    const customWindow = document.createElement('div');
    customWindow.id = 'custom-window';
    customWindow.innerHTML = `
        <h3>位置・サイズの設定</h3>
        <label>幅 (px): <input type="number" id="custom-width" min="100"></label>
        <label>高さ (px): <input type="number" id="custom-height" min="100"></label>
        <label>X位置 (px): <input type="number" id="custom-left"></label>
        <label>Y位置 (px): <input type="number" id="custom-top"></label>
        <button class="close-button" id="close-custom-window">閉じる</button>
    `;
    document.body.appendChild(customWindow);

    const chatHeader = document.createElement('div');
    chatHeader.id = 'idp-chat-window-header';
    chatHeader.setAttribute('draggable', 'false');
    document.body.appendChild(chatHeader);

    const chatTitle = document.createElement('span');
    chatTitle.id = 'idp-chat-window-title';
    chatTitle.textContent = 'チャットウインドウ (ドラッグで移動)';
    chatHeader.appendChild(chatTitle);

    const chatControls = document.createElement('div');
    chatControls.id = 'idp-chat-window-controls';
    chatHeader.appendChild(chatControls);

    const chatColorPicker = document.createElement('input');
    chatColorPicker.type = 'color';
    chatColorPicker.id = 'idp-chat-color-picker';
    chatColorPicker.value = '#000000';
    chatColorPicker.title = 'チャット背景色を変更';
    chatControls.appendChild(chatColorPicker);

    const chatRestoreBtn = document.createElement('button');
    chatRestoreBtn.id = 'idp-chat-restore-btn';
    chatRestoreBtn.type = 'button';
    chatRestoreBtn.textContent = '❐';
    chatRestoreBtn.title = '元のサイズと位置に戻す';
    chatControls.appendChild(chatRestoreBtn);

    const chatMaximizeBtn = document.createElement('button');
    chatMaximizeBtn.id = 'idp-chat-maximize-btn';
    chatMaximizeBtn.type = 'button';
    chatMaximizeBtn.textContent = '⛶';
    chatMaximizeBtn.title = '最大化';
    chatControls.appendChild(chatMaximizeBtn);

    [chatControls, chatColorPicker, chatRestoreBtn, chatMaximizeBtn].forEach(el => {
        el.addEventListener('mousedown', (e) => e.stopPropagation());
        el.addEventListener('pointerdown', (e) => e.stopPropagation());
    });

    const chatResizeHandle = document.createElement('div');
    chatResizeHandle.id = 'idp-chat-resize-handle';
    document.body.appendChild(chatResizeHandle);

    // ============================================================
    // ★ #top-bar のみ背景をインライン !important で強制適用
    //    #top-settings-holder には一切触らない
    // ============================================================
    let _lastTopBarBgHover = null;
    function applyTopBarBackground(isHover) {
        const topBar = document.getElementById('top-bar');
        if (!topBar) return;

        const hover = !!isHover;
        _lastTopBarBgHover = hover;

        const bgColor = hover ? 'rgb(23, 23, 23)' : 'rgba(23, 23, 23, 0)';
        topBar.style.setProperty('background-color', bgColor, 'important');
        topBar.style.setProperty('background-image', 'none', 'important');
        topBar.style.setProperty('box-shadow', '0 2px 20px 0 rgba(0, 0, 0, 0)', 'important');
        topBar.style.setProperty('backdrop-filter', 'none', 'important');
        topBar.style.setProperty('-webkit-backdrop-filter', 'none', 'important');
    }

    // ============================================================
    // #top-bar 近接検出
    // ============================================================
    function setupTopBarHover() {
        const TOP_BAR_HOVER_MARGIN = 20;
        let _isHover = false;
        let _lastX = -1, _lastY = -1;

        function update(x, y) {
            const topBar = document.getElementById('top-bar');
            if (!topBar) return;

            if (x < 0 || y < 0) {
                if (_isHover) {
                    _isHover = false;
                    document.body.classList.remove('top-bar-hover');
                }
                applyTopBarBackground(_isHover);
                return;
            }

            const rect = topBar.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;

            const inside =
                x >= rect.left - TOP_BAR_HOVER_MARGIN && x <= rect.right + TOP_BAR_HOVER_MARGIN &&
                y >= rect.top - TOP_BAR_HOVER_MARGIN && y <= rect.bottom + TOP_BAR_HOVER_MARGIN;

            if (inside !== _isHover) {
                _isHover = inside;
                document.body.classList.toggle('top-bar-hover', inside);
            }
            applyTopBarBackground(_isHover);
        }

        document.addEventListener('mousemove', (e) => {
            _lastX = e.clientX;
            _lastY = e.clientY;
            update(_lastX, _lastY);
        }, { passive: true });

        document.addEventListener('mouseleave', () => {
            _lastX = -1; _lastY = -1;
            update(-1, -1);
        });

        window.addEventListener('blur', () => {
            _lastX = -1; _lastY = -1;
            update(-1, -1);
        });

        applyTopBarBackground(false);
        setInterval(() => {
            if (_lastX >= 0) update(_lastX, _lastY);
            else applyTopBarBackground(_isHover);
        }, 150);

        console.log(`[ImageDisplay] #top-bar hover 検出を開始しました (margin=${TOP_BAR_HOVER_MARGIN}px)`);
    }

    setupTopBarHover();

    function getTopBarZIndex() {
        const topBar = document.getElementById('top-bar');
        if (!topBar) return NaN;
        try {
            const z = parseInt(window.getComputedStyle(topBar).zIndex, 10);
            return Number.isFinite(z) ? z : NaN;
        } catch (e) { return NaN; }
    }

    function applyHeaderZIndex() {
        if (!header) return;
        const topBarZ = getTopBarZIndex();
        let headerZ = parseInt(Z_INDEX_HEADER_DEFAULT, 10);
        if (Number.isFinite(topBarZ) && topBarZ > 1) headerZ = Math.max(500, topBarZ - 1);
        header.style.setProperty('z-index', String(headerZ), 'important');
    }

    function applyChatHeaderZIndex() {
        if (!chatHeader) return;
        const topBarZ = getTopBarZIndex();
        let headerZ = parseInt(Z_INDEX_HEADER_DEFAULT, 10);
        if (Number.isFinite(topBarZ) && topBarZ > 1) headerZ = Math.max(500, topBarZ - 1);
        chatHeader.style.setProperty('z-index', String(headerZ), 'important');
    }

    function shouldShowHeader() { return isCustomWindowOpen === true; }

    function setHeaderVisible(visible) {
        if (!header) return;
        if (headerVisible === visible) return;
        headerVisible = visible;
        header.classList.toggle('idp-visible', visible);
    }

    function syncHeaderVisibility() { setHeaderVisible(shouldShowHeader()); }

    function syncChatHeaderVisibility() {
        const visible = isCustomWindowOpen === true;
        if (chatHeader) chatHeader.classList.toggle('idp-visible', visible);
        if (chatResizeHandle) chatResizeHandle.classList.toggle('idp-visible', visible && chatCurrentMode === 'normal');
    }

    function syncHeaderPosition() {
        if (!imageContainer || !header) return;
        if (currentMode === 'maximized') {
            header.style.setProperty('left', '0', 'important');
            header.style.setProperty('top', '0', 'important');
            header.style.setProperty('width', '100vw', 'important');
            header.style.setProperty('height', HEADER_HEIGHT + 'px', 'important');
            header.style.setProperty('position', 'fixed', 'important');
            applyHeaderZIndex();
            return;
        }
        if (currentMode === 'halfMaximized') {
            header.style.setProperty('left', '0', 'important');
            header.style.setProperty('top', '0', 'important');
            header.style.setProperty('width', '50vw', 'important');
            header.style.setProperty('height', HEADER_HEIGHT + 'px', 'important');
            header.style.setProperty('position', 'fixed', 'important');
            applyHeaderZIndex();
            return;
        }
        const rect = imageContainer.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        header.style.setProperty('left', Math.round(rect.left) + 'px', 'important');
        header.style.setProperty('top', Math.round(rect.top) + 'px', 'important');
        header.style.setProperty('width', Math.round(rect.width) + 'px', 'important');
        header.style.setProperty('height', HEADER_HEIGHT + 'px', 'important');
        header.style.setProperty('position', 'fixed', 'important');
        applyHeaderZIndex();
    }

    function syncChatHeaderPosition() {
        if (!chatHeader) return;
        const sheld = document.getElementById('sheld');
        if (!sheld) return;

        let left, top, width;
        const isExplicit = sheld.classList.contains('idp-chat-explicit');
        const isMaximized = sheld.classList.contains('idp-chat-maximized');

        if (isExplicit || isMaximized) {
            const chatEl = document.getElementById('chat');
            if (chatEl) {
                const chatRect = chatEl.getBoundingClientRect();
                if (chatRect.width > 0 && chatRect.height > 0) {
                    left = chatRect.left;
                    top = chatRect.top - CHAT_HEADER_HEIGHT;
                    width = chatRect.width;
                }
            }
        }
        if (left === undefined) {
            const sheldRect = sheld.getBoundingClientRect();
            if (sheldRect.width <= 0 || sheldRect.height <= 0) return;
            left = sheldRect.left; top = sheldRect.top; width = sheldRect.width;
        }
        chatHeader.style.setProperty('left', Math.round(left) + 'px', 'important');
        chatHeader.style.setProperty('top', Math.round(top) + 'px', 'important');
        chatHeader.style.setProperty('width', Math.round(width) + 'px', 'important');
        chatHeader.style.setProperty('height', CHAT_HEADER_HEIGHT + 'px', 'important');
        chatHeader.style.setProperty('position', 'fixed', 'important');
        applyChatHeaderZIndex();
    }

    function syncChatResizeHandlePosition() {
        if (!chatResizeHandle) return;
        const sheld = document.getElementById('sheld');
        if (!sheld) return;
        const rect = sheld.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        chatResizeHandle.style.setProperty('left', Math.round(rect.right - 20) + 'px', 'important');
        chatResizeHandle.style.setProperty('top', Math.round(rect.bottom - 20) + 'px', 'important');
    }

    function ensureChatExplicitPosition() {
        const sheld = document.getElementById('sheld');
        if (!sheld) return;
        if (!chatPreState) {
            const rect = sheld.getBoundingClientRect();
            chatPreState = { width: rect.width, height: rect.height, left: rect.left, top: rect.top };
        }
        sheld.style.setProperty('--idp-chat-left', Math.round(chatPreState.left) + 'px');
        sheld.style.setProperty('--idp-chat-top', Math.round(chatPreState.top) + 'px');
        sheld.style.setProperty('--idp-chat-width', Math.round(chatPreState.width) + 'px');
        sheld.style.setProperty('--idp-chat-height', Math.round(chatPreState.height) + 'px');
        sheld.classList.remove('idp-chat-maximized');
        sheld.classList.add('idp-chat-explicit');
        sheld.dataset.idpChatExplicit = 'true';
    }

    function updateChatSizeButtons() {
        if (!chatRestoreBtn || !chatMaximizeBtn) return;
        chatRestoreBtn.classList.remove('size-btn-disabled');
        chatMaximizeBtn.classList.remove('size-btn-disabled');
        if (chatCurrentMode === 'normal') chatRestoreBtn.classList.add('size-btn-disabled');
        else if (chatCurrentMode === 'maximized') chatMaximizeBtn.classList.add('size-btn-disabled');
    }

    function applyChatNormalState() {
        const sheld = document.getElementById('sheld');
        if (!sheld || !chatPreState) return;
        sheld.classList.remove('idp-chat-maximized');
        sheld.style.removeProperty('--idp-form-max-width');
        sheld.style.setProperty('--idp-chat-left', Math.round(chatPreState.left) + 'px');
        sheld.style.setProperty('--idp-chat-top', Math.round(chatPreState.top) + 'px');
        sheld.style.setProperty('--idp-chat-width', Math.round(chatPreState.width) + 'px');
        sheld.style.setProperty('--idp-chat-height', Math.round(chatPreState.height) + 'px');
        sheld.classList.add('idp-chat-explicit');
        chatCurrentMode = 'normal';
        updateChatSizeButtons();
        syncChatHeaderPosition();
        syncChatResizeHandlePosition();
        syncChatHeaderVisibility();
        try { window.dispatchEvent(new Event('resize')); } catch (e) { /* ignore */ }
    }

    function applyChatMaximizedState() {
        const sheld = document.getElementById('sheld');
        if (!sheld) return;
        if (chatCurrentMode === 'normal') ensureChatExplicitPosition();

        const formSheld = document.getElementById('form_sheld');
        if (formSheld) {
            const w = Math.round(formSheld.getBoundingClientRect().width);
            if (w > 0) {
                sheld.style.setProperty('--idp-form-max-width', w + 'px');
            } else if (chatPreState) {
                sheld.style.setProperty('--idp-form-max-width', Math.round(chatPreState.width) + 'px');
            }
        }

        sheld.classList.remove('idp-chat-explicit');
        sheld.classList.add('idp-chat-maximized');
        chatCurrentMode = 'maximized';
        updateChatSizeButtons();
        syncChatHeaderPosition();
        syncChatResizeHandlePosition();
        syncChatHeaderVisibility();
        try { window.dispatchEvent(new Event('resize')); } catch (e) { /* ignore */ }
    }

    function isOnChatHeaderControl(e) {
        const target = e.target;
        if (target && target.closest) {
            if (target.closest('#idp-chat-window-controls') ||
                target.closest('#idp-chat-color-picker') ||
                target.closest('#idp-chat-restore-btn') ||
                target.closest('#idp-chat-maximize-btn')) return true;
        }
        const path = e.composedPath ? e.composedPath() : [];
        return path.some(el => el && el.id && [
            'idp-chat-window-controls', 'idp-chat-color-picker',
            'idp-chat-restore-btn', 'idp-chat-maximize-btn'
        ].includes(el.id));
    }

    chatColorPicker.addEventListener('input', () => {
        const hex = chatColorPicker.value;
        const rgb = hexToRgbString(hex);
        document.documentElement.style.setProperty('--chat-bg-rgb', rgb);
        try {
            const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
            if (context?.extensionSettings?.[MODULE_NAME]) {
                context.extensionSettings[MODULE_NAME].chatBgColor = hex;
                if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
            }
        } catch (e) { /* ignore */ }
    });

    chatRestoreBtn.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        if (chatCurrentMode === 'normal') return;
        applyChatNormalState();
        saveDisplayState();
    });

    chatMaximizeBtn.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        if (chatCurrentMode === 'maximized') return;
        applyChatMaximizedState();
        saveDisplayState();
    });

    function startChatDrag(e) {
        if (isDraggingChat) return;
        if (e.button !== undefined && e.button !== 0) return;
        if (isOnChatHeaderControl(e)) return;
        if (chatCurrentMode !== 'normal') return;
        ensureChatExplicitPosition();
        const sheld = document.getElementById('sheld');
        if (!sheld) return;
        const rect = sheld.getBoundingClientRect();
        isDraggingChat = true;
        chatDragOffsetX = e.clientX - rect.left;
        chatDragOffsetY = e.clientY - rect.top;
        chatHeader.style.cursor = 'grabbing';
        try {
            if (e.pointerId !== undefined && chatHeader.setPointerCapture) chatHeader.setPointerCapture(e.pointerId);
        } catch (err) { /* ignore */ }
    }

    chatHeader.addEventListener('pointerdown', (e) => { if (e.button === 0) startChatDrag(e); });
    chatHeader.addEventListener('mousedown', (e) => { if (e.button === 0) startChatDrag(e); });

    function handleChatDragMove(e) {
        if (!isDraggingChat) return;
        const sheld = document.getElementById('sheld');
        if (!sheld) return;
        sheld.style.setProperty('--idp-chat-left', Math.round(e.clientX - chatDragOffsetX) + 'px');
        sheld.style.setProperty('--idp-chat-top', Math.round(e.clientY - chatDragOffsetY) + 'px');
        syncChatHeaderPosition();
        syncChatResizeHandlePosition();
        try { window.dispatchEvent(new Event('resize')); } catch (err) { /* ignore */ }
    }

    function stopChatDrag(e) {
        if (!isDraggingChat) return;
        isDraggingChat = false;
        chatHeader.style.cursor = 'grab';
        try {
            if (e && e.pointerId !== undefined && chatHeader.releasePointerCapture) chatHeader.releasePointerCapture(e.pointerId);
        } catch (err) { /* ignore */ }
        if (chatPreState) {
            const sheld = document.getElementById('sheld');
            if (sheld) {
                const l = parseInt(sheld.style.getPropertyValue('--idp-chat-left'), 10);
                const t = parseInt(sheld.style.getPropertyValue('--idp-chat-top'), 10);
                if (Number.isFinite(l)) chatPreState.left = l;
                if (Number.isFinite(t)) chatPreState.top = t;
            }
        }
        saveDisplayState();
    }

    document.addEventListener('pointermove', handleChatDragMove);
    document.addEventListener('pointerup', stopChatDrag);
    document.addEventListener('mousemove', handleChatDragMove);
    document.addEventListener('mouseup', stopChatDrag);

    chatResizeHandle.addEventListener('mousedown', (e) => {
        if (chatCurrentMode !== 'normal') return;
        e.stopPropagation(); e.preventDefault();
        ensureChatExplicitPosition();
        const sheld = document.getElementById('sheld');
        if (!sheld) return;
        isResizingChat = true;
        chatResizeStartX = e.clientX;
        chatResizeStartY = e.clientY;
        chatResizeStartW = sheld.offsetWidth;
        chatResizeStartH = sheld.offsetHeight;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizingChat) return;
        const sheld = document.getElementById('sheld');
        if (!sheld) return;
        const newW = Math.max(200, chatResizeStartW + (e.clientX - chatResizeStartX));
        const newH = Math.max(150, chatResizeStartH + (e.clientY - chatResizeStartY));
        sheld.style.setProperty('--idp-chat-width', newW + 'px');
        sheld.style.setProperty('--idp-chat-height', newH + 'px');
        syncChatHeaderPosition();
        syncChatResizeHandlePosition();
        try { window.dispatchEvent(new Event('resize')); } catch (err) { /* ignore */ }
    });

    document.addEventListener('mouseup', () => {
        if (!isResizingChat) return;
        isResizingChat = false;
        if (chatPreState) {
            const sheld = document.getElementById('sheld');
            if (sheld) {
                const w = parseInt(sheld.style.getPropertyValue('--idp-chat-width'), 10);
                const h = parseInt(sheld.style.getPropertyValue('--idp-chat-height'), 10);
                if (Number.isFinite(w)) chatPreState.width = w;
                if (Number.isFinite(h)) chatPreState.height = h;
            }
        }
        saveDisplayState();
    });

    // 条件評価・キーワードロジック
    function normalizeConditionExpression(expr) {
        if (!expr || typeof expr !== 'string') return '';
        return expr.replace(/\band\b/gi, '+').replace(/\bor\b/gi, ',').replace(/\bnot\b/gi, '!');
    }

    function tokenizeCondition(expr) {
        const tokens = [];
        let i = 0;
        const len = expr.length;
        while (i < len) {
            const ch = expr[i];
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
            if (ch === '(' || ch === ')' || ch === '!' || ch === '+' || ch === ',') {
                tokens.push({ type: ch, value: ch }); i++; continue;
            }
            let j = i;
            while (j < len && !'()!+,'.includes(expr[j])) j++;
            const raw = expr.slice(i, j).trim();
            if (raw) tokens.push({ type: 'KEYWORD', value: raw });
            i = j > i ? j : i + 1;
        }
        return tokens;
    }

    function parseConditionTokens(tokens) {
        let pos = 0;
        const peek = () => tokens[pos];
        const consume = (type) => {
            const t = tokens[pos];
            if (t && t.type === type) { pos++; return t; }
            return null;
        };
        function parseOr() {
            let node = parseAnd();
            while (peek() && peek().type === ',') { consume(','); const r = parseAnd(); node = { type: 'OR', left: node, right: r }; }
            return node;
        }
        function parseAnd() {
            let node = parseUnary();
            while (peek() && peek().type === '+') { consume('+'); const r = parseUnary(); node = { type: 'AND', left: node, right: r }; }
            return node;
        }
        function parseUnary() {
            if (peek() && peek().type === '!') { consume('!'); return { type: 'NOT', operand: parseUnary() }; }
            return parsePrimary();
        }
        function parsePrimary() {
            const t = peek();
            if (!t) return null;
            if (t.type === '(') { consume('('); const inner = parseOr(); consume(')'); return inner; }
            if (t.type === 'KEYWORD') { consume('KEYWORD'); return { type: 'KEYWORD', value: t.value }; }
            return null;
        }
        return parseOr();
    }

    function evaluateConditionNode(node, lowerText) {
        if (!node) return false;
        switch (node.type) {
            case 'KEYWORD': return lowerText.includes(node.value.toLowerCase());
            case 'AND': return evaluateConditionNode(node.left, lowerText) && evaluateConditionNode(node.right, lowerText);
            case 'OR': return evaluateConditionNode(node.left, lowerText) || evaluateConditionNode(node.right, lowerText);
            case 'NOT': return !evaluateConditionNode(node.operand, lowerText);
            default: return false;
        }
    }

    function getParsedConditionAst(condStr) {
        if (!condStr || typeof condStr !== 'string') return null;
        let ast = parsedConditionCache.get(condStr);
        if (ast !== undefined) return ast;
        try {
            const normalized = normalizeConditionExpression(condStr);
            const tokens = tokenizeCondition(normalized);
            if (tokens.length === 0) { parsedConditionCache.set(condStr, null); return null; }
            ast = parseConditionTokens(tokens);
            parsedConditionCache.set(condStr, ast);
            return ast;
        } catch (error) { parsedConditionCache.set(condStr, null); return null; }
    }

    function evaluateCondition(condStr, text) {
        if (!condStr || !text) return false;
        try {
            const ast = getParsedConditionAst(condStr);
            if (!ast) return false;
            return evaluateConditionNode(ast, text.toLowerCase());
        } catch (error) { return false; }
    }

    // ★ 合体モードで生成された画像の「未表示マーク」
    //   _getBagState で新規画像のフラグを 0 で開始するために使う。
    const _combinedModeGeneratedSrcs = new Set();

    function markGeneratedButNotShown(fullPath) {
        if (typeof fullPath !== 'string') return;
        const trimmed = fullPath.trim();
        if (!trimmed) return;
        _combinedModeGeneratedSrcs.add(trimmed);
        console.debug(`[ImageDisplay] 🔖 合体モード生成画像をマーク: ${trimmed.split('/').pop()}`);
    }
    
    // ============================================================
    // ★ シャッフルバッグ方式の状態管理
    //   キーワード（または '__default__' などの固定キー）ごとに
    //   「表示済みフラグ」を保持し、未表示の画像だけを候補にする。
    //   - 全て表示済みになったらフラグを全リセット
    //   - 画像リストが増えた場合、新規画像は「表示済み(1)」で開始
    //   - 画像リストが減った場合、消えた画像のフラグは自動的に破棄
    // ============================================================
    const _bagState = new Map();
    
    function _getBagState(key, validSources) {
        const sig = validSources.join('\x1f');
        let state = _bagState.get(key);

        if (!state || state.signature !== sig) {
            const newFlags = new Map();
            if (state) {
                // 配列変更時: 既存画像はフラグを引き継ぎ、新規画像は 1 で開始
                for (const src of validSources) {
                    if (state.flags.has(src)) {
                        newFlags.set(src, state.flags.get(src));
                    } else {
                        // ★ 合体モードで生成された画像は「未表示（0）」で開始
                        //   それ以外（手動追加・背景生成モード）は「既に表示済み（1）」
                        const wasCombined = _combinedModeGeneratedSrcs.has(src);
                        if (wasCombined) {
                            _combinedModeGeneratedSrcs.delete(src);
                        }
                        newFlags.set(src, wasCombined ? 0 : 1);
                    }
                }
            } else {
                // 初回: 全て 0 で開始
                for (const src of validSources) {
                    newFlags.set(src, 0);
                }
            }
            state = { signature: sig, flags: newFlags };
            _bagState.set(key, state);
            _scheduleBagStateSave();   // ★ 配列変更時に永続化
        }
        return state;
    }

    function _resetBagState() {
        const size = _bagState.size;
        _bagState.clear();
        if (size > 0) {
            console.debug(`[ImageDisplay] 🔄 シャッフルバッグ状態をリセット (${size} キー)`);
        }
    }

    // ============================================================
    // ★ シャッフルバッグ状態の永続化
    //   character.data.extensions.image_display_bag_state に保存する。
    //   - フラグ変更時に debounce 保存（即時 in-memory 更新 + 300ms 後 persist）
    //   - beforeunload / pagehide で即時フラッシュ
    //   - キャラ切替時に新キャラの状態を復元
    // ============================================================
    const BAG_STATE_NS = 'image_display_bag_state';
    let _bagStateSaveTimer = null;

    function _serializeBagState() {
        const out = {};
        for (const [key, state] of _bagState.entries()) {
            out[key] = {
                signature: state.signature,
                flags: Object.fromEntries(state.flags),
            };
        }
        return out;
    }

    function _persistBagState() {
        if (_bagStateSaveTimer) {
            clearTimeout(_bagStateSaveTimer);
            _bagStateSaveTimer = null;
        }
        if (_bagState.size === 0) return;

        try {
            const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
            const char = ctx?.characters?.[ctx?.characterId];
            if (!char) return;

            const payload = _serializeBagState();
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};
            char.data.extensions[BAG_STATE_NS] = payload;

            if (window.CharStore?.saveCharacterExtension) {
                window.CharStore.saveCharacterExtension(BAG_STATE_NS, payload);
            }
            console.debug(`[ImageDisplay] 💾 バッグ状態を保存: ${Object.keys(payload).length} キー`);
        } catch (e) {
            console.warn('[ImageDisplay] バッグ状態保存エラー:', e);
        }
    }

    function _scheduleBagStateSave() {
        if (_bagState.size === 0) return;

        // ★ 即時 in-memory 更新（キャラ切替直後でも正しいデータが残る）
        try {
            const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
            const char = ctx?.characters?.[ctx?.characterId];
            if (char) {
                const payload = _serializeBagState();
                if (!char.data) char.data = {};
                if (!char.data.extensions) char.data.extensions = {};
                char.data.extensions[BAG_STATE_NS] = payload;
            }
        } catch (e) { /* ignore */ }

        // ★ debounce で CharStore persist（HTTP リクエスト抑制）
        if (_bagStateSaveTimer) return;
        _bagStateSaveTimer = setTimeout(() => {
            _bagStateSaveTimer = null;
            _persistBagState();
        }, 300);
    }

    function _loadBagStateFromChar() {
        _bagState.clear();
        try {
            const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
            const char = ctx?.characters?.[ctx?.characterId];
            if (!char) return;

            const serialized = char?.data?.extensions?.[BAG_STATE_NS];
            if (!serialized || typeof serialized !== 'object') {
                console.debug('[ImageDisplay] 保存済みバッグ状態なし');
                return;
            }

            for (const [key, data] of Object.entries(serialized)) {
                if (!data || typeof data !== 'object') continue;
                if (typeof data.signature !== 'string') continue;
                if (!data.flags || typeof data.flags !== 'object') continue;
                const flags = new Map();
                for (const [src, flag] of Object.entries(data.flags)) {
                    flags.set(src, flag ? 1 : 0);
                }
                _bagState.set(key, { signature: data.signature, flags });
            }
            console.debug(`[ImageDisplay] 📂 バッグ状態を復元: ${_bagState.size} キー`);
        } catch (e) {
            console.warn('[ImageDisplay] バッグ状態読み込みエラー:', e);
        }
    }

    // beforeunload / pagehide でフラッシュ
    ['beforeunload', 'pagehide'].forEach(evt => {
        window.addEventListener(evt, () => {
            if (_bagState.size > 0) _persistBagState();
        });
    });
    
    function getRandomImageSource(imageSource, keyHint = null) {
        if (Array.isArray(imageSource)) {
            const valid = imageSource.filter(src => typeof src === 'string' && src.trim() !== '');
            if (valid.length === 0) return null;
            if (valid.length === 1) return valid[0];

            const key = keyHint || valid.join('\x1f');
            const state = _getBagState(key, valid);

            // 未表示（flags=0）の画像を候補に
            let candidates = valid.filter(src => state.flags.get(src) === 0);

            // 全画像表示済み → フラグをリセットして最初から
            if (candidates.length === 0) {
                for (const src of valid) {
                    state.flags.set(src, 0);
                }
                candidates = valid;
                _scheduleBagStateSave();   // ★ 全リセット時の永続化
                console.debug(
                    `[ImageDisplay] 🔄 全画像表示済みのためフラグをリセット ` +
                    `(key=${String(key).slice(0, 40)}, count=${valid.length})`
                );
            }

            const picked = candidates[Math.floor(Math.random() * candidates.length)];
            state.flags.set(picked, 1);
            _scheduleBagStateSave();   // ★ 1枚選出時の永続化
            console.debug(
                `[ImageDisplay] 🎲 半ランダム選択: ${picked.split('/').pop()} ` +
                `(未表示 ${candidates.length - 1}/${valid.length})`
            );
            return picked;
        }
        return (typeof imageSource === 'string' && imageSource.trim() !== '') ? imageSource : null;
    }

    function getSortedKeywordEntries() {
        if (!currentImageMap) return [];
        if (sortedKeywordEntriesCache && sortedKeywordEntriesCacheSource === currentImageMap) return sortedKeywordEntriesCache;
        sortedKeywordEntriesCacheSource = currentImageMap;
        sortedKeywordEntriesCache = Object.entries(currentImageMap)
            .filter(([key]) => key !== "default" && key !== "thumbnail")
            .map(([key, url]) => ({
                condition: key, url: url,
                complexity: (key.match(/\band\b/gi) || []).length * 10 + (key.match(/\bor\b/gi) || []).length * 5 +
                    (key.match(/\+/g) || []).length * 8 + (key.match(/,/g) || []).length * 4 +
                    (key.match(/!/g) || []).length * 6 + (key.match(/\(/g) || []).length * 3 +
                    (key.match(/\)/g) || []).length * 3 + key.length
            }))
            .sort((a, b) => b.complexity - a.complexity);
        return sortedKeywordEntriesCache;
    }

    function findMatchingImageUrl(text) {
        if (!text || !currentImageMap) return null;
        const signature = getTextSignature(text);
        const now = Date.now();
        if (lastMatchCache.signature === signature && (now - lastMatchCache.timestamp) < MATCH_CACHE_TTL) return lastMatchCache.url;
        for (const entry of getSortedKeywordEntries()) {
            try {
                if (evaluateCondition(entry.condition, text)) {
                    // ★ キーワードをキーにして独立したバッグを管理
                    const selected = getRandomImageSource(entry.url, `kw::${entry.condition}`);
                    if (selected) { lastMatchCache = { signature, url: selected, timestamp: now }; return selected; }
                }
            } catch (error) { /* ignore */ }
        }
        lastMatchCache = { signature, url: null, timestamp: now };
        return null;
    }

    function findLastKeywordImage() {
        // ★ 常にユーザー発言を監視（合体モード固定）
        const selector = `.mes[is_user="true"] .mes_text`;
        const messages = Array.from(document.querySelectorAll(selector));
        const start = Math.max(0, messages.length - MAX_MESSAGE_SCAN);
        for (let i = messages.length - 1; i >= start; i--) {
            const mediaUrl = findMatchingImageUrl(messages[i].textContent || messages[i].innerText || "");
            if (mediaUrl) return mediaUrl;
        }
        return null;
    }

    // ============================================================
    // ★ サムネイル名 → 元ファイル名 変換
    //   _ext.json に "_img_thum.png" / "_mp4_thum.png" 等が残っている
    //   レガシーデータでも元ファイルを表示できるようにする。
    // ============================================================
    function resolveThumbToOriginal(url) {
        if (!url || typeof url !== 'string') return url;
        const lastSlash = url.lastIndexOf('/');
        const dir = lastSlash >= 0 ? url.slice(0, lastSlash) : '';
        const fileName = lastSlash >= 0 ? url.slice(lastSlash + 1) : url;

        // 動画サムネ: xxx_mp4_thum.png / xxx_webm_thum.png
        const vm = fileName.match(/^(.+)_(mp4|webm)_thum\.png$/i);
        if (vm) {
            const resolved = `${vm[1]}.${vm[2].toLowerCase()}`;
            return dir ? `${dir}/${resolved}` : resolved;
        }

        // 画像サムネ: xxx_img_thum.png
        if (fileName.endsWith('_img_thum.png')) {
            try {
                if (window.GicApi?.resolveOriginalFileName) {
                    const orig = window.GicApi.resolveOriginalFileName(fileName);
                    if (orig) {
                        return dir ? `${dir}/${orig}` : orig;
                    }
                }
            } catch (e) { /* ignore */ }
        }

        return url;
    }    
    
    async function updateImageWithUrl(targetUrl) {
        if (isDefaultImageFailed) {
            const isDefaultRequest = !targetUrl ||
                /(?:^|\/)default\.(png|jpg|jpeg|webp|gif|avif|bmp|mp4|webm)(?:\?|#|$)/i.test(targetUrl) ||
                targetUrl.endsWith('/default');
            if (isDefaultRequest) return;
            isDefaultImageFailed = false;
            mediaContainer.style.removeProperty('display');
        }

        if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.trim()) {
            const fallback = getRandomImageSource(currentImageMap.default, '__default__') || currentImageMap.default;
            if (fallback && fallback !== targetUrl && typeof fallback === 'string' && fallback.trim()) {
                await updateImageWithUrl(fallback);
            }
            return;
        }

        let newUrl = targetUrl.trim();

        // ★ サムネイル名 → 元ファイル名 解決（レガシーデータ対応）
        const resolvedUrl = resolveThumbToOriginal(newUrl);
        if (resolvedUrl !== newUrl) {
            console.log(`[ImageDisplay] 🔍 サムネイル名を解決: ${newUrl} → ${resolvedUrl}`);
            newUrl = resolvedUrl;
        }

        // ★ 最終防衛: パスなし（ファイル名のみ）の場合はキャラフォルダを補完
        //   findMatchingImageUrl → getRandomImageSource の過程で、
        //   image_display_extension 内にファイル名のみのエントリが残っていても
        //   404 にならないよう、ここで最終的に補完する。
        if (!newUrl.includes('/') && !/^(data:|blob:|https?:)/i.test(newUrl)) {
            const charName = getCharacterNameFromDOM();
            if (charName) {
                const before = newUrl;
                newUrl = `user/images/${charName}/${newUrl}`;
                console.log(`[ImageDisplay] 🔧 パスを補完: ${before} → ${newUrl}`);
            }
        }

        // 拡張子チェック
        if (!newUrl.match(/\.(png|jpg|jpeg|webp|gif|avif|bmp|mp4|webm)$/i)) {
            const detected = await detectImageExtension(newUrl);
            if (detected) newUrl = detected;
            else {
                console.log('[ImageDisplay] detectImageExtension で解決できず:', newUrl);
                return;
            }
        }

        if (currentImageUrl === newUrl && mediaContainer.children.length > 0) {
            console.log('[ImageDisplay] 同一URLのため再描画スキップ:', newUrl);
            return;
        }
        currentImageUrl = newUrl;
        // image-display.js の updateImageWithUrl 内、currentImageUrl = newUrl の直後
        try {
            window.dispatchEvent(new CustomEvent('gic-image-display-changed', {
                detail: { url: newUrl }
            }));
        } catch (e) { /* ignore */ }
        

        if (isVideoUrl(newUrl)) {
            const videoElement = document.createElement('video');
            videoElement.src = newUrl;
            videoElement.autoplay = true;
            videoElement.loop = true;
            videoElement.muted = true;
            videoElement.playsInline = true;
            videoElement.preload = 'auto';
            videoElement.style.width = '100%';
            videoElement.style.height = '100%';
            videoElement.style.objectFit = 'contain';
            videoElement.onerror = () => handleMediaError(videoElement, newUrl);
            mediaContainer.innerHTML = '';
            mediaContainer.appendChild(videoElement);
            videoElement.play().catch(() => {});
        } else {
            // ★ GIF は cache-buster で新規ロード（Firefox のキャッシュ済みアニメ停止対策）
            let urlForLoad = newUrl;
            const isGif = /\.gif(\?|#|$)/i.test(newUrl);
            if (isGif) {
                const base = newUrl.split('?')[0].split('#')[0];
                urlForLoad = base + '?_t=' + Date.now();
            }

            console.log('[ImageDisplay] 画像ブランチ:', { resolvedUrl: newUrl, loadUrl: urlForLoad });

            const imgElement = document.createElement('img');
            imgElement.style.width = '100%';
            imgElement.style.height = '100%';
            imgElement.style.objectFit = 'contain';
            imgElement.onerror = () => handleMediaError(imgElement, newUrl);
            imgElement.onload = () => {
                console.log(`[ImageDisplay] img 読み込み成功: ${imgElement.naturalWidth}x${imgElement.naturalHeight} (${urlForLoad.slice(0, 80)})`);
            };
            imgElement.src = urlForLoad;
            mediaContainer.innerHTML = '';
            mediaContainer.appendChild(imgElement);
        }
    }

    async function updateImage() {
        // ★ 合体モード準備中（5秒間）は画像更新をスキップ
        if (window.GicApi?.isCombinedPreparing?.() === true) {
            console.debug('[ImageDisplay] 合体モード準備中のため image 更新をスキップ');
            return;
        }
        // ★ バトルモード中の背景画像ロック
        if (isBattleModeActive()) {
            // バトルモード中: ロックして同じ画像を維持
            if (!_battleImageLock) {
                lockBattleImage();
            }
            if (_battleImageLock && currentImageUrl !== _battleImageLock) {
                await updateImageWithUrl(_battleImageLock);
            }
            console.debug('[ImageDisplay] バトルモード中のため背景画像更新をスキップ');
            return;
        }

        // ★ バトルモード解除を検知したらロックを解放（画像は維持）
        if (_battleImageLock) {
            unlockBattleImage();
            console.debug('[ImageDisplay] バトルモード解除 → 背景画像ロックを解放');
        }

        // ★ isDefaultImageFailed の早期 return を削除
        //   上流で return すると updateImageWithUrl の復帰ロジックに到達できず、
        //   一度 true になると永久に復帰不能になる catch-22 が発生するため。
        //   実際の判定は updateImageWithUrl 内で行う。

        if (_lastSentKeywordImage) {
            if (currentImageUrl !== _lastSentKeywordImage) {
                await updateImageWithUrl(_lastSentKeywordImage);
            }
            return;
        }

        const keywordMedia = findLastKeywordImage();
        let newUrl = keywordMedia || getRandomImageSource(currentImageMap.default) || currentImageMap.default;
        if (!newUrl || typeof newUrl !== 'string' || !newUrl.trim()) return;
        await updateImageWithUrl(newUrl);
    }

    const safeUpdateImage = debounce(() => { updateImage(); }, 50);

    // ============================================================
    // ★ 合体モード: 現在のキーワードに対応する事前登録画像を選んで表示
    //   - _lastSentKeywordImage をクリアしてから最新メッセージを再スキャン
    //   - findLastKeywordImage() で該当キーワードの画像を取得（bag state 経由で半ランダム選択）
    //   - updateImageWithUrl() で即座に表示
    //   - 一致なしの場合はデフォルトへフォールバック
    // ============================================================
    async function pickAndShowCurrentKeyword() {
        _lastSentKeywordImage = null;
        invalidateMatchCache();
        const matchedUrl = findLastKeywordImage();
        if (matchedUrl) {
            _lastSentKeywordImage = matchedUrl;
            return updateImageWithUrl(matchedUrl);
        }
        // ★ マッチなし → デフォルトへフォールバック
        const fallback = getRandomImageSource(currentImageMap.default, '__default__')
            || currentImageMap.default;
        if (fallback && typeof fallback === 'string' && fallback.trim()) {
            console.log(`[ImageDisplay] 一致なし → デフォルトへフォールバック: ${fallback}`);
            return updateImageWithUrl(fallback);
        }
        // デフォルトも無い → 表示クリア
        console.log('[ImageDisplay] 一致なし・デフォルトなし → 表示クリア');
        mediaContainer.innerHTML = '';
        currentImageUrl = null;
        return Promise.resolve();
    }
    
    async function handleMediaError(element, src) {
        if (src && typeof src === 'string' && !src.match(/\.(png|jpg|jpeg|webp|gif|avif|bmp|mp4|webm)$/i)) {
            const detectedPath = await detectImageExtension(src);
            if (detectedPath) { element.src = detectedPath; return; }
        }
        if (src && (src.match(/default\.(png|jpg|jpeg|webp|gif|avif|bmp|mp4|webm)$/i) || src.endsWith('/default'))) {
            isDefaultImageFailed = true;
            mediaContainer.style.display = 'none';
        } else {
            const fallback = getRandomImageSource(currentImageMap.default, '__default__') || currentImageMap.default;
            if (fallback && fallback !== src && typeof fallback === 'string' && fallback.trim()) element.src = fallback.trim();
        }
    }

    function setupSendInterception() {
        if (isSendInterceptionInstalled) return;
        isSendInterceptionInstalled = true;

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            const target = e.target;
            if (!target || target.id !== 'send_textarea') return;
            // ★ 合体モード時は gic_lorebook.js が制御するため介入しない
            if (window.GicApi?.isCombinedMode?.() === true) return;
            const text = target.value;
            if (!text || !text.trim()) return;
            const matchedUrl = findMatchingImageUrl(text);
            if (matchedUrl) {
                _lastSentKeywordImage = matchedUrl;   // ★ ロック
                updateImageWithUrl(matchedUrl);
            }
        }, true);

        document.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('#send_but') : null;
            if (!btn) return;
            // ★ 合体モード時は gic_lorebook.js が制御するため介入しない
            if (window.GicApi?.isCombinedMode?.() === true) return;
            const textarea = document.querySelector('#send_textarea');
            if (!textarea) return;
            const text = textarea.value;
            if (!text || !text.trim()) return;
            const matchedUrl = findMatchingImageUrl(text);
            if (matchedUrl) {
                _lastSentKeywordImage = matchedUrl;   // ★ ロック
                updateImageWithUrl(matchedUrl);
            }
        }, true);
    }

    function setupChatDomObserver() {
        const chatContainer = document.querySelector('#chat');
        if (!chatContainer) return;
        if (chatDomObserver) chatDomObserver.disconnect();
        const debouncedUpdate = debounce(() => { safeUpdateImage(); }, 150);
        chatDomObserver = new MutationObserver(() => debouncedUpdate());
        chatDomObserver.observe(chatContainer, { childList: true, subtree: true, characterData: true });
    }

    function findImageMapInData(data) {
        if (data === null || typeof data !== 'object') return null;
        if (data.hasOwnProperty('image_display_extension')) {
            const potentialMap = data.image_display_extension;
            if (typeof potentialMap === 'object' && potentialMap !== null) return potentialMap;
        }
        for (const key in data) {
            if (data.hasOwnProperty(key)) {
                const result = findImageMapInData(data[key]);
                if (result !== null) return result;
            }
        }
        return null;
    }

    // ============================================================
    // ★ 別キャラの画像エントリ検出・除去
    //   過去のバグで別キャラのファイル名が保存されてしまった残留データを、
    //   読み込み時に検出して除去する。
    //   - 生成画像は {キャラ名}_{キー}_{timestamp}.png の命名なので、
    //     ファイル名が別の既知キャラ名 + "_" で始まる場合は別キャラ由来と判定。
    //   - 現在キャラ名で始まる場合は除外しない（誤判定防止）。
    // ============================================================
    function extractFileNameForCleanup(path) {
        if (!path || typeof path !== 'string') return '';
        if (path.startsWith('data:')) return '';
        const clean = path.split('?')[0].split('#')[0];
        const parts = clean.split('/');
        const name = parts[parts.length - 1];
        if (!name || name.startsWith('data:')) return '';
        return name;
    }

    function getKnownCharacterNames() {
        try {
            const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
            const chars = ctx?.characters || [];
            return chars.map(c => c?.name).filter(n => typeof n === 'string' && n);
        } catch (e) { return []; }
    }

    function isForeignImageFileName(fileName, currentCharName) {
        if (!fileName || !currentCharName) return false;
        if (fileName.startsWith(currentCharName + '_')) return false;
        const knownChars = getKnownCharacterNames();
        for (const other of knownChars) {
            if (other && other !== currentCharName && fileName.startsWith(other + '_')) {
                return true;
            }
        }
        return false;
    }

    // ============================================================
    // ★ 別キャラ画像エントリの「一度きり」マイグレーション管理
    //   character.data.extensions.image_display_extension_meta に
    //   foreign_cleaned_version: 1 を保存し、2回目以降はクリーンアップをスキップ。
    //   - 新規インポートされたキャラはフラグを持たないため、初回のみクリーンアップが走る
    //   - バージョンを上げれば将来の再マイグレーションにも対応可能
    // ============================================================
    const IMG_MIGRATION_META_NS = 'image_display_extension_meta';
    const IMG_MIGRATION_FLAG_KEY = 'foreign_cleaned_version';
    const IMG_MIGRATION_VERSION = 1;

    function isMigrationDoneForChar(charName) {
        if (!charName) return false;
        try {
            const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
            const char = ctx?.characters?.[ctx?.characterId];
            if (char?.name !== charName) return false;
            const v = char?.data?.extensions?.[IMG_MIGRATION_META_NS]?.[IMG_MIGRATION_FLAG_KEY] || 0;
            return v >= IMG_MIGRATION_VERSION;
        } catch (e) { return false; }
    }

    function markMigrationDoneForChar(charName) {
        if (!charName) return false;
        try {
            const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
            const char = ctx?.characters?.[ctx?.characterId];
            if (char?.name !== charName) return false;
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};
            if (!char.data.extensions[IMG_MIGRATION_META_NS]) {
                char.data.extensions[IMG_MIGRATION_META_NS] = {};
            }
            char.data.extensions[IMG_MIGRATION_META_NS][IMG_MIGRATION_FLAG_KEY] = IMG_MIGRATION_VERSION;
            if (window.CharStore?.saveCharacterExtension) {
                // ★ STコアの再取得でデータが上書きされるのを防ぐため即時保存
                window.CharStore.saveCharacterExtension(
                    IMG_MIGRATION_META_NS,
                    char.data.extensions[IMG_MIGRATION_META_NS],
                    { immediate: true }
                );
            }
            return true;
        } catch (e) { return false; }
    }

    // ============================================================
    // ★ パスなし（ファイル名のみ）のエントリをフルパスに正規化
    //   stj_editor.js の旧バージョンで image_display_extension に
    //   ファイル名のみが保存された場合への防御的対応。
    //   - 文字列に '/' が含まれない場合は `user/images/{charName}/{file}` を補完
    //   - data: / blob: / http(s): で始まる場合はそのまま保持
    // ============================================================
    function normalizeImageMapPaths(imageMap, charName) {
        if (!imageMap || typeof imageMap !== 'object' || !charName) return imageMap;

        const processOne = (p) => {
            if (typeof p !== 'string') return p;
            const trimmed = p.trim();
            if (!trimmed) return trimmed;
            // 既にフルパス or 特殊URL
            if (trimmed.includes('/')) return trimmed;
            if (/^(data:|blob:|https?:)/i.test(trimmed)) return trimmed;
            return `user/images/${charName}/${trimmed}`;
        };

        const result = {};
        for (const [key, val] of Object.entries(imageMap)) {
            if (Array.isArray(val)) {
                result[key] = val.map(processOne);
            } else if (typeof val === 'string') {
                result[key] = processOne(val);
            } else {
                result[key] = val;
            }
        }
        return result;
    }
    
    function cleanForeignImageEntries(imageMap, charName) {
        if (!imageMap || typeof imageMap !== 'object' || !charName) return imageMap;

        // ★ 既にクリーンアップ済みのキャラは、ユーザーが明示的に追加した
        //    別キャラの画像を尊重するため、クリーンアップをスキップする。
        if (isMigrationDoneForChar(charName)) {
            return imageMap;
        }

        const alreadyMigrated = false;

        let removed = 0;
        const cleaned = {};

        const processValue = (val) => {
            if (Array.isArray(val)) {
                const filtered = val.filter(p => {
                    if (typeof p !== 'string') return true;
                    const fn = extractFileNameForCleanup(p);
                    if (!fn) return true;
                    if (isForeignImageFileName(fn, charName)) {
                        if (!alreadyMigrated) {
                            console.log(`[ImageDisplay] 🧹 別キャラの画像エントリを除外: ${fn}`);
                        }
                        removed++;
                        return false;
                    }
                    return true;
                });
                if (filtered.length === 0) return null;
                return filtered.length === 1 ? filtered[0] : filtered;
            } else if (typeof val === 'string') {
                const fn = extractFileNameForCleanup(val);
                if (fn && isForeignImageFileName(fn, charName)) {
                    if (!alreadyMigrated) {
                        console.log(`[ImageDisplay] 🧹 別キャラの画像エントリを除外: ${fn}`);
                    }
                    removed++;
                    return null;
                }
                return val;
            }
            return val;
        };

        for (const [key, val] of Object.entries(imageMap)) {
            const result = processValue(val);
            if (result !== null) cleaned[key] = result;
        }

        if (removed > 0) {
            console.log(
                `[ImageDisplay] 🧹 別キャラの画像エントリ ${removed} 件を整理 ` +
                `(${Object.keys(imageMap).length} → ${Object.keys(cleaned).length} entries)` +
                (alreadyMigrated ? ' [STコアによるデータ再取得を検知]' : '')
            );
            // ★ STコアの再取得で上書きされるのを防ぐため即時保存
            try {
                if (window.CharStore?.saveCharacterExtension) {
                    window.CharStore.saveCharacterExtension('image_display_extension', cleaned, { immediate: true });
                }
            } catch (e) { /* ignore */ }
        }

        // ★ フラグ未設定なら初回としてマーク
        if (!alreadyMigrated) {
            markMigrationDoneForChar(charName);
        }

        return cleaned;
    }
            
    function getCharacterNameFromDOM() {
        const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const userName = (context && (context.name1 || context.user_name)) || 'ユーザー';
        if (context && context.character && context.character.name && context.character.name !== userName) return context.character.name;
        if (context && context.characters && typeof context.characterId !== 'undefined' && context.characters[context.characterId]) {
            const cName = context.characters[context.characterId].name;
            if (cName && cName !== userName) return cName;
        }
        const selectedOption = document.querySelector('#character_select option:checked, select[name="character"] option:checked');
        if (selectedOption && selectedOption.textContent.trim()) {
            const val = selectedOption.textContent.trim();
            if (val !== userName) return val;
        }
        return null;
    }

    function invalidateAllCaches() {
        invalidateMatchCache();
        invalidateSortedEntriesCache();
    }

    async function loadCharacterData(forceRefresh = false) {
        const charName = getCharacterNameFromDOM();
        if (!charName) {
            if (currentImageMap === defaultImageMap) {
                currentImageMap = await detectImageMapExtensions(defaultImageMap);
                invalidateAllCaches(); safeUpdateImage();
            }
            return;
        }
        if (!forceRefresh && currentCharacter === charName && currentImageMap !== defaultImageMap) return;

        // ★ キャラ切替判定（currentCharacter 更新前）
        const characterChanged = (currentCharacter !== charName);

        currentCharacter = charName;

        // ★ キャラ切替時のみバッグ状態を復元
        if (characterChanged) {
            _loadBagStateFromChar();
        }

        if (!forceRefresh && imageMapCache.has(charName)) {
            currentImageMap = imageMapCache.get(charName);
            invalidateAllCaches(); preloadCharacterImages(currentImageMap); safeUpdateImage();
            return;
        }

        let loadedMap = null;

        // ── ① 一次情報源: ctx.characters[characterId] → ctx.character の順 ──
        try {
            const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;

            // 1a. ctx.characters[characterId] を最優先
            const charFromList = context?.characters?.[context?.characterId];
            let ext = charFromList?.data?.extensions?.image_display_extension;

            // 1b. ctx.character 経由（フォールバック）
            if (!ext || typeof ext !== 'object' || Object.keys(ext).length === 0) {
                ext = context?.character?.data?.extensions?.image_display_extension;
            }

            if (ext && typeof ext === 'object' && Object.keys(ext).length > 0) {
                loadedMap = ext;
                console.log(`[ImageDisplay] image_display_extension を読込 (${Object.keys(ext).length} entries)`);
            }
        } catch (e) { /* ignore */ }

        // ── ② 移行フォールバック: _ext.json（character.data が空の時のみ）──
        if (!loadedMap) {
            // ★ character.data に image_display_extension キーが既に存在すれば
            //    （たとえ空 {} でも）「新システム使用中・確認済み」とみなし、
            //    _ext.json フォールバックを完全スキップする
            let hasExtKeyInCharData = false;
            try {
                const context = SillyTavern.getContext();
                const char = context?.characters?.[context?.characterId];
                if (char?.name === charName) {
                    hasExtKeyInCharData = char?.data?.extensions?.image_display_extension !== undefined;
                }
            } catch (e) { /* ignore */ }

            if (!hasExtKeyInCharData) {
                try {
                    const resp = await fetch(`user/images/${charName}/${charName}_ext.json`);
                    if (resp.ok) {
                        const data = await resp.json();
                        const legacy = findImageMapInData(data);
                        if (legacy && typeof legacy === 'object' && Object.keys(legacy).length > 0) {
                            loadedMap = legacy;
                            console.log(`[ImageDisplay] 🔄 _ext.json を検出。character.data へ移行します`);
                            try {
                                window.CharStore?.saveCharacterExtension?.(
                                    'image_display_extension', legacy, { immediate: true }
                                );
                            } catch (migErr) { console.warn('[ImageDisplay] 移行エラー:', migErr); }
                        } else {
                            // _ext.json は存在するが中身が空 → 「確認済み・データなし」として空データ保存
                            window.CharStore?.saveCharacterExtension?.(
                                'image_display_extension', {}, { immediate: true }
                            );
                        }
                    } else if (resp.status === 404) {
                        // _ext.json なし → 「確認済み・データなし」として空データ保存
                        //   これにより次回以降は hasExtKeyInCharData が true になり
                        //   不要な 404 リクエストが発生しない
                        window.CharStore?.saveCharacterExtension?.(
                            'image_display_extension', {}, { immediate: true }
                        );
                    }
                    // 5xx などの一時的エラーは保存せず、次回リトライを許容
                } catch (e) { /* ignore */ }
            }
        }

        if (loadedMap) {
            // ★ 別キャラの画像エントリを先に除外する
            //    （detectImageMapExtensions が HEAD リクエストを発行する前に除去することで
            //     無駄な 404 リクエストを抑止する）
            const preCleanedMap = cleanForeignImageEntries(loadedMap, charName);

            // ★ パスなし（ファイル名のみ）のエントリをフルパスに正規化
            //   stj_editor.js の旧バージョンで保存されたレガシーデータ対策。
            const normalizedMap = normalizeImageMapPaths(preCleanedMap, charName);

            const detectedMap = await detectImageMapExtensions(normalizedMap);
            currentImageMap = detectedMap;
            imageMapCache.set(charName, detectedMap);
        } else {
            currentImageMap = await detectImageMapExtensions(defaultImageMap);
        }
        invalidateAllCaches();
        preloadCharacterImages(currentImageMap);
        safeUpdateImage();
    }

    function toggleCustomWindow() { if (isCustomWindowOpen) closeCustomWindow(); else openCustomWindow(); }

    function openCustomWindow(options = {}) {
        const { skipSave = false } = options;
        ensureChatExplicitPosition();
        document.getElementById('custom-width').value = imageContainer.offsetWidth;
        document.getElementById('custom-height').value = imageContainer.offsetHeight;
        document.getElementById('custom-left').value = parseInt(imageContainer.style.left) || DEFAULT_LEFT;
        document.getElementById('custom-top').value = parseInt(imageContainer.style.top) || DEFAULT_TOP;
        customWindow.style.display = 'block';
        isCustomWindowOpen = true;
        syncHeaderVisibility();
        syncChatHeaderVisibility();
        syncChatHeaderPosition();
        syncChatResizeHandlePosition();
        updateChatSizeButtons();
        if (!skipSave) saveDisplayState();
    }

    function closeCustomWindow(options = {}) {
        const { skipSave = false } = options;
        customWindow.style.display = 'none';
        isCustomWindowOpen = false;
        syncHeaderVisibility();
        syncChatHeaderVisibility();
        if (!skipSave) saveDisplayState();
    }

    function updateCustomWindow() {
        if (!isCustomWindowOpen) return;
        document.getElementById('custom-width').value = imageContainer.offsetWidth;
        document.getElementById('custom-height').value = imageContainer.offsetHeight;
        document.getElementById('custom-left').value = parseInt(imageContainer.style.left) || 0;
        document.getElementById('custom-top').value = parseInt(imageContainer.style.top) || 0;
    }

    customButton.addEventListener('click', toggleCustomWindow);
    document.getElementById('close-custom-window').addEventListener('click', () => closeCustomWindow());

    ['custom-width', 'custom-height', 'custom-left', 'custom-top'].forEach(id => {
        document.getElementById(id).addEventListener('input', () => {
            if (currentMode !== 'normal') return;
            const w = parseInt(document.getElementById('custom-width').value) || DEFAULT_WIDTH;
            const h = parseInt(document.getElementById('custom-height').value) || DEFAULT_HEIGHT;
            const l = parseInt(document.getElementById('custom-left').value) || DEFAULT_LEFT;
            const t = parseInt(document.getElementById('custom-top').value) || DEFAULT_TOP;
            imageContainer.style.width = `${w}px`;
            imageContainer.style.height = `${h}px`;
            imageContainer.style.left = `${l}px`;
            imageContainer.style.top = `${t}px`;
            preNormalState = { width: w, height: h, left: l, top: t };
            syncHeaderPosition();
            saveDisplayState();
        });
    });

    function saveDisplayState() {
        const state = {
            preNormalState,
            bgColor: colorPicker.value,
            currentMode,
            chatBgColor: chatColorPicker.value,
            imageManualMode,
            chatCurrentMode,
            chatPreState: chatPreState ? { ...chatPreState } : null,
            isCustomWindowOpen: isCustomWindowOpen === true,
        };
        const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (context && context.extensionSettings) {
            context.extensionSettings[MODULE_NAME] = state;
            if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
        }
    }

    function restoreDisplayState() {
        const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        let state = context && context.extensionSettings ? context.extensionSettings[MODULE_NAME] : null;
        if (!state) {
            const oldSaved = localStorage.getItem(OLD_STORAGE_KEY);
            if (oldSaved) {
                try {
                    state = JSON.parse(oldSaved);
                    if (context && context.extensionSettings) {
                        context.extensionSettings[MODULE_NAME] = state;
                        if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
                        localStorage.removeItem(OLD_STORAGE_KEY);
                    }
                } catch (e) { /* ignore */ }
            }
        }
        if (state) {
            try {
                if (state.preNormalState) {
                    const pns = state.preNormalState;
                    const w = Number(pns.width), h = Number(pns.height);
                    const l = Number(pns.left), t = Number(pns.top);
                    preNormalState = {
                        width: Number.isFinite(w) && w > 0 ? w : DEFAULT_WIDTH,
                        height: Number.isFinite(h) && h > 0 ? h : DEFAULT_HEIGHT,
                        left: Number.isFinite(l) ? l : DEFAULT_LEFT,
                        top: Number.isFinite(t) ? t : DEFAULT_TOP,
                    };
                }
                if (state.bgColor) { imageContainer.style.backgroundColor = state.bgColor; colorPicker.value = state.bgColor; }
                currentMode = state.currentMode || 'normal';
                if (state.chatBgColor) {
                    chatColorPicker.value = state.chatBgColor;
                    const rgb = hexToRgbString(state.chatBgColor);
                    document.documentElement.style.setProperty('--chat-bg-rgb', rgb);
                }
                if (state.imageManualMode) imageManualMode = state.imageManualMode;
                if (state.chatCurrentMode) chatCurrentMode = state.chatCurrentMode;
                if (state.chatPreState) chatPreState = { ...state.chatPreState };
                if (typeof state.isCustomWindowOpen === 'boolean') savedCustomWindowOpen = state.isCustomWindowOpen;

                switch (currentMode) {
                    case 'maximized': applyMaximizeMode(); break;
                    case 'halfMaximized': applyHalfMaximizeMode(); break;
                    default: applyNormalMode(); break;
                }
            } catch (e) { setDefaultDisplayState(); }
        } else { setDefaultDisplayState(); }
    }

    function setDefaultDisplayState() {
        preNormalState = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, left: DEFAULT_LEFT, top: DEFAULT_TOP };
        imageContainer.style.backgroundColor = DEFAULT_BG_COLOR;
        colorPicker.value = DEFAULT_BG_COLOR;
        applyNormalMode();
    }

    function updateSizeButtons() {
        const restoreBtn = document.getElementById('image-display-restore-btn');
        const maximizeBtn = document.getElementById('image-display-maximize-btn');
        if (!restoreBtn || !maximizeBtn) return;
        restoreBtn.classList.remove('size-btn-disabled');
        maximizeBtn.classList.remove('size-btn-disabled');
        if (currentMode === 'normal') restoreBtn.classList.add('size-btn-disabled');
        else if (currentMode === 'maximized') maximizeBtn.classList.add('size-btn-disabled');
    }

    function applyNormalMode() {
        imageContainer.style.width = `${preNormalState.width}px`;
        imageContainer.style.height = `${preNormalState.height}px`;
        imageContainer.style.left = `${preNormalState.left}px`;
        imageContainer.style.top = `${preNormalState.top}px`;
        imageContainer.style.position = 'absolute';
        imageContainer.style.setProperty('z-index', Z_INDEX_BODY, 'important');
        resizeHandle.style.display = 'block';
        header.style.cursor = 'grab';
        imageContainer.classList.remove('half-maximized');
        maximizeButton.classList.remove('disabled'); maximizeButton.classList.add('enabled');
        halfMaximizeButton.classList.remove('disabled'); halfMaximizeButton.classList.add('enabled');
        customButton.classList.remove('disabled'); customButton.classList.add('enabled');
        currentMode = 'normal';
        updateSizeButtons();
        syncHeaderPosition();
        syncHeaderVisibility();
    }

    function applyMaximizeMode() {
        if (currentMode === 'normal') updatePreNormalStateFromDOM();
        imageContainer.style.setProperty('position', 'fixed', 'important');
        imageContainer.style.setProperty('width', '100vw', 'important');
        imageContainer.style.setProperty('height', '100vh', 'important');
        imageContainer.style.setProperty('left', '0', 'important');
        imageContainer.style.setProperty('top', '0', 'important');
        imageContainer.style.setProperty('right', 'auto', 'important');
        imageContainer.style.setProperty('bottom', 'auto', 'important');
        imageContainer.style.setProperty('z-index', Z_INDEX_BODY, 'important');
        resizeHandle.style.display = 'none';
        header.style.cursor = 'default';
        imageContainer.classList.remove('half-maximized');
        maximizeButton.classList.remove('enabled'); maximizeButton.classList.add('disabled');
        halfMaximizeButton.classList.remove('disabled'); halfMaximizeButton.classList.add('enabled');
        customButton.classList.remove('disabled'); customButton.classList.add('enabled');
        currentMode = 'maximized';
        updateSizeButtons();
        syncHeaderPosition();
        syncHeaderVisibility();
    }

    function applyHalfMaximizeMode() {
        if (currentMode === 'normal') updatePreNormalStateFromDOM();
        imageContainer.style.setProperty('position', 'fixed', 'important');
        imageContainer.style.setProperty('width', '50vw', 'important');
        imageContainer.style.setProperty('height', '100vh', 'important');
        imageContainer.style.setProperty('left', '0', 'important');
        imageContainer.style.setProperty('top', '0', 'important');
        imageContainer.style.setProperty('right', 'auto', 'important');
        imageContainer.style.setProperty('bottom', 'auto', 'important');
        imageContainer.style.setProperty('z-index', Z_INDEX_BODY, 'important');
        resizeHandle.style.display = 'none';
        header.style.cursor = 'default';
        imageContainer.classList.add('half-maximized');
        maximizeButton.classList.remove('disabled'); maximizeButton.classList.add('enabled');
        halfMaximizeButton.classList.remove('enabled'); halfMaximizeButton.classList.add('disabled');
        customButton.classList.remove('disabled'); customButton.classList.add('enabled');
        currentMode = 'halfMaximized';
        updateSizeButtons();
        syncHeaderPosition();
        syncHeaderVisibility();
    }

    restoreDisplayState();

    colorPicker.addEventListener('input', () => {
        imageContainer.style.backgroundColor = colorPicker.value;
        saveDisplayState();
    });

    function updatePreNormalStateFromDOM() {
        const leftVal = parseInt(imageContainer.style.left, 10);
        const topVal = parseInt(imageContainer.style.top, 10);
        const wVal = imageContainer.offsetWidth;
        const hVal = imageContainer.offsetHeight;
        preNormalState = {
            width: Number.isFinite(wVal) && wVal > 0 ? wVal : DEFAULT_WIDTH,
            height: Number.isFinite(hVal) && hVal > 0 ? hVal : DEFAULT_HEIGHT,
            left: Number.isFinite(leftVal) ? leftVal : DEFAULT_LEFT,
            top: Number.isFinite(topVal) ? topVal : DEFAULT_TOP,
        };
    }

    restoreSizeBtn.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        if (currentMode === 'normal') return;
        if (getTextStylingLayoutMode() === 'manual') imageManualMode = 'normal';
        applyNormalMode();
        saveDisplayState();
    });

    maximizeSizeBtn.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        if (currentMode === 'maximized') return;
        if (getTextStylingLayoutMode() === 'manual') imageManualMode = 'maximized';
        applyMaximizeMode();
        saveDisplayState();
    });

    colorPicker.addEventListener('click', (e) => e.stopPropagation());

    function isOnHeaderControl(e) {
        const target = e.target;
        if (target && target.closest) {
            if (target.closest('#image-display-header-controls') ||
                target.closest('#bg-color-picker') ||
                target.closest('#image-display-restore-btn') ||
                target.closest('#image-display-maximize-btn')) return true;
        }
        const path = e.composedPath ? e.composedPath() : [];
        return path.some(el => el && el.id && [
            'image-display-header-controls', 'bg-color-picker',
            'image-display-restore-btn', 'image-display-maximize-btn'
        ].includes(el.id));
    }

    header.addEventListener('mousedown', (e) => {
        if (isOnHeaderControl(e)) return;
        if (currentMode !== 'normal') return;
        isDragging = true;
        offsetX = e.clientX - imageContainer.getBoundingClientRect().left;
        offsetY = e.clientY - imageContainer.getBoundingClientRect().top;
        imageContainer.classList.add('dragging');
        header.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging || currentMode !== 'normal') return;
        imageContainer.style.left = `${e.clientX - offsetX}px`;
        imageContainer.style.top = `${e.clientY - offsetY}px`;
        syncHeaderPosition();
        if (isCustomWindowOpen) updateCustomWindow();
    });

    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        imageContainer.classList.remove('dragging');
        if (currentMode === 'normal') {
            header.style.cursor = 'grab';
            updatePreNormalStateFromDOM();
        }
        syncHeaderPosition();
        saveDisplayState();
    });

    resizeHandle.addEventListener('mousedown', (e) => {
        if (currentMode !== 'normal') return;
        e.stopPropagation();
        isResizing = true;
        imageContainer.classList.add('resizing');
        const startX = e.clientX, startY = e.clientY;
        const startWidth = imageContainer.offsetWidth, startHeight = imageContainer.offsetHeight;
        function handleResize(ev) {
            if (!isResizing) return;
            const newWidth = Math.max(100, startWidth + (ev.clientX - startX));
            const newHeight = Math.max(100, startHeight + (ev.clientY - startY));
            imageContainer.style.width = `${newWidth}px`;
            imageContainer.style.height = `${newHeight}px`;
            syncHeaderPosition();
            if (isCustomWindowOpen) updateCustomWindow();
        }
        function stopResize() {
            if (!isResizing) return;
            isResizing = false;
            imageContainer.classList.remove('resizing');
            if (currentMode === 'normal') updatePreNormalStateFromDOM();
            syncHeaderPosition();
            saveDisplayState();
            document.removeEventListener('mousemove', handleResize);
            document.removeEventListener('mouseup', stopResize);
        }
        document.addEventListener('mousemove', handleResize);
        document.addEventListener('mouseup', stopResize);
    });

    window.addEventListener('resize', () => {
        if (currentMode === 'maximized') {
            imageContainer.style.setProperty('width', '100vw', 'important');
            imageContainer.style.setProperty('height', '100vh', 'important');
            imageContainer.style.setProperty('top', '0', 'important');
        } else if (currentMode === 'halfMaximized') {
            imageContainer.style.setProperty('width', '50vw', 'important');
            imageContainer.style.setProperty('height', '100vh', 'important');
            imageContainer.style.setProperty('top', '0', 'important');
        }
        syncHeaderPosition();
        syncHeaderVisibility();
        syncChatHeaderPosition();
        syncChatResizeHandlePosition();
    });

    setInterval(() => {
        syncHeaderPosition();
        syncChatHeaderPosition();
        syncChatResizeHandlePosition();
    }, 500);
    
    function setupEventSourceListeners() {
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const context = SillyTavern.getContext();
            if (context && context.eventSource && context.eventTypes) {
                const { eventSource, eventTypes } = context;
                const safeOn = (eventType, handler) => {
                    if (eventType && typeof eventSource.on === 'function') eventSource.on(eventType, handler);
                };
            const immediateUpdate = () => updateImage();
            safeOn(eventTypes.CHARACTER_MESSAGE_RENDERED, immediateUpdate);
            safeOn(eventTypes.USER_MESSAGE_RENDERED, immediateUpdate);

            // ★ メッセージの削除・編集時はキーワード画像ロックを解除して再スキャン
            //    （削除されたメッセージのキーワード画像が居座り続けるバグを修正）
            //    ★ バトルモード中はロックを保持して背景切替を防ぐ
            const clearLockAndUpdate = () => {
                if (!isBattleModeActive() && !_battleImageLock) {
                    _lastSentKeywordImage = null;
                }
                invalidateMatchCache();
                // DOM 更新を待ってから再スキャン
                //   （ST は MESSAGE_DELETED を emit してから printMessages() するため、
                //     同期実行だと削除前のメッセージを読んでしまう）
                setTimeout(() => {
                    updateImage();
                }, 100);
            };
            if (eventTypes.MESSAGE_DELETED) safeOn(eventTypes.MESSAGE_DELETED, clearLockAndUpdate);
            if (eventTypes.MESSAGE_EDITED) safeOn(eventTypes.MESSAGE_EDITED, clearLockAndUpdate);

            if (eventTypes.CHAT_LOADED) safeOn(eventTypes.CHAT_LOADED, immediateUpdate);
                const onCharacterOrChatChanged = () => {
                    // ★ _resetBagState() を削除
                    //   キャラ切替時は loadCharacterData 内で _loadBagStateFromChar() が
                    //   新キャラの状態を読み込むため、ここでのリセットは不要
                    //   （チャット切替時は同一キャラなので state を維持すべき）

                    // ★ バトルモード中はロックを保持（背景切替を防ぐ）
                    if (!isBattleModeActive() && !_battleImageLock) {
                        _lastSentKeywordImage = null;   // ★ ロック解除
                    }
                    invalidateMatchCache();
                    loadCharacterData(true);
                };
                safeOn(eventTypes.CHAT_CHANGED, onCharacterOrChatChanged);
                safeOn(eventTypes.CHARACTER_SELECTED, onCharacterOrChatChanged);
            }
        }
    }

    function setupCharStoreListener() {
        // ① STJ Editor からの即時更新通知
        window.addEventListener('lbe-image-map-updated', (e) => {
            const { charName, imageMap } = e.detail || {};
            if (!charName || !imageMap) return;
            if (charName !== currentCharacter) return;

            console.log(`[ImageDisplay] image_display_extension 更新通知: ${charName}`);
            detectImageMapExtensions(imageMap).then((detected) => {
                imageMapCache.set(charName, detected);
                currentImageMap = detected;
                invalidateAllCaches();
                preloadCharacterImages(currentImageMap);
                safeUpdateImage();
            });
        });

        // ★ 削除/登録解除された画像を即座に使用中止し、
        //   キーワードマッピングから次の画像を選んで表示する
        window.addEventListener('gic-image-removed', (e) => {
            const { charName, removedFileName, imageMap } = e.detail || {};
            if (!charName || !imageMap) return;
            if (charName !== currentCharacter) return;

            // ── ① マップを即時更新（detect を待たない） ──
            currentImageMap = imageMap;
            imageMapCache.set(charName, imageMap);
            invalidateAllCaches();

            // ── ② 現在表示中の画像が削除対象かチェック ──
            const currentFile = currentImageUrl
                ? extractFileNameForCleanup(currentImageUrl)
                : null;
            const isCurrentRemoved = !!(currentFile && removedFileName &&
                currentFile === removedFileName);

            if (!isCurrentRemoved) {
                console.log(
                    `[ImageDisplay] 🗑️ 別画像の削除を検知（表示継続）: ` +
                    `表示中="${currentFile}", 削除="${removedFileName}"`
                );
            } else {
                console.log(
                    `[ImageDisplay] 🗑️ 表示中の画像が削除されました → 次の画像へ切替: ${currentFile}`
                );
                // ── ③ 現在画像をクリアし、キーワードマップから次の画像を選ぶ ──
                pickAndShowCurrentKeyword().catch(err =>
                    console.warn('[ImageDisplay] 削除後の画像切替エラー:', err)
                );
            }

            // ── ④ バックグラウンドで detect（プリロード等） ──
            detectImageMapExtensions(imageMap).then((detected) => {
                if (currentCharacter === charName) {
                    currentImageMap = detected;
                    imageMapCache.set(charName, detected);
                    invalidateAllCaches();
                    preloadCharacterImages(currentImageMap);
                }
            }).catch(() => { /* ignore */ });
        });

        // ★ ギャラリー一括削除（gic-image-deleted）にも対応
        window.addEventListener('gic-image-deleted', (e) => {
            const { charName, fileNames } = e.detail || {};
            if (!charName || !Array.isArray(fileNames) || fileNames.length === 0) return;
            if (charName !== currentCharacter) return;

            const currentFile = currentImageUrl
                ? extractFileNameForCleanup(currentImageUrl)
                : null;
            if (!currentFile) return;

            const isCurrentDeleted = fileNames.some(fn => fn === currentFile);
            if (!isCurrentDeleted) return;

            console.log(
                `[ImageDisplay] 🗑️ 一括削除で表示中の画像が削除されました → 次の画像へ切替: ${currentFile}`
            );

            // stj_editor.js が後続で lbe-image-map-updated を発火するので、
            // ここでは _lastSentKeywordImage をクリアするだけで良い。
            _lastSentKeywordImage = null;
            invalidateMatchCache();
        });

        // ② ST ネイティブイベント（外部編集・他経路の更新を拾う）
        try {
            const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
            if (ctx?.eventSource && ctx?.eventTypes?.CHARACTER_EDITED) {
                ctx.eventSource.on(ctx.eventTypes.CHARACTER_EDITED, () => {
                    console.log('[ImageDisplay] CHARACTER_EDITED 受信 → キャッシュ破棄');
                    const charName = getCharacterNameFromDOM();
                    if (charName) imageMapCache.delete(charName);
                    loadCharacterData(true);
                });
            }
        } catch (e) { /* ignore */ }
    }
    
    setupEventSourceListeners();
    setupCharStoreListener();
    setupSendInterception();
    loadCharacterData(true);
    setupChatDomObserver();

    let pollCount = 0;
    const initialPoll = setInterval(() => {
        loadCharacterData();
        pollCount++;
        if (pollCount > 10) clearInterval(initialPoll);
    }, 1000);

    function isGalleryOpen() {
        const candidates = document.querySelectorAll([
            '#gallery_container', '.gallery-container', '.gallery_container',
            '#gallery', '.gallery', '[data-gallery-container]', '.gallery-grid', '#gallery-grid'
        ].join(','));
        for (const el of candidates) {
            if (!el) continue;
            const style = window.getComputedStyle(el);
            if (style.display === 'none') continue;
            if (style.visibility === 'hidden') continue;
            if (parseFloat(style.opacity) === 0) continue;
            if (el.offsetParent === null && style.position !== 'fixed') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            return true;
        }
        return false;
    }

    let lastGalleryState = null;
    function updateControlContainerVisibility() {
        const galleryOpen = isGalleryOpen();
        if (galleryOpen === lastGalleryState) return;
        lastGalleryState = galleryOpen;
        controlContainer.style.display = galleryOpen ? 'none' : 'flex';
    }

    function setupGalleryObserver() {
        const observer = new MutationObserver(() => updateControlContainerVisibility());
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
        setInterval(updateControlContainerVisibility, 300);
        updateControlContainerVisibility();
    }

    setupGalleryObserver();

    setTimeout(() => {
        try {
            const lm = getTextStylingLayoutMode();
            if (lm === 'manual' && savedCustomWindowOpen) {
                if (!isCustomWindowOpen) openCustomWindow({ skipSave: true });
                if (imageManualMode === 'maximized') applyMaximizeMode();
                else if (imageManualMode === 'halfMaximized') applyHalfMaximizeMode();
                if (chatPreState) {
                    ensureChatExplicitPosition();
                    if (chatCurrentMode === 'maximized') applyChatMaximizedState();
                    else applyChatNormalState();
                }
                console.log('[ImageDisplay] 手動モード状態を復元しました', { imageManualMode, chatCurrentMode, hasChatPreState: !!chatPreState });
            }
        } catch (e) {
            console.warn('[ImageDisplay] delayed restore failed:', e);
        }
    }, 1500);

    window.ImageDisplayExtension = {
        getCurrentImageUrl: function () { return currentImageUrl; },
        // ★ 互換用: 背景生成モード廃止に伴い常に false を返す
        //   他モジュール（gic_lorebook.js / gic.js / stj_editor.js など）が
        //   isOverride() を参照しても、合体モード固定であることを正しく示す。
        isOverride: () => false,
        applyNormalMode: function () {
            if (imageManualMode === 'maximized') applyMaximizeMode();
            else if (imageManualMode === 'halfMaximized') applyHalfMaximizeMode();
            else applyNormalMode();
            if (chatPreState) {
                ensureChatExplicitPosition();
                if (chatCurrentMode === 'maximized') applyChatMaximizedState();
                else applyChatNormalState();
            }
            saveDisplayState();
        },
        applyMaximizeMode: function () {
            const sheld = document.getElementById('sheld');
            if (sheld) sheld.classList.remove('idp-chat-explicit', 'idp-chat-maximized');
            applyMaximizeMode();
            saveDisplayState();
        },
        applyHalfMaximizeMode: function () {
            const sheld = document.getElementById('sheld');
            if (sheld) sheld.classList.remove('idp-chat-explicit', 'idp-chat-maximized');
            applyHalfMaximizeMode();
            saveDisplayState();
        },
        // ★ 既存の残留データを手動でクリーンアップする（デバッグ・復旧用）
        cleanForeignEntries: function () {
            const charName = getCharacterNameFromDOM();
            if (!charName) return { changed: false, message: 'no charName' };
            try {
                const ctx = SillyTavern.getContext();
                const charFromList = ctx?.characters?.[ctx?.characterId];
                let ext = charFromList?.data?.extensions?.image_display_extension;
                if (!ext || typeof ext !== 'object') {
                    return { changed: false, message: 'no data' };
                }
                const before = Object.keys(ext).length;
                const cleaned = cleanForeignImageEntries(ext, charName);
                const after = Object.keys(cleaned).length;
                return {
                    charName,
                    changed: before !== after,
                    before,
                    after,
                    removed: before - after,
                };
            } catch (e) {
                return { changed: false, error: String(e) };
            }
        },

        // ★ マイグレーションフラグをリセット（手動で再クリーンアップしたい時用）
        resetMigration: function () {
            const charName = getCharacterNameFromDOM();
            if (!charName) return { ok: false, message: 'no charName' };
            try {
                const ctx = SillyTavern.getContext();
                const char = ctx?.characters?.[ctx?.characterId];
                if (char?.name !== charName) {
                    return { ok: false, message: 'char mismatch' };
                }
                if (char?.data?.extensions?.[IMG_MIGRATION_META_NS]) {
                    delete char.data.extensions[IMG_MIGRATION_META_NS][IMG_MIGRATION_FLAG_KEY];
                    if (window.CharStore?.saveCharacterExtension) {
                        window.CharStore.saveCharacterExtension(
                            IMG_MIGRATION_META_NS,
                            char.data.extensions[IMG_MIGRATION_META_NS]
                        );
                    }
                }
                return { ok: true, charName };
            } catch (e) {
                return { ok: false, error: String(e) };
            }
        },

        // ★ バッグ状態の手動リセット（デバッグ・復旧用）
        resetBagState: function () {
            _resetBagState();
            // 永続化データもクリア
            try {
                const ctx = SillyTavern.getContext();
                const char = ctx?.characters?.[ctx?.characterId];
                if (char?.data?.extensions?.[BAG_STATE_NS]) {
                    delete char.data.extensions[BAG_STATE_NS];
                    window.CharStore?.saveCharacterExtension?.(BAG_STATE_NS, {}, { immediate: true });
                }
            } catch (e) { /* ignore */ }
            return true;
        },
        // ★ バッグ状態の内容を取得（デバッグ用）
        getBagState: function () {
            const out = {};
            for (const [key, state] of _bagState.entries()) {
                out[key] = {
                    signature: state.signature.slice(0, 80),
                    flags: Object.fromEntries(
                        Array.from(state.flags.entries()).map(([src, flag]) => [
                            src.split('/').pop(),
                            flag
                        ])
                    ),
                };
            }
            return out;
        },
        
        getCurrentMode: function () { return currentMode; },
        openCustomWindow: function () { try { openCustomWindow(); } catch (e) { console.warn(e); } },
        closeCustomWindow: function () { try { closeCustomWindow(); } catch (e) { console.warn(e); } },
        isCustomWindowOpen: function () { return isCustomWindowOpen; },
        syncHeaderPosition, applyHeaderZIndex, syncHeaderVisibility,
        syncChatHeaderVisibility, syncChatHeaderPosition,
        ensureChatExplicitPosition,
        applyTopBarBackground,
        lockBattleImage,
        unlockBattleImage,
        isBattleImageLocked: () => !!_battleImageLock,
        markGeneratedButNotShown,       // ★
        pickAndShowCurrentKeyword,      // ★
    };
    console.log("✅ Image Display Extension API を window.ImageDisplayExtension に公開しました");
})();

// ============================================================
// 全ドロワーアイコンの opacity 制御
//   通常時: 0.01 / top-bar ホバー時: 0.4 / アイコン個別ホバー時: 1
// ============================================================
(function setupDrawerIconOpacityControl() {
    const OPACITY_NORMAL     = '0.01';  // 通常時（ほぼ透明）
    const OPACITY_TOPBAR     = '0.4';   // #top-bar ホバー判定中
    const OPACITY_ICON_HOVER = '1';     // アイコン個別ホバー時

    let isTopBarHover = false;
    let lastX = -1, lastY = -1;

    function getDrawerIcons() {
        // closedIcon / openIcon の両方を対象にする
        return document.querySelectorAll(
            '.drawer-icon.closedIcon, .drawer-icon.openIcon'
        );
    }

    function isMouseOverElement(x, y, el) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        return (
            x >= rect.left && x <= rect.right &&
            y >= rect.top  && y <= rect.bottom
        );
    }

    function updateAllIcons(x, y) {
        const icons = getDrawerIcons();
        icons.forEach(icon => {
            let opacity;
            if (x >= 0 && y >= 0 && isMouseOverElement(x, y, icon)) {
                // アイコン個別ホバー
                opacity = OPACITY_ICON_HOVER;
            } else if (isTopBarHover) {
                // #top-bar 近接ホバー中
                opacity = OPACITY_TOPBAR;
            } else {
                // 通常時
                opacity = OPACITY_NORMAL;
            }
            icon.style.setProperty('opacity', opacity, 'important');
        });
    }

    function syncTopBarHover() {
        // 既存の setupTopBarHover() が付与する body.top-bar-hover を利用
        isTopBarHover = document.body.classList.contains('top-bar-hover');
    }

    // ── マウス移動でリアルタイム更新 ──
    document.addEventListener('mousemove', (e) => {
        lastX = e.clientX;
        lastY = e.clientY;
        syncTopBarHover();
        updateAllIcons(lastX, lastY);
    }, { passive: true });

    // ── body.top-bar-hover クラスの変化を監視 ──
    const observer = new MutationObserver(() => {
        syncTopBarHover();
        if (lastX >= 0 && lastY >= 0) {
            updateAllIcons(lastX, lastY);
        } else {
            updateAllIcons(-1, -1);
        }
    });
    observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class']
    });

    // ── マウスがウィンドウ外に出た時 ──
    document.addEventListener('mouseleave', () => {
        lastX = -1;
        lastY = -1;
        isTopBarHover = false;
        updateAllIcons(-1, -1);
    });

    // ── 初期化 ──
    syncTopBarHover();
    updateAllIcons(-1, -1);

    console.log(
        `[ImageDisplay] 全ドロワーアイコンの opacity 制御を開始 ` +
        `(normal=${OPACITY_NORMAL}, topbar=${OPACITY_TOPBAR}, hover=${OPACITY_ICON_HOVER})`
    );
})();
