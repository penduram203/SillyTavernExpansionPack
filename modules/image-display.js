(function () {
    console.log("Image Display: 初期化を開始します。");
    const MODULE_NAME = 'image_display';
    const OLD_STORAGE_KEY = 'imageDisplayState';

    const mediaExistsCache = new Map();

    const DEFAULT_WIDTH = 300, DEFAULT_HEIGHT = 200, DEFAULT_LEFT = 100, DEFAULT_TOP = 100, DEFAULT_BG_COLOR = '#000000';
    const defaultImageMap = { "default": "addchara/default" };
    let currentCharacter = null;
    let currentImageMap = defaultImageMap;
    let currentImageUrl = null;
    let currentMode = 'normal';
    let preNormalState = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, left: DEFAULT_LEFT, top: DEFAULT_TOP };
    let isDragging = false, isResizing = false, offsetX, offsetY, isCustomWindowOpen = false;
    const imageMapCache = new Map();
    let isDefaultImageFailed = false;
    let currentTextMode = 'user';
    let streamingTimer = null;
    let lastStreamingText = '';
    const STREAMING_DELAY = 500;
    let chatDomObserver = null;

    let isOverrideActive = false;
    let overrideImageUrl = null;

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

    let headerVisible = false;

    // ★ #top-bar / #top-settings-holder 連動 hover 用
    const TOP_BAR_HOVER_MARGIN = 20;
    let topBarHoverVisible = false;
    let lastMouseX = -1;
    let lastMouseY = -1;

    function getTextSignature(text) {
        if (!text || typeof text !== 'string') return '';
        return text.slice(-200);
    }

    function invalidateMatchCache() {
        lastMatchCache = { signature: null, url: null, timestamp: 0 };
    }

    function invalidateSortedEntriesCache() {
        sortedKeywordEntriesCache = null;
        sortedKeywordEntriesCacheSource = null;
    }

    function clearOverrideState(options = {}) {
        const { save = true, reason = '' } = options;
        const wasActive = isOverrideActive;
        isOverrideActive = false;
        overrideImageUrl = null;
        if (reason) {
            console.warn(`🔄 override状態を解除: ${reason} (旧 active=${wasActive})`);
        } else {
            console.log(`🔄 override状態を解除しました (旧 active=${wasActive})`);
        }
        if (save) {
            try { saveDisplayState(); } catch (e) { /* ignore */ }
        }
    }

    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'mp4', 'webm'];

    function isVideoUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return !!url.match(/\.(mp4|webm)$/i);
    }

    async function detectImageExtension(imagePath) {
        if (!imagePath || typeof imagePath !== 'string' || !imagePath.trim()) return null;
        const cleanPath = imagePath.trim();

        if (cleanPath.match(/\.(png|jpg|jpeg|webp|gif|avif|bmp|mp4|webm)$/i)) {
            return cleanPath;
        }

        for (const ext of ALLOWED_EXTENSIONS) {
            const imagePathWithExt = `${cleanPath}.${ext}`;
            const exists = await checkMediaExists(imagePathWithExt);
            if (exists) {
                console.log(`✅ 拡張子自動検出: ${imagePathWithExt}`);
                return imagePathWithExt;
            }
        }
        console.warn(`⚠ メディアが見つかりません: ${cleanPath}`);
        return null;
    }

    function checkMediaExists(mediaUrl) {
        if (!mediaUrl || typeof mediaUrl !== 'string' || !mediaUrl.trim()) {
            return Promise.resolve(false);
        }
        const cleanUrl = mediaUrl.trim();

        if (mediaExistsCache.has(cleanUrl)) {
            return Promise.resolve(mediaExistsCache.get(cleanUrl));
        }

        return new Promise((resolve) => {
            if (isVideoUrl(cleanUrl)) {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.onloadedmetadata = () => {
                    mediaExistsCache.set(cleanUrl, true);
                    resolve(true);
                };
                video.onerror = () => {
                    mediaExistsCache.set(cleanUrl, false);
                    resolve(false);
                };
                video.src = cleanUrl;
            } else {
                const img = new Image();
                img.onload = () => {
                    mediaExistsCache.set(cleanUrl, true);
                    resolve(true);
                };
                img.onerror = () => {
                    mediaExistsCache.set(cleanUrl, false);
                    resolve(false);
                };
                img.src = cleanUrl;
            }
        });
    }

    async function detectImageMapExtensions(imageMap) {
        if (!imageMap) return imageMap;
        const detectedMap = {};
        for (const [key, value] of Object.entries(imageMap)) {
            if (Array.isArray(value)) {
                const detectedArray = [];
                for (const imagePath of value) {
                    const detectedPath = await detectImageExtension(imagePath);
                    if (detectedPath) {
                        detectedArray.push(detectedPath);
                    }
                }
                detectedMap[key] = detectedArray.length > 0 ? detectedArray : value;
            } else if (typeof value === 'string') {
                const detectedPath = await detectImageExtension(value);
                detectedMap[key] = detectedPath || value;
            } else {
                detectedMap[key] = value;
            }
        }
        return detectedMap;
    }

    function preloadCharacterImages(imageMap) {
        if (!imageMap) return;
        const urls = new Set();
        for (const [key, value] of Object.entries(imageMap)) {
            if (key === 'thumbnail') continue;
            if (Array.isArray(value)) {
                value.forEach(u => { if (typeof u === 'string' && u.trim()) urls.add(u.trim()); });
            } else if (typeof value === 'string' && value.trim()) {
                urls.add(value.trim());
            }
        }
        if (urls.size === 0) return;
        console.log(`🎬 ${urls.size} 件のメディアをプリロード開始`);
        urls.forEach(url => {
            if (isVideoUrl(url)) {
                const v = document.createElement('video');
                v.preload = 'auto';
                v.muted = true;
                v.playsInline = true;
                v.src = url;
            } else {
                const img = new Image();
                img.src = url;
            }
        });
    }

    // ============================================================
    // ★ #top-bar と #top-settings-holder を普段非表示 / hover で表示する CSS
    //    両者は常に連動する（同じクラスで制御）
    //    z-index / position には触らない
    // ============================================================
    (function injectTopBarCSS() {
        if (document.getElementById('idp-topbar-extra-css')) return;
        const style = document.createElement('style');
        style.id = 'idp-topbar-extra-css';
        style.textContent = `
            #top-bar,
            #top-settings-holder {
                opacity: 0 !important;
                pointer-events: none !important;
                transition: opacity 0.15s ease !important;
            }
            #top-bar.idp-topbar-visible,
            #top-settings-holder.idp-topbar-visible {
                opacity: 1 !important;
                pointer-events: auto !important;
            }
        `;
        document.head.appendChild(style);
    })();

    (function injectHeaderExtraCSS() {
        if (document.getElementById('image-display-header-extra-css')) return;
        const style = document.createElement('style');
        style.id = 'image-display-header-extra-css';
        style.textContent = `
            #image-display-container {
                position: absolute;
                z-index: ${Z_INDEX_BODY} !important;
            }
            #image-display-header {
                display: flex !important;
                align-items: center !important;
                justify-content: space-between !important;
                gap: 6px !important;
                padding: 0 8px !important;
                box-sizing: border-box !important;
                height: ${HEADER_HEIGHT}px !important;
                min-height: ${HEADER_HEIGHT}px !important;
                max-height: ${HEADER_HEIGHT}px !important;
                overflow: visible !important;
                position: fixed !important;
                z-index: ${Z_INDEX_HEADER_DEFAULT} !important;
                background-color: #333 !important;
                color: #fff !important;
                border-bottom: 1px solid #555 !important;
                cursor: grab;
                user-select: none !important;
                opacity: 0 !important;
                pointer-events: none !important;
                transition: opacity 0.15s ease !important;
            }
            #image-display-header.idp-visible {
                opacity: 1 !important;
                pointer-events: auto !important;
            }
            #image-display-title {
                flex: 1 1 auto !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
                white-space: nowrap !important;
                min-width: 0 !important;
                pointer-events: none !important;
                font-size: 13px !important;
                font-weight: bold !important;
            }
            #image-display-header-controls {
                flex: 0 0 auto !important;
                display: flex !important;
                align-items: center !important;
                gap: 4px !important;
                pointer-events: auto !important;
                z-index: 4 !important;
                position: relative !important;
            }
            #bg-color-picker,
            #image-display-restore-btn,
            #image-display-maximize-btn {
                pointer-events: auto !important;
                z-index: 5 !important;
                position: relative !important;
            }
            #bg-color-picker {
                width: 22px !important;
                height: 22px !important;
                padding: 0 !important;
                border: 1px solid #888 !important;
                border-radius: 3px !important;
                cursor: pointer !important;
                box-sizing: border-box !important;
                flex: 0 0 auto !important;
                background-color: transparent !important;
            }
            #image-display-restore-btn,
            #image-display-maximize-btn {
                width: 22px !important;
                height: 22px !important;
                padding: 0 !important;
                background-color: #444 !important;
                color: #fff !important;
                border: 1px solid #666 !important;
                border-radius: 3px !important;
                cursor: pointer !important;
                font-size: 13px !important;
                line-height: 1 !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                box-sizing: border-box !important;
                flex: 0 0 auto !important;
                user-select: none !important;
            }
            #image-display-restore-btn:hover,
            #image-display-maximize-btn:hover {
                background-color: #666 !important;
            }
            #image-display-restore-btn:active,
            #image-display-maximize-btn:active {
                background-color: #222 !important;
            }
            #image-display-restore-btn.size-btn-disabled,
            #image-display-maximize-btn.size-btn-disabled {
                opacity: 0.3 !important;
                cursor: not-allowed !important;
                pointer-events: none !important;
            }
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
        el.addEventListener('mousedown', (e) => { e.stopPropagation(); });
        el.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
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

    const textModeButton = document.createElement('button');
    textModeButton.id = 'text-mode-button';
    textModeButton.textContent = 'UT';
    textModeButton.title = 'クリックでテキストモード切り替え（現在: ユーザー）';
    document.body.appendChild(textModeButton);

    const customButton = document.createElement('button');
    customButton.id = 'custom-button';
    customButton.textContent = '手動';
    customButton.title = '位置とサイズを手動設定';

    const maximizeButton = document.createElement('button');
    maximizeButton.id = 'maximize-button';
    maximizeButton.textContent = 'フル';
    maximizeButton.title = '全画面モードに切替';
    maximizeButton.classList.add('enabled');

    const halfMaximizeButton = document.createElement('button');
    halfMaximizeButton.id = 'half-maximize-button';
    halfMaximizeButton.textContent = '左半分';
    halfMaximizeButton.title = '左半分モードに切替';
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

    function getTopBarZIndex() {
        const topBar = document.getElementById('top-bar');
        if (!topBar) return NaN;
        try {
            const z = parseInt(window.getComputedStyle(topBar).zIndex, 10);
            return Number.isFinite(z) ? z : NaN;
        } catch (e) {
            return NaN;
        }
    }

    function applyHeaderZIndex() {
        if (!header) return;
        const topBarZ = getTopBarZIndex();
        let headerZ = parseInt(Z_INDEX_HEADER_DEFAULT, 10);

        if (Number.isFinite(topBarZ) && topBarZ > 1) {
            headerZ = Math.max(500, topBarZ - 1);
        }
        header.style.setProperty('z-index', String(headerZ), 'important');
    }

    function shouldShowHeader() {
        return isCustomWindowOpen === true;
    }

    function setHeaderVisible(visible) {
        if (!header) return;
        if (headerVisible === visible) return;
        headerVisible = visible;
        header.classList.toggle('idp-visible', visible);
    }

    function syncHeaderVisibility() {
        setHeaderVisible(shouldShowHeader());
    }

    // ============================================================
    // ★ #top-bar / #top-settings-holder の hover 表示制御（連動）
    // ============================================================
    function getTopBar() {
        return document.getElementById('top-bar');
    }

    function getTopSettingsHolder() {
        return document.getElementById('top-settings-holder');
    }

    function setTopBarVisible(visible) {
        const topBar = getTopBar();
        const settingsHolder = getTopSettingsHolder();
        if (!topBar && !settingsHolder) return;
        if (topBarHoverVisible === visible) return;
        topBarHoverVisible = visible;
        if (topBar) topBar.classList.toggle('idp-topbar-visible', visible);
        if (settingsHolder) settingsHolder.classList.toggle('idp-topbar-visible', visible);
    }

    function isInsideRect(rect, x, y, margin) {
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        return x >= rect.left - margin &&
               x <= rect.right + margin &&
               y >= rect.top - margin &&
               y <= rect.bottom + margin;
    }

    function updateTopBarVisibility(x, y) {
        const topBar = getTopBar();
        const settingsHolder = getTopSettingsHolder();

        if (!topBar && !settingsHolder) {
            setTopBarVisible(false);
            return;
        }

        if (x < 0 || y < 0) {
            setTopBarVisible(false);
            return;
        }

        let inside = false;
        if (topBar) {
            inside = inside || isInsideRect(topBar.getBoundingClientRect(), x, y, TOP_BAR_HOVER_MARGIN);
        }
        if (settingsHolder) {
            inside = inside || isInsideRect(settingsHolder.getBoundingClientRect(), x, y, TOP_BAR_HOVER_MARGIN);
        }

        setTopBarVisible(inside);
    }

    document.addEventListener('mousemove', (e) => {
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
        updateTopBarVisibility(e.clientX, e.clientY);
    }, { passive: true });

    document.addEventListener('mouseleave', () => {
        lastMouseX = -1;
        lastMouseY = -1;
        setTopBarVisible(false);
    });

    window.addEventListener('blur', () => {
        lastMouseX = -1;
        lastMouseY = -1;
        setTopBarVisible(false);
    });

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

    function normalizeConditionExpression(expr) {
        if (!expr || typeof expr !== 'string') return '';
        return expr
            .replace(/\band\b/gi, '+')
            .replace(/\bor\b/gi, ',')
            .replace(/\bnot\b/gi, '!');
    }

    function tokenizeCondition(expr) {
        const tokens = [];
        let i = 0;
        const len = expr.length;
        while (i < len) {
            const ch = expr[i];
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
            if (ch === '(' || ch === ')' || ch === '!' || ch === '+' || ch === ',') {
                tokens.push({ type: ch, value: ch });
                i++;
                continue;
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
            while (peek() && peek().type === ',') {
                consume(',');
                const right = parseAnd();
                node = { type: 'OR', left: node, right };
            }
            return node;
        }
        function parseAnd() {
            let node = parseUnary();
            while (peek() && peek().type === '+') {
                consume('+');
                const right = parseUnary();
                node = { type: 'AND', left: node, right };
            }
            return node;
        }
        function parseUnary() {
            if (peek() && peek().type === '!') {
                consume('!');
                return { type: 'NOT', operand: parseUnary() };
            }
            return parsePrimary();
        }
        function parsePrimary() {
            const t = peek();
            if (!t) return null;
            if (t.type === '(') {
                consume('(');
                const inner = parseOr();
                consume(')');
                return inner;
            }
            if (t.type === 'KEYWORD') {
                consume('KEYWORD');
                return { type: 'KEYWORD', value: t.value };
            }
            return null;
        }
        return parseOr();
    }

    function evaluateConditionNode(node, lowerText) {
        if (!node) return false;
        switch (node.type) {
            case 'KEYWORD':
                return lowerText.includes(node.value.toLowerCase());
            case 'AND':
                return evaluateConditionNode(node.left, lowerText) && evaluateConditionNode(node.right, lowerText);
            case 'OR':
                return evaluateConditionNode(node.left, lowerText) || evaluateConditionNode(node.right, lowerText);
            case 'NOT':
                return !evaluateConditionNode(node.operand, lowerText);
            default:
                return false;
        }
    }

    function getParsedConditionAst(condStr) {
        if (!condStr || typeof condStr !== 'string') return null;
        let ast = parsedConditionCache.get(condStr);
        if (ast !== undefined) return ast;
        try {
            const normalized = normalizeConditionExpression(condStr);
            const tokens = tokenizeCondition(normalized);
            if (tokens.length === 0) {
                parsedConditionCache.set(condStr, null);
                return null;
            }
            ast = parseConditionTokens(tokens);
            parsedConditionCache.set(condStr, ast);
            return ast;
        } catch (error) {
            console.error(`❌ 条件パースエラー "${condStr}":`, error);
            parsedConditionCache.set(condStr, null);
            return null;
        }
    }

    function evaluateCondition(condStr, text) {
        if (!condStr || !text) return false;
        try {
            const ast = getParsedConditionAst(condStr);
            if (!ast) return false;
            return evaluateConditionNode(ast, text.toLowerCase());
        } catch (error) {
            console.error(`❌ 条件評価エラー "${condStr}":`, error);
            return false;
        }
    }

    function getRandomImageSource(imageSource) {
        if (Array.isArray(imageSource)) {
            if (imageSource.length === 0) return null;
            const validSources = imageSource.filter(src => typeof src === 'string' && src.trim() !== '');
            if (validSources.length === 0) return null;
            const randomIndex = Math.floor(Math.random() * validSources.length);
            return validSources[randomIndex];
        }
        return (typeof imageSource === 'string' && imageSource.trim() !== '') ? imageSource : null;
    }

    function getSortedKeywordEntries() {
        if (!currentImageMap) return [];
        if (sortedKeywordEntriesCache && sortedKeywordEntriesCacheSource === currentImageMap) {
            return sortedKeywordEntriesCache;
        }
        sortedKeywordEntriesCacheSource = currentImageMap;
        sortedKeywordEntriesCache = Object.entries(currentImageMap)
            .filter(([key]) => key !== "default" && key !== "thumbnail")
            .map(([key, url]) => ({
                condition: key,
                url: url,
                complexity:
                    (key.match(/\band\b/gi) || []).length * 10 +
                    (key.match(/\bor\b/gi)  || []).length * 5  +
                    (key.match(/\+/g)       || []).length * 8  +
                    (key.match(/,/g)        || []).length * 4  +
                    (key.match(/!/g)        || []).length * 6  +
                    (key.match(/\(/g)       || []).length * 3  +
                    (key.match(/\)/g)       || []).length * 3  +
                    key.length
            }))
            .sort((a, b) => b.complexity - a.complexity);
        return sortedKeywordEntriesCache;
    }

    function findMatchingImageUrl(text) {
        if (!text || !currentImageMap) return null;

        const signature = getTextSignature(text);
        const now = Date.now();

        if (lastMatchCache.signature === signature &&
            (now - lastMatchCache.timestamp) < MATCH_CACHE_TTL) {
            return lastMatchCache.url;
        }

        const keywordEntries = getSortedKeywordEntries();

        for (const entry of keywordEntries) {
            try {
                if (evaluateCondition(entry.condition, text)) {
                    const selected = getRandomImageSource(entry.url);
                    if (selected) {
                        lastMatchCache = { signature, url: selected, timestamp: now };
                        return selected;
                    }
                }
            } catch (error) {
                console.error(`❌ 条件評価エラー "${entry.condition}":`, error);
            }
        }

        lastMatchCache = { signature, url: null, timestamp: now };
        return null;
    }

    function findLastKeywordImage() {
        const isUserMode = currentTextMode === 'user';
        const selector = `.mes[is_user="${isUserMode}"] .mes_text`;
        const messages = Array.from(document.querySelectorAll(selector));
        const start = Math.max(0, messages.length - MAX_MESSAGE_SCAN);
        for (let i = messages.length - 1; i >= start; i--) {
            const textContent = messages[i].textContent || messages[i].innerText || "";
            const mediaUrl = findMatchingImageUrl(textContent);
            if (mediaUrl) return mediaUrl;
        }
        return null;
    }

    async function updateImageWithUrl(targetUrl) {
        if (isDefaultImageFailed) return;

        if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.trim()) {
            console.warn("⚠ 空または不正なメディアURLのため、デフォルト画像へ安全にフォールバックします。");
            const fallback = getRandomImageSource(currentImageMap.default) || currentImageMap.default;
            if (fallback && fallback !== targetUrl && typeof fallback === 'string' && fallback.trim()) {
                await updateImageWithUrl(fallback);
            }
            return;
        }

        let newUrl = targetUrl.trim();

        if (!newUrl.match(/\.(png|jpg|jpeg|webp|gif|avif|bmp|mp4|webm)$/i)) {
            const detected = await detectImageExtension(newUrl);
            if (detected) {
                newUrl = detected;
            } else {
                console.warn(`⚠ メディア拡張子の補完に失敗しました: ${newUrl}`);
                return;
            }
        }

        if (currentImageUrl === newUrl && mediaContainer.children.length > 0) {
            return;
        }

        console.log(`🖼 メディアを更新: ${newUrl}`);
        currentImageUrl = newUrl;

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
            const imgElement = document.createElement('img');
            imgElement.style.width = '100%';
            imgElement.style.height = '100%';
            imgElement.style.objectFit = 'contain';

            imgElement.onload = () => {
                if (currentImageUrl === newUrl) {
                    mediaContainer.innerHTML = '';
                    mediaContainer.appendChild(imgElement);
                }
            };
            imgElement.onerror = () => handleMediaError(imgElement, newUrl);
            imgElement.src = newUrl;

            if (typeof imgElement.decode === 'function') {
                imgElement.decode().catch(() => {});
            }
        }
    }

    async function updateImage() {
        if (isDefaultImageFailed) return;

        if (isOverrideActive) {
            if (overrideImageUrl) {
                if (currentImageUrl !== overrideImageUrl) {
                    await updateImageWithUrl(overrideImageUrl);
                }
            } else {
                const fallback = getRandomImageSource(currentImageMap.default) || currentImageMap.default;
                if (fallback && typeof fallback === 'string' && fallback.trim()) {
                    if (currentImageUrl !== fallback) {
                        await updateImageWithUrl(fallback);
                    }
                }
            }
            return;
        }

        const keywordMedia = findLastKeywordImage();
        let newUrl = keywordMedia || getRandomImageSource(currentImageMap.default) || currentImageMap.default;

        if (!newUrl || typeof newUrl !== 'string' || !newUrl.trim()) {
            return;
        }
        await updateImageWithUrl(newUrl);
    }

    const safeUpdateImage = debounce(() => {
        updateImage();
    }, 50);

    async function handleMediaError(element, src) {
        console.error("メディアの読み込みに失敗しました:", src);

        if (isOverrideActive && overrideImageUrl &&
            typeof src === 'string' && src === overrideImageUrl) {
            console.warn(`⚠ override画像の読み込みに失敗したため、override状態を自動解除します: ${src}`);
            clearOverrideState({ save: true, reason: 'override画像の読み込み失敗' });

            setTimeout(() => {
                safeUpdateImage();
            }, 100);
            return;
        }

        if (src && typeof src === 'string' && !src.match(/\.(png|jpg|jpeg|webp|gif|avif|bmp|mp4|webm)$/i)) {
            const detectedPath = await detectImageExtension(src);
            if (detectedPath) {
                element.src = detectedPath;
                if (isVideoUrl(detectedPath) && element.tagName.toLowerCase() === 'video') {
                    element.play().catch(() => {});
                }
                return;
            }
        }
        if (src && (src.match(/default\.(png|jpg|jpeg|webp|gif|avif|bmp|mp4|webm)$/i) || src.endsWith('/default'))) {
            isDefaultImageFailed = true;
            console.warn("⚠ デフォルトメディアが見つかりません。表示を無効化します");
            mediaContainer.style.display = 'none';
        } else {
            const fallback = getRandomImageSource(currentImageMap.default) || currentImageMap.default;
            if (fallback && fallback !== src && typeof fallback === 'string' && fallback.trim()) {
                element.src = fallback.trim();
                if (isVideoUrl(fallback) && element.tagName.toLowerCase() === 'video') {
                    element.play().catch(() => {});
                }
            }
        }
    }

    function setupSendInterception() {
        if (isSendInterceptionInstalled) return;
        isSendInterceptionInstalled = true;

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            const target = e.target;
            if (!target || target.id !== 'send_textarea') return;
            if (currentTextMode !== 'user') return;

            const text = target.value;
            if (!text || !text.trim()) return;

            const matchedUrl = findMatchingImageUrl(text);
            if (matchedUrl) {
                console.log(`⌨️ Enter 傍受: "${text.slice(0, 40)}..." → ${matchedUrl}`);
                updateImageWithUrl(matchedUrl);
            }
        }, true);

        document.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('#send_but') : null;
            if (!btn) return;
            if (currentTextMode !== 'user') return;

            const textarea = document.querySelector('#send_textarea');
            if (!textarea) return;
            const text = textarea.value;
            if (!text || !text.trim()) return;

            const matchedUrl = findMatchingImageUrl(text);
            if (matchedUrl) {
                console.log(`🖱 送信ボタン傍受: "${text.slice(0, 40)}..." → ${matchedUrl}`);
                updateImageWithUrl(matchedUrl);
            }
        }, true);

        console.log("✅ 送信操作のキャプチャ傍受をインストールしました。");
    }

    function toggleTextMode() {
        currentTextMode = currentTextMode === 'user' ? 'ai' : 'user';
        textModeButton.textContent = currentTextMode === 'user' ? 'UT' : 'AI';
        textModeButton.title = `クリックでテキストモード切り替え（現在: ${currentTextMode === 'user' ? 'ユーザー' : 'AI'}）`;
        console.log(`🔄 テキストモード切替: ${currentTextMode}`);
        invalidateMatchCache();
        saveDisplayState();
        safeUpdateImage();
    }
    textModeButton.addEventListener('click', toggleTextMode);

    function handleStreamingUpdate() {
        if (currentTextMode !== 'ai') return;
        const lastAiMessage = document.querySelector('.mes[is_user="false"]:last-child .mes_text');
        if (!lastAiMessage) return;

        const currentText = lastAiMessage.textContent;
        if (currentText === lastStreamingText) return;
        lastStreamingText = currentText;

        if (streamingTimer) clearTimeout(streamingTimer);
        streamingTimer = setTimeout(() => {
            safeUpdateImage();
        }, STREAMING_DELAY);
    }

    function setupChatDomObserver() {
        const chatContainer = document.querySelector('#chat');
        if (!chatContainer) return;
        if (chatDomObserver) chatDomObserver.disconnect();

        const debouncedUpdate = debounce(() => {
            handleStreamingUpdate();
            safeUpdateImage();
        }, 150);

        chatDomObserver = new MutationObserver((mutations) => {
            debouncedUpdate();
        });

        chatDomObserver.observe(chatContainer, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function findImageMapInData(data) {
        if (data === null || typeof data !== 'object') return null;
        if (data.hasOwnProperty('image_display_extension')) {
            const potentialMap = data.image_display_extension;
            if (typeof potentialMap === 'object' && potentialMap !== null) {
                return potentialMap;
            }
        }
        for (const key in data) {
            if (data.hasOwnProperty(key)) {
                const result = findImageMapInData(data[key]);
                if (result !== null) return result;
            }
        }
        return null;
    }

    function getCharacterNameFromDOM() {
        const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        const userName = (context && (context.name1 || context.user_name)) || 'ユーザー';

        if (context && context.character && context.character.name && context.character.name !== userName) {
            return context.character.name;
        }

        if (context && context.characters && typeof context.characterId !== 'undefined' && context.characters[context.characterId]) {
            const cName = context.characters[context.characterId].name;
            if (cName && cName !== userName) return cName;
        }

        const selectedOption = document.querySelector('#character_select option:checked, select[name="character"] option:checked');
        if (selectedOption && selectedOption.textContent.trim()) {
            const val = selectedOption.textContent.trim();
            if (val !== userName) return val;
        }

        const nameEl = document.querySelector('#character_name_holder, #character_name_id, .character_name, .ch_name');
        if (nameEl && nameEl.textContent.trim()) {
            const val = nameEl.textContent.trim();
            if (val !== userName) return val;
        }

        const navBlock = document.querySelector('.right-nav-char-block[data-name]');
        if (navBlock && navBlock.dataset && navBlock.dataset.name) {
            const val = navBlock.dataset.name;
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
                invalidateAllCaches();
                safeUpdateImage();
            }
            return;
        }

        if (!forceRefresh && currentCharacter === charName && currentImageMap !== defaultImageMap) {
            return;
        }

        currentCharacter = charName;
        console.log(`👤 キャラクター検出: ${charName}`);

        if (!forceRefresh && imageMapCache.has(charName)) {
            currentImageMap = imageMapCache.get(charName);
            invalidateAllCaches();
            preloadCharacterImages(currentImageMap);
            safeUpdateImage();
            return;
        }

        let loadedMap = null;
        try {
            const extPath = `addchara/${charName}/${charName}_ext.json`;
            const resp = await fetch(extPath);
            if (resp.ok) {
                const data = await resp.json();
                loadedMap = findImageMapInData(data);
            }
        } catch (e) {
            console.warn(`[Image Display] ${charName}_ext.json の読み込みをスキップ:`, e);
        }

        const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!loadedMap && context && context.character && context.character.data) {
            loadedMap = findImageMapInData(context.character.data);
        }

        if (loadedMap) {
            const detectedMap = await detectImageMapExtensions(loadedMap);
            currentImageMap = detectedMap;
            imageMapCache.set(charName, detectedMap);
            console.log(`✅ キャラクター設定マップをロードしました (${charName}):`, currentImageMap);
        } else {
            console.warn(`⚠ ${charName} の拡張設定が見つかりませんでした。デフォルト画像を使用します。`);
            currentImageMap = await detectImageMapExtensions(defaultImageMap);
        }

        invalidateAllCaches();
        preloadCharacterImages(currentImageMap);
        safeUpdateImage();
    }

    function toggleCustomWindow() {
        if (isCustomWindowOpen) {
            closeCustomWindow();
        } else {
            openCustomWindow();
        }
    }

    function openCustomWindow() {
        if (currentMode !== 'normal') {
            applyNormalMode();
            saveDisplayState();
        }
        document.getElementById('custom-width').value = imageContainer.offsetWidth;
        document.getElementById('custom-height').value = imageContainer.offsetHeight;
        document.getElementById('custom-left').value = parseInt(imageContainer.style.left) || DEFAULT_LEFT;
        document.getElementById('custom-top').value = parseInt(imageContainer.style.top) || DEFAULT_TOP;
        customWindow.style.display = 'block';
        isCustomWindowOpen = true;
        syncHeaderVisibility();
    }

    function closeCustomWindow() {
        customWindow.style.display = 'none';
        isCustomWindowOpen = false;
        syncHeaderVisibility();
    }

    function updateCustomWindow() {
        if (!isCustomWindowOpen) return;
        document.getElementById('custom-width').value = imageContainer.offsetWidth;
        document.getElementById('custom-height').value = imageContainer.offsetHeight;
        document.getElementById('custom-left').value = parseInt(imageContainer.style.left) || 0;
        document.getElementById('custom-top').value = parseInt(imageContainer.style.top) || 0;
    }

    customButton.addEventListener('click', toggleCustomWindow);
    document.getElementById('close-custom-window').addEventListener('click', closeCustomWindow);

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
            textMode: currentTextMode,
            isOverrideActive,
            overrideImageUrl,
        };
        const context = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (context && context.extensionSettings) {
            context.extensionSettings[MODULE_NAME] = state;
            if (typeof context.saveSettingsDebounced === 'function') {
                context.saveSettingsDebounced();
            }
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
                        if (typeof context.saveSettingsDebounced === 'function') {
                            context.saveSettingsDebounced();
                        }
                        localStorage.removeItem(OLD_STORAGE_KEY);
                    }
                } catch (e) {
                    console.error('[Image Display] 旧データの移行に失敗しました:', e);
                }
            }
        }

        if (state) {
            try {
                if (state.preNormalState) {
                    const pns = state.preNormalState;
                    const w = Number(pns.width);
                    const h = Number(pns.height);
                    const l = Number(pns.left);
                    const t = Number(pns.top);
                    preNormalState = {
                        width: Number.isFinite(w) && w > 0 ? w : DEFAULT_WIDTH,
                        height: Number.isFinite(h) && h > 0 ? h : DEFAULT_HEIGHT,
                        left: Number.isFinite(l) ? l : DEFAULT_LEFT,
                        top: Number.isFinite(t) ? t : DEFAULT_TOP,
                    };
                }
                if (state.bgColor) {
                    imageContainer.style.backgroundColor = state.bgColor;
                    colorPicker.value = state.bgColor;
                }
                currentMode = state.currentMode || 'normal';
                if (state.textMode) {
                    currentTextMode = state.textMode;
                    textModeButton.textContent = currentTextMode === 'user' ? 'UT' : 'AI';
                    textModeButton.title = `クリックでテキストモード切り替え（現在: ${currentTextMode === 'user' ? 'ユーザー' : 'AI'}）`;
                }

                if (state.isOverrideActive) {
                    isOverrideActive = true;
                    overrideImageUrl = (typeof state.overrideImageUrl === 'string' && state.overrideImageUrl.trim())
                        ? state.overrideImageUrl.trim()
                        : null;
                    console.log(`[Image Display] override状態を復元: ${overrideImageUrl || '(デフォルト)'}`);
                } else {
                    isOverrideActive = false;
                    overrideImageUrl = null;
                }

                switch (currentMode) {
                    case 'maximized':
                        applyMaximizeMode();
                        break;
                    case 'halfMaximized':
                        applyHalfMaximizeMode();
                        break;
                    default:
                        applyNormalMode();
                        break;
                }
            } catch (e) {
                console.error('状態復元エラー:', e);
                setDefaultDisplayState();
            }
        } else {
            setDefaultDisplayState();
        }
    }

    async function validateRestoredOverride() {
        if (!isOverrideActive) return;
        if (!overrideImageUrl) {
            console.log('ℹ override状態（URL未指定）を確認しました（デフォルト画像を使用）');
            return;
        }

        try {
            const exists = await checkMediaExists(overrideImageUrl);
            if (!exists) {
                console.warn(`⚠ 復元された override画像が存在しません。override状態を解除します: ${overrideImageUrl}`);
                clearOverrideState({ save: true, reason: '復元時の存在確認失敗' });
                safeUpdateImage();
            } else {
                console.log(`✅ 復元された override画像の存在を確認: ${overrideImageUrl}`);
            }
        } catch (e) {
            console.error('[Image Display] override画像の存在確認でエラー:', e);
        }
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

        if (currentMode === 'normal') {
            restoreBtn.classList.add('size-btn-disabled');
        } else if (currentMode === 'maximized') {
            maximizeBtn.classList.add('size-btn-disabled');
        }
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
        maximizeButton.classList.remove('disabled');
        maximizeButton.classList.add('enabled');
        halfMaximizeButton.classList.remove('disabled');
        halfMaximizeButton.classList.add('enabled');
        customButton.classList.remove('disabled');
        customButton.classList.add('enabled');
        currentMode = 'normal';
        updateSizeButtons();
        syncHeaderPosition();
        syncHeaderVisibility();
    }

    function applyMaximizeMode() {
        if (currentMode === 'normal') {
            updatePreNormalStateFromDOM();
        }

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
        maximizeButton.classList.remove('enabled');
        maximizeButton.classList.add('disabled');
        halfMaximizeButton.classList.remove('disabled');
        halfMaximizeButton.classList.add('enabled');
        customButton.classList.remove('disabled');
        customButton.classList.add('enabled');
        currentMode = 'maximized';
        updateSizeButtons();
        syncHeaderPosition();
        syncHeaderVisibility();
    }

    function applyHalfMaximizeMode() {
        if (currentMode === 'normal') {
            updatePreNormalStateFromDOM();
        }

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
        maximizeButton.classList.remove('disabled');
        maximizeButton.classList.add('enabled');
        halfMaximizeButton.classList.remove('enabled');
        halfMaximizeButton.classList.add('disabled');
        customButton.classList.remove('disabled');
        customButton.classList.add('enabled');
        currentMode = 'halfMaximized';
        updateSizeButtons();
        syncHeaderPosition();
        syncHeaderVisibility();
    }

    restoreDisplayState();

    validateRestoredOverride();

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
        e.stopPropagation();
        e.preventDefault();
        console.log(`[Image Display] ❐ 元に戻すボタンがクリックされました (mode=${currentMode})`);
        if (currentMode === 'normal') {
            console.log('[Image Display] 既に normal モードのため、何もしません');
            return;
        }
        applyNormalMode();
        saveDisplayState();
    });

    maximizeSizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        console.log(`[Image Display] ⛶ 最大化ボタンがクリックされました (mode=${currentMode})`);
        if (currentMode === 'maximized') {
            console.log('[Image Display] 既に maximized モードのため、何もしません');
            return;
        }
        applyMaximizeMode();
        saveDisplayState();
    });

    colorPicker.addEventListener('click', (e) => {
        e.stopPropagation();
        console.log('[Image Display] 🎨 カラーピッカーがクリックされました');
    });

    function isOnHeaderControl(e) {
        const target = e.target;
        if (target && target.closest) {
            if (target.closest('#image-display-header-controls') ||
                target.closest('#bg-color-picker') ||
                target.closest('#image-display-restore-btn') ||
                target.closest('#image-display-maximize-btn')) {
                return true;
            }
        }
        const path = e.composedPath ? e.composedPath() : [];
        return path.some(el =>
            el && el.id && [
                'image-display-header-controls',
                'bg-color-picker',
                'image-display-restore-btn',
                'image-display-maximize-btn'
            ].includes(el.id)
        );
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
        if (isDragging && currentMode === 'normal') {
            imageContainer.style.left = `${e.clientX - offsetX}px`;
            imageContainer.style.top = `${e.clientY - offsetY}px`;
            syncHeaderPosition();
            if (isCustomWindowOpen) updateCustomWindow();
        }
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            imageContainer.classList.remove('dragging');
            if (currentMode === 'normal') header.style.cursor = 'grab';
            if (currentMode === 'normal') {
                updatePreNormalStateFromDOM();
            }
            syncHeaderPosition();
            saveDisplayState();
        }
    });

    resizeHandle.addEventListener('mousedown', (e) => {
        if (currentMode !== 'normal') return;
        e.stopPropagation();
        isResizing = true;
        imageContainer.classList.add('resizing');
        const startX = e.clientX;
        const startY = e.clientY;
        const startWidth = imageContainer.offsetWidth;
        const startHeight = imageContainer.offsetHeight;

        function handleResize(e) {
            if (isResizing) {
                const newWidth = Math.max(100, startWidth + (e.clientX - startX));
                const newHeight = Math.max(100, startHeight + (e.clientY - startY));
                imageContainer.style.width = `${newWidth}px`;
                imageContainer.style.height = `${newHeight}px`;
                syncHeaderPosition();
                if (isCustomWindowOpen) updateCustomWindow();
            }
        }

        function stopResize() {
            if (isResizing) {
                isResizing = false;
                imageContainer.classList.remove('resizing');
                if (currentMode === 'normal') {
                    updatePreNormalStateFromDOM();
                }
                syncHeaderPosition();
                saveDisplayState();
                document.removeEventListener('mousemove', handleResize);
                document.removeEventListener('mouseup', stopResize);
            }
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
        updateTopBarVisibility(lastMouseX, lastMouseY);
    });

    setInterval(() => {
        syncHeaderPosition();
        updateTopBarVisibility(lastMouseX, lastMouseY);
    }, 500);

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

                safeOn(eventTypes.STREAM_TOKEN_RECEIVED, handleStreamingUpdate);

                const immediateUpdate = () => {
                    updateImage();
                };

                safeOn(eventTypes.CHARACTER_MESSAGE_RENDERED, immediateUpdate);
                safeOn(eventTypes.USER_MESSAGE_RENDERED, immediateUpdate);

                if (eventTypes.MESSAGE_DELETED) safeOn(eventTypes.MESSAGE_DELETED, immediateUpdate);
                if (eventTypes.MESSAGE_EDITED) safeOn(eventTypes.MESSAGE_EDITED, immediateUpdate);
                if (eventTypes.CHAT_LOADED) safeOn(eventTypes.CHAT_LOADED, immediateUpdate);

                const onCharacterOrChatChanged = () => {
                    loadCharacterData(true);
                };

                safeOn(eventTypes.CHAT_CHANGED, onCharacterOrChatChanged);
                safeOn(eventTypes.CHARACTER_SELECTED, onCharacterOrChatChanged);

                console.log("✅ SillyTavern EventSource による監視を開始しました。");
            }
        }
    }

    setupEventSourceListeners();
    setupSendInterception();
    loadCharacterData(true);
    setupChatDomObserver();

    updateTopBarVisibility(-1, -1);

    let pollCount = 0;
    const initialPoll = setInterval(() => {
        loadCharacterData();
        pollCount++;
        if (pollCount > 10) clearInterval(initialPoll);
    }, 1000);

    function positionTextModeButton() {
        const textModeBtn = document.getElementById('text-mode-button');
        if (!textModeBtn) return;

        if (isOverrideActive) {
            if (textModeBtn.style.display !== 'none') {
                console.log('🎨 背景生成モード → UT/AI ボタンを非表示化');
            }
            textModeBtn.style.display = 'none';
            textModeBtn.style.pointerEvents = 'none';
            return;
        }

        const gicBtn = document.getElementById('gic-release-override-button');

        if (!gicBtn) {
            textModeBtn.style.display = 'none';
            return;
        }
        const gicDisplay = window.getComputedStyle(gicBtn).display;
        if (gicDisplay === 'none') {
            textModeBtn.style.display = 'none';
            return;
        }

        const gicRect = gicBtn.getBoundingClientRect();
        if (gicRect.width === 0 || gicRect.height === 0) {
            textModeBtn.style.display = 'none';
            return;
        }

        if (textModeBtn.style.display === 'none') {
            console.log('📋 事前設定モード → UT/AI ボタンを再表示');
        }
        if (textModeBtn.style.display === 'none') {
            textModeBtn.style.display = '';
        }
        textModeBtn.style.pointerEvents = '';

        const gap = 5;
        const btnW = textModeBtn.offsetWidth  || 40;
        const btnH = textModeBtn.offsetHeight || 30;

        let left = gicRect.right + gap;
        let top  = gicRect.top + (gicRect.height - btnH) / 2;

        const margin = 4;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (left < margin) left = margin;
        if (left + btnW > vw - margin) left = vw - margin - btnW;
        if (top  < margin) top  = margin;
        if (top + btnH > vh - margin) top = vh - margin - btnH;

        textModeBtn.style.setProperty('z-index', '15000', 'important');
        textModeBtn.style.setProperty('position', 'fixed', 'important');
        textModeBtn.style.setProperty('left', Math.round(left) + 'px', 'important');
        textModeBtn.style.setProperty('top', Math.round(top) + 'px', 'important');
        textModeBtn.style.setProperty('right', 'auto', 'important');
        textModeBtn.style.setProperty('bottom', 'auto', 'important');
        textModeBtn.style.setProperty('transform', 'none', 'important');
    }

    setInterval(positionTextModeButton, 200);
    window.addEventListener('resize', positionTextModeButton);

    function isGalleryOpen() {
        const candidates = document.querySelectorAll([
            '#gallery_container',
            '.gallery-container',
            '.gallery_container',
            '#gallery',
            '.gallery',
            '[data-gallery-container]',
            '.gallery-grid',
            '#gallery-grid',
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

        if (galleryOpen) {
            controlContainer.style.display = 'none';
            console.log('📷 ギャラリー表示中 → コントロールボタンを非表示');
        } else {
            controlContainer.style.display = 'flex';
            console.log('📷 ギャラリー非表示 → コントロールボタンを再表示');
        }

        const textModeBtn = document.getElementById('text-mode-button');
        if (textModeBtn) {
            if (galleryOpen) {
                textModeBtn.style.display = 'none';
            } else {
                textModeBtn.style.display = '';
            }
        }

        const gicButton = document.getElementById('gic-release-override-button');
        if (gicButton) {
            if (galleryOpen) {
                gicButton.style.display = 'none';
                console.log('📷 ギャラリー表示中 → GICトグルボタンを非表示');
            } else {
                gicButton.style.display = '';
                console.log('📷 ギャラリー非表示 → GICトグルボタンを再表示');
            }
        }
    }

    function setupGalleryObserver() {
        const galleryObserver = new MutationObserver(() => {
            updateControlContainerVisibility();
        });
        galleryObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class'],
        });

        setInterval(updateControlContainerVisibility, 300);

        updateControlContainerVisibility();
        console.log('📷 ギャラリー連動監視を開始しました');
    }

    setupGalleryObserver();

    requestAnimationFrame(positionTextModeButton);

    window.ImageDisplayExtension = {
        setOverrideImage: async function (url) {
            const cleanUrl = (url && typeof url === 'string') ? url.trim() : '';

            if (cleanUrl) {
                const exists = await checkMediaExists(cleanUrl);
                if (!exists) {
                    console.warn(`⚠ 指定されたURLが存在しないため、override画像を設定できません: ${cleanUrl}`);
                    clearOverrideState({ save: true, reason: 'setOverrideImage: URL存在確認失敗' });
                    safeUpdateImage();
                    return false;
                }
            }

            overrideImageUrl = cleanUrl || null;
            isOverrideActive = true;

            if (overrideImageUrl) {
                console.log(`🎯 外部連携: 画像を強制表示 ${overrideImageUrl}`);
                await updateImageWithUrl(overrideImageUrl);
            } else {
                console.log(`🎯 外部連携: 強制表示モードON（デフォルト画像）`);
                const fallback = getRandomImageSource(currentImageMap.default) || currentImageMap.default;
                if (fallback && typeof fallback === 'string' && fallback.trim()) {
                    await updateImageWithUrl(fallback);
                }
            }
            saveDisplayState();
            return true;
        },

        clearOverrideImage: function () {
            clearOverrideState({ save: true, reason: 'API clearOverrideImage' });
            safeUpdateImage();
        },

        getCurrentImageUrl: function () {
            return currentImageUrl;
        },

        isOverride: function () {
            return isOverrideActive;
        },

        getOverrideImageUrl: function () {
            return overrideImageUrl;
        },

        applyNormalMode: function () {
            console.log('🎯 API: applyNormalMode を実行');
            applyNormalMode();
            saveDisplayState();
        },
        applyMaximizeMode: function () {
            console.log('🎯 API: applyMaximizeMode を実行（フル表示）');
            applyMaximizeMode();
            saveDisplayState();
        },
        applyHalfMaximizeMode: function () {
            console.log('🎯 API: applyHalfMaximizeMode を実行（左半分表示）');
            applyHalfMaximizeMode();
            saveDisplayState();
        },
        getCurrentMode: function () {
            return currentMode;
        },

        openCustomWindow: function () {
            console.log('🎯 API: openCustomWindow を実行');
            try {
                openCustomWindow();
            } catch (e) {
                console.warn('openCustomWindow エラー:', e);
            }
        },
        closeCustomWindow: function () {
            console.log('🎯 API: closeCustomWindow を実行');
            try {
                closeCustomWindow();
            } catch (e) {
                console.warn('closeCustomWindow エラー:', e);
            }
        },
        isCustomWindowOpen: function () {
            return isCustomWindowOpen;
        },
        syncHeaderPosition: syncHeaderPosition,
        applyHeaderZIndex: applyHeaderZIndex,
        syncHeaderVisibility: syncHeaderVisibility,
        updateTopBarVisibility: updateTopBarVisibility,
        setTopBarVisible: setTopBarVisible,
    };
    console.log("✅ Image Display Extension API を window.ImageDisplayExtension に公開しました");
})();
