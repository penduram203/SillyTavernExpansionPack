(function () {
    console.log("Image Display: 初期化を開始します。");
    const MODULE_NAME = 'image_display';
    const OLD_STORAGE_KEY = 'imageDisplayState';

    // メディアの存在確認・読み込み用キャッシュマップ
    const mediaExistsCache = new Map();

    // --- デフォルト値とグローバル変数の定義 ---
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
    let currentTextMode = 'user'; // 'user' または 'ai'
    let streamingTimer = null;
    let lastStreamingText = '';
    const STREAMING_DELAY = 500;
    let chatDomObserver = null;

    // --- 外部連携用：強制表示（override）状態 ---
    let isOverrideActive = false;
    let overrideImageUrl = null;

    // --- マッチキャッシュ（二重発火によるちらつき防止） ---
    let lastMatchCache = { signature: null, url: null, timestamp: 0 };
    const MATCH_CACHE_TTL = 1500; // ms

    // --- 条件式 AST パースキャッシュ（毎回パースしない） ---
    const parsedConditionCache = new Map();

    // --- ソート済みキーワードエントリキャッシュ（毎回ソートしない） ---
    let sortedKeywordEntriesCache = null;
    let sortedKeywordEntriesCacheSource = null;

    // --- findLastKeywordImage の探索上限（最新N件のみ走査） ---
    const MAX_MESSAGE_SCAN = 20;

    // --- 送信傍受の多重登録防止フラグ ---
    let isSendInterceptionInstalled = false;

    function getTextSignature(text) {
        if (!text || typeof text !== 'string') return '';
        // 末尾200文字をシグネチャとして使用
        return text.slice(-200);
    }

    function invalidateMatchCache() {
        lastMatchCache = { signature: null, url: null, timestamp: 0 };
    }

    function invalidateSortedEntriesCache() {
        sortedKeywordEntriesCache = null;
        sortedKeywordEntriesCacheSource = null;
    }

    /**
     * ★ override 状態を解除する。
     */
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

    // デバウンス処理
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    }

    // --- 拡張子自動検出関数（動画・画像対応） ---
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

    // 高速チェック＆キャッシュ付きメディア確認
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

    // キャラクターの全メディアをプリロード（初回表示のラグ低減）
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

    // --- UI要素の作成 ---
    const imageContainer = document.createElement('div');
    imageContainer.id = 'image-display-container';
    document.body.appendChild(imageContainer);

    const header = document.createElement('div');
    header.id = 'image-display-header';
    header.textContent = 'メディア表示エリア (ドラッグで移動)';
    imageContainer.appendChild(header);

    const colorPicker = document.createElement('input');
    colorPicker.type = 'color';
    colorPicker.id = 'bg-color-picker';
    colorPicker.value = DEFAULT_BG_COLOR;
    colorPicker.title = '背景色を変更';
    header.appendChild(colorPicker);

    // メディア表示用コンテナ
    const mediaContainer = document.createElement('div');
    mediaContainer.id = 'media-element-container';
    mediaContainer.style.width = '100%';
    mediaContainer.style.height = 'calc(100% - 30px)';
    imageContainer.appendChild(mediaContainer);

    const resizeHandle = document.createElement('div');
    resizeHandle.id = 'resize-handle';
    imageContainer.appendChild(resizeHandle);

    // コントロールボタンコンテナ（手動のみ）
    const controlContainer = document.createElement('div');
    controlContainer.id = 'image-control-container';
    document.body.appendChild(controlContainer);

    // ★ UT/AI 切り替えボタンは独立させ、GIC ボタンの右隣に動的配置するため
    //    controlContainer ではなく body に直接追加する
    const textModeButton = document.createElement('button');
    textModeButton.id = 'text-mode-button';
    textModeButton.textContent = 'UT';
    textModeButton.title = 'クリックでテキストモード切り替え（現在: ユーザー）';
    document.body.appendChild(textModeButton);

    // ★ 手動ボタン: Text_styling の「手動」モードに統合したため DOM に追加しない
    const customButton = document.createElement('button');
    customButton.id = 'custom-button';
    customButton.textContent = '手動';
    customButton.title = '位置とサイズを手動設定';
    // controlContainer.appendChild(customButton);  // ← 統合により非表示

    // ★ Text_styling 側のボタンに統合したため、maximizeButton と
    //    halfMaximizeButton も DOM に追加しない。
    //    （API 経由で applyMaximizeMode / applyHalfMaximizeMode が呼ばれる）
    const maximizeButton = document.createElement('button');
    maximizeButton.id = 'maximize-button';
    maximizeButton.textContent = 'フル';
    maximizeButton.title = '全画面モードに切替';
    maximizeButton.classList.add('enabled');
    // controlContainer.appendChild(maximizeButton);  // ← 統合により非表示

    const halfMaximizeButton = document.createElement('button');
    halfMaximizeButton.id = 'half-maximize-button';
    halfMaximizeButton.textContent = '左半分';
    halfMaximizeButton.title = '左半分モードに切替';
    halfMaximizeButton.classList.add('enabled');
    // controlContainer.appendChild(halfMaximizeButton);  // ← 統合により非表示

    // カスタム設定ウィンドウ
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

    // --- 条件評価・キーワードロジック (カッコ / NOT / AND / OR 対応) ---

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
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
                i++;
                continue;
            }
            if (ch === '(' || ch === ')' || ch === '!' || ch === '+' || ch === ',') {
                tokens.push({ type: ch, value: ch });
                i++;
                continue;
            }
            let j = i;
            while (j < len && !'()!+,'.includes(expr[j])) {
                j++;
            }
            const raw = expr.slice(i, j).trim();
            if (raw) {
                tokens.push({ type: 'KEYWORD', value: raw });
            }
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
                const operand = parseUnary();
                return { type: 'NOT', operand };
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
                return evaluateConditionNode(node.left, lowerText)
                    && evaluateConditionNode(node.right, lowerText);
            case 'OR':
                return evaluateConditionNode(node.left, lowerText)
                    || evaluateConditionNode(node.right, lowerText);
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

    // --- 指定URLでの即時メディア更新 ---
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

    // --- DOM基準のメディア表示更新処理 ---
    async function updateImage() {
        if (isDefaultImageFailed) return;

        // ★ 外部連携による強制表示（override）モード
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

        // 通常モード: キーワードマッチ
        const keywordMedia = findLastKeywordImage();
        let newUrl = keywordMedia || getRandomImageSource(currentImageMap.default) || currentImageMap.default;

        if (!newUrl || typeof newUrl !== 'string' || !newUrl.trim()) {
            return;
        }
        await updateImageWithUrl(newUrl);
    }

    // 重複発火を抑止するデバウンス付き安全更新関数（高頻度イベント用）
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

    // --- 送信操作のキャプチャフェーズ傍受 ---
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

    // --- テキストモード切り替え ---
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

    // --- ストリーミング監視 ---
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

    // --- キャラクターデータの読み込み ---
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

    // --- カスタムウィンドウの制御 ---
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
    }

    function closeCustomWindow() {
        customWindow.style.display = 'none';
        isCustomWindowOpen = false;
    }

    function updateCustomWindow() {
        if (!isCustomWindowOpen) return;
        document.getElementById('custom-width').value = imageContainer.offsetWidth;
        document.getElementById('custom-height').value = imageContainer.offsetHeight;
        document.getElementById('custom-left').value = parseInt(imageContainer.style.left) || 0;
        document.getElementById('custom-top').value = parseInt(imageContainer.style.top) || 0;
    }

    // ★ customButton は DOM に追加していないが、リスナー登録は無害
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
            saveDisplayState();
        });
    });

    // --- 状態の永続化・復元 ---
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
                if (state.preNormalState) preNormalState = state.preNormalState;
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

    /**
     * ★ 復元された override URL が実際に存在するか非同期で検証する。
     */
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

    function applyNormalMode() {
        imageContainer.style.width = `${preNormalState.width}px`;
        imageContainer.style.height = `${preNormalState.height}px`;
        imageContainer.style.left = `${preNormalState.left}px`;
        imageContainer.style.top = `${preNormalState.top}px`;
        imageContainer.style.position = 'absolute';
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
    }

    function applyMaximizeMode() {
        if (currentMode === 'normal') {
            preNormalState = {
                width: imageContainer.offsetWidth,
                height: imageContainer.offsetHeight,
                left: parseInt(imageContainer.style.left) || DEFAULT_LEFT,
                top: parseInt(imageContainer.style.top) || DEFAULT_TOP
            };
        }
        imageContainer.style.width = '100%';
        imageContainer.style.height = '100%';
        imageContainer.style.left = '0';
        imageContainer.style.top = '0';
        imageContainer.style.position = 'fixed';
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
    }

    function applyHalfMaximizeMode() {
        if (currentMode === 'normal') {
            preNormalState = {
                width: imageContainer.offsetWidth,
                height: imageContainer.offsetHeight,
                left: parseInt(imageContainer.style.left) || DEFAULT_LEFT,
                top: parseInt(imageContainer.style.top) || DEFAULT_TOP
            };
        }
        imageContainer.style.width = '50vw';
        imageContainer.style.height = '100vh';
        imageContainer.style.left = '0';
        imageContainer.style.top = '0';
        imageContainer.style.position = 'fixed';
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
    }

    restoreDisplayState();

    // ★ 復元直後に override URL の存在を非同期検証（404ループ防止）
    validateRestoredOverride();

    // --- イベントリスナー設定 ---
    colorPicker.addEventListener('input', () => {
        imageContainer.style.backgroundColor = colorPicker.value;
        saveDisplayState();
    });

    // ★ maximizeButton / halfMaximizeButton は DOM に追加していないため、
    //    click リスナーは登録しない（API 経由で呼ばれる）

    header.addEventListener('mousedown', (e) => {
        if (e.target === colorPicker || currentMode !== 'normal') return;
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
            if (isCustomWindowOpen) updateCustomWindow();
        }
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            imageContainer.classList.remove('dragging');
            if (currentMode === 'normal') header.style.cursor = 'grab';
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
                if (isCustomWindowOpen) updateCustomWindow();
            }
        }

        function stopResize() {
            if (isResizing) {
                isResizing = false;
                imageContainer.classList.remove('resizing');
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
            imageContainer.style.width = '100%';
            imageContainer.style.height = '100%';
        } else if (currentMode === 'halfMaximized') {
            imageContainer.style.width = '50vw';
            imageContainer.style.height = '100vh';
        }
    });

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

    // --- 初期ロードとポーリング ---
    setupEventSourceListeners();
    setupSendInterception();
    loadCharacterData(true);
    setupChatDomObserver();

    let pollCount = 0;
    const initialPoll = setInterval(() => {
        loadCharacterData();
        pollCount++;
        if (pollCount > 10) clearInterval(initialPoll);
    }, 1000);

    // ===================================================================
    // ===== ★ UT/AIボタンをGICボタン（背景生成/事前設定）の右隣に配置 =====
    // ===================================================================
    function positionTextModeButton() {
        const textModeBtn = document.getElementById('text-mode-button');
        if (!textModeBtn) return;

        // ★ 背景生成（override）モード中は UT/AI ボタンを非表示・クリック不能にする
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

    // ===================================================================
    // ===== Gallery連動：公式ギャラリー表示中はコントロールボタンを非表示 =====
    // ===================================================================

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

    // ===================================================================
    // ===== 外部連携用API（Generate Image Controller などから呼び出す） =====
    // ===================================================================
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

        // ============================================================
        // ★ Text_styling 統合用 API
        //    Text_styling のトグルボタンから呼び出される
        //    - center モード: applyMaximizeMode
        //    - split  モード: applyHalfMaximizeMode
        //    - manual モード: applyNormalMode + openCustomWindow
        // ============================================================
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

        // ============================================================
        // ★ Text_styling 統合用 API（手動モード）
        //    カスタムウィンドウの開閉を外部から制御できるようにする
        // ============================================================
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
    };
    console.log("✅ Image Display Extension API を window.ImageDisplayExtension に公開しました");
})();
