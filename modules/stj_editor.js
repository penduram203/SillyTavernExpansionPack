// stj_editor.js
(function() {
    const MODULE_NAME = 'stj_editor';

    // ★ 多言語対応ヘルパー（window.ExpI18n が読まれていなくても安全）
    function _t(k, fb, p) {
        try {
            if (window.ExpI18n?.t) return window.ExpI18n.t(k, fb, p);
        } catch (e) { /* ignore */ }
        let s = (fb !== undefined) ? String(fb) : k;
        if (p && typeof p === 'object') {
            for (const kk of Object.keys(p)) s = s.split(`{${kk}}`).join(String(p[kk]));
        }
        return s;
    }
    // ★ gic.js と共有する定数（gic.js 側は独立して定義しているが、
    //   stj_editor.js から sync 関数内で参照するためここでも定義する）
    const UNREGISTER_EXCLUDED_KEYS = new Set(['default', 'thumbnail']);

    const mediaCache = new Map();
    const MEDIA_CACHE_FALSE_TTL_MS = 3000;
    const MEDIA_CHECK_TIMEOUT_MS = 5000;

    // ===== 動画サムネイルキャッシュ =====
    const THUMB_SUFFIX = '_thum.png';
    const THUMB_EXIST_CACHE_TTL_MS = 60000;
    const _stjThumbUrlCache = new Map();
    const _stjThumbExistCache = new Map();

    let stjModalEl = null;
    let outsideClickHandlerInstalled = false;
    let helpOutsideHandlerInstalled = false;
    let modalOpenedTimestamp = 0;
    const MODAL_OPEN_GUARD_MS = 300;

    let confirmDialogEl = null;
    let pendingDeleteCallback = null;
    let pendingCancelCallback = null;
    let messageDialogEl = null;

    let pointerDragState = null;
    let pointerDragHandlerInstalled = false;
    const DRAG_THRESHOLD_PX = 5;
    const CLICK_THRESHOLD_PX = 2;

    let _suppressCellClickUntil = 0;

    const AUTOSCROLL_EDGE_PX = 200;
    const AUTOSCROLL_MAX_SPEED = 35;
    let autoScrollRAF = null;
    let autoScrollTarget = null;
    let autoScrollDelta = 0;

    let isDialogActive = false;

    // ===== Cell Popup Modal 状態 =====
    let currentCellModal = null;
    let currentModalCell = null;
    let modalOriginalKeyword = '';
    let modalOriginalImages = [];

    // ===== セルモーダル レンダートークン =====
    let _currentGridRenderToken = 0;

    // ===== オートセーブ用 =====
    let _autoSaveTimer = null;

    // ===== エディタ初期化中フラグ =====
    let _editorLoading = false;
    const _explicitlyDeletedKeys = new Set();

    const STJ_MIGRATION_META_NS = 'image_display_extension_meta';
    const STJ_MIGRATION_FLAG_KEY = 'foreign_cleaned_version';
    const STJ_MIGRATION_VERSION = 1;

    function isMigrationDoneForChar(charName) {
        if (!charName) return false;
        try {
            const ctx = getSTContext();
            const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
            if (char?.name !== charName) return false;
            const v = char?.data?.extensions?.[STJ_MIGRATION_META_NS]?.[STJ_MIGRATION_FLAG_KEY] || 0;
            return v >= STJ_MIGRATION_VERSION;
        } catch (e) { return false; }
    }

    function markMigrationDoneForChar(charName) {
        if (!charName) return false;
        try {
            const ctx = getSTContext();
            const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
            if (char?.name !== charName) return false;
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};
            if (!char.data.extensions[STJ_MIGRATION_META_NS]) {
                char.data.extensions[STJ_MIGRATION_META_NS] = {};
            }
            char.data.extensions[STJ_MIGRATION_META_NS][STJ_MIGRATION_FLAG_KEY] = STJ_MIGRATION_VERSION;
            if (window.CharStore?.saveCharacterExtension) {
                window.CharStore.saveCharacterExtension(
                    STJ_MIGRATION_META_NS,
                    char.data.extensions[STJ_MIGRATION_META_NS],
                    { immediate: true }
                );
            }
            return true;
        } catch (e) { return false; }
    }

    // ===== ★ 動画サムネイル用 🎬 バッジのCSS注入 =====
    (function injectStjVideoBadgeStyle() {
        if (document.getElementById('stj-video-badge-style')) return;
        const style = document.createElement('style');
        style.id = 'stj-video-badge-style';
        style.textContent = `
            .stj-video-badge {
                position: absolute !important;
                top: 50% !important;
                left: 50% !important;
                transform: translate(-50%, -50%) !important;
                font-size: 24px !important;
                line-height: 1 !important;
                pointer-events: none !important;
                z-index: 10 !important;
                opacity: 0.95 !important;
                user-select: none !important;
                -webkit-user-select: none !important;
                filter:
                    drop-shadow(1px 0 0 #ffffff)
                    drop-shadow(-1px 0 0 #ffffff)
                    drop-shadow(0 1px 0 #ffffff)
                    drop-shadow(0 -1px 0 #ffffff)
                    drop-shadow(1px 1px 0 #ffffff)
                    drop-shadow(-1px -1px 0 #ffffff)
                    drop-shadow(1px -1px 0 #ffffff)
                    drop-shadow(-1px 1px 0 #ffffff)
                    drop-shadow(0 2px 3px rgba(0, 0, 0, 0.9)) !important;
            }
        `;
        document.head.appendChild(style);
    })();

    // ===== ★ ツリーレイアウト用 CSS 注入 =====
    (function injectStjTreeLayoutStyle() {
        if (document.getElementById('stj-tree-layout-style')) return;
        const style = document.createElement('style');
        style.id = 'stj-tree-layout-style';
        style.textContent = `
            #stj_keywords_container.stj-tree-mode {
                position: relative !important;
                display: block !important;
                padding: 0 !important;
                margin: 0 !important;
                min-height: 600px;
                max-width: 100%;
                overflow: auto;
            }
            #stj_keywords_container.stj-tree-mode > .stj-keyword-item {
                position: absolute !important;
                flex: none !important;
                display: flex !important;
                flex-direction: column;
                margin: 0 !important;
                box-sizing: border-box;
                z-index: 1;
                transition: left 0.15s ease, top 0.15s ease;
            }
            #stj_keywords_container.stj-tree-mode > .stj-keyword-item > .stj-image-preview {
                flex: 1 1 auto;
                min-height: 0;
                overflow: hidden;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            #stj_keywords_container.stj-tree-mode > .stj-keyword-item > .stj-image-preview > img,
            #stj_keywords_container.stj-tree-mode > .stj-keyword-item > .stj-image-preview > video {
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
            }
            #stj_keywords_container.stj-tree-mode > .stj-keyword-item > .stj-keyword-display {
                flex: 0 0 auto;
                text-align: center;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                padding: 4px 2px;
                font-size: 12px;
            }
            #stj_keywords_container.stj-tree-mode > .stj-tree-svg {
                position: absolute;
                top: 0;
                left: 0;
                pointer-events: none;
                overflow: visible;
                z-index: 0;
            }
            #stj_keywords_container.stj-tree-mode .stj-tree-bottom-left-other .stj-keyword-item {
                position: relative !important;
                left: auto !important;
                top: auto !important;
                flex: 0 0 auto !important;
            }
        `;
        document.head.appendChild(style);
    })();

    // ===== セルデータヘルパー =====
    function getCellImages(cell) {
        try {
            const raw = cell.getAttribute('data-image-list');
            if (!raw) return [];
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            return arr.filter(name =>
                typeof name === 'string' &&
                /\.(png|jpe?g|gif|webp|avif|bmp|mp4|webm)$/i.test(name)
            );
        } catch (e) { return []; }
    }

    function setCellImages(cell, arr) {
        cell.setAttribute('data-image-list', JSON.stringify(arr || []));
    }

    function getCellKeyword(cell) {
        return cell.getAttribute('data-keyword') || '';
    }

    function setCellKeyword(cell, kw) {
        cell.setAttribute('data-keyword', kw || '');
        const display = cell.querySelector('.stj-keyword-display');
        if (display) display.textContent = kw || '';
    }

    function findDuplicateKeyword(currentCell, keyword) {
        if (!currentCell || !keyword || typeof keyword !== 'string') return null;
        const target = keyword.trim();
        if (!target) return null;

        const cells = document.querySelectorAll('#stj_keywords_container .stj-keyword-item');
        for (const cell of cells) {
            if (cell === currentCell) continue;
            if (getCellKeyword(cell).trim() === target) {
                return cell;
            }
        }
        return null;
    }

    function showKeywordDuplicateWarning(keyword) {
        const message = _t('stj.keyword_dup_msg',
            `既に同じキーワードが設定されています: 「${keyword}」`,
            { keyword });

        try {
            if (typeof window.toastr !== 'undefined' && typeof window.toastr.warning === 'function') {
                window.toastr.warning(message, _t('stj.keyword_dup_toast_title', 'キーワード重複'), {
                    timeOut: 3000,
                    positionClass: 'toast-top-center',
                });
                return;
            }
        } catch (e) { /* fallthrough */ }

        const existing = document.getElementById('stj_kw_dup_alert');
        if (existing) existing.remove();

        const alertDiv = document.createElement('div');
        alertDiv.id = 'stj_kw_dup_alert';
        alertDiv.textContent = message;
        Object.assign(alertDiv.style, {
            position: 'fixed', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)', padding: '16px 28px',
            background: 'rgba(220, 38, 38, 0.95)', color: '#fff',
            fontSize: '16px', fontWeight: 'bold', borderRadius: '8px',
            boxShadow: '0 8px 30px rgba(0,0,0,0.6)', zIndex: '25000',
            pointerEvents: 'none', textAlign: 'center',
            maxWidth: '90vw', border: '2px solid #fff',
        });
        document.body.appendChild(alertDiv);
        setTimeout(() => {
            alertDiv.style.transition = 'opacity 0.3s ease';
            alertDiv.style.opacity = '0';
            setTimeout(() => alertDiv.remove(), 300);
        }, 2500);
    }

    function addImageToCell(cell, fileName) {
        if (!cell || !fileName) return false;
        const images = getCellImages(cell);
        if (images.includes(fileName)) return false;
        images.push(fileName);
        setCellImages(cell, images);
        return true;
    }

    function removeImageFromCell(cell, fileName) {
        if (!cell || !fileName) return false;
        const images = getCellImages(cell);
        const idx = images.indexOf(fileName);
        if (idx < 0) return false;
        images.splice(idx, 1);
        setCellImages(cell, images);
        return true;
    }

    function isVideoUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return !!url.match(/\.(mp4|webm)(\?|#|$)/i);
    }

    function resolveThumbToOriginal(fileName) {
        if (!fileName || typeof fileName !== 'string') return fileName;

        const vm = fileName.match(/^(.+)_(mp4|webm)_thum\.png$/i);
        if (vm) return `${vm[1]}.${vm[2].toLowerCase()}`;

        if (fileName.endsWith('_img_thum.png')) {
            if (window.GicApi?.resolveOriginalFileName) {
                const orig = window.GicApi.resolveOriginalFileName(fileName);
                if (orig) return orig;
            }
            return fileName.slice(0, -'_img_thum.png'.length) + '.png';
        }

        return fileName;
    }

    async function attachVideoBadge(parentEl, isVideo, fileName, charName) {
        if (!parentEl) return;

        let shouldShow = !!isVideo;

        if (!shouldShow && fileName && charName && /\.(gif|png)$/i.test(fileName)) {
            try {
                if (window.GicApi?.isAnimatedImage) {
                    shouldShow = await window.GicApi.isAnimatedImage(fileName, charName);
                }
            } catch (e) { /* ignore */ }
        }

        const existing = parentEl.querySelectorAll(':scope > .stj-video-badge');

        if (shouldShow) {
            if (existing.length === 1) return;
            existing.forEach(el => el.remove());

            const cs = window.getComputedStyle(parentEl);
            if (cs.position === 'static') {
                parentEl.style.setProperty('position', 'relative', 'important');
            }

            const badge = document.createElement('div');
            badge.className = 'stj-video-badge';
            badge.textContent = '🎬';
            parentEl.appendChild(badge);
        } else if (existing.length > 0) {
            existing.forEach(el => el.remove());
        }
    }

    function getSTContext() {
        if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
            return window.SillyTavern.getContext();
        }
        return null;
    }

    function getExtensionSettings() {
        const context = getSTContext();
        if (!context || !context.extensionSettings) return {};
        if (!context.extensionSettings[MODULE_NAME]) context.extensionSettings[MODULE_NAME] = {};
        return context.extensionSettings[MODULE_NAME];
    }

    function persistSettings() {
        const context = getSTContext();
        if (context && typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
    }

    function detectCharacterNameFromDOM() {
        try {
            const ctx = getSTContext();
            const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
            if (char?.name) return char.name;
        } catch (e) { /* ignore */ }

        const nameHolder = document.querySelector('#character_name_holder');
        if (nameHolder) {
            const t = (nameHolder.textContent || '').trim();
            if (t) return t;
        }

        const greetingMessage = document.querySelector('.mes[mesid="0"][is_user="false"]');
        if (greetingMessage) {
            const t = (greetingMessage.getAttribute('ch_name') || '').trim();
            if (t) return t;
        }

        return null;
    }

    function videoFileToThumbName(videoFileName) {
        if (!videoFileName || typeof videoFileName !== 'string') return null;
        const m = videoFileName.match(/^(.+)\.(mp4|webm)$/i);
        if (!m) return null;
        return `${m[1]}_${m[2].toLowerCase()}${THUMB_SUFFIX}`;
    }

    async function stjCheckThumbExists(thumbUrl) {
        const c = _stjThumbExistCache.get(thumbUrl);
        if (c && Date.now() - c.ts < THUMB_EXIST_CACHE_TTL_MS) return c.exists;
        let exists = false;
        try {
            const resp = await fetch(thumbUrl, { method: 'HEAD' });
            if (resp.ok) {
                const ct = (resp.headers.get('content-type') || '').toLowerCase();
                exists = !ct.includes('text/html');
            }
        } catch (e) { /* ignore */ }
        _stjThumbExistCache.set(thumbUrl, { exists, ts: Date.now() });
        return exists;
    }

    async function ensureThumbForEditor(videoFileName, charName) {
        if (!videoFileName || !charName) return null;
        if (window.GicApi?.ensureThumbnailForVideo) {
            try {
                const url = await window.GicApi.ensureThumbnailForVideo(videoFileName, charName);
                if (url) return url;
            } catch (e) { /* fall through */ }
        }
        const key = `${charName}:${videoFileName}`;
        if (_stjThumbUrlCache.has(key)) return _stjThumbUrlCache.get(key);

        const thumbName = videoFileToThumbName(videoFileName);
        if (!thumbName) return null;
        const thumbUrl = '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(thumbName);
        if (await stjCheckThumbExists(thumbUrl)) {
            _stjThumbUrlCache.set(key, thumbUrl);
            return thumbUrl;
        }
        _stjThumbUrlCache.set(key, null);
        return null;
    }

function getCharacterWorldInfoName() {
    // 1. LorebookExpansion の getChoicesWorldName を優先（キャラ紐付け + 現在選択中）
    if (window.LorebookExpansion?.getChoicesWorldName) {
        const wiName = window.LorebookExpansion.getChoicesWorldName();
        if (wiName) {
            console.log(`[STJ Editor] ✅ getChoicesWorldName から取得: "${wiName}"`);
            return wiName;
        }
    }
    
    // 2. ST Context から直接取得
    const ctx = getSTContext();
    if (ctx) {
        let char = null;
        if (ctx.characters && ctx.characterId !== undefined && ctx.characterId !== null) {
            char = ctx.characters[ctx.characterId];
        }
        if (!char && ctx.character) char = ctx.character;
        
        if (char) {
            const fromExt = char.data?.extensions?.world;
            if (fromExt && typeof fromExt === 'string' && fromExt.trim()) {
                console.log(`[STJ Editor] ✅ char.data.extensions.world から取得: "${fromExt.trim()}"`);
                return fromExt.trim();
            }
            const fromData = char.data?.world;
            if (fromData && typeof fromData === 'string' && fromData.trim()) {
                console.log(`[STJ Editor] ✅ char.data.world から取得: "${fromData.trim()}"`);
                return fromData.trim();
            }
        }
    }
    
    // 3. LorebookExpansion の getCurrentWorldName (DOM から取得)
    if (window.LorebookExpansion?.getCurrentWorldName) {
        const currentWi = window.LorebookExpansion.getCurrentWorldName();
        if (currentWi) {
            console.log(`[STJ Editor] ✅ getCurrentWorldName から取得: "${currentWi}"`);
            return currentWi;
        }
    }
    
    console.warn('[STJ Editor] ❌ getCharacterWorldInfoName: ワールド名を特定できませんでした');
    return null;
}

// 1. 内部形式を SillyTavern エクスポート形式に変換する関数を追加
function convertToExportFormat(entries) {
    if (!entries || typeof entries !== 'object') return [];
    
    // position の数値から文字列への変換マップ (SillyTavern 仕様)
    const positionMap = {
        0: 'before_char',
        1: 'after_char',
        2: 'before_example',
        3: 'after_example',
        4: 'author_note',
        5: 'in_depth_prompt'
    };

    return Object.values(entries).map(entry => {
        // keys の正規化
        let keys = [];
        if (Array.isArray(entry.keys)) keys = entry.keys;
        else if (Array.isArray(entry.key)) keys = entry.key;
        else if (typeof entry.keys === 'string') keys = [entry.keys];
        else if (typeof entry.key === 'string') keys = [entry.key];

        // secondary_keys の正規化
        let secondaryKeys = [];
        if (Array.isArray(entry.keysecondary)) secondaryKeys = entry.keysecondary;
        else if (Array.isArray(entry.secondary_keys)) secondaryKeys = entry.secondary_keys;

        // position の変換
        let position = 'after_char';
        if (typeof entry.position === 'number') {
            position = positionMap[entry.position] || 'after_char';
        } else if (typeof entry.position === 'string') {
            position = entry.position;
        }

        // enabled の変換 (disable の反転)
        const enabled = entry.disable !== undefined ? !entry.disable : (entry.enabled !== undefined ? entry.enabled : true);
        
        // insertion_order の変換 (order から)
        const insertionOrder = entry.order !== undefined ? entry.order : (entry.insertion_order !== undefined ? entry.insertion_order : 100);

        return {
            id: entry.uid !== undefined ? entry.uid : (entry.id !== undefined ? entry.id : 0),
            keys: keys,
            secondary_keys: secondaryKeys,
            comment: entry.comment || '',
            content: entry.content || '',
            constant: entry.constant !== undefined ? entry.constant : false,
            selective: entry.selective !== undefined ? entry.selective : false,
            insertion_order: insertionOrder,
            enabled: enabled,
            position: position,
            use_regex: entry.use_regex !== undefined ? entry.use_regex : (entry.useRegex !== undefined ? entry.useRegex : false),
            extensions: entry.extensions || {}
        };
    }).sort((a, b) => a.id - b.id); // id でソートして安定させる
}

// 2. ロアブックエントリ取得関数の強化（fetch 優先 + 詳細ログ）
async function loadWorldInfoEntries(worldName) {
    if (!worldName) {
        console.warn('[STJ Editor] ❌ loadWorldInfoEntries: worldName が指定されていません');
        return null;
    }
    
    // 1. fetch を最優先で試行（サーバー上の最新ファイルを直接取得）
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const ctx = getSTContext();
            const headers = (ctx && typeof ctx.getRequestHeaders === 'function')
                ? ctx.getRequestHeaders()
                : { 'Content-Type': 'application/json' };
            
            console.log(`[STJ Editor] 🔍 fetch 試行 ${attempt}/2: /api/worldinfo/get (name="${worldName}")`);
            const resp = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: worldName }),
                cache: 'no-store',
            });
            
            if (resp.ok) {
                const data = await resp.json();
                if (data && data.entries && Object.keys(data.entries).length > 0) {
                    console.log(`[STJ Editor] ✅ fetch からロアブックエントリを取得: ${Object.keys(data.entries).length} 件`);
                    return data.entries;
                } else {
                    console.warn(`[STJ Editor] ⚠️ fetch は成功したが entries が空または不正:`, data);
                }
            } else {
                console.warn(`[STJ Editor] ⚠️ fetch 失敗: HTTP ${resp.status}`);
            }
        } catch (err) {
            console.warn(`[STJ Editor] ⚠️ fetch 試行 ${attempt}/2 例外:`, err);
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 100));
    }

    // 2. fetch が失敗した場合のみ、LorebookExpansion のキャッシュを利用
    if (window.LorebookExpansion?.loadWorldInfoEntriesByName) {
        try {
            console.log(`[STJ Editor] 🔍 LorebookExpansion.loadWorldInfoEntriesByName を試行`);
            const entries = await window.LorebookExpansion.loadWorldInfoEntriesByName(worldName);
            if (entries && typeof entries === 'object' && Object.keys(entries).length > 0) {
                console.log(`[STJ Editor] ✅ LorebookExpansion からロアブックエントリを取得: ${Object.keys(entries).length} 件`);
                return entries;
            }
        } catch (err) {
            console.warn(`[STJ Editor] ⚠️ LorebookExpansion.loadWorldInfoEntriesByName 例外:`, err);
        }
    }

    console.warn(`[STJ Editor] ❌ ロアブック "${worldName}" のエントリを全経路で取得できませんでした`);
    return null;
}

    function getEntryKeys(entry) {
        if (!entry) return [];
        if (Array.isArray(entry.keys) && entry.keys.length) return entry.keys;
        if (Array.isArray(entry.key) && entry.key.length) return entry.key;
        if (typeof entry.keys === 'string' && entry.keys.trim()) return [entry.keys];
        if (typeof entry.key === 'string' && entry.key.trim()) return [entry.key];
        return [];
    }

    function getLexDataFor(worldName, uid, entry) {
        if (window.LorebookExpansion?.getDataFor) {
            try {
                const data = window.LorebookExpansion.getDataFor(worldName, uid, entry);
                if (data && Array.isArray(data.choices)) {
                    return {
                        img_prompt: typeof data.img_prompt === 'string' ? data.img_prompt : '',
                        choices: data.choices.map(c => normalizeChoiceItem(c)).filter(Boolean),
                    };
                }
            } catch (e) { /* ignore */ }
        }
        const ext = entry && entry.extensions && entry.extensions.lorebook_expansion;
        if (ext && typeof ext === 'object') {
            return {
                img_prompt: typeof ext.img_prompt === 'string' ? ext.img_prompt : '',
                choices: Array.isArray(ext.choices)
                    ? ext.choices.map(c => normalizeChoiceItem(c)).filter(Boolean)
                    : [],
            };
        }
        return { img_prompt: '', choices: [] };
    }

    function findEntryByKeyword(entries, kw) {
        if (!entries || !kw) return null;
        const list = Array.isArray(entries) ? entries : Object.values(entries);
        const target = String(kw).trim();
        if (!target) return null;

        for (const entry of list) {
            if (!entry) continue;
            if (getEntryKeyword(entry) === target) return entry;
        }

        for (const entry of list) {
            if (!entry) continue;
            const keys = getEntryKeys(entry);
            for (const k of keys) {
                if (String(k).trim() === target) return entry;
            }
        }

        return _stjFindEntryByKeywordLoose(list, target);
    }

    function escapeCssAttrValue(val) {
        if (window.CSS && typeof window.CSS.escape === 'function') {
            return window.CSS.escape(String(val));
        }
        return String(val).replace(/["\\]/g, '\\$&');
    }

    function findSourceWorldEntryEl(entries, targetEntry, kw) {
        const popup = document.getElementById('world_popup');
        if (!popup) return null;

        if (targetEntry && targetEntry.uid !== undefined && targetEntry.uid !== null) {
            const byUid = popup.querySelector(`.world_entry[uid="${escapeCssAttrValue(targetEntry.uid)}"]`);
            if (byUid) return byUid;
        }

        const targetKw = String(kw || '').trim();
        if (!targetKw) return null;

        for (const el of popup.querySelectorAll('.world_entry[uid]')) {
            const uid = el.getAttribute('uid');
            const entry = entries ? entries[uid] : null;
            if (entry && getEntryKeyword(entry) === targetKw) return el;

            const commentInput = el.querySelector(
                'input[name="comment"], textarea[name="comment"], .world_entry_comment input, .world_entry_comment textarea'
            );
            if (commentInput && (commentInput.value || '').trim() === targetKw) return el;
        }
        return null;
    }

    function collapseLbeExtrasPanel(clonedEl) {
        if (!clonedEl) return;

        clonedEl.classList.add('lbe-extras-collapsed');
        clonedEl.querySelectorAll('.lbe-extras-toggle').forEach((toggle) => {
            toggle.classList.remove('open', 'expanded');
            toggle.classList.add('lbe-extras-collapsed', 'collapsed');
            const icon = toggle.querySelector('.lbe-extras-icon, i');
            if (icon) {
                icon.classList.remove('up', 'fa-circle-chevron-up', 'fa-chevron-up', 'fa-caret-up');
                icon.classList.add('down', 'fa-circle-chevron-down');
            }
        });

        clonedEl.querySelectorAll('.lbe-extras-panel').forEach((panel) => {
            panel.classList.remove('open', 'expanded');
            panel.classList.add('lbe-extras-collapsed', 'collapsed');
            panel.style.setProperty('display', 'none', 'important');
        });
    }

    function expandClonedEntryPanels(clonedEl) {
        if (!clonedEl) return;

        if (!clonedEl.dataset.stjSavedClasses) {
            clonedEl.dataset.stjSavedClasses = clonedEl.className;
        }
        clonedEl.classList.add('stj-modal-expanded-entry');
    }

    function cleanupEntryModalState(el) {
        if (!el) return;
        el.classList.remove('stj-modal-expanded-entry');
        if (el.dataset.stjSavedClasses !== undefined) {
            el.className = el.dataset.stjSavedClasses;
            delete el.dataset.stjSavedClasses;
        }
        const toggle = el.querySelector('.inline-drawer-toggle');
        const content = el.querySelector('.inline-drawer-content');
        if (toggle && toggle.classList.contains('up')) {
            toggle.classList.remove('up', 'fa-circle-chevron-up');
            toggle.classList.add('down', 'fa-circle-chevron-down');
        }
        if (content) {
            content.style.display = 'none';
        }
    }

    async function ensureSourceEntryExpanded(sourceEl) {
        if (!sourceEl) return;
        const toggle = sourceEl.querySelector('.inline-drawer-toggle');
        const content = sourceEl.querySelector('.inline-drawer-content');
        const isClosed =
            (toggle && toggle.classList.contains('down')) ||
            !content ||
            content.style.display === 'none' ||
            content.children.length === 0;

        if (isClosed && toggle) {
            toggle.click();
            await new Promise((r) => setTimeout(r, 80));
        }
    }

    let _worldInfoSaveTimer = null;
    function scheduleWorldInfoPersist(sourceEl) {
        if (_worldInfoSaveTimer) clearTimeout(_worldInfoSaveTimer);
        _worldInfoSaveTimer = setTimeout(async () => {
            _worldInfoSaveTimer = null;
            try {
                const ctx = getSTContext();
                const worldName = getCharacterWorldInfoName();
                if (!worldName) return;

                if (typeof window.saveWorldInfo === 'function') {
                    await window.saveWorldInfo(worldName, null, true);
                } else if (ctx && typeof ctx.saveWorldInfo === 'function') {
                    await ctx.saveWorldInfo(worldName);
                }

                if (window.LorebookExpansion?.clearWorldInfoEntriesCache) {
                    window.LorebookExpansion.clearWorldInfoEntriesCache(worldName);
                }
                if (ctx?.eventSource && ctx?.eventTypes?.WORLDINFO_UPDATED) {
                    const uid = sourceEl?.getAttribute?.('uid');
                    ctx.eventSource.emit(ctx.eventTypes.WORLDINFO_UPDATED, worldName, uid);
                }
            } catch (err) {
                console.warn('[STJ Editor] ロアブック保存エラー:', err);
            }
        }, 250);
    }

    // ============================================================
    // ★ 特殊プレビュー（「デフォルト表示」「サムネイル表示」）と「他セル」の復元・配置
    // ============================================================
    function restoreSpecialPreviewsToOrigin() {
        document.querySelectorAll('.stj-special-pair[data-stj-moved-pair="1"]').forEach((pair) => {
            Array.from(pair.children).forEach((child) => {
                const origParentId = child.dataset?.stjOrigParentId;
                const origIndex = parseInt(child.dataset?.stjOrigIndex || '-1', 10);
                const origParent = origParentId ? document.getElementById(origParentId) : null;
                if (origParent) {
                    if (origIndex >= 0 && origIndex < origParent.children.length) {
                        origParent.insertBefore(child, origParent.children[origIndex]);
                    } else {
                        origParent.appendChild(child);
                    }
                }
                child.style.position = child.dataset?.stjOrigPosition || '';
                child.style.left = child.dataset?.stjOrigLeft || '';
                child.style.top = child.dataset?.stjOrigTop || '';
                child.style.width = child.dataset?.stjOrigWidth || '';
                child.style.height = child.dataset?.stjOrigHeight || '';
            });
            pair.remove();
        });
        document.querySelectorAll('.stj-tree-top-left-modes, .stj-tree-bottom-left-other, .stj-standalone-cell-item').forEach((box) => {
            box.remove();
        });
    }

    function arrangeTreeControlsAndCompress(containerEl) {
        if (!containerEl || !containerEl.classList.contains('stj-tree-mode')) return;

        const roots = [
            containerEl.closest('.stj-modal, #stj_editor_modal, #stj_export_modal, .popup, dialog'),
            document.body,
        ].filter(Boolean);

        // 1. 操作方法説明（.stj-info-panel）を非表示化
        roots.forEach((root) => {
            root.querySelectorAll('.stj-info-panel').forEach((panel) => {
                panel.style.setProperty('display', 'none', 'important');
            });
        });

        const scale = getTreeScale(containerEl);
        // ツリーセルの実最下端を算出（「他セル」や「左上プレビュー」は除外）
        let treeActualBottom = 0;
        containerEl.querySelectorAll(':scope > .stj-keyword-item').forEach((node) => {
            if (node.dataset.stjIsStandaloneCell === '1') return;
            const t = parseFloat(node.style.top) || 0;
            const h = parseFloat(node.style.height) || (STJ_TREE_CELL_H * scale);
            if (t + h > treeActualBottom) treeActualBottom = t + h;
        });
        if (treeActualBottom <= 0) {
            treeActualBottom = parseFloat(containerEl.dataset.stjTreeBottom || '0') || (120 * scale);
        }
 
        const gap = Math.ceil(16 * scale);
        const neededH = Math.max(Math.ceil(120 * scale), Math.ceil(treeActualBottom + gap));

        containerEl.style.setProperty('min-height', `${neededH}px`);
        containerEl.style.setProperty('height', `${neededH}px`);
    }

    function getTreeScale(containerEl) {
        if (!containerEl) return 1;
        const raw = (getComputedStyle(containerEl).getPropertyValue('--exp-scale')
            || getComputedStyle(document.documentElement).getPropertyValue('--exp-scale')
            || '').trim();
        const parsed = parseFloat(raw);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
        if (typeof window !== 'undefined' && window.innerWidth > 0) {
            const ratio = window.innerWidth / 1920;
            return ratio > 0 ? ratio : 1;
        }
        return 1;
    }

    function applyTreeScaleToContainer(containerEl) {
        if (!containerEl || !containerEl.classList.contains('stj-tree-mode')) return 1;
        const scale = getTreeScale(containerEl);
        containerEl.style.setProperty('--stj-tree-scale', String(scale));

        const minW = parseFloat(containerEl.style.minWidth);
        const minH = parseFloat(containerEl.style.minHeight);
        if (Number.isFinite(minW) && !containerEl.dataset.stjBaseMinW) {
            containerEl.dataset.stjBaseMinW = String(minW);
        }
        if (Number.isFinite(minH) && !containerEl.dataset.stjBaseMinH) {
            containerEl.dataset.stjBaseMinH = String(minH);
        }
        if (containerEl.dataset.stjBaseMinW) {
            containerEl.style.minWidth = `${parseFloat(containerEl.dataset.stjBaseMinW) * scale}px`;
        }
        if (containerEl.dataset.stjBaseMinH) {
            containerEl.style.minHeight = `${parseFloat(containerEl.dataset.stjBaseMinH) * scale}px`;
        }

        let maxBottom = 0;
        let maxRight = 0;
        const displayFontPx = `${(13 * scale).toFixed(2)}px`;
        const itemFontPx = `${(14 * scale).toFixed(2)}px`;

        containerEl.querySelectorAll('.stj-keyword-item').forEach((item) => {
            if (item.dataset.stjIsStandaloneCell === '1' || item.closest('.stj-horizontal-panel-body')) {
                if (item.dataset.stjIsStandaloneCell === '1') {
                    item.style.setProperty('display', 'none', 'important');
                }
                return;
            }
            const isOther = item.dataset.stjIsOtherCell === '1' || Boolean(item.closest('.stj-tree-bottom-left-other'));
            const left = parseFloat(item.style.left);
            const top = parseFloat(item.style.top);
            const width = parseFloat(item.style.width);
            const height = parseFloat(item.style.height);
            let nextLeft = left;
            let nextTop = top;
            let nextWidth = width;
            let nextHeight = height;

            if (isOther) {
                if (!item.dataset.stjBaseWidth) item.dataset.stjBaseWidth = String(STJ_TREE_CELL_W);
                if (!item.dataset.stjBaseHeight) item.dataset.stjBaseHeight = String(STJ_TREE_CELL_H);
                nextWidth = parseFloat(item.dataset.stjBaseWidth) * scale;
                nextHeight = parseFloat(item.dataset.stjBaseHeight) * scale;
                item.style.setProperty('position', 'relative', 'important');
                item.style.setProperty('left', 'auto', 'important');
                item.style.setProperty('top', 'auto', 'important');
                item.style.width = `${nextWidth}px`;
                item.style.height = `${nextHeight}px`;
            } else {
                if (Number.isFinite(left)) {
                    if (!item.dataset.stjBaseLeft) item.dataset.stjBaseLeft = String(left);
                    nextLeft = parseFloat(item.dataset.stjBaseLeft) * scale;
                    item.style.left = `${nextLeft}px`;
                }
                if (Number.isFinite(top)) {
                    if (!item.dataset.stjBaseTop) item.dataset.stjBaseTop = String(top);
                    nextTop = parseFloat(item.dataset.stjBaseTop) * scale;
                    item.style.top = `${nextTop}px`;
                }
                if (Number.isFinite(width)) {
                    if (!item.dataset.stjBaseWidth) item.dataset.stjBaseWidth = String(width);
                    nextWidth = parseFloat(item.dataset.stjBaseWidth) * scale;
                    item.style.width = `${nextWidth}px`;
                }
                if (Number.isFinite(height)) {
                    if (!item.dataset.stjBaseHeight) item.dataset.stjBaseHeight = String(height);
                    nextHeight = parseFloat(item.dataset.stjBaseHeight) * scale;
                    item.style.height = `${nextHeight}px`;
                }
            }
            item.style.setProperty('font-size', itemFontPx, 'important');

            const previewEl = item.querySelector('.stj-image-preview');
            if (previewEl && Number.isFinite(nextHeight)) {
                const labelReserve = Math.round(34 * scale);
                previewEl.style.height = `${Math.max(40, nextHeight - labelReserve)}px`;
            }

            item.querySelectorAll('.stj-keyword-display, .stj-preview-text').forEach((txtEl) => {
                txtEl.style.setProperty('font-size', displayFontPx, 'important');
                txtEl.style.setProperty('line-height', '1.25', 'important');
            });

            if (!isOther) {
                if (Number.isFinite(nextLeft) && Number.isFinite(nextWidth)) {
                    maxRight = Math.max(maxRight, nextLeft + nextWidth);
                }
                if (Number.isFinite(nextTop) && Number.isFinite(nextHeight)) {
                    maxBottom = Math.max(maxBottom, nextTop + nextHeight);
                }
            }
        });

        const svg = containerEl.querySelector('.stj-tree-svg');
        if (svg) {
            const svgW = parseFloat(svg.getAttribute('width') || svg.style.width);
            const svgH = parseFloat(svg.getAttribute('height') || svg.style.height);
            if (Number.isFinite(svgW) && !svg.dataset.stjBaseW) svg.dataset.stjBaseW = String(svgW);
            if (Number.isFinite(svgH) && !svg.dataset.stjBaseH) svg.dataset.stjBaseH = String(svgH);
            const nextW = svg.dataset.stjBaseW ? parseFloat(svg.dataset.stjBaseW) * scale : svgW;
            const nextH = svg.dataset.stjBaseH ? parseFloat(svg.dataset.stjBaseH) * scale : svgH;
            if (Number.isFinite(nextW)) {
                svg.setAttribute('width', String(nextW));
                svg.style.width = `${nextW}px`;
                maxRight = Math.max(maxRight, nextW);
            }
            if (Number.isFinite(nextH)) {
                svg.setAttribute('height', String(nextH));
                svg.style.height = `${nextH}px`;
                maxBottom = Math.max(maxBottom, nextH);
            }
            svg.querySelectorAll('path').forEach((pathEl) => {
                const d = pathEl.getAttribute('d');
                if (!d) return;
                if (!pathEl.dataset.stjBaseD) {
                    pathEl.dataset.stjBaseD = d;
                }
                const scaledD = pathEl.dataset.stjBaseD.replace(/-?\d+(?:\.\d+)?/g, (num) => String(parseFloat(num) * scale));
                pathEl.setAttribute('d', scaledD);
                pathEl.setAttribute('stroke-width', String(4 * scale));
            });
            svg.querySelectorAll('polygon').forEach((polyEl) => {
                const pts = polyEl.getAttribute('points');
                if (!pts) return;
                if (!polyEl.dataset.stjBasePoints) {
                    polyEl.dataset.stjBasePoints = pts;
                }
                const scaledPts = polyEl.dataset.stjBasePoints.replace(/-?\d+(?:\.\d+)?/g, (num) => String(parseFloat(num) * scale));
                polyEl.setAttribute('points', scaledPts);
            });
        }

        if (maxBottom > 0) {
            containerEl.dataset.stjTreeBottom = String(maxBottom);
        }

        arrangeTreeControlsAndCompress(containerEl);
 
        const edgePad = Math.ceil(40 * scale);
        const finalW = maxRight > 0
            ? Math.max(Math.ceil(200 * scale), Math.ceil(maxRight + edgePad))
            : Math.ceil(300 * scale);
        if (finalW !== null) {
            containerEl.style.minWidth = `${finalW}px`;
            containerEl.style.width = `${finalW}px`;
        }
 
        let parent = containerEl.parentElement;
        for (let depth = 0; depth < 8 && parent && parent !== document.body && parent !== document.documentElement; depth++, parent = parent.parentElement) {
            const pStyle = getComputedStyle(parent);
            if (pStyle.maxHeight && pStyle.maxHeight !== 'none') {
                parent.style.maxHeight = 'none';
            }
            if (pStyle.overflowY === 'hidden') {
                parent.style.overflowY = 'auto';
            }
            if (pStyle.minHeight && pStyle.minHeight !== '0px') {
                parent.style.minHeight = '0px';
            }
        }
 
        const areaPad = Math.ceil(20 * scale);
        const rawTreeBottom = maxBottom > 0 ? maxBottom : (120 * scale);
        containerEl.dataset.stjTreeBottom = String(Math.ceil(rawTreeBottom));
 
        arrangeTreeControlsAndCompress(containerEl);
 
        let contentBottom = rawTreeBottom;
        const bottomLeftBox = containerEl.querySelector('.stj-tree-bottom-left-other');
        if (bottomLeftBox) {
            const boxTop = parseFloat(bottomLeftBox.style.top) || 0;
            const boxH = bottomLeftBox.offsetHeight || 0;
            if (boxH > 0) {
                contentBottom = Math.max(contentBottom, boxTop + boxH);
            }
        }
        const topLeftBox = containerEl.querySelector('.stj-tree-top-left-modes');
        if (topLeftBox) {
            const tlTop = parseFloat(topLeftBox.style.top) || 0;
            const tlH = topLeftBox.offsetHeight || 0;
            if (tlH > 0) {
                contentBottom = Math.max(contentBottom, tlTop + tlH);
            }
        }
 
        const minNeededH = Math.max(Math.ceil(120 * scale), Math.ceil(contentBottom + areaPad));
        const baseMinH = Math.max(Math.ceil(100 * scale), Math.ceil(rawTreeBottom + areaPad));
        const baseMinW = Math.max(Math.ceil(180 * scale), Math.ceil(finalW - areaPad));

        containerEl.dataset.stjBaseMinW = String(baseMinW);
        containerEl.dataset.stjBaseMinH = String(baseMinH);
        containerEl.style.setProperty('min-width', `${finalW}px`);
        containerEl.style.setProperty('width', `${finalW}px`);
        containerEl.style.setProperty('min-height', `${minNeededH}px`);
        containerEl.style.setProperty('height', `${minNeededH}px`);

        containerEl.dataset.stjAppliedScale = String(scale);
        return scale;
    }

    function syncAllTreeScales() {
        document.querySelectorAll('#stj_keywords_container.stj-tree-mode, .stj-grid-container.stj-tree-mode')
            .forEach((el) => applyTreeScaleToContainer(el));
    }

    if (typeof window !== 'undefined' && !window._stjTreeScaleWatcherInstalled) {
        window._stjTreeScaleWatcherInstalled = true;
        window.addEventListener('resize', () => {
            requestAnimationFrame(syncAllTreeScales);
        });
    }

    function restoreMountedWorldEntry(hostEl) {
        if (!hostEl) return;
        const movedEl = hostEl._movedEntryEl;
        const placeholder = hostEl._entryPlaceholder;
        if (movedEl && placeholder && placeholder.parentNode) {
            cleanupEntryModalState(movedEl);
            placeholder.parentNode.insertBefore(movedEl, placeholder);
            placeholder.remove();
            try {
                if (typeof window.saveSettingsDebounced === 'function') {
                    window.saveSettingsDebounced();
                }
            } catch (e) { /* ignore */ }
        } else if (placeholder && placeholder.parentNode) {
            placeholder.remove();
        }
        hostEl.innerHTML = '';
        hostEl.style.display = 'none';
        delete hostEl._sourceEntryEl;
        delete hostEl._movedEntryEl;
        delete hostEl._entryPlaceholder;
        delete hostEl._syncEntry;
    }

async function mountWorldEntryInCellModal(cell) {
        const modal = currentCellModal;
        if (!modal || !cell) return;
        const hostEl = modal.querySelector('#stj_cell_modal_entry_host');
        if (!hostEl) return;

        restoreMountedWorldEntry(hostEl);

        if (cell.classList.contains('stj-special-item')) return;
        const cellUid = getCellUid(cell);
        const kw = getCellKeyword(cell).trim();
        if (!cellUid && !kw) return;

        const worldName = getCharacterWorldInfoName();
        if (!worldName) return;

        let entries = null;
        try {
            entries = await loadWorldInfoEntries(worldName);
        } catch (e) { return; }

        if (currentCellModal !== modal || currentModalCell !== cell) return;
        if (!entries) return;

        const list = Array.isArray(entries) ? entries : Object.values(entries);
        const targetEntry = (cellUid
            ? (entries[cellUid] || list.find(e => getEntryUid(e) === cellUid))
            : null) || findEntryByKeyword(entries, kw);
        if (!targetEntry) return;

        const sourceEl = findSourceWorldEntryEl(entries, targetEntry, kw);
        if (!sourceEl) return;

        await ensureSourceEntryExpanded(sourceEl);

        if (currentCellModal !== modal || currentModalCell !== cell) return;

        const placeholder = document.createComment('stj-world-entry-placeholder');
        if (sourceEl.parentNode) {
            sourceEl.parentNode.insertBefore(placeholder, sourceEl);
        }
        expandClonedEntryPanels(sourceEl);
        collapseLbeExtrasPanel(sourceEl);

        hostEl._sourceEntryEl = sourceEl;
        hostEl._movedEntryEl = sourceEl;
        hostEl._entryPlaceholder = placeholder;
        hostEl._syncEntry = () => scheduleWorldInfoPersist(sourceEl);
        hostEl.appendChild(sourceEl);
        hostEl.style.display = 'block';
        hostEl.style.height = '43%';

        if (window.LorebookExpansion?.forceInject) {
            await window.LorebookExpansion.forceInject().catch(() => {});
        }
    }

    function checkMediaExists(mediaUrl) {
        if (!mediaUrl || typeof mediaUrl !== 'string' || !mediaUrl.trim()) return Promise.resolve(false);
        const cleanUrl = mediaUrl.trim();
        if (mediaCache.has(cleanUrl)) {
            const cached = mediaCache.get(cleanUrl);
            if (cached.exists === true) return Promise.resolve(true);
            if (Date.now() - cached.timestamp < MEDIA_CACHE_FALSE_TTL_MS) return Promise.resolve(false);
            mediaCache.delete(cleanUrl);
        }
        return new Promise((resolve) => {
            let resolved = false;
            const finish = (exists) => {
                if (resolved) return;
                resolved = true;
                mediaCache.set(cleanUrl, { exists, timestamp: Date.now() });
                resolve(exists);
            };
            const timeout = setTimeout(() => finish(false), MEDIA_CHECK_TIMEOUT_MS);
            if (isVideoUrl(cleanUrl)) {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.onloadedmetadata = () => { clearTimeout(timeout); finish(true); };
                video.onerror = () => { clearTimeout(timeout); finish(false); };
                video.src = cleanUrl;
            } else {
                const img = new Image();
                img.onload = () => { clearTimeout(timeout); finish(true); };
                img.onerror = () => { clearTimeout(timeout); finish(false); };
                img.src = cleanUrl;
            }
        });
    }

    async function checkFileExistsOnServer(charName, fileName) {
        if (!charName || !fileName) return false;
        const path = `/user/images/${encodeURIComponent(charName)}/${encodeURIComponent(fileName)}`;
        try {
            const resp = await fetch(path, {
                method: 'HEAD',
                cache: 'no-store',
            });
            if (!resp.ok) return false;
            const ct = (resp.headers.get('content-type') || '').toLowerCase();
            if (ct.includes('text/html')) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    async function detectImageExtension(charName, fileNameWithExt) {
        if (!charName || !fileNameWithExt) return null;
        const path = fileNameWithExt.startsWith('user/images/')
            ? fileNameWithExt
            : `user/images/${charName}/${fileNameWithExt}`;
        const exists = await checkMediaExists(path);
        return exists ? path : null;
    }

    function normalizeChoiceItem(item) {
        if (typeof item === 'string') {
            return item.trim();
        }
        if (item && typeof item === 'object') {
            const num = (item.id ?? item.number ?? item.code ?? '').toString().trim();
            const txt = (item.text ?? item.content ?? item.label ?? '').toString().trim();
            if (num && txt) {
                return txt.startsWith(num) ? txt : `${num}${txt}`;
            }
            return num || txt;
        }
        return '';
    }

    function extractChoiceTriggerText(choiceStr) {
        const str = String(choiceStr || '').trim();
        if (!str) return '';
        return str;
    }

    function extractFileNameFromPath(path) {
        if (!path || typeof path !== 'string') return '';
        if (path.startsWith('data:')) return '';
        const clean = path.split('?')[0].split('#')[0];
        const parts = clean.split('/');
        let name = parts[parts.length - 1];
        if (!name || name.startsWith('data:')) return '';
        if (!/\.(png|jpe?g|gif|webp|avif|bmp|mp4|webm)$/i.test(name)) return '';
        return name;
    }

    function parseImageNames(input) {
        if (!input) return [];
        return input.split(',').map(name => name.trim()).filter(name => name.length > 0);
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

    function getKnownCharacterNames() {
        try {
            const ctx = getSTContext();
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

    function cleanForeignImageEntries(imageMap, charName) {
        if (!imageMap || typeof imageMap !== 'object' || !charName) return imageMap;

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
                    const fn = extractFileNameFromPath(p);
                    if (!fn) return true;
                    if (isForeignImageFileName(fn, charName)) {
                        if (!alreadyMigrated) {
                            console.log(`[STJ Editor] 🧹 別キャラの画像エントリを除外: ${fn}`);
                        }
                        removed++;
                        return false;
                    }
                    return true;
                });
                if (filtered.length === 0) return [];
                return filtered.length === 1 ? filtered[0] : filtered;
            } else if (typeof val === 'string') {
                const fn = extractFileNameFromPath(val);
                if (fn && isForeignImageFileName(fn, charName)) {
                    if (!alreadyMigrated) {
                        console.log(`[STJ Editor] 🧹 別キャラの画像エントリを除外: ${fn}`);
                    }
                    removed++;
                    return [];
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
                `[STJ Editor] 🧹 別キャラの画像エントリ ${removed} 件を整理 ` +
                `(${Object.keys(imageMap).length} → ${Object.keys(cleaned).length} entries)` +
                (alreadyMigrated ? ' [STコアによるデータ再取得を検知]' : '')
            );
            try {
                if (window.CharStore?.saveCharacterExtension) {
                    window.CharStore.saveCharacterExtension('image_display_extension', cleaned, { immediate: true });
                }
            } catch (e) { /* ignore */ }
        }

        if (!alreadyMigrated) {
            markMigrationDoneForChar(charName);
        }

        return cleaned;
    }

    async function cleanMissingImageFiles(imageMap, charName) {
        if (!imageMap || typeof imageMap !== 'object' || !charName) return imageMap;

        const fileNames = new Set();
        const addFile = (p) => {
            if (typeof p !== 'string') return;
            const fn = extractFileNameFromPath(p);
            if (!fn) return;
            const resolved = resolveThumbToOriginal(fn);
            if (resolved) fileNames.add(resolved);
        };
        for (const val of Object.values(imageMap)) {
            if (Array.isArray(val)) val.forEach(addFile);
            else if (typeof val === 'string') addFile(val);
        }
        if (fileNames.size === 0) return imageMap;

        const existMap = new Map();
        await Promise.all([...fileNames].map(async (fn) => {
            const exists = await checkFileExistsOnServer(charName, fn);
            existMap.set(fn, exists);
        }));

        let removed = 0;
        const cleaned = {};
        const isMissing = (p) => {
            if (typeof p !== 'string') return false;
            const fn = extractFileNameFromPath(p);
            if (!fn) return false;
            const resolved = resolveThumbToOriginal(fn);
            return existMap.get(resolved) === false;
        };

        for (const [key, val] of Object.entries(imageMap)) {
            if (Array.isArray(val)) {
                const filtered = val.filter(p => {
                    if (isMissing(p)) {
                        console.log(`[STJ Editor] 🗑️ 存在しないファイルを除去: key="${key}" → ${p}`);
                        removed++;
                        return false;
                    }
                    return true;
                });
                cleaned[key] = filtered.length === 0 ? [] : (filtered.length === 1 ? filtered[0] : filtered);
            } else if (typeof val === 'string') {
                if (isMissing(val)) {
                    console.log(`[STJ Editor] 🗑️ 存在しないファイルを除去: key="${key}" → ${val}`);
                    removed++;
                    cleaned[key] = [];
                    continue;
                }
                cleaned[key] = val;
            } else {
                cleaned[key] = val;
            }
        }

        if (removed > 0) {
            console.log(
                `[STJ Editor] 🧹 存在しないファイル ${removed} 件を整理 ` +
                `(${Object.keys(imageMap).length} → ${Object.keys(cleaned).length} entries)`
            );
            try {
                window.CharStore?.saveCharacterExtension?.(
                    'image_display_extension', cleaned, { immediate: true }
                );
                window.dispatchEvent(new CustomEvent('lbe-image-map-updated', {
                    detail: { charName, imageMap: cleaned }
                }));
            } catch (e) { /* ignore */ }
        }

        return cleaned;
    }

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

    function evaluateCondition(condStr, text) {
        if (!condStr || !text) return false;
        try {
            const normalized = normalizeConditionExpression(condStr);
            const tokens = tokenizeCondition(normalized);
            if (tokens.length === 0) return false;
            const ast = parseConditionTokens(tokens);
            return evaluateConditionNode(ast, text.toLowerCase());
        } catch (error) { return false; }
    }

    function calcConditionComplexity(condition) {
        if (!condition || typeof condition !== 'string') return 0;
        return (
            (condition.match(/\band\b/gi) || []).length * 10 +
            (condition.match(/\bor\b/gi)  || []).length * 5  +
            (condition.match(/\+/g)       || []).length * 8  +
            (condition.match(/,/g)        || []).length * 4  +
            (condition.match(/!/g)        || []).length * 6  +
            (condition.match(/\(/g)       || []).length * 3  +
            (condition.match(/\)/g)       || []).length * 3  +
            condition.length
        );
    }

    function showDeleteConfirmDialog(message, onConfirm, onCancel) {
        if (!confirmDialogEl) return;
        const msgEl = confirmDialogEl.querySelector('.stj-confirm-message');
        if (msgEl) msgEl.textContent = message || '本当に削除しますか？';
        pendingDeleteCallback = onConfirm;
        pendingCancelCallback = onCancel || null;
        confirmDialogEl.style.display = 'flex';
    }

    function hideDeleteConfirmDialog() {
        if (!confirmDialogEl) return;
        confirmDialogEl.style.display = 'none';
        pendingDeleteCallback = null;
        pendingCancelCallback = null;
    }

    function showMessageDialog(text) {
        if (!messageDialogEl) return;
        const textEl = messageDialogEl.querySelector('.stj-message-text');
        if (textEl) textEl.textContent = text;
        messageDialogEl.style.display = 'flex';
    }

    function hideMessageDialog() {
        if (!messageDialogEl) return;
        messageDialogEl.style.display = 'none';
    }

    function insertCellAt(source, reference, position) {
        if (!source || !reference || source === reference) return;
        const parent = source.parentNode;
        if (!parent || parent !== reference.parentNode) return;

        if (position === 'before') {
            parent.insertBefore(source, reference);
        } else {
            parent.insertBefore(source, reference.nextSibling);
        }
    }

    function swapCells(a, b) {
        if (!a || !b || a === b) return;
        const parent = a.parentNode;
        if (!parent || parent !== b.parentNode) return;
        const placeholder = document.createComment('stj-swap');
        parent.insertBefore(placeholder, a);
        parent.insertBefore(a, b);
        parent.insertBefore(b, placeholder);
        parent.removeChild(placeholder);
        _stjScheduleTreeLayout();
    }

    function findScrollableAncestor(el) {
        let cur = el ? el.parentElement : null;
        while (cur && cur !== document.body && cur !== document.documentElement) {
            const style = window.getComputedStyle(cur);
            const oy = style.overflowY;
            if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay')
                && cur.scrollHeight > cur.clientHeight + 1) return cur;
            cur = cur.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    function stopAutoScroll() {
        if (autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = null; }
        autoScrollTarget = null;
        autoScrollDelta = 0;
    }

    function autoScrollStep() {
        autoScrollRAF = null;
        if (!pointerDragState || !autoScrollTarget || autoScrollDelta === 0) return;
        const before = autoScrollTarget.scrollTop;
        autoScrollTarget.scrollTop = before + autoScrollDelta;
        if (pointerDragState.isDragging) {
            updateDragTarget(pointerDragState, pointerDragState.lastX, pointerDragState.lastY);
        }
        if (autoScrollTarget.scrollTop !== before || autoScrollDelta !== 0) {
            autoScrollRAF = requestAnimationFrame(autoScrollStep);
        }
    }

    function updateAutoScroll(container, cursorY) {
        if (!container) { stopAutoScroll(); return; }
        const rect = container.getBoundingClientRect();
        const topDist = cursorY - rect.top;
        const bottomDist = rect.bottom - cursorY;
        let delta = 0;
        if (topDist >= 0 && topDist < AUTOSCROLL_EDGE_PX) {
            const ratio = (AUTOSCROLL_EDGE_PX - topDist) / AUTOSCROLL_EDGE_PX;
            delta = -Math.ceil(ratio * AUTOSCROLL_MAX_SPEED);
        } else if (bottomDist >= 0 && bottomDist < AUTOSCROLL_EDGE_PX) {
            const ratio = (AUTOSCROLL_EDGE_PX - bottomDist) / AUTOSCROLL_EDGE_PX;
            delta = Math.ceil(ratio * AUTOSCROLL_MAX_SPEED);
        }
        autoScrollTarget = container;
        autoScrollDelta = delta;
        if (delta !== 0) {
            if (!autoScrollRAF) autoScrollRAF = requestAnimationFrame(autoScrollStep);
        } else stopAutoScroll();
    }

    function findDropZone(s, x, y) {
        const container = document.getElementById('stj_keywords_container');
        if (!container) return null;

        const el = document.elementFromPoint(x, y);
        const hoveredCell = el && el.closest ? el.closest('.stj-keyword-item') : null;

        if (hoveredCell && container.contains(hoveredCell)) {
            if (hoveredCell === s.sourceItem) return null;
            const rect = hoveredCell.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return null;
            const relX = (x - rect.left) / rect.width;
            if (relX < 0.15) {
                return { type: 'insert', reference: hoveredCell, position: 'before' };
            }
            if (relX > 0.85) {
                return { type: 'insert', reference: hoveredCell, position: 'after' };
            }
            return { type: 'swap', cell: hoveredCell };
        }

        const containerRect = container.getBoundingClientRect();
        const margin = 60;
        if (x < containerRect.left - margin || x > containerRect.right + margin ||
            y < containerRect.top - margin || y > containerRect.bottom + margin) {
            return null;
        }

        const cells = Array.from(container.querySelectorAll('.stj-keyword-item'))
            .filter(c => c !== s.sourceItem);
        if (cells.length === 0) return null;

        let nearest = null;
        let nearestDist = Infinity;
        for (const cell of cells) {
            const rect = cell.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dx = Math.max(0, Math.abs(x - cx) - rect.width / 2);
            const dy = Math.max(0, Math.abs(y - cy) - rect.height / 2);
            const dist = dx * dx + dy * dy;
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = cell;
            }
        }
        if (!nearest) return null;

        const rect = nearest.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = x - cx;
        const dy = y - cy;

        let insertBefore;
        if (Math.abs(dx) > rect.width * 0.15) {
            insertBefore = dx < 0;
        } else if (Math.abs(dy) > rect.height * 0.15) {
            insertBefore = dy < 0;
        } else {
            insertBefore = dx < 0;
        }

        return { type: 'insert', reference: nearest, position: insertBefore ? 'before' : 'after' };
    }

    function ensureDragModeBadge() {
        let badge = document.getElementById('stj-drag-mode-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'stj-drag-mode-badge';
            badge.className = 'stj-drag-mode-badge';
            badge.style.display = 'none';
            document.body.appendChild(badge);
        }
        return badge;
    }

    function positionDragModeBadge(x, y) {
        const badge = document.getElementById('stj-drag-mode-badge');
        if (!badge || badge.style.display === 'none') return;
        const offsetX = 18;
        const offsetY = -44;
        let left = x + offsetX;
        let top = y + offsetY;
        const rect = badge.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        if (left + rect.width > vw - 4) left = x - offsetX - rect.width;
        if (top < 4) top = y + 22;
        if (top + rect.height > vh - 4) top = vh - 4 - rect.height;
        if (left < 4) left = 4;
        badge.style.left = Math.round(left) + 'px';
        badge.style.top = Math.round(top) + 'px';
    }

    function updateDragModeBadge(zone, x, y) {
        const badge = ensureDragModeBadge();
        if (!zone) {
            badge.style.display = 'none';
            return;
        }
        let text, mode;
        if (zone.type === 'swap') {
            text = _t('stj.drag.swap', '⇄ 場所交代');
            mode = 'swap';
        } else {
            text = _t('stj.drag.insert', '⬇ 隙間挿入');
            mode = 'insert';
        }
        if (badge.textContent !== text) badge.textContent = text;
        badge.dataset.mode = mode;
        badge.style.display = 'block';
        positionDragModeBadge(x, y);
    }

    function removeDragModeBadge() {
        const badge = document.getElementById('stj-drag-mode-badge');
        if (badge) badge.style.display = 'none';
    }

    function updateDragTarget(s, x, y) {
        const zone = findDropZone(s, x, y);

        const newTarget = (zone && zone.type === 'swap') ? zone.cell : null;
        const newInsertRef = (zone && zone.type === 'insert') ? zone.reference : null;

        if (s.currentTarget && s.currentTarget !== newTarget) {
            s.currentTarget.classList.remove('stj-drag-over');
            s.currentTarget = null;
        }
        if (s.insertReference && s.insertReference !== newInsertRef) {
            s.insertReference.classList.remove('stj-insert-before', 'stj-insert-after');
            s.insertReference = null;
        }

        s.insertZone = null;

        if (!zone) {
            updateDragModeBadge(null, x, y);
            return;
        }

        if (zone.type === 'swap') {
            s.currentTarget = zone.cell;
            zone.cell.classList.add('stj-drag-over');
        } else if (zone.type === 'insert') {
            s.insertZone = zone;
            s.insertReference = zone.reference;
            zone.reference.classList.add(zone.position === 'before' ? 'stj-insert-before' : 'stj-insert-after');
        }

        updateDragModeBadge(zone, x, y);
    }

    function createDragGhost(sourceItem, cursorX, cursorY) {
        const previewEl = sourceItem.querySelector('.stj-image-preview');
        if (!previewEl) return null;
        const rect = previewEl.getBoundingClientRect();
        const ghost = document.createElement('div');
        ghost.className = 'stj-drag-ghost';
        const media = previewEl.querySelector('img, video');
        if (media) {
            const cloned = media.cloneNode(true);
            cloned.style.width = '100%';
            cloned.style.height = '100%';
            cloned.style.objectFit = 'contain';
            cloned.style.display = 'block';
            cloned.style.pointerEvents = 'none';
            cloned.removeAttribute('id');
            if (cloned.tagName === 'VIDEO') {
                cloned.muted = true; cloned.autoplay = true; cloned.loop = true;
                cloned.playsInline = true;
                cloned.play().catch(() => {});
            }
            ghost.appendChild(cloned);
        } else {
            const fallback = document.createElement('div');
            fallback.textContent = _t('stj.preview.placeholder', 'プレビュー');
            fallback.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#a0aec0;font-size:14px;pointer-events:none;';
            ghost.appendChild(fallback);
        }
        ghost.style.width = rect.width + 'px';
        ghost.style.height = rect.height + 'px';
        const offsetX = cursorX - rect.left;
        const offsetY = cursorY - rect.top;
        ghost.style.left = (cursorX - offsetX) + 'px';
        ghost.style.top = (cursorY - offsetY) + 'px';
        document.body.appendChild(ghost);
        return { el: ghost, offsetX, offsetY };
    }

    function moveDragGhost(ghostState, cursorX, cursorY) {
        if (!ghostState || !ghostState.el) return;
        ghostState.el.style.left = (cursorX - ghostState.offsetX) + 'px';
        ghostState.el.style.top = (cursorY - ghostState.offsetY) + 'px';
    }

    function removeDragGhost(ghostState) {
        if (!ghostState) return;
        if (ghostState.el && ghostState.el.parentNode) ghostState.el.parentNode.removeChild(ghostState.el);
    }

    function installPointerDragHandlers() {
        if (pointerDragHandlerInstalled) return;
        pointerDragHandlerInstalled = true;

        document.addEventListener('mousemove', (e) => {
            if (!pointerDragState) return;
            const s = pointerDragState;
            s.lastX = e.clientX;
            s.lastY = e.clientY;
            const dx = e.clientX - s.startX;
            const dy = e.clientY - s.startY;

            if (!s.hasMoved && (dx * dx + dy * dy) > (CLICK_THRESHOLD_PX * CLICK_THRESHOLD_PX)) {
                s.hasMoved = true;
            }

            if (!s.isDragging && (dx * dx + dy * dy) > (DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX)) {
                s.isDragging = true;
                s.sourceItem.classList.add('stj-dragging');
                s.ghostState = createDragGhost(s.sourceItem, e.clientX, e.clientY);
                s.scrollContainer = findScrollableAncestor(s.sourceItem);
                if (stjModalEl) stjModalEl.classList.add('stj-drag-active');
            }
            if (!s.isDragging) return;
            moveDragGhost(s.ghostState, e.clientX, e.clientY);
            positionDragModeBadge(e.clientX, e.clientY);
            updateDragTarget(s, e.clientX, e.clientY);
            updateAutoScroll(s.scrollContainer, e.clientY);
        });

        document.addEventListener('mouseup', () => {
            if (!pointerDragState) return;
            const s = pointerDragState;
            pointerDragState = null;
            stopAutoScroll();
            removeDragModeBadge();
            if (stjModalEl) stjModalEl.classList.remove('stj-drag-active');
            if (s.sourceItem) s.sourceItem.classList.remove('stj-dragging');
            if (s.currentTarget) s.currentTarget.classList.remove('stj-drag-over');
            if (s.insertReference) s.insertReference.classList.remove('stj-insert-before', 'stj-insert-after');
            removeDragGhost(s.ghostState);

            if (s.isDragging || s.hasMoved) {
                _suppressCellClickUntil = Date.now() + 300;
            }

            if (s.isDragging) {
                if (s.insertZone && s.insertZone.reference && s.insertZone.reference !== s.sourceItem) {
                    insertCellAt(s.sourceItem, s.insertZone.reference, s.insertZone.position);
                    runLiveTest();
                    autoSave({ immediate: true });
                    _stjScheduleTreeLayout();
                } else if (s.currentTarget && s.currentTarget !== s.sourceItem) {
                    swapCells(s.sourceItem, s.currentTarget);
                    runLiveTest();
                    autoSave({ immediate: true });
                    _stjScheduleTreeLayout();
                }
            } else {
                const src = s.sourceItem;
                if (!src) return;
                if (s.hasMoved) {
                    return;
                }
                openCellModal(src);
            }
        });

        window.addEventListener('blur', () => {
            if (!pointerDragState) return;
            const s = pointerDragState;
            pointerDragState = null;
            stopAutoScroll();
            removeDragModeBadge();
            if (stjModalEl) stjModalEl.classList.remove('stj-drag-active');
            if (s.sourceItem) s.sourceItem.classList.remove('stj-dragging');
            if (s.currentTarget) s.currentTarget.classList.remove('stj-drag-over');
            if (s.insertReference) s.insertReference.classList.remove('stj-insert-before', 'stj-insert-after');
            removeDragGhost(s.ghostState);
        });
    }

    function resetFormToEmpty() {
        restoreSpecialPreviewsToOrigin();

        const defaultCell = document.querySelector('.stj-special-item:nth-child(1)');
        if (defaultCell) {
            setCellImages(defaultCell, []);
            updateCellPreview(defaultCell);
        }

        const thumbnailCell = document.querySelector('.stj-special-item:nth-child(2)');
        if (thumbnailCell) {
            setCellImages(thumbnailCell, []);
            updateCellPreview(thumbnailCell);
        }

        const container = document.getElementById('stj_keywords_container');
        if (container) {
            delete container.dataset.stjBaseMinW;
            delete container.dataset.stjBaseMinH;
            delete container.dataset.stjTreeBottom;
            delete container.dataset.stjAppliedScale;
            container.innerHTML = '';
            addKeywordRowWithData(container, 0, { keyword: '', images: [] });
        }

        const testInput = document.getElementById('stj_test_input');
        if (testInput) testInput.value = '';

        runLiveTest();
    }

    // ===== 最新のロアブックエントリ名へ同期 =====
async function syncEditorWithLatestLorebook(charName) {
        if (!charName) return false;
        const worldName = getCharacterWorldInfoName();
        if (!worldName) return false;

        try {
            window.LorebookExpansion?.clearWorldInfoEntriesCache?.(worldName);
        } catch (e) { /* ignore */ }

        const entries = await loadWorldInfoEntries(worldName);
        if (!entries || typeof entries !== 'object') return false;

        const list = Array.isArray(entries) ? entries : Object.values(entries);
        if (list.length === 0) return false;

        const imageMap = getCurrentImageMapFromCharData(charName) || {};
        const orderedEntries = [...list].sort((a, b) => {
            const oa = Number(a?.order ?? a?.displayIndex ?? 0);
            const ob = Number(b?.order ?? b?.displayIndex ?? 0);
            return oa - ob;
        });

        const container = document.getElementById('stj_keywords_container');
        if (!container) return false;

        const existingCells = Array.from(container.querySelectorAll('.stj-keyword-item'));
        const cellByUid = new Map();
        const unusedCellsByKw = new Map();

        for (const cell of existingCells) {
            const u = getCellUid(cell);
            const k = getCellKeyword(cell).trim();
            if (u) {
                cellByUid.set(u, cell);
            } else if (k) {
                if (!unusedCellsByKw.has(k)) unusedCellsByKw.set(k, []);
                unusedCellsByKw.get(k).push(cell);
            }
        }

        const usedCells = new Set();
        const usedMapKeys = new Set();
        let idx = 0;

        for (const entry of orderedEntries) {
            if (!entry) continue;
            const latestName = getEntryKeyword(entry);
            const uid = getEntryUid(entry);
            if (!latestName || isCommonRuleName(latestName)) continue;

            const keys = getEntryKeys(entry).map(k => String(k).trim()).filter(Boolean);
            const candidates = [latestName, ...keys];

            let matchedKey = null;
            for (const cand of candidates) {
                if (Object.prototype.hasOwnProperty.call(imageMap, cand) && !usedMapKeys.has(cand)) {
                    matchedKey = cand;
                    break;
                }
            }
            if (matchedKey) usedMapKeys.add(matchedKey);

            const files = matchedKey
                ? (Array.isArray(imageMap[matchedKey]) ? imageMap[matchedKey] : [imageMap[matchedKey]])
                    .map(p => extractFileNameFromPath(p))
                    .filter(Boolean)
                : [];

            let cell = uid ? cellByUid.get(uid) : null;
            if (!cell) {
                const pool = unusedCellsByKw.get(latestName) || [];
                while (pool.length > 0 && !cell) {
                    const candCell = pool.shift();
                    if (!usedCells.has(candCell)) cell = candCell;
                }
            }

            if (cell) {
                usedCells.add(cell);
                setCellUid(cell, uid);
                setCellKeyword(cell, latestName);
                setCellImages(cell, files);
                updateCellPreview(cell);
                container.appendChild(cell);
            } else {
                addKeywordRowWithData(container, idx, { uid, keyword: latestName, images: files });
            }
            idx++;
        }

        for (const cell of existingCells) {
            if (!usedCells.has(cell)) cell.remove();
        }
        if (container.querySelectorAll('.stj-keyword-item').length === 0) {
            addKeywordRowWithData(container, 0, { uid: '', keyword: '', images: [] });
        }

        runLiveTest();
        _stjScheduleTreeLayout();
        return true;
    }
    
    // ===== ①ロアブック本体・②Lorebook Expansion・③画像マッピングの一括JSON自動出力 =====
    let _bundleExportTimer = null;
    let _bundleExportInFlight = false;

async function exportUnifiedBundleJson(options = {}) {
    const { silent = true, charName: explicitCharName = '' } = options;
    const charName = explicitCharName || detectCharacterNameFromDOM();
    if (!charName) {
        console.warn('[STJ Editor] ❌ 一括JSON出力スキップ: キャラクター名が取得できません');
        return { ok: false, reason: 'no_char' };
    }
    // ★ 通常クリック（PNG export）と同一の PNG を CharStore 経由で書き出す
    //    （アバター PNG が取れない場合は Shift+クリックと同じ JSON にフォールバック）
    if (window.CharStore?.exportCurrentCharacterPngToFiles) {
        const r = await window.CharStore.exportCurrentCharacterPngToFiles({ expectedCharName: charName });
        if (r.ok && !silent) window.GicApi?.showBottomToast?.(`キャラクターカード全体を出力しました: ${r.path}`);
        return r;
    }
    if (_bundleExportInFlight) return { ok: false, reason: 'in_flight' };
    _bundleExportInFlight = true;
    
    let bundlePayload = null;

    try {
        console.log(`[STJ Editor] 🚀 キャラクターカード全体形式での一括JSON出力開始: charName="${charName}"`);
        
        const ctx = window.SillyTavern?.getContext?.();
        const charObj = ctx?.characters?.[ctx?.characterId];
        if (!charObj) {
            throw new Error('キャラクターオブジェクトが見つかりません');
        }

        // 1. キャラクター基本データの複製 (V3形式に準拠)
        const charData = charObj.data || {};
        const charExt = charData.extensions || {};
        
        bundlePayload = {
            name: charObj.name || charName,
            description: charData.description || '',
            personality: charData.personality || '',
            scenario: charData.scenario || '',
            first_mes: charData.first_mes || '',
            mes_example: charData.mes_example || '',
            creator_notes: charData.creator_notes || '',
            system_prompt: charData.system_prompt || '',
            post_history_instructions: charData.post_history_instructions || '',
            tags: Array.isArray(charData.tags) ? [...charData.tags] : [],
            creator: charData.creator || '',
            character_version: charData.character_version || '',
            alternate_greetings: Array.isArray(charData.alternate_greetings) ? [...charData.alternate_greetings] : [],
            extensions: structuredClone(charExt),
            character_book: {
                name: '',
                entries: []
            },
            avatar_url: charObj.avatar || '',
            ch_name: charObj.name || charName,
            create_date: new Date().toISOString()
        };

        // 2. ロアブック本体の取得と変換
        const worldName = getCharacterWorldInfoName() || (window.LorebookExpansion?.getChoicesWorldName ? window.LorebookExpansion.getChoicesWorldName() : null);
        console.log(`[STJ Editor] 📌 解決された worldName: "${worldName}"`);
        
        if (worldName) {
            bundlePayload.character_book.name = worldName;
            try {
                window.LorebookExpansion?.clearWorldInfoEntriesCache?.(worldName);
            } catch (e) { /* ignore */ }
            
            const rawEntries = await loadWorldInfoEntries(worldName);
            if (rawEntries && typeof rawEntries === 'object') {
                // SillyTavern エクスポート形式に変換
                const positionMap = {
                    0: 'before_char',
                    1: 'after_char',
                    2: 'before_example',
                    3: 'after_example',
                    4: 'author_note',
                    5: 'in_depth_prompt'
                };

                bundlePayload.character_book.entries = Object.values(rawEntries).map(entry => {
                    const uid = entry.uid !== undefined ? entry.uid : (entry.id !== undefined ? entry.id : 0);
                    
                    // extensions の補完 (window.world_info から最新データを取得)
                    let ext = entry.extensions || {};
                    const wiEntries = window.world_info?.[worldName]?.entries || {};
                    if (Object.keys(ext).length === 0 && wiEntries[uid] && wiEntries[uid].extensions) {
                        ext = wiEntries[uid].extensions;
                    }

                    // keys の正規化
                    let keys = [];
                    if (Array.isArray(entry.keys) && entry.keys.length) keys = entry.keys;
                    else if (Array.isArray(entry.key) && entry.key.length) keys = entry.key;
                    else if (typeof entry.keys === 'string' && entry.keys.trim()) keys = [entry.keys];
                    else if (typeof entry.key === 'string' && entry.key.trim()) keys = [entry.key];

                    // secondary_keys の正規化
                    let secondaryKeys = [];
                    if (Array.isArray(entry.keysecondary)) secondaryKeys = entry.keysecondary;
                    else if (Array.isArray(entry.secondary_keys)) secondaryKeys = entry.secondary_keys;

                    // position の変換
                    let position = 'after_char';
                    if (typeof entry.position === 'number') {
                        position = positionMap[entry.position] || 'after_char';
                    } else if (typeof entry.position === 'string') {
                        position = entry.position;
                    }

                    // enabled の変換 (disable の反転)
                    const enabled = entry.disable !== undefined ? !entry.disable : (entry.enabled !== undefined ? entry.enabled : true);
                    
                    // insertion_order の変換 (order から)
                    const insertionOrder = entry.order !== undefined ? entry.order : (entry.insertion_order !== undefined ? entry.insertion_order : 100);

                    return {
                        id: uid,
                        keys: keys,
                        secondary_keys: secondaryKeys,
                        comment: entry.comment || '',
                        content: entry.content || '',
                        constant: entry.constant !== undefined ? entry.constant : false,
                        selective: entry.selective !== undefined ? entry.selective : false,
                        insertion_order: insertionOrder,
                        enabled: enabled,
                        position: position,
                        use_regex: entry.use_regex !== undefined ? entry.use_regex : (entry.useRegex !== undefined ? entry.useRegex : false),
                        extensions: ext
                    };
                }).sort((a, b) => a.id - b.id);
                
                console.log(`[STJ Editor] 📚 ロアブックエントリを変換完了: ${bundlePayload.character_book.entries.length} 件`);
            }
        }

        // 3. 拡張機能データの最新状態を統合
        // ② Lorebook Expansion データ (per-world store から取得)
        const lexFromStore = (worldName && ctx?.extensionSettings?.lorebook_expansion?.data?.[worldName])
            ? structuredClone(ctx.extensionSettings.lorebook_expansion.data[worldName]) : {};
        
        // ③ JSON編集ツリー（画像マッピング）データ
        const imageMap = structuredClone(getCurrentImageMapFromCharData(charName) || charExt.image_display_extension || {});
        const bagState = structuredClone(charExt.image_display_bag_state || {});
        const meta = structuredClone(charExt.image_display_extension_meta || {});

        // extensions オブジェクトに統合
        if (!bundlePayload.extensions) bundlePayload.extensions = {};
        bundlePayload.extensions.lorebook_expansion = lexFromStore;
        bundlePayload.extensions.image_display_extension = imageMap;
        bundlePayload.extensions.image_display_bag_state = bagState;
        if (Object.keys(meta).length > 0) {
            bundlePayload.extensions.image_display_extension_meta = meta;
        }
        
        // world 紐付けも確実に含める
        if (worldName) {
            bundlePayload.extensions.world = worldName;
        }

        // 4. ファイル出力
        const payloadStr = JSON.stringify(bundlePayload, null, 2);
        const asciiPart = String(charName).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
        const nonAsciiHash = Array.from(String(charName)).reduce((acc, ch) => ((acc * 31 + ch.charCodeAt(0)) >>> 0), 0).toString(36);
        const safeFileBase = asciiPart ? `${asciiPart}_${nonAsciiHash}_card` : `char_${nonAsciiHash}_card`;
        const targetRelativePath = `${safeFileBase}.json`;
        const base64Data = btoa(unescape(encodeURIComponent(payloadStr)));
        const headers = typeof ctx?.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
            
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            headers,
            body: JSON.stringify({ name: targetRelativePath, data: base64Data })
        });
        
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${errText}`.trim());
        }
        
        console.log(`[STJ Editor] ✅ キャラクターカード全体形式のJSONを出力しました: ${targetRelativePath} (サイズ: ${(payloadStr.length / 1024).toFixed(1)} KiB, エントリ数: ${bundlePayload.character_book.entries.length})`);
        if (!silent) window.GicApi?.showBottomToast?.(`キャラクターカード全体を出力しました: ${targetRelativePath}`);
        return { ok: true, path: targetRelativePath };
    } catch (err) {
        console.warn('[STJ Editor] ❌ 一括JSON自動出力エラー:', err);
        if (bundlePayload) {
            try {
                const safeCharName = String(charName).replace(/[\\/:*?"<>|]/g, '_');
                const blob = new Blob([JSON.stringify(bundlePayload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${safeCharName}_card.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                return { ok: true, downloaded: true, fileName: `${safeCharName}_card.json` };
            } catch (dlErr) {
                return { ok: false, error: String(err) };
            }
        }
        return { ok: false, error: String(err) };
    } finally {
        _bundleExportInFlight = false;
    }
}

    function scheduleUnifiedBundleExport(charName = '', delayMs = 800) {
        if (_bundleExportTimer) clearTimeout(_bundleExportTimer);
        _bundleExportTimer = setTimeout(() => {
            _bundleExportTimer = null;
            exportUnifiedBundleJson({ silent: true, charName });
        }, delayMs);
    }
   
    function openExportModal() {
        if (!stjModalEl) return;
        if (stjModalEl.style.display === 'block') return;

        stjModalEl.style.display = 'block';
        stjModalEl.style.position = 'fixed';
        stjModalEl.style.top = '0px';
        stjModalEl.style.left = 'auto';
        stjModalEl.style.right = '0';
        stjModalEl.style.width = '70.5vw';
        stjModalEl.style.minWidth = '500px';
        stjModalEl.style.height = '100vh';
        stjModalEl.style.zIndex = '10001';
        stjModalEl.scrollTop = 0;
        document.body.classList.add('stj-editor-open');
        modalOpenedTimestamp = Date.now();

        const charName = detectCharacterNameFromDOM() || '';
        const nameEl = document.getElementById('stj_char_name_display');
        if (nameEl) nameEl.textContent = charName;

        _editorLoading = true;

        resetFormToEmpty();

        (async () => {
            try {
                let effectiveCharName = charName;
                if (!effectiveCharName) {
                    for (let i = 0; i < 10; i++) {
                        await new Promise(r => setTimeout(r, 200));
                        effectiveCharName = detectCharacterNameFromDOM() || '';
                        if (effectiveCharName) {
                            if (nameEl) nameEl.textContent = effectiveCharName;
                            console.log(`[STJ Editor] charName を遅延取得: ${effectiveCharName}`);
                            break;
                        }
                    }
                }

                if (!effectiveCharName) {
                    console.warn('[STJ Editor] charName を取得できませんでした（フォームは空のまま）');
                }

                const hasCharData = await loadExistingJSONData(effectiveCharName);
                if (!hasCharData) {
                    loadSavedData(effectiveCharName);
                } else {
                    console.log('[STJ Editor] character.data を権威ソースとして使用（extensionSettings フォールバック無効）');
                }
                await syncEditorWithLatestLorebook(effectiveCharName);
                setupPreviewListeners();
                runLiveTest();
            } catch (err) {
                console.error('[STJ Editor] モーダル表示エラー:', err);
            } finally {
                _editorLoading = false;
            }
        })();
    }

    function closeExportModalInternal() {
        if (!stjModalEl) return;
        flushAutoSave();
        try {
            if (window.CharStore?.flushCharacterExtension) {
                window.CharStore.flushCharacterExtension('image_display_extension');
            }
        } catch (e) { /* ignore */ }
        closeCellModal(false);
        restoreSpecialPreviewsToOrigin();
        stjModalEl.style.display = 'none';
        document.body.classList.remove('stj-editor-open');
    }

    function closeExportModal(opts = {}) {
        if (!stjModalEl) return;
        const { fromGallery = false, force = false } = opts;
        if (stjModalEl.style.display !== 'block') return;
        if (!force && isDialogActive) return;
        closeExportModalInternal();
        if (!fromGallery) {
            if (window.GicApi?.closeGallery) {
                try { window.GicApi.closeGallery(); } catch (e) { /* ignore */ }
            }
        }
    }

    function createCellModal() {
        const modal = document.createElement('div');
        modal.id = 'stj_cell_modal';
        modal.className = 'stj-cell-modal';
        modal.innerHTML = `
            <div class="stj-cell-modal-content">
                <div class="stj-cell-modal-header">
                    <button type="button" class="stj-cell-modal-apply">${_t('stj.cell_modal.apply', '決定')}</button>
                    <button type="button" class="stj-cell-modal-cancel">${_t('stj.cell_modal.cancel', 'キャンセル')}</button>
                    <div class="stj-cell-modal-keyword-display" id="stj_cell_modal_keyword_display"></div>
                    <button type="button" class="stj-cell-modal-delete">削除</button>
                </div>
                <div class="stj-cell-modal-entry-host" id="stj_cell_modal_entry_host" style="display: block; height: 35%;"></div>
                <div class="stj-cell-modal-grid"></div>
            </div>
        `;

        if (!document.getElementById('stj-cell-keyword-style')) {
            const s = document.createElement('style');
            s.id = 'stj-cell-keyword-style';
            s.textContent = `
                #stj_keywords_container.stj-tree-mode {
                    --stj-tree-scale: var(--exp-scale, 1);
                    position: relative;
                }
                #stj_keywords_container.stj-tree-mode .stj-tree-svg {
                    transform-origin: top left;
                }
                .stj-info-panel {
                    display: none !important;
                }
                #stj_keywords_container.stj-tree-mode .stj-tree-top-left-modes {
                    position: absolute !important;
                    left: calc(var(--stj-tree-scale, 1) * 12px) !important;
                    top: calc(var(--stj-tree-scale, 1) * 12px) !important;
                    z-index: 5;
                    display: flex !important;
                    flex-direction: column !important;
                    gap: calc(var(--stj-tree-scale, 1) * 6px) !important;
                }
                #stj_keywords_container.stj-tree-mode .stj-tree-top-left-modes .stj-special-pair {
                    display: flex !important;
                    flex-direction: column !important;
                    align-items: flex-start !important;
                    gap: calc(var(--stj-tree-scale, 1) * 2px) !important;
                    width: calc(var(--stj-tree-scale, 1) * 160px) !important;
                }
                #stj_keywords_container.stj-tree-mode .stj-tree-top-left-modes .stj-special-preview,
                #stj_keywords_container.stj-tree-mode .stj-tree-top-left-modes .stj-image-preview {
                    width: calc(var(--stj-tree-scale, 1) * 160px) !important;
                    height: calc(var(--stj-tree-scale, 1) * 160px) !important;
                    min-width: 0 !important;
                    min-height: 0 !important;
                    max-width: calc(var(--stj-tree-scale, 1) * 160px) !important;
                    max-height: calc(var(--stj-tree-scale, 1) * 160px) !important;
                }
                #stj_keywords_container.stj-tree-mode .stj-tree-top-left-modes .stj-special-label {
                    font-size: calc(var(--stj-tree-scale, 1) * 10px) !important;
                    line-height: 1.2 !important;
                }
                .stj-tree-bottom-left-other {
                    position: absolute;
                    left: calc(var(--stj-tree-scale, 1) * 12px);
                    z-index: 5;
                    display: flex;
                    flex-direction: row;
                    align-items: flex-end;
                    flex-wrap: wrap;
                    gap: calc(var(--stj-tree-scale, 1) * 8px);
                }
                #stj_keywords_container.stj-tree-mode .stj-keyword-item {
                    box-sizing: border-box;
                    font-size: calc(var(--stj-tree-scale, 1) * 14px) !important;
                }
                #stj_keywords_container.stj-tree-mode .stj-keyword-display {
                    padding: calc(var(--stj-tree-scale, 1) * 4px) calc(var(--stj-tree-scale, 1) * 6px);
                    font-size: calc(var(--stj-tree-scale, 1) * 13px) !important;
                    line-height: 1.25 !important;
                    word-break: break-word;
                }
                #stj_keywords_container.stj-tree-mode .stj-preview-text {
                    font-size: calc(var(--stj-tree-scale, 1) * 13px) !important;
                }
                #stj_cell_modal .stj-cell-modal-content {
                    display: flex !important;
                    flex-direction: column !important;
                    width: calc(var(--stj-cell-modal-base-w, 80vh) * 1.35) !important;
                    max-width: 96vw !important;
                    height: calc(var(--stj-cell-modal-base-h, 86vh) * 1.15) !important;
                    max-height: 96vh !important;
                    overflow: hidden;
                }
                #stj_cell_modal .stj-cell-modal-header,
                .stj-cell-modal-header {
                    height: calc(var(--exp-scale, 1) * 36px);
                    min-height: calc(var(--exp-scale, 1) * 30px);
                    max-height: calc(var(--exp-scale, 1) * 60px);
                    display: flex !important;
                    flex-direction: row !important;
                    flex-wrap: nowrap !important;
                    align-items: center !important;
                    gap: calc(var(--exp-scale, 1) * 6px);
                    padding: 0 calc(var(--exp-scale, 1) * 8px);
                    background: #2d3748;
                    border-bottom: 1px solid #4a5568;
                    width: 100%;
                    flex-shrink: 0;
                    position: relative;
                }
                #stj_cell_modal .stj-cell-modal-entry-host {
                    display: block !important;
                    width: 100%;
                    height: 43% !important;
                    min-height: 0;
                    overflow-y: auto;
                    margin: 0px;
                    padding: 1px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 6px;
                    background: rgba(0, 0, 0, 0.25);
                    box-sizing: border-box;
                    flex: 0 0 43% !important;
                }
                .stj-cell-modal-apply {
                    height: calc(var(--exp-scale, 1) * 36px);
                    padding: 0 calc(var(--exp-scale, 1) * 8px);
                    background: #e0e0e0;
                    color: #000;
                    border: 1px solid #aaa;
                    border-radius: calc(var(--exp-scale, 1) * 4px);
                    cursor: pointer;
                    font-size: calc(var(--exp-scale, 1) * 18px);
                    font-weight: bold;
                    flex-shrink: 0;
                }
                .stj-cell-modal-cancel {
                    height: calc(var(--exp-scale, 1) * 36px);
                    padding: 0 calc(var(--exp-scale, 1) * 8px);
                    background: #4a5568;
                    color: white;
                    border: 1px solid #718096;
                    border-radius: calc(var(--exp-scale, 1) * 4px);
                    cursor: pointer;
                    font-size: calc(var(--exp-scale, 1) * 18px);
                    font-weight: bold;
                    flex-shrink: 0;
                }
                .lbe-variable-row {
                    display: flex;
                    gap: 6px;
                    align-items: center;
                    width: 100%;
                    max-width: 100%;
                    box-sizing: border-box;
                    flex-wrap: nowrap;
                    height: calc(var(--exp-scale, 1) * 28px);
                }
                #stj_cell_modal .stj-cell-modal-entry-host .world_entry {
                    display: block !important;
                    width: 100%;
                    height: auto !important;
                    max-height: none !important;
                }
                #stj_cell_modal .stj-cell-modal-entry-host .world_entry > *:not(.drag-handle):not(.inline-drawer-header) {
                    visibility: visible !important;
                    opacity: 1 !important;
                    height: auto !important;
                    max-height: none !important;
                }
                #stj_cell_modal .stj-cell-modal-entry-host .inline-drawer-content,
                #stj_cell_modal .stj-cell-modal-entry-host .world_entry_edit,
                #stj_cell_modal .stj-cell-modal-entry-host .world_entry_form {
                    display: block !important;
                    visibility: visible !important;
                    opacity: 1 !important;
                    height: auto !important;
                    max-height: none !important;
                    overflow: visible !important;
                }
                #stj_cell_modal .stj-cell-modal-entry-host .lbe-extras-panel {
                    height: auto !important;
                    max-height: none !important;
                    overflow: visible !important;
                }
                #stj_cell_modal .stj-cell-modal-entry-host .world_entry.lbe-extras-collapsed .lbe-extras-panel {
                    display: none !important;
                }
                #stj_cell_modal .stj-cell-modal-entry-host .drag-handle,
                #stj_cell_modal .stj-cell-modal-entry-host .inline-drawer-header,
                #stj_cell_modal .stj-cell-modal-entry-host [name="keywordsAndLogicBlock"] {
                    display: none !important;
                }
                #stj_cell_modal .stj-cell-modal-entry-host textarea[name="comment"] {
                    min-height: 36px;
                    line-height: 1.4;
                    resize: vertical;
                }
                #stj_cell_modal .stj-cell-modal-grid {
                    display: grid !important;
                    grid-template-columns: repeat(4, minmax(0, 1fr)) !important;
                    flex: 1 1 auto;
                    min-height: 0;
                    overflow-y: auto;
                }
                .stj-cell-modal-keyword-display {
                    display: inline-block;
                    flex: 1 1 auto;
                    min-width: 0;
                    padding: 10px 16px;
                    margin: 0;
                    font-size: calc(var(--exp-scale, 1) * 28px);
                    font-weight: bold;
                    color: #ffffff;
                    text-align: left;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                    -webkit-text-stroke: 4px #000000;
                    paint-order: stroke fill;
                    text-shadow:
                        -3px -3px 0 #000, 3px -3px 0 #000, -3px 3px 0 #000, 3px 3px 0 #000,
                        -3px 0 0 #000, 3px 0 0 #000, 0 -3px 0 #000, 0 3px 0 #000;
                    word-break: break-word;
                    line-height: 1.3;
                }
                .stj-cell-modal-keyword-display:empty {
                    display: none;
                }
                .lbe-label-row > .lbe-resolution-select {
                    flex: 0 0 auto;
                    width: auto;
                    min-width: 150px;
                    max-width: calc(var(--exp-scale, 1) * 300px);
                    font-size: 0.82em;
                    padding: 2px 4px;
                    box-sizing: border-box;
                }
                .lbe-label-row {
                    justify-content: flex-start;
                    width: 100%;
                    max-width: 100%;
                    box-sizing: border-box;
                    font-size: calc(var(--exp-scale, 1) * 20px);
                }
                .lbe-label-row > .lbe-label {
                    margin: 0;
                    flex: 0 1 auto;
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: inherit;
                    white-space: nowrap;
                    font-size: calc(var(--exp-scale, 1) * 22px) !important;
                    padding: 0px 5px 0px !important;
                }
                .lbe-template-row > .lbe-template-add {
                    font-size: calc(var(--exp-scale, 1) * 16px) !important;
                }
                .lbe-template-row > .lbe-template-del {
                    font-size: calc(var(--exp-scale, 1) * 16px) !important;
                }
                .lbe-choice-add {
                    font-size: calc(var(--exp-scale, 1) * 14px) !important;
                }
                .lbe-variable-add {
                    font-size: calc(var(--exp-scale, 1) * 14px) !important;
                }
                .stj-cell-modal-delete {
                    height: calc(var(--exp-scale, 1) * 36px);
                    padding: 0 calc(var(--exp-scale, 1) * 8px);
                    background: rgba(255, 255, 255, 1.0);
                    color: #ff0000;
                    border: 4px solid #ff0000;
                    border-radius: calc(var(--exp-scale, 1) * 4px);
                    cursor: pointer;
                    font-size: calc(var(--exp-scale, 1) * 18px);
                    font-weight: bold;
                    flex-shrink: 0;
                    margin-left: auto; /* 右端に寄せる */
                }
                .stj-cell-modal-delete:hover {
                    background: rgba(255, 33, 33, 0.2);
                    color: #ffffff;
                }
            `;
            document.head.appendChild(s);
        }

        document.body.appendChild(modal);

        modal.querySelector('.stj-cell-modal-apply').addEventListener('click', (e) => {
            e.stopPropagation();
            applyCellModal();
        });
        modal.querySelector('.stj-cell-modal-cancel').addEventListener('click', (e) => {
            e.stopPropagation();
            closeCellModal(true);
        });

// stj_editor.js (createCellModal 関数内の .stj-cell-modal-delete イベントリスナーを置き換え)
modal.querySelector('.stj-cell-modal-delete').addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!currentModalCell) return;
    
    const entryName = getCellKeyword(currentModalCell) || modalOriginalKeyword;
    if (!entryName) {
        showCustomAlert('キーワードが設定されていないため削除できません');
        return;
    }
    
    // 1. 自作の確認ダイアログを表示（改行付き）
    showDeleteConfirmDialog(
        `画像データを残してエントリを削除しますか？\nエントリ: ${entryName}\nこの操作は取り消せません！`,
        () => {
            // 「はい」が押されたら実行されるコールバック
            
            // 2. 対象のロアブックエントリ要素を探す（セルモーダル内にマウントされている）
            const hostEl = currentCellModal.querySelector('#stj_cell_modal_entry_host');
            let targetEntryEl = hostEl?.querySelector('.world_entry[uid]');
            
            if (!targetEntryEl) {
                const worldPopup = document.getElementById('world_popup');
                const cellUid = getCellUid(currentModalCell);
                if (cellUid && worldPopup) {
                    targetEntryEl = worldPopup.querySelector(`.world_entry[uid="${CSS.escape(cellUid)}"]`);
                }
            }
            
            if (!targetEntryEl) {
                showCustomAlert('対象のロアブックエントリが見つかりません');
                return;
            }
            
            const deleteBtn = targetEntryEl.querySelector('.delete_entry_button');
            if (!deleteBtn) {
                showCustomAlert('削除ボタンが見つかりません');
                return;
            }
            
            // 3. 公式ダイアログ(#dialogue_popup)を即座に非表示化してスキップ
            const observer = new MutationObserver((mutations, obs) => {
                const popup = document.querySelector('#dialogue_popup');
                if (popup && popup.style.display !== 'none' && !popup.classList.contains('stj-auto-confirmed')) {
                    popup.classList.add('stj-auto-confirmed');
                    
                    // ★ 修正: 即座に非表示にしてユーザーに見せない
                    popup.style.setProperty('display', 'none', 'important');
                    
                    // ★ 修正: innerHTML で <br> を使って確実に改行
                    const textEl = popup.querySelector('#dialogue_popup_text');
                    if (textEl) {
                        textEl.innerHTML = `画像データを残してエントリを削除しますか？<br>エントリ: <b>${entryName}</b><br>この操作は取り消せません！`;
                    }
                    
                    // 即座に「はい」を自動クリック
                    const okBtn = popup.querySelector('#dialogue_popup_ok');
                    if (okBtn) {
                        setTimeout(() => {
                            okBtn.click();
                        }, 10);
                    }
                    
                    // Observerは一度処理したら切断
                    setTimeout(() => obs.disconnect(), 300);
                }
            });
            observer.observe(document.body, { 
                childList: true, 
                subtree: true, 
                attributes: true,
                attributeFilter: ['style', 'class']
            });
            
            // 4. ゴミ箱ボタンをクリックしてST本体の削除処理を発火
            const clickEvent = new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                view: window
            });
            deleteBtn.dispatchEvent(clickEvent);
            
            // 5. セルモーダルを閉じ、セルを削除する処理を予約
            setTimeout(() => {
                // セルモーダルを閉じる
                closeCellModal(false);
                
                // JSON編集ツリーからセルを削除
                if (currentModalCell && currentModalCell.parentNode) {
                    currentModalCell.remove();
                }
                
                // ツリーレイアウトを再計算して保存
                autoSave({ immediate: true });
                runLiveTest();
                _stjScheduleTreeLayout();
                
                console.log(`[STJ Editor] 🗑️ エントリ削除完了: ${entryName}`);
            }, 300);
        }
    );
});
        
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeCellModal(true);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.classList.contains('visible')) {
                closeCellModal(true);
            }
        });

        const kwInput = modal.querySelector('.stj-cell-modal-keyword');
        if (kwInput) {
            kwInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    applyCellModal();
                }
            });

            kwInput.addEventListener('input', () => {
                if (!currentModalCell) return;
                if (currentModalCell.classList.contains('stj-special-item')) return;

                const newKw = kwInput.value.trim();
                if (!newKw) {
                    kwInput.style.borderColor = '';
                    kwInput.style.boxShadow = '';
                    kwInput.title = '';
                    return;
                }

                const dup = findDuplicateKeyword(currentModalCell, newKw);
                if (dup) {
                    kwInput.style.borderColor = '#e53e3e';
                    kwInput.style.boxShadow = '0 0 0 2px rgba(229, 62, 62, 0.4)';
                    kwInput.title = '既に同じキーワードが設定されています';
                } else {
                    kwInput.style.borderColor = '';
                    kwInput.style.boxShadow = '';
                    kwInput.title = '';
                }
            });
        }

        modal.querySelector('.stj-cell-modal-grid').addEventListener('click', (e) => {
            const btn = e.target.closest('.stj-cell-modal-slot-remove');
            if (!btn) return;
            e.stopPropagation();
            e.preventDefault();
            const slot = btn.closest('.stj-cell-modal-slot');
            const fileName = slot.dataset.fileName;
            if (fileName && currentModalCell) {
                removeImageFromCell(currentModalCell, fileName);
                renderCellModalGrid(currentModalCell).catch(err => console.warn('[STJ Editor] render error:', err));
                updateCellPreview(currentModalCell);
                autoSave({ immediate: true });
            }
        });

        return modal;
    }

    function openCellModal(cell) {
        if (!cell) return;
        if (isDialogActive) return;

        if (currentModalCell === cell &&
            currentCellModal &&
            currentCellModal.classList.contains('visible')) {
            return;
        }

        if (!currentCellModal) currentCellModal = createCellModal();

        currentModalCell = cell;
        modalOriginalImages = [...getCellImages(cell)];
        modalOriginalKeyword = getCellKeyword(cell);

        const isSpecial = cell.classList.contains('stj-special-item');
        const entryHostEl = currentCellModal.querySelector('#stj_cell_modal_entry_host');

        if (entryHostEl) {
            entryHostEl.innerHTML = '';
            entryHostEl.style.display = 'none';
            if (!isSpecial) {
                mountWorldEntryInCellModal(cell).catch(e => console.warn('[STJ Editor] entry mount error:', e));
            }
        }

        const grid = currentCellModal.querySelector('.stj-cell-modal-grid');
        grid.innerHTML = '';
        grid.scrollTop = 0;

        if (_cellVideoIO) {
            try { _cellVideoIO.disconnect(); } catch (e) { /* ignore */ }
            _cellVideoIO = null;
            _cellVideoIORoot = null;
        }

        const headerEl = currentCellModal.querySelector('.stj-cell-modal-header');
        let kwDisplayEl = currentCellModal.querySelector('#stj_cell_modal_keyword_display');
        if (!kwDisplayEl && headerEl) {
            kwDisplayEl = document.createElement('div');
            kwDisplayEl.className = 'stj-cell-modal-keyword-display';
            kwDisplayEl.id = 'stj_cell_modal_keyword_display';
            headerEl.appendChild(kwDisplayEl);
        } else if (kwDisplayEl && headerEl && kwDisplayEl.parentElement !== headerEl) {
            headerEl.appendChild(kwDisplayEl);
        }
        if (kwDisplayEl) {
            kwDisplayEl.textContent = isSpecial ? '' : (getCellKeyword(cell) || modalOriginalKeyword || '');
        }

        currentCellModal.classList.add('visible');
        document.body.classList.add('stj-cell-modal-active');

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (!currentCellModal || currentModalCell !== cell) return;
                try {
                    renderCellModalGrid(cell).catch(e => console.warn('[STJ Editor] renderCellModalGrid error:', e));
                } catch (e) {
                    console.error('[STJ Editor] renderCellModalGrid error:', e);
                }
            });
        });
    }

    function closeCellModal(revert) {
        if (!currentCellModal) return;
        const entryHostEl = currentCellModal.querySelector('#stj_cell_modal_entry_host');
        if (entryHostEl) {
            restoreMountedWorldEntry(entryHostEl);
        }
        const zoom = document.getElementById('stj_media_zoom');
        if (zoom) zoom.remove();
        document.body.classList.remove('stj-zoom-active');

        if (revert && currentModalCell) {
            if (!currentModalCell.classList.contains('stj-special-item')) {
                setCellKeyword(currentModalCell, modalOriginalKeyword);
            }
            setCellImages(currentModalCell, modalOriginalImages);
            updateCellPreview(currentModalCell);
        }
        currentCellModal.classList.remove('visible');
        currentModalCell = null;
        modalOriginalKeyword = '';
        modalOriginalImages = [];
        document.body.classList.remove('stj-cell-modal-active');

        if (_cellVideoIO) {
            try { _cellVideoIO.disconnect(); } catch (e) { /* ignore */ }
            _cellVideoIO = null;
            _cellVideoIORoot = null;
        }
    }

    function applyCellModal() {
        if (!currentCellModal || !currentModalCell) return;

        const cell = currentModalCell;

        if (!cell.classList.contains('stj-special-item')) {
            const kwInput = currentCellModal.querySelector('.stj-cell-modal-keyword');
            const newKw = kwInput ? kwInput.value.trim() : '';
            if (newKw) {
                const dup = findDuplicateKeyword(cell, newKw);
                if (dup) {
                    showKeywordDuplicateWarning(newKw);
                    if (kwInput) {
                        kwInput.style.borderColor = '#e53e3e';
                        kwInput.style.boxShadow = '0 0 0 2px rgba(229, 62, 62, 0.4)';
                        kwInput.title = '既に同じキーワードが設定されています';
                        try { kwInput.focus(); } catch (e) { /* ignore */ }
                    }
                    return;
                }
            }
        }

        const currentImages = getCellImages(cell);
        const currentSet = new Set(currentImages);
        const removedFiles = modalOriginalImages.filter(f => !currentSet.has(f));

        if (removedFiles.length > 0) {
            showDeleteConfirmDialog(
                _t('stj.confirm.unregister_images_msg',
                   `${removedFiles.length}枚の画像をキーワードから登録解除しますか？`,
                   { count: removedFiles.length }),
                () => { doApplyCellModal(); },
                () => { /* いいえ: モーダルに留まる */ }
            );
            return;
        }

        doApplyCellModal();
    }

    function doApplyCellModal() {
        if (!currentCellModal || !currentModalCell) return;
        const cell = currentModalCell;
        updateCellPreview(cell);
        runLiveTest();
        autoSave({ immediate: true });
        try {
            if (window.LorebookExpansion?.cleanupLexDuplicateKeys) {
                window.LorebookExpansion.cleanupLexDuplicateKeys();
            }
            if (typeof window.saveSettingsDebounced === 'function') {
                window.saveSettingsDebounced();
            }
        } catch (e) { /* ignore */ }
        const entryHostEl = currentCellModal.querySelector('#stj_cell_modal_entry_host');
        if (entryHostEl) {
            if (typeof entryHostEl._syncEntry === 'function') entryHostEl._syncEntry();
            restoreMountedWorldEntry(entryHostEl);
        }
        const zoom = document.getElementById('stj_media_zoom');
        if (zoom) zoom.remove();
        document.body.classList.remove('stj-zoom-active');
        currentCellModal.classList.remove('visible');
        currentModalCell = null;
        modalOriginalKeyword = '';
        modalOriginalImages = [];
        document.body.classList.remove('stj-cell-modal-active');

        if (_cellVideoIO) {
            try { _cellVideoIO.disconnect(); } catch (e) { /* ignore */ }
            _cellVideoIO = null;
            _cellVideoIORoot = null;
        }
    }

    let _cellVideoIO = null;
    let _cellVideoIORoot = null;

    function ensureCellVideoIO(grid) {
        if (_cellVideoIO && _cellVideoIORoot === grid) return _cellVideoIO;
        if (_cellVideoIO) {
            try { _cellVideoIO.disconnect(); } catch (e) { /* ignore */ }
        }
        _cellVideoIORoot = grid;
        _cellVideoIO = new IntersectionObserver(() => { /* no-op */ }, {
            threshold: 0.1,
            root: grid,
        });
        return _cellVideoIO;
    }

    function resolveModalMediaPath(fileName, charName) {
        if (!fileName || typeof fileName !== 'string') return '';
        if (/^https?:\/\//i.test(fileName)) return fileName;
        if (fileName.startsWith('/')) return fileName;
        if (fileName.startsWith('user/images/')) return '/' + fileName;
        if (!charName) return '/' + fileName;
        return '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(fileName);
    }

    async function renderCellModalGrid(cell) {
        if (!currentCellModal || !cell) return;

        const myToken = ++_currentGridRenderToken;

        const rawImages = getCellImages(cell);
        const images = rawImages.map(f => resolveThumbToOriginal(f));

        const grid = currentCellModal.querySelector('.stj-cell-modal-grid');
        if (!grid) return;

        const neededSlots = Math.max(8, Math.ceil(images.length / 4) * 4);
        const currentCount = grid.children.length;
        for (let i = currentCount; i < neededSlots; i++) {
            const slot = document.createElement('div');
            slot.className = 'stj-cell-modal-slot';
            slot.dataset.index = String(i);
            slot.innerHTML = `<button type="button" class="stj-cell-modal-slot-remove" title="${_t('stj.cell_modal.slot_remove_title', '登録解除')}">×</button>`;
            grid.appendChild(slot);
        }

        const slots = grid.querySelectorAll('.stj-cell-modal-slot');
        const charName = document.getElementById('stj_char_name_display')?.textContent || '';
        const io = ensureCellVideoIO(grid);

        const thumbPromises = new Map();
        for (let i = 0; i < images.length; i++) {
            const fileName = images[i];
            if (!fileName || !isVideoUrl(fileName)) continue;
            thumbPromises.set(i, ensureThumbForEditor(fileName, charName));
        }

        for (let i = 0; i < slots.length; i++) {
            if (myToken !== _currentGridRenderToken) return;

            const slot = slots[i];
            const fileName = images[i];
            const rawFileName = rawImages[i];

            if (!fileName) {
                slot.querySelectorAll(':scope > img, :scope > video').forEach(el => {
                    if (el.tagName === 'VIDEO') {
                        try { el.pause(); } catch (e) { /* ignore */ }
                    }
                    el.remove();
                });
                attachVideoBadge(slot, false).catch(() => {});
                try { io.unobserve(slot); } catch (e) { /* ignore */ }
                slot.removeAttribute('data-file-name');
                delete slot.dataset.fileName;
                continue;
            }

            const fullPath = resolveModalMediaPath(fileName, charName);
            const isVideo = isVideoUrl(fileName);

            slot.dataset.fileName = rawFileName || fileName;

            const existing = slot.querySelector(':scope > img, :scope > video');
            if (existing) {
                const existingSrc = existing.getAttribute('data-src') || existing.getAttribute('src');
                const existingIsVideo = existing.tagName === 'VIDEO';
                if (existingIsVideo === isVideo && existingSrc === fullPath) {
                    attachVideoBadge(slot, isVideo, fileName, charName).catch(() => {});
                    continue;
                }
                if (existingIsVideo) {
                    try { existing.pause(); } catch (e) { /* ignore */ }
                    try { io.unobserve(slot); } catch (e) { /* ignore */ }
                }
                existing.remove();
            }

            const openZoom = (e) => {
                e.stopPropagation();
                e.preventDefault();
                showMediaZoom(fullPath, isVideo);
            };

            if (isVideo) {
                const thumbUrl = await thumbPromises.get(i);
                if (myToken !== _currentGridRenderToken) return;
                if (thumbUrl) {
                    const img = document.createElement('img');
                    img.src = thumbUrl;
                    img.dataset.src = thumbUrl;
                    img.dataset.videoSrc = fullPath;
                    img.alt = fileName;
                    img.className = 'gic-cell-thumb';
                    img.style.cssText =
                        'width:100%;height:100%;object-fit:contain;display:block;' +
                        'pointer-events:auto;cursor:zoom-in;background:#000;';
                    img.addEventListener('click', openZoom);
                    slot.insertBefore(img, slot.firstChild);
                    attachVideoBadge(slot, true, fileName, charName).catch(() => {});
                    continue;
                }

                const v = document.createElement('video');
                v.className = 'gic-cell-video';
                v.dataset.src = fullPath;
                v.setAttribute('muted', '');
                v.setAttribute('loop', '');
                v.setAttribute('playsinline', '');
                v.setAttribute('webkit-playsinline', '');
                v.setAttribute('preload', 'auto');
                v.muted = true;
                v.loop = true;
                v.playsInline = true;
                v.preload = 'auto';
                v.style.cssText =
                    'width:100%;height:100%;object-fit:contain;display:block;' +
                    'background:#000;pointer-events:auto;cursor:zoom-in;';
                v.addEventListener('click', openZoom);
                v.addEventListener('loadeddata', () => {
                    try {
                        if (Number.isFinite(v.duration) && v.duration > 0.1) {
                            v.currentTime = Math.min(1, v.duration * 0.1);
                        }
                    } catch (e) { /* ignore */ }
                }, { once: true });
                v.src = fullPath;
                slot.insertBefore(v, slot.firstChild);
                io.observe(slot);
                attachVideoBadge(slot, true, fileName, charName).catch(() => {});
            } else {
                let displaySrc = fullPath;
                if (/\.(gif|png)$/i.test(fileName)) {
                    try {
                        if (window.GicApi?.getStaticFrameUrl) {
                            const staticUrl = await window.GicApi.getStaticFrameUrl(fileName, charName);
                            if (myToken !== _currentGridRenderToken) return;
                            if (staticUrl) displaySrc = staticUrl;
                        }
                    } catch (e) { /* ignore */ }
                }

                const img = document.createElement('img');
                img.src = displaySrc;
                img.dataset.src = fullPath;
                img.alt = fileName;
                img.style.cssText =
                    'width:100%;height:100%;object-fit:contain;display:block;' +
                    'pointer-events:auto;cursor:zoom-in;';
                img.addEventListener('click', openZoom);
                slot.insertBefore(img, slot.firstChild);

                attachVideoBadge(slot, false, fileName, charName).catch(() => {});
            }
        }
    }

    function showMediaZoom(src, isVideo) {
        const existing = document.getElementById('stj_media_zoom');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'stj_media_zoom';
        overlay.className = 'stj-media-zoom';

        let mediaEl;
        if (isVideo) {
            mediaEl = document.createElement('video');
            mediaEl.dataset.src = src;
            mediaEl.setAttribute('controls', '');
            mediaEl.setAttribute('playsinline', '');
            mediaEl.setAttribute('webkit-playsinline', '');
            mediaEl.setAttribute('autoplay', '');
            mediaEl.setAttribute('loop', '');
            mediaEl.controls = true;
            mediaEl.loop = true;
            mediaEl.playsInline = true;
            mediaEl.autoplay = true;
            mediaEl.muted = false;
            mediaEl.preload = 'auto';
            mediaEl.src = src;
        } else {
            mediaEl = document.createElement('img');
            mediaEl.src = src;
            mediaEl.alt = '';
            mediaEl.dataset.src = src;
        }
        mediaEl.className = 'stj-media-zoom-content';
        overlay.appendChild(mediaEl);

        const close = () => {
            overlay.remove();
            document.body.classList.remove('stj-zoom-active');
            document.removeEventListener('keydown', onKeyDown);
            try { mediaEl.pause && mediaEl.pause(); } catch (e) { /* ignore */ }
        };
        const onKeyDown = (e) => {
            if (e.key === 'Escape') close();
        };

        overlay.addEventListener('click', (e) => {
            if (e.target === mediaEl) {
                if (isVideo) return;
                e.stopPropagation();
                e.preventDefault();
                close();
                return;
            }
            e.stopPropagation();
            e.preventDefault();
            close();
        });

        document.addEventListener('keydown', onKeyDown);
        document.body.classList.add('stj-zoom-active');
        document.body.appendChild(overlay);

        if (isVideo) {
            mediaEl.play().catch((err) => {
                console.warn('[STJ Video Zoom] autoplay failed, retrying muted:', err);
                mediaEl.muted = true;
                mediaEl.play().catch(() => {});
            });
        }
    }

    function updateCellPreview(cell) {
        if (!cell) return;
        const previewEl = cell.querySelector('.stj-image-preview');
        if (!previewEl) return;
        const charName = document.getElementById('stj_char_name_display')?.textContent || '';
        const images = getCellImages(cell);
        updateImagePreview(previewEl.id, charName, images.join(','));
    }

    function handleCellDropFromPath(cell, path) {
        if (!cell || !path) return;
        cell.classList.remove('stj-drop-target');
        const rawName = extractFileNameFromPath(path);
        if (!rawName) {
            console.log(`[STJ Editor] 無効なファイル名のためスキップ: ${String(path).slice(0, 80)}`);
            return;
        }

        const fileName = resolveThumbToOriginal(rawName);

        if (!/\.(png|jpe?g|gif|webp|avif|bmp|mp4|webm)$/i.test(fileName)) {
            console.log(`[STJ Editor] 拡張子なしのためスキップ: ${fileName}`);
            return;
        }

        const added = addImageToCell(cell, fileName);
        if (!added) {
            console.log(`[STJ Editor] ${fileName} は追加できません（重複）`);
            return;
        }
        updateCellPreview(cell);

        if (currentModalCell === cell && currentCellModal && currentCellModal.classList.contains('visible')) {
            renderCellModalGrid(cell).catch(e => console.warn('[STJ Editor] render error:', e));
        }

        try { runLiveTest(); } catch (_) {}
        autoSave({ immediate: true });
        _stjScheduleTreeLayout();
        console.log(`[STJ Editor] 🖼️ ドロップで追加: ${fileName}`);
    }

    function handleCellDrop(cell, e) {
        if (!cell) return;
        cell.classList.remove('stj-drop-target');
        let path = '';
        try {
            path = e.dataTransfer.getData('application/x-gic-path')
                || e.dataTransfer.getData('text/plain')
                || e.dataTransfer.getData('text/uri-list')
                || '';
        } catch (_) {}
        handleCellDropFromPath(cell, path);
    }

    function setupCellDropTargets(container) {
        if (!container) container = document;
        const cells = container.querySelectorAll('.stj-keyword-item, .stj-special-item');
        cells.forEach(cell => {
            if (cell.dataset.gicDropReady === '1') return;
            cell.dataset.gicDropReady = '1';
            cell.addEventListener('dragenter', (e) => {
                if (!window.__gicDragInProgress) return;
                e.preventDefault();
                e.stopPropagation();
                cell.classList.add('stj-drop-target');
            });
            cell.addEventListener('dragover', (e) => {
                if (!window.__gicDragInProgress) return;
                e.preventDefault();
                e.stopPropagation();
                cell.classList.add('stj-drop-target');
            });
            cell.addEventListener('dragleave', (e) => {
                if (!window.__gicDragInProgress) return;
                if (e.relatedTarget && cell.contains(e.relatedTarget)) return;
                cell.classList.remove('stj-drop-target');
            });
        });
    }

    function installGlobalDropInterceptor() {
        if (window.__gicDropInterceptorInstalled) return;
        window.__gicDropInterceptorInstalled = true;

        window.addEventListener('dragover', (e) => {
            if (!window.__gicDragInProgress) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const cell = e.target && e.target.closest
                ? e.target.closest('.stj-keyword-item, .stj-special-item')
                : null;
            if (cell) {
                try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
                cell.classList.add('stj-drop-target');
            }
        }, true);

        window.addEventListener('dragenter', (e) => {
            if (!window.__gicDragInProgress) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        }, true);

        window.addEventListener('drop', (e) => {
            if (!window.__gicDragInProgress) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            const cell = e.target && e.target.closest
                ? e.target.closest('.stj-keyword-item, .stj-special-item')
                : null;
            if (!cell) return;
            handleCellDrop(cell, e);
        }, true);

        window.addEventListener('dragleave', (e) => {
            if (!window.__gicDragInProgress) return;
            const cell = e.target && e.target.closest
                ? e.target.closest('.stj-keyword-item, .stj-special-item')
                : null;
            if (!cell) return;
            if (e.relatedTarget && cell.contains(e.relatedTarget)) return;
            cell.classList.remove('stj-drop-target');
        }, true);

        console.log('[STJ Editor] 🌐 グローバル drop インターセプタを設置しました');
    }

    function installCustomDropListener() {
        if (window.__gicCustomDropListenerInstalled) return;
        window.__gicCustomDropListenerInstalled = true;

        window.addEventListener('gic-drop-file', (e) => {
            const { path, paths, cell, x, y } = e.detail || {};
            const pathList = (Array.isArray(paths) && paths.length > 0)
                ? paths
                : (path ? [path] : []);
            if (pathList.length === 0) return;

            if (cell) {
                for (const p of pathList) {
                    handleCellDropFromPath(cell, p);
                }
                return;
            }

            if (currentModalCell && currentCellModal && currentCellModal.classList.contains('visible')) {
                const contentEl = currentCellModal.querySelector('.stj-cell-modal-content');
                if (contentEl && typeof x === 'number' && typeof y === 'number') {
                    const rect = contentEl.getBoundingClientRect();
                    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                        for (const p of pathList) {
                            handleCellDropFromPath(currentModalCell, p);
                        }
                    }
                }
            }
        });

        console.log('[STJ Editor] 🎯 カスタムドロップリスナーを設置しました');
    }

    function attachKeywordRowListeners(item, index) {
        const previewEl = item.querySelector('.stj-image-preview');
        if (previewEl) {
            previewEl.addEventListener('mousedown', function(e) {
                if (e.button !== 0) return;
                if (e.target.closest && e.target.closest('button')) return;
                e.preventDefault();
                e.stopPropagation();
                pointerDragState = {
                    sourceItem: item,
                    startX: e.clientX, startY: e.clientY,
                    lastX: e.clientX, lastY: e.clientY,
                    isDragging: false, isBulkDelete: false,
                    hasMoved: false,
                    currentTarget: null, ghostState: null, scrollContainer: null,
                    insertReference: null, insertZone: null
                };
            });
        }

        item.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            if (isDialogActive) return;
            if (Date.now() < _suppressCellClickUntil) {
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            openCellModal(item);
        });
    }

    function runLiveTest() {
        const testInput = document.getElementById('stj_test_input');
        const testResult = document.getElementById('stj_test_result');
        if (!testInput || !testResult) return;

        const text = testInput.value.trim();
        const items = document.querySelectorAll('.stj-keyword-item');
        items.forEach(item => {
            item.style.border = '';
            item.style.backgroundColor = '';
        });

        if (!text) {
            testResult.innerHTML = `${_t('stj.test.result_prefix', '判定結果')}: ` +
                `<span style="color: #aaa; font-weight: normal;">${_t('stj.test.empty_hint', '文章を入力するとヒットするキーワードが表示されます')}</span>`;
            return;
        }

        const candidates = [];
        items.forEach(item => {
            const kw = getCellKeyword(item);
            if (!kw) return;
            const images = getCellImages(item);
            candidates.push({
                element: item,
                keyword: kw,
                imageName: images[0] || '',
                complexity: calcConditionComplexity(kw)
            });
        });
        candidates.sort((a, b) => b.complexity - a.complexity);

        let matched = null;
        for (const c of candidates) {
            try {
                if (evaluateCondition(c.keyword, text)) { matched = c; break; }
            } catch (e) { /* ignore */ }
        }

        const prefix = _t('stj.test.result_prefix', '判定結果');

        if (matched) {
            const fileDisp = matched.imageName || _t('stj.test.file_unspecified', '未指定');
            testResult.innerHTML = `${prefix}: ` +
                `<span style="color: #64b5f6; font-size: 16px;">${_t('stj.test.matched', `「${matched.keyword}」 にマッチしました！ (ファイル: ${fileDisp})`, { keyword: matched.keyword, file: fileDisp })}</span>`;
            matched.element.style.border = '2px solid #64b5f6';
            matched.element.style.backgroundColor = 'rgba(100, 181, 246, 0.15)';
        } else {
            const defaultCell = document.querySelector('.stj-special-item:nth-child(1)');
            const defaultImages = defaultCell ? getCellImages(defaultCell) : [];
            const defDisplay = defaultImages[0] || 'defa';
            testResult.innerHTML = `${prefix}: ` +
                `<span style="color: #ffb74d;">${_t('stj.test.no_match', `一致するキーワードがありません（デフォルト「${defDisplay}」が適用されます）`, { default: defDisplay })}</span>`;
        }
    }

    function addKeywordRow(modal) {
        const container = modal.querySelector('#stj_keywords_container');
        const itemCount = container.querySelectorAll('.stj-keyword-item').length;
        const newItem = document.createElement('div');
        newItem.className = 'stj-keyword-item';
        newItem.setAttribute('data-image-list', '[]');
        newItem.setAttribute('data-keyword', '');
        newItem.innerHTML = `
            <div class="stj-image-preview" id="stj_preview_${itemCount}" style="position: relative;">
                <div class="stj-preview-text">${_t('stj.preview.placeholder', 'プレビュー')}</div>
            </div>
            <div class="stj-keyword-display"></div>
        `;
        container.appendChild(newItem);
        attachKeywordRowListeners(newItem, itemCount);
        setupCellDropTargets(newItem);
        modal.scrollTop = modal.scrollHeight;
        runLiveTest();
        autoSave({ immediate: true });
        _stjScheduleTreeLayout();
    }

    function buildImageMapFromLegacySavedData(data, charName) {
        const imageMap = {};
        const toPaths = (names) => (names || []).map(name => {
            const cleaned = extractFileNameFromPath(name);
            const resolved = resolveThumbToOriginal(cleaned);
            return `user/images/${charName}/${resolved}`;
        });

        if (Array.isArray(data.defaultImages) && data.defaultImages.length > 0) {
            const paths = toPaths(data.defaultImages);
            imageMap.default = paths.length === 1 ? paths[0] : paths;
        }
        if (Array.isArray(data.thumbnailImages) && data.thumbnailImages.length > 0) {
            const paths = toPaths(data.thumbnailImages);
            imageMap.thumbnail = paths.length === 1 ? paths[0] : paths;
        }
        if (Array.isArray(data.keywords)) {
            data.keywords.forEach(kw => {
                if (!kw.keyword) return;
                const paths = toPaths(kw.images || []);
                imageMap[kw.keyword] = paths.length === 0
                    ? []
                    : (paths.length === 1 ? paths[0] : paths);
            });
        }
        return imageMap;
    }

    async function loadExistingJSONData(charName) {
        if (!charName) { console.warn('[STJ Editor] charName 空'); return false; }

        let imageMap = null;
        let hasCharData = false;

        try {
            const context = getSTContext();

            const charFromList = context?.characters?.[context?.characterId];
            let ext = charFromList?.data?.extensions?.image_display_extension;

            if (ext === undefined) {
                ext = context?.character?.data?.extensions?.image_display_extension;
            }

            if (ext !== undefined && typeof ext === 'object') {
                hasCharData = true;
                const filteredExt = {};
                let nullRemoved = 0;
                for (const [k, v] of Object.entries(ext)) {
                    if (v !== null && v !== undefined) {
                        filteredExt[k] = v;
                    } else {
                        nullRemoved++;
                    }
                }

                if (nullRemoved > 0) {
                    try {
                        const context = getSTContext();
                        const charFromList = context?.characters?.[context?.characterId];
                        if (charFromList?.name === charName && charFromList?.data?.extensions) {
                            charFromList.data.extensions.image_display_extension = filteredExt;
                        }
                        if (context?.character?.name === charName && context?.character?.data?.extensions) {
                            context.character.data.extensions.image_display_extension = filteredExt;
                        }
                        window.CharStore?.saveCharacterExtension?.(
                            'image_display_extension', filteredExt, { immediate: true }
                        );
                    } catch (e) {
                        console.warn('[STJ Editor] null 値クリーンアップ失敗:', e);
                    }
                }

                if (Object.keys(filteredExt).length > 0) {
                    imageMap = filteredExt;
                }
            }

        } catch (e) { /* ignore */ }

        if (!imageMap && !hasCharData) {
            try {
                const jsonPath = `user/images/${charName}/${charName}_ext.json`;
                const resp = await fetch(jsonPath);
                if (resp.ok) {
                    const data = await resp.json();
                    const legacy = findImageMapInData(data);
                    if (legacy && Object.keys(legacy).length > 0) {
                        imageMap = legacy;
                        try {
                            window.CharStore?.saveCharacterExtension?.(
                                'image_display_extension', legacy, { immediate: true }
                            );
                        } catch (e) { /* ignore */ }
                    } else {
                        window.CharStore?.saveCharacterExtension?.(
                            'image_display_extension', {}, { immediate: true }
                        );
                    }
                } else if (resp.status === 404) {
                    try {
                        const stjSettings = getExtensionSettings();
                        const legacyData = stjSettings[charName];
                        const hasLegacyData = legacyData && (
                            (Array.isArray(legacyData.keywords) && legacyData.keywords.length > 0) ||
                            (Array.isArray(legacyData.defaultImages) && legacyData.defaultImages.length > 0) ||
                            (Array.isArray(legacyData.thumbnailImages) && legacyData.thumbnailImages.length > 0)
                        );
                        if (hasLegacyData) {
                            const migrated = buildImageMapFromLegacySavedData(legacyData, charName);
                            window.CharStore?.saveCharacterExtension?.(
                                'image_display_extension', migrated, { immediate: true }
                            );
                            imageMap = migrated;
                        } else {
                            window.CharStore?.saveCharacterExtension?.(
                                'image_display_extension', {}, { immediate: true }
                            );
                        }
                    } catch (e) {
                        window.CharStore?.saveCharacterExtension?.(
                            'image_display_extension', {}, { immediate: true }
                        );
                    }
                }
            } catch (e) { /* ignore */ }
        }

        if (imageMap) {
            const cleanedMap = cleanForeignImageEntries(imageMap, charName);
            const existingMap = cleanedMap;

            populateFormFromImageMap(existingMap);
            try { saveData({ silent: true }); } catch (e) { /* ignore */ }
        }

        return hasCharData;
    }

    const STJ_TREE_CELL_W = 160;
    const STJ_TREE_CELL_H = 160;
    const STJ_TREE_H_GAP = 100;
    const STJ_TREE_V_GAP = 30;
    const STJ_TREE_PADDING = 40;

    function _stjToHalfWidth(str) {
        return String(str).replace(/[Ａ-Ｚａ-ｚ０-９]/g, c =>
            String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
        );
    }

    function _stjToFullWidth(str) {
        return String(str).replace(/[A-Za-z0-9]/g, c =>
            String.fromCharCode(c.charCodeAt(0) + 0xFEE0)
        );
    }

    function _stjInstallPanningHandlers() {
        if (window.__stjPanningHandlersInstalled) return;
        window.__stjPanningHandlersInstalled = true;

        const container = document.getElementById('stj_keywords_container');
        if (!container) {
            setTimeout(_stjInstallPanningHandlers, 500);
            return;
        }

        // パンニング用のイベントリスナー
        container.addEventListener('mousedown', _stjStartPanning, { passive: false });
        document.addEventListener('mousemove', _stjPan, { passive: false });
        document.addEventListener('mouseup', _stjEndPanning);
        document.addEventListener('mouseleave', _stjEndPanning);

        // カーソルを変更してドラッグ可能であることを示す
        container.style.cursor = 'grab';
    }
    
    function _stjExtractChoiceNumber(text) {
        if (!text || typeof text !== 'string') return null;
        const normalized = _stjToHalfWidth(text);
        if (window.LorebookExpansion?.extractChoiceNumber) {
            return window.LorebookExpansion.extractChoiceNumber(normalized);
        }
        const pats = [
            // 選択肢○○○形式（全角/半角数字に対応）
            /\u9078\u629e\u80a2[\u300c\u300e\"']?([\d\uFF10-\uFF19]{1,4})[\u300d\u300f\"']?/,
            /choice[^\\d\uFF10-\uFF19]{0,3}([\d\uFF10-\uFF19]{1,4})/i,
            // 単体の数字（全角/半角）
            /(?:^|\\s)([\d\uFF10-\uFF19]{3,4})(?:\\s|$|[\u3000\u3002.,])/,
            /([\d\uFF10-\uFF19]{3})/,
        ];
        for (const pat of pats) {
            const m = normalized.match(pat);
            if (m) return String(m[1]).padStart(3, '0');
        }
        return null;
    }

    function _stjFindEntryByChoice(entries, choiceNum) {
        if (window.LorebookExpansion?.findEntryByChoice) {
            return window.LorebookExpansion.findEntryByChoice(entries, choiceNum);
        }
        if (!entries || !choiceNum) return null;
        const list = Array.isArray(entries) ? entries : Object.values(entries);
        // ★ 文字列を半角に正規化して比較
        const normalizedChoiceNum = _stjToHalfWidth(String(choiceNum).trim());
        for (const entry of list) {
            if (!entry) continue;
            for (const key of getEntryKeys(entry)) {
                const k = String(key).trim();
                const normalizedK = _stjToHalfWidth(k);
                if (normalizedK === normalizedChoiceNum) return entry;
            }
        }
        return null;
    }

    function _stjFindEntryByKeywordLoose(list, choiceStr) {
        if (!Array.isArray(list) || !choiceStr) return null;
        const raw = String(choiceStr).trim();
        if (!raw) return null;

        const num = _stjExtractChoiceNumber(raw);
        if (num) {
            const normalizedNum = _stjToHalfWidth(num);
            for (const e of list) {
                const kw = getEntryKeyword(e);
                if (!kw) continue;
                const normalizedKw = _stjToHalfWidth(kw);
                if (normalizedKw === normalizedNum) return e;
            }
        }

        const clean = raw.replace(/^\u9078\u629e\u80a2[\u300c\u300e\"']?/, '')
                         .replace(/[\u300d\u300f\"']$/, '')
                         .replace(/^choice[:\\s]*/i, '')
                         .replace(/^[\uff10-\uff19\\d]{1,4}[:\\uff1a\\s]*/, '')
                         .trim();
        if (!clean) return null;

        // ★ 文字列を半角に正規化
        const normalizedClean = _stjToHalfWidth(clean);
        for (const e of list) {
            const kw = getEntryKeyword(e);
            if (!kw) continue;
            const normalizedKw = _stjToHalfWidth(kw);
            if (normalizedKw === normalizedClean) return e;
        }

        const lowerClean = normalizedClean.toLowerCase();
        for (const e of list) {
            const kw = getEntryKeyword(e);
            if (!kw) continue;
            const normalizedKw = _stjToHalfWidth(kw);
            if (normalizedKw.toLowerCase() === lowerClean) return e;
        }
        return null;
    }

    async function _stjBuildChoiceGraph(imageMap) {
        const empty = { children: new Map(), parents: new Map(), allNodes: new Set() };
        const worldName = getCharacterWorldInfoName();
        if (!worldName) return empty;

        let entries;
        try {
            entries = await loadWorldInfoEntries(worldName);
        } catch (e) {
            return empty;
        }
        if (!entries) return empty;

        const list = Array.isArray(entries) ? entries : Object.values(entries);
        const entryMap = new Map();
        for (const entry of list) {
            const kw = getEntryKeyword(entry);
            if (kw) entryMap.set(kw, entry);
        }

        const allNodes = new Set();
        for (const kw of Object.keys(imageMap)) {
            if (kw === 'default' || kw === 'thumbnail') continue;
            if (!kw || !kw.trim()) continue;
            allNodes.add(kw);
        }

        const children = new Map();
        const parents = new Map();

        for (const kw of allNodes) {
            const entry = entryMap.get(kw);
            if (!entry) { children.set(kw, []); continue; }

            const lex = getLexDataFor(worldName, entry.uid, entry);
            const choices = Array.isArray(lex.choices) ? lex.choices : [];
            const childKws = [];

            for (const choiceStr of choices) {
                let target = null;
                const num = _stjExtractChoiceNumber(choiceStr);
                if (num) {
                    target = _stjFindEntryByChoice(list, num);
                }
                if (!target) {
                    target = _stjFindEntryByKeywordLoose(list, choiceStr);
                }
                if (!target) continue;

                const targetKw = getEntryKeyword(target);
                if (!targetKw || !allNodes.has(targetKw)) continue;
                if (childKws.includes(targetKw)) continue;
                childKws.push(targetKw);
                if (!parents.has(targetKw)) parents.set(targetKw, []);
                parents.get(targetKw).push(kw);
            }
            children.set(kw, childKws);
        }

        return { children, parents, allNodes };
    }

    function _stjComputeTreeLayout(graph) {
        const { children, parents, allNodes } = graph;
        const positions = new Map();
        const visited = new Set();
        let cursorY = 0;

        function layoutSubtree(node, depth) {
            if (visited.has(node)) return null;
            visited.add(node);

            const kids = (children.get(node) || []).filter(k => !visited.has(k));
            if (kids.length === 0) {
                const y = cursorY;
                positions.set(node, {
                    x: depth * (STJ_TREE_CELL_W + STJ_TREE_H_GAP),
                    y,
                });
                cursorY += STJ_TREE_CELL_H + STJ_TREE_V_GAP;
                return { top: y, bottom: y + STJ_TREE_CELL_H };
            }

            const kidBounds = [];
            for (const kid of kids) {
                const b = layoutSubtree(kid, depth + 1);
                if (b) kidBounds.push(b);
            }

            if (kidBounds.length === 0) {
                const y = cursorY;
                positions.set(node, {
                    x: depth * (STJ_TREE_CELL_W + STJ_TREE_H_GAP),
                    y,
                });
                cursorY += STJ_TREE_CELL_H + STJ_TREE_V_GAP;
                return { top: y, bottom: y + STJ_TREE_CELL_H };
            }

            const top = kidBounds[0].top;
            const bottom = kidBounds[kidBounds.length - 1].bottom;
            const centerY = (top + bottom - STJ_TREE_CELL_H) / 2;
            positions.set(node, {
                x: depth * (STJ_TREE_CELL_W + STJ_TREE_H_GAP),
                y: centerY,
            });
            return {
                top: Math.min(top, centerY),
                bottom: Math.max(bottom, centerY + STJ_TREE_CELL_H),
            };
        }

        const roots = [];
        const isolated = [];
        for (const kw of allNodes) {
            const hasParent = parents.has(kw) && parents.get(kw).length > 0;
            const hasChild = (children.get(kw) || []).length > 0;
            if (!hasParent) {
                if (hasChild) roots.push(kw);
                else isolated.push(kw);
            }
        }
        roots.sort();
        isolated.sort();

        for (const root of roots) {
            layoutSubtree(root, 0);
            cursorY += STJ_TREE_V_GAP * 2;
        }

        for (const node of isolated) {
            positions.set(node, { x: 0, y: cursorY });
            cursorY += STJ_TREE_CELL_H + STJ_TREE_V_GAP;
        }

        const unvisited = [...allNodes].filter(k => !visited.has(k));
        for (const node of unvisited) {
            positions.set(node, { x: 0, y: cursorY });
            cursorY += STJ_TREE_CELL_H + STJ_TREE_V_GAP;
        }

        return { positions, children };
    }

function _stjDrawConnections(container, positions, children) {
        const old = container.querySelector(':scope > .stj-tree-svg');
        if (old) old.remove();

        let maxX = 0, maxY = 0;
        for (const pos of positions.values()) {
            maxX = Math.max(maxX, pos.x + STJ_TREE_CELL_W);
            maxY = Math.max(maxY, pos.y + STJ_TREE_CELL_H);
        }
        const svgW = maxX + STJ_TREE_PADDING;
        const svgH = maxY + STJ_TREE_PADDING;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('stj-tree-svg');
        svg.setAttribute('width', String(svgW));
        svg.setAttribute('height', String(svgH));
        svg.style.width = svgW + 'px';
        svg.style.height = svgH + 'px';

        for (const [parentKw, childKws] of children) {
            const parentPos = positions.get(parentKw);
            if (!parentPos) continue;
            for (const childKw of childKws) {
                const childPos = positions.get(childKw);
                if (!childPos) continue;

                const sz = 14;
                const x1 = parentPos.x + STJ_TREE_CELL_W;
                const y1 = parentPos.y + STJ_TREE_CELL_H / 2;
                const x2 = childPos.x;
                const y2 = childPos.y + STJ_TREE_CELL_H / 2;
                const lineEndX = x2 - sz / 2;
                const midX = x1 + (lineEndX - x1) / 2;

                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d',
                    `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${lineEndX} ${y2}`);
                path.setAttribute('stroke', '#ffffff');
                path.setAttribute('stroke-width', '4');
                path.setAttribute('fill', 'none');
                path.setAttribute('stroke-linejoin', 'round');
                svg.appendChild(path);

                const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                arrow.setAttribute('points',
                    `${x2},${y2} ${x2 - sz},${y2 - sz / 1.5} ${x2 - sz},${y2 + sz / 1.5}`);
                arrow.setAttribute('fill', '#ffffff');
                svg.appendChild(arrow);
            }
        }

        container.insertBefore(svg, container.firstChild);
    }

    let _stjTreeLayoutInFlight = false;
    let _stjTreeLayoutPending = false;
    let _stjLastGraphSignature = '';

    function _stjBuildGraphSignature(graph) {
        if (!graph) return '';
        const nodes = Array.from(graph.allNodes || []).sort();
        const edges = [];
        for (const [parentKw, childKws] of (graph.children || new Map()).entries()) {
            for (const childKw of (childKws || [])) {
                edges.push(`${parentKw}->${childKw}`);
            }
        }
        edges.sort();
        return `${nodes.join('|')}#${edges.join(',')}`;
    }

    function _stjSyncStandalonePanel(containerEl, graph) {
        const panelBody = document.getElementById('stj_standalone_body');
        if (!panelBody || !containerEl) return;

        const connectedSet = new Set();
        for (const [parentKw, childKws] of (graph?.children || new Map()).entries()) {
            if (Array.isArray(childKws) && childKws.length > 0) {
                connectedSet.add(parentKw);
                for (const c of childKws) connectedSet.add(c);
            }
        }
        for (const [childKw, parentKws] of (graph?.parents || new Map()).entries()) {
            if (Array.isArray(parentKws) && parentKws.length > 0) {
                connectedSet.add(childKw);
                for (const p of parentKws) connectedSet.add(p);
            }
        }

        panelBody.innerHTML = '';
        const sourceCells = Array.from(containerEl.querySelectorAll(':scope > .stj-keyword-item'));
        const standaloneCells = sourceCells.filter(cell => {
            const kw = getCellKeyword(cell).trim();
            return !kw || !connectedSet.has(kw);
        });

        if (standaloneCells.length === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'stj-standalone-empty';
            emptyEl.textContent = _t('stj.standalone.empty', '独立セルはありません');
            panelBody.appendChild(emptyEl);
            return;
        }

        standaloneCells.forEach((cell, idx) => {
            cell.dataset.stjIsStandaloneCell = '1';
            const card = document.createElement('div');
            card.className = 'stj-keyword-item stj-standalone-cell-item';
            card.setAttribute('data-keyword', getCellKeyword(cell));
            card.setAttribute('data-image-list', cell.getAttribute('data-image-list') || '[]');

            const previewDiv = document.createElement('div');
            previewDiv.className = 'stj-image-preview';
            previewDiv.id = `stj_standalone_preview_${idx}`;
            previewDiv.style.position = 'relative';

            const ph = document.createElement('div');
            ph.className = 'stj-preview-text';
            ph.textContent = _t('stj.preview.placeholder', 'プレビュー');
            previewDiv.appendChild(ph);

            const kwDisplay = document.createElement('div');
            kwDisplay.className = 'stj-keyword-display';
            kwDisplay.textContent = getCellKeyword(cell);

            card.appendChild(previewDiv);
            card.appendChild(kwDisplay);
            panelBody.appendChild(card);

            card.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                if (isDialogActive) return;
                openCellModal(cell);
            });

            const charName = document.getElementById('stj_char_name_display')?.textContent || '';
            updateImagePreview(previewDiv.id, charName, getCellImages(cell).join(','));
        });
    }

    async function _stjApplyTreeLayout() {
        if (_stjTreeLayoutInFlight) {
            _stjTreeLayoutPending = true;
            return;
        }
        _stjTreeLayoutInFlight = true;

        try {
            const container = document.getElementById('stj_keywords_container');
            if (!container) return;
            if (container.offsetParent === null) return;

            container.classList.add('stj-tree-mode');
            const startCharName = document.getElementById('stj_char_name_display')?.textContent;
            if (!startCharName) return;

            // 前回の独立セル・特殊要素の配置を一旦リセットしてから再計算
            container.querySelectorAll('.stj-tree-bottom-left-other .stj-keyword-item, .stj-standalone-cell-item').forEach((cell) => {
                delete cell.dataset.stjIsOtherCell;
                delete cell.dataset.stjIsStandaloneCell;
                if (cell.classList.contains('stj-standalone-cell-item')) {
                    cell.remove();
                    return;
                }
                container.appendChild(cell);
            });

            const imageMap = {};
            let cellCount = 0;
            container.querySelectorAll(':scope > .stj-keyword-item').forEach(cell => {
                cellCount++;
                const kw = getCellKeyword(cell).trim();
                if (kw) imageMap[kw] = getCellImages(cell);
            });
 
            if (Object.keys(imageMap).length === 0) {
                container.classList.add('stj-tree-mode');
                container.querySelectorAll(':scope > .stj-keyword-item').forEach(cell => {
                    cell.style.position = 'absolute';
                    cell.style.left = '0px';
                    cell.style.top = '0px';
                    cell.style.width = STJ_TREE_CELL_W + 'px';
                    cell.style.height = STJ_TREE_CELL_H + 'px';
                });
                const emptySig = `cells:${cellCount}#`;
                const prevHeight = parseFloat(container.style.height) || 0;
                const graphChanged = _stjLastGraphSignature !== emptySig;
                _stjLastGraphSignature = emptySig;
                applyTreeScaleToContainer(container);
                if (!graphChanged && prevHeight > 0) {
                    container.style.setProperty('min-height', `${prevHeight}px`);
                    container.style.setProperty('height', `${prevHeight}px`);
                }
                return;
            }

            const graph = await _stjBuildChoiceGraph(imageMap);
 
            const endCharName = document.getElementById('stj_char_name_display')?.textContent;
            if (endCharName !== startCharName) return;
            if (!document.body.contains(container)) return;

            const nextSignature = `cells:${cellCount}#${_stjBuildGraphSignature(graph)}`;
            const graphOrCellChanged = _stjLastGraphSignature !== nextSignature;
            const prevHeight = parseFloat(container.style.height) || 0;
            _stjLastGraphSignature = nextSignature;
 
            const { positions, children } = _stjComputeTreeLayout(graph);

            const connectedSet = new Set();
            for (const [parentKw, childKws] of (graph?.children || new Map()).entries()) {
                if (Array.isArray(childKws) && childKws.length > 0) {
                    connectedSet.add(parentKw);
                    for (const c of childKws) connectedSet.add(c);
                }
            }
            for (const [childKw, parentKws] of (graph?.parents || new Map()).entries()) {
                if (Array.isArray(parentKws) && parentKws.length > 0) {
                    connectedSet.add(childKw);
                    for (const p of parentKws) connectedSet.add(p);
                }
            }

            container.querySelectorAll(':scope > .stj-keyword-item').forEach(cell => {
                const kw = getCellKeyword(cell).trim();
                if (!kw || !connectedSet.has(kw)) {
                    cell.dataset.stjIsStandaloneCell = '1';
                    cell.style.setProperty('display', 'none', 'important');
                } else {
                    delete cell.dataset.stjIsStandaloneCell;
                    cell.style.removeProperty('display');
                }
            });

            let hasConnectedPos = false;
            let maxX = 0, maxY = STJ_TREE_CELL_H, minX = 0, minY = 0;
            for (const [kw, pos] of positions.entries()) {
                if (!connectedSet.has(kw)) continue;

                if (!hasConnectedPos) {
                    minX = pos.x;
                    minY = pos.y;
                    maxX = pos.x + STJ_TREE_CELL_W;
                    maxY = pos.y + STJ_TREE_CELL_H;
                    hasConnectedPos = true;
                } else {
                    maxX = Math.max(maxX, pos.x + STJ_TREE_CELL_W);
                    maxY = Math.max(maxY, pos.y + STJ_TREE_CELL_H);
                    minX = Math.min(minX, pos.x);
                    minY = Math.min(minY, pos.y);
                }
            }
            const offsetX = STJ_TREE_PADDING - minX;
            const offsetY = STJ_TREE_PADDING - minY;

            const unpositioned = [];
            container.querySelectorAll(':scope > .stj-keyword-item').forEach(cell => {
                if (cell.dataset.stjIsStandaloneCell === '1') {
                    cell.style.setProperty('display', 'none', 'important');
                    return;
                }
                cell.style.removeProperty('display');
                const kw = getCellKeyword(cell).trim();
                const pos = kw ? positions.get(kw) : null;
                if (pos) {
                    const baseL = pos.x + offsetX;
                    const baseT = pos.y + offsetY;
                    cell.dataset.stjBaseLeft = String(baseL);
                    cell.dataset.stjBaseTop = String(baseT);
                    cell.dataset.stjBaseWidth = String(STJ_TREE_CELL_W);
                    cell.dataset.stjBaseHeight = String(STJ_TREE_CELL_H);
                    cell.style.position = 'absolute';
                    cell.style.left = baseL + 'px';
                    cell.style.top = baseT + 'px';
                    cell.style.width = STJ_TREE_CELL_W + 'px';
                    cell.style.height = STJ_TREE_CELL_H + 'px';
                } else {
                    unpositioned.push(cell);
                }
            });

            const totalWidth = Math.max(300, maxX - minX + STJ_TREE_PADDING * 2);
            const totalHeight = Math.max(120, maxY - minY + STJ_TREE_PADDING * 2);
 
            delete container.dataset.stjBaseMinW;
            delete container.dataset.stjBaseMinH;
            container.style.width = totalWidth + 'px';
            container.style.height = totalHeight + 'px';
            container.style.minWidth = totalWidth + 'px';
            container.style.minHeight = totalHeight + 'px';
            container.dataset.stjTreeBottom = String(Math.ceil(totalHeight - STJ_TREE_PADDING));

            const offsetPositions = new Map();
            for (const [kw, pos] of positions.entries()) {
                if (!connectedSet.has(kw)) continue;
                offsetPositions.set(kw, {
                    x: pos.x + offsetX,
                    y: pos.y + offsetY,
                });
            }

            _stjDrawConnections(container, offsetPositions, children);

            applyTreeScaleToContainer(container);
            container.dataset.stjBaseMinW = String(totalWidth);
            container.dataset.stjBaseMinH = String(totalHeight);
            _stjSyncStandalonePanel(container, graph);
            const currentH = parseFloat(container.style.height) || 0;
            if (!graphOrCellChanged && prevHeight > 0 && prevHeight <= currentH) {
                container.style.setProperty('min-height', `${prevHeight}px`);
                container.style.setProperty('height', `${prevHeight}px`);
            }
        } catch (e) {
            console.warn('[STJ Editor] ツリーレイアウト適用エラー:', e);
        } finally {
            _stjTreeLayoutInFlight = false;
            if (_stjTreeLayoutPending) {
                _stjTreeLayoutPending = false;
                _stjScheduleTreeLayout();
            }
        }
    }

    let _stjTreeLayoutTimer = null;
    function _stjScheduleTreeLayout() {
        if (_stjTreeLayoutTimer) clearTimeout(_stjTreeLayoutTimer);
        _stjTreeLayoutTimer = setTimeout(() => {
            _stjTreeLayoutTimer = null;
            _stjApplyTreeLayout().catch(e => console.warn('[STJ Editor] ツリーレイアウトエラー:', e));
        }, 100);
    }

    function populateFormFromImageMap(imageMap, preserveOrder = false) {
        const toFileNames = (val) => {
            if (val === null || val === undefined) return [];
            const arr = Array.isArray(val) ? val : [val];
            return arr
                .filter(p => p !== null && p !== undefined)
                .map(p => extractFileNameFromPath(p))
                .filter(Boolean);
        };

        restoreSpecialPreviewsToOrigin();

        const defaultCell = document.querySelector('.stj-special-item:nth-child(1)');
        if (defaultCell) {
            const files = imageMap.default !== undefined ? toFileNames(imageMap.default) : [];
            setCellImages(defaultCell, files);
            updateCellPreview(defaultCell);
        }

        const thumbnailCell = document.querySelector('.stj-special-item:nth-child(2)');
        if (thumbnailCell) {
            const files = imageMap.thumbnail !== undefined ? toFileNames(imageMap.thumbnail) : [];
            setCellImages(thumbnailCell, files);
            updateCellPreview(thumbnailCell);
        }

        const container = document.getElementById('stj_keywords_container');
        if (!container) return;

        const activeKeys = Object.keys(imageMap).filter(k => k !== 'default' && k !== 'thumbnail');

        if (preserveOrder) {
            const existingItems = Array.from(container.querySelectorAll('.stj-keyword-item'));
            const itemMapByKeyword = new Map();

            existingItems.forEach(item => {
                const kw = getCellKeyword(item);
                if (kw) {
                    itemMapByKeyword.set(kw, item);
                }
            });

            const unmatchedItems = existingItems.filter(item => !activeKeys.includes(getCellKeyword(item)));

            activeKeys.forEach((key, index) => {
                let item = itemMapByKeyword.get(key);

                if (!item && unmatchedItems.length > 0) {
                    item = unmatchedItems.shift();
                    setCellKeyword(item, key);
                }

                if (item) {
                    const files = toFileNames(imageMap[key]);
                    setCellImages(item, files);
                    updateCellPreview(item);
                    container.appendChild(item);
                } else {
                    addKeywordRowWithData(container, index, { keyword: key, images: toFileNames(imageMap[key]) });
                }
            });

            unmatchedItems.forEach(item => item.remove());

            if (container.querySelectorAll('.stj-keyword-item').length === 0) {
                addKeywordRowWithData(container, 0, { keyword: '', images: [] });
            }
        } else {
            container.innerHTML = '';
            let index = 0;
            activeKeys.forEach(key => {
                addKeywordRowWithData(container, index, { keyword: key, images: toFileNames(imageMap[key]) });
                index++;
            });
            if (index === 0) {
                addKeywordRowWithData(container, 0, { keyword: '', images: [] });
            }
        }
        _stjScheduleTreeLayout();
    }

    function setupPreviewListeners() { updatePreview(); }

    function updatePreview() {
        document.querySelectorAll('.stj-keyword-item, .stj-special-item').forEach(cell => {
            updateCellPreview(cell);
        });
    }

    const _previewLoadGen = new WeakMap();

    async function updateImagePreview(previewId, charName, rawValue, targetIndex = 0) {
        const previewEl = document.getElementById(previewId);
        if (!previewEl) return;
        previewEl.style.position = 'relative';

        const myGen = (_previewLoadGen.get(previewEl) || 0) + 1;
        _previewLoadGen.set(previewEl, myGen);

        let placeholder = previewEl.querySelector(':scope > .stj-preview-text');
        if (!placeholder) {
            placeholder = document.createElement('div');
            placeholder.className = 'stj-preview-text';
            placeholder.textContent = _t('stj.preview.placeholder', 'プレビュー');
            previewEl.insertBefore(placeholder, previewEl.firstChild);
        }
        if (!placeholder.dataset.originalText) {
            placeholder.dataset.originalText =
                (placeholder.textContent || _t('stj.preview.placeholder', 'プレビュー')).trim()
                || _t('stj.preview.placeholder', 'プレビュー');
        }

        const removeMedia = () => previewEl.querySelectorAll(':scope > img, :scope > video, :scope > .stj-video-badge').forEach(el => {
            if (el.tagName === 'VIDEO') {
                try { el.pause(); } catch (e) { /* ignore */ }
            }
            el.remove();
        });
        const removeLoading = () => previewEl.querySelectorAll(':scope > .stj-preview-loading').forEach(el => el.remove());
        const placeholderShowNormal = () => {
            placeholder.textContent = placeholder.dataset.originalText;
            placeholder.classList.remove('stj-preview-error');
            placeholder.style.removeProperty('display');
        };
        const placeholderShowError = () => {
            placeholder.textContent = _t('stj.preview.missing_file', 'ファイルが見つかりません');
            placeholder.classList.add('stj-preview-error');
            placeholder.style.removeProperty('display');
        };
        const placeholderHide = () => {
            placeholder.style.setProperty('display', 'none', 'important');
            placeholder.classList.remove('stj-preview-error');
        };

        const imageNames = parseImageNames(rawValue);

        if (!charName || imageNames.length === 0) {
            removeMedia(); removeLoading();
            attachVideoBadge(previewEl, false).catch(() => {});
            placeholderShowNormal();
            delete previewEl.dataset.currentIndex;
            delete previewEl.dataset.currentPath;
            return;
        }

        let currentIndex = targetIndex;
        if (currentIndex < 0) currentIndex = imageNames.length - 1;
        if (currentIndex >= imageNames.length) currentIndex = 0;
        previewEl.dataset.currentIndex = currentIndex;

        const fileName = extractFileNameFromPath(imageNames[currentIndex]);
        if (!fileName) {
            removeMedia(); removeLoading();
            attachVideoBadge(previewEl, false).catch(() => {});
            placeholderShowError();
            previewEl.dataset.currentPath = '__missing__';
            return;
        }

        const origFileName = resolveThumbToOriginal(fileName);

        const fullPath = await detectImageExtension(charName, fileName);
        if (_previewLoadGen.get(previewEl) !== myGen) return;

        if (fullPath === null) {
            removeMedia(); removeLoading();
            attachVideoBadge(previewEl, false).catch(() => {});
            placeholderShowError();
            previewEl.dataset.currentPath = '__missing__';
            return;
        }

        if (previewEl.dataset.currentPath === fullPath) {
            attachVideoBadge(previewEl, isVideoUrl(fullPath), origFileName, charName).catch(() => {});
            placeholderHide();
            return;
        }

        removeMedia(); removeLoading(); placeholderHide();

        const loadingEl = document.createElement('div');
        loadingEl.className = 'stj-preview-loading';
        loadingEl.textContent = _t('stj.preview.loading', '読み込み中...');
        Object.assign(loadingEl.style, {
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)', color: '#e2e8f0',
            fontSize: '13px', fontWeight: 'bold', padding: '6px 12px',
            background: 'rgba(0,0,0,0.65)', borderRadius: '4px',
            pointerEvents: 'none', zIndex: '20',
        });
        previewEl.appendChild(loadingEl);

        if (isVideoUrl(fullPath)) {
            const thumbUrl = await ensureThumbForEditor(fileName, charName);
            if (_previewLoadGen.get(previewEl) !== myGen) { removeLoading(); return; }
            if (thumbUrl) {
                const img = new Image();
                img.src = thumbUrl;
                try {
                    if (typeof img.decode === 'function') await img.decode();
                    else await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
                } catch (e) { /* fall through to video */ }
                if (_previewLoadGen.get(previewEl) === myGen) {
                    img.style.width = '100%'; img.style.height = '100%';
                    img.style.objectFit = 'contain'; img.style.display = 'block';
                    img.style.backgroundColor = 'transparent';
                    previewEl.appendChild(img);
                    attachVideoBadge(previewEl, true, origFileName, charName).catch(() => {});
                    previewEl.dataset.currentPath = fullPath;
                    removeLoading(); placeholderHide();
                    return;
                }
            }

            const video = document.createElement('video');
            video.setAttribute('muted', '');
            video.setAttribute('loop', '');
            video.setAttribute('playsinline', '');
            video.setAttribute('webkit-playsinline', '');
            video.setAttribute('preload', 'auto');
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.preload = 'auto';
            video.src = fullPath;

            await new Promise((resolve) => {
                let done = false;
                const finish = () => { if (done) return; done = true; resolve(); };
                video.addEventListener('loadeddata', () => {
                    try {
                        if (Number.isFinite(video.duration) && video.duration > 0.1) {
                            video.currentTime = Math.min(1, video.duration * 0.1);
                        } else {
                            video.currentTime = 0;
                        }
                    } catch (e) { /* ignore */ }
                    finish();
                }, { once: true });
                video.addEventListener('error', finish, { once: true });
                setTimeout(finish, 2500);
            });
            if (_previewLoadGen.get(previewEl) !== myGen) { removeLoading(); return; }
            if (video.readyState === 0) {
                removeLoading();
                attachVideoBadge(previewEl, false).catch(() => {});
                placeholderShowError();
                previewEl.dataset.currentPath = '__missing__';
                return;
            }
            video.style.width = '100%'; video.style.height = '100%';
            video.style.objectFit = 'contain'; video.style.display = 'block';
            video.style.backgroundColor = 'transparent';
            previewEl.appendChild(video);
            attachVideoBadge(previewEl, true, origFileName, charName).catch(() => {});
            previewEl.dataset.currentPath = fullPath;
            removeLoading(); placeholderHide();
        } else {
            let displaySrc = fullPath;
            if (/\.(gif|png)$/i.test(origFileName)) {
                try {
                    if (window.GicApi?.getStaticFrameUrl) {
                        const staticUrl = await window.GicApi.getStaticFrameUrl(origFileName, charName);
                        if (_previewLoadGen.get(previewEl) !== myGen) { removeLoading(); return; }
                        if (staticUrl) displaySrc = staticUrl;
                    }
                } catch (e) { /* ignore */ }
            }

            const img = new Image();
            img.src = displaySrc;
            img.alt = fileName;
            let decodeOk = false;
            try {
                if (typeof img.decode === 'function') {
                    await img.decode();
                    decodeOk = true;
                } else {
                    await new Promise((resolve, reject) => {
                        img.onload = () => { decodeOk = true; resolve(); };
                        img.onerror = () => reject(new Error('load failed'));
                    });
                }
            } catch (e) { decodeOk = false; }
            if (_previewLoadGen.get(previewEl) !== myGen) { removeLoading(); return; }
            if (!decodeOk) {
                removeLoading();
                attachVideoBadge(previewEl, false).catch(() => {});
                placeholderShowError();
                previewEl.dataset.currentPath = '__missing__';
                return;
            }
            img.style.width = '100%'; img.style.height = '100%';
            img.style.objectFit = 'contain'; img.style.display = 'block';
            previewEl.appendChild(img);
            attachVideoBadge(previewEl, false, origFileName, charName).catch(() => {});
            previewEl.dataset.currentPath = fullPath;
            removeLoading(); placeholderHide();
        }
    }

    function buildImageMapFromForm(charName, existingMap = null) {
        const imageMap = {};
        const toPaths = (names) => names.map(name => {
            const cleaned = extractFileNameFromPath(name);
            const resolved = resolveThumbToOriginal(cleaned);
            return `user/images/${charName}/${resolved}`;
        });

        const defaultCell = document.querySelector('.stj-special-item:nth-child(1)');
        const defaultImages = defaultCell ? getCellImages(defaultCell) : [];
        if (defaultImages.length > 0) {
            const paths = toPaths(defaultImages);
            imageMap.default = paths.length === 1 ? paths[0] : paths;
        }

        const thumbnailCell = document.querySelector('.stj-special-item:nth-child(2)');
        const thumbnailImages = thumbnailCell ? getCellImages(thumbnailCell) : [];
        if (thumbnailImages.length > 0) {
            const paths = toPaths(thumbnailImages);
            imageMap.thumbnail = paths.length === 1 ? paths[0] : paths;
        }

        document.querySelectorAll('.stj-keyword-item').forEach(item => {
            const kw = getCellKeyword(item).trim();
            if (!kw) return;
            const images = getCellImages(item);
            const paths = toPaths(images);
            imageMap[kw] = paths.length === 0
                ? []
                : (paths.length === 1 ? paths[0] : paths);
        });

        if (existingMap && typeof existingMap === 'object') {
            for (const [key, val] of Object.entries(existingMap)) {
                if (key in imageMap) continue;
                if (_explicitlyDeletedKeys.has(key)) continue;
                if (val === null) continue;
                imageMap[key] = val;
            }
        }

        return imageMap;
    }

    function showCustomAlert(message) {
        const existingAlert = document.getElementById('stj_custom_alert');
        if (existingAlert) existingAlert.remove();
        const alertDiv = document.createElement('div');
        alertDiv.id = 'stj_custom_alert';
        alertDiv.textContent = message;
        document.body.appendChild(alertDiv);
        setTimeout(() => {
            alertDiv.style.opacity = '1';
            alertDiv.style.transform = 'translate(-50%, -50%) scale(1)';
        }, 10);
        setTimeout(() => {
            alertDiv.style.opacity = '0';
            alertDiv.style.transform = 'translate(-50%, -50%) scale(0.9)';
            setTimeout(() => {
                if (alertDiv.parentNode) alertDiv.parentNode.removeChild(alertDiv);
            }, 300);
        }, 3000);
    }

    function _doAutoSave() {
        try {
            const nameEl = document.getElementById('stj_char_name_display');
            const charName = nameEl ? nameEl.textContent : '';
            if (!charName) return;

            if (_editorLoading) return;

            try {
                const ctx = getSTContext();
                const currentChar = ctx?.characters?.[ctx?.characterId] || ctx?.character;
                const currentCharName = currentChar?.name || '';
                if (currentCharName && currentCharName !== charName) return;
            } catch (e) { /* ignore */ }

            saveData({ silent: true });

            try {
                const existingMap = getCurrentImageMapFromCharData(charName) || {};
                const imageMap = buildImageMapFromForm(charName, existingMap);

                const explicitDeletes = Array.from(_explicitlyDeletedKeys)
                    .filter(k => !(k in imageMap));

                let payload = imageMap;
                if (explicitDeletes.length > 0) {
                    payload = { ...imageMap };
                    for (const k of explicitDeletes) {
                        payload[k] = null;
                    }
                }

                if (window.CharStore?.saveCharacterExtension) {
                    window.CharStore.saveCharacterExtension(
                        'image_display_extension',
                        payload,
                        { immediate: true }
                    );

                    try {
                        const ctx = getSTContext();
                        const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
                        if (char?.name === charName && char.data?.extensions) {
                            char.data.extensions.image_display_extension = imageMap;
                        }
                    } catch (e) { /* ignore */ }

                    window.dispatchEvent(new CustomEvent('lbe-image-map-updated', {
                        detail: { charName, imageMap }
                    }));

                    _explicitlyDeletedKeys.clear();
                }
            } catch (e) {
                console.warn('[STJ Editor] character.json 保存エラー:', e);
            }
        } catch (e) {
            console.warn('[STJ Editor] autoSave error:', e);
        }
    }

    function autoSave(options = {}) {
        const { immediate = false } = options;
        if (_autoSaveTimer) {
            clearTimeout(_autoSaveTimer);
            _autoSaveTimer = null;
        }
        if (immediate) {
            _doAutoSave();
            return;
        }
        _autoSaveTimer = setTimeout(() => {
            _autoSaveTimer = null;
            _doAutoSave();
        }, 400);
    }

    function flushAutoSave() {
        if (_autoSaveTimer) {
            clearTimeout(_autoSaveTimer);
            _autoSaveTimer = null;
            _doAutoSave();
        }
    }

    function saveData(options = {}) {
        const { silent = false } = options;
        const nameEl = document.getElementById('stj_char_name_display');
        const charName = nameEl ? nameEl.textContent : '';
        if (!charName) {
            if (!silent) alert(_t('stj.char_name_missing', 'キャラクター名が設定されていません'));
            return;
        }

        const kwMap = new Map();
        const duplicates = [];
        document.querySelectorAll('#stj_keywords_container .stj-keyword-item').forEach(item => {
            const kw = getCellKeyword(item).trim();
            if (!kw) return;
            if (kwMap.has(kw)) {
                duplicates.push(kw);
            } else {
                kwMap.set(kw, item);
            }
        });
        if (duplicates.length > 0) {
            if (!silent) {
                showKeywordDuplicateWarning(duplicates[0]);
            }
            return;
        }

        const defaultCell = document.querySelector('.stj-special-item:nth-child(1)');
        const thumbnailCell = document.querySelector('.stj-special-item:nth-child(2)');
        const data = {
            charName,
            defaultImages: defaultCell ? getCellImages(defaultCell) : [],
            thumbnailImages: thumbnailCell ? getCellImages(thumbnailCell) : [],
            keywords: []
        };

        document.querySelectorAll('.stj-keyword-item').forEach(item => {
            const kw = getCellKeyword(item).trim();
            const images = getCellImages(item);
            if (kw || images.length > 0) data.keywords.push({ keyword: kw, images });
        });

        if (silent &&
            data.keywords.length === 0 &&
            data.defaultImages.length === 0 &&
            data.thumbnailImages.length === 0 &&
            _editorLoading) {
            return;
        }

        const stjSettings = getExtensionSettings();
        stjSettings[charName] = data;
        persistSettings();
        scheduleUnifiedBundleExport(charName, 800);

        if (!silent) {
            showCustomAlert(_t('stj.save_success', 'データを保存しました'));
        }
    }

    function loadSavedData(charName) {
        if (!charName) return;
        const stjSettings = getExtensionSettings();
        const data = stjSettings[charName];
        if (!data) return;
        try {
            const defaultImages = data.defaultImages
                || (data.defaultImage ? parseImageNames(data.defaultImage) : []);
            const thumbnailImages = data.thumbnailImages
                || (data.thumbnailImage ? parseImageNames(data.thumbnailImage) : []);

            const defaultCell = document.querySelector('.stj-special-item:nth-child(1)');
            if (defaultCell) {
                setCellImages(defaultCell, defaultImages);
                updateCellPreview(defaultCell);
            }
            const thumbnailCell = document.querySelector('.stj-special-item:nth-child(2)');
            if (thumbnailCell) {
                setCellImages(thumbnailCell, thumbnailImages);
                updateCellPreview(thumbnailCell);
            }

            const container = document.getElementById('stj_keywords_container');
            if (!container) return;

            if (!Array.isArray(data.keywords) || data.keywords.length === 0) {
                return;
            }

            container.innerHTML = '';
            data.keywords.forEach((kw, index) => {
                const images = kw.images || (kw.imageName ? parseImageNames(kw.imageName) : []);
                addKeywordRowWithData(container, index, { keyword: kw.keyword, images });
            });
        } catch (e) { console.error('保存データの読み込みに失敗しました', e); }
    }

    function getCellUid(cell) {
        if (!cell) return '';
        const v = cell.getAttribute('data-entry-uid');
        return v !== null && v !== undefined ? String(v).trim() : '';
    }

    function setCellUid(cell, uid) {
        if (!cell) return;
        if (uid !== null && uid !== undefined && String(uid).trim() !== '') {
            cell.setAttribute('data-entry-uid', String(uid).trim());
        } else {
            cell.removeAttribute('data-entry-uid');
        }
    }

    function getEntryUid(entry) {
        if (!entry || typeof entry !== 'object') return '';
        const raw = entry.uid !== undefined && entry.uid !== null ? entry.uid : entry.id;
        return raw !== undefined && raw !== null ? String(raw).trim() : '';
    }

    function getNodeKeyForEntry(entry, fallbackKw = '') {
        const uid = getEntryUid(entry);
        if (uid) return `uid:${uid}`;
        const kw = String(fallbackKw || getEntryKeyword(entry) || '').trim();
        return kw ? `kw:${kw}` : '';
    }

    function getNodeKeyForCell(cell) {
        const uid = getCellUid(cell);
        if (uid) return `uid:${uid}`;
        const kw = getCellKeyword(cell).trim();
        return kw ? `kw:${kw}` : '';
    }

    function addKeywordRowWithData(container, index, data) {
        const newItem = document.createElement('div');
        newItem.className = 'stj-keyword-item';
        const images = data.images || [];
        newItem.setAttribute('data-image-list', JSON.stringify(images));
        newItem.setAttribute('data-keyword', data.keyword || '');
        if (data.uid !== undefined && data.uid !== null && String(data.uid).trim() !== '') {
            newItem.setAttribute('data-entry-uid', String(data.uid).trim());
        }
        newItem.innerHTML = `
            <div class="stj-image-preview" id="stj_preview_${index}" style="position: relative;">
                <div class="stj-preview-text">${_t('stj.preview.placeholder', 'プレビュー')}</div>
            </div>
            <div class="stj-keyword-display"></div>
        `;
        container.appendChild(newItem);

        setCellKeyword(newItem, data.keyword || '');
        attachKeywordRowListeners(newItem, index);
        setupCellDropTargets(newItem);

        const previewEl = newItem.querySelector('.stj-image-preview');
        if (previewEl) {
            const charName = document.getElementById('stj_char_name_display')?.textContent || '';
            updateImagePreview(previewEl.id, charName, images.join(','));
        }
    }

    function buildSyntaxGuideHtml() {
        return `
            <div class="stj-guide-section">
                <div class="stj-guide-section-title">${_t('stj.syntax.title', '🔧 基本演算子')}</div>
                <ul class="stj-guide-list">
                    <li><code class="stj-op">+</code> <b>${_t('stj.syntax.and', 'AND（全て含む）')}</b><div class="stj-op-ex">${_t('stj.syntax.and_ex', '例：<code>山+川</code> → 「山」と「川」の両方が含まれる時にマッチ')}</div></li>
                    <li><code class="stj-op">,</code> <b>${_t('stj.syntax.or', 'OR（いずれか含む）')}</b><div class="stj-op-ex">${_t('stj.syntax.or_ex', '例：<code>山,川</code> → 「山」または「川」のどちらかが含まれる時にマッチ')}</div></li>
                    <li><code class="stj-op">!</code> <b>${_t('stj.syntax.not', 'NOT（除外）')}</b><div class="stj-op-ex">${_t('stj.syntax.not_ex', '例：<code>!山</code> → 「山」が含まれていない時にのみマッチ')}</div></li>
                    <li><code class="stj-op">( )</code> <b>${_t('stj.syntax.group', 'グループ化（入れ子可能）')}</b><div class="stj-op-ex">${_t('stj.syntax.group_ex', '例：<code>(山+川),谷</code> → 「山と川」または「谷」のいずれかにマッチ')}</div></li>
                </ul>
            </div>
        `;
    }

    function createConfirmDialog() {
        const existing = document.getElementById('stj_confirm_dialog');
        if (existing) existing.remove();
        const dialog = document.createElement('div');
        dialog.id = 'stj_confirm_dialog';
        dialog.innerHTML = `
            <div class="stj-confirm-box">
                <div class="stj-confirm-message">${_t('stj.confirm.delete_msg', '本当に削除しますか？')}</div>
                <div class="stj-confirm-buttons">
                    <button type="button" class="stj-confirm-yes">${_t('stj.confirm.yes', 'はい')}</button>
                    <button type="button" class="stj-confirm-no">${_t('stj.confirm.no', 'いいえ')}</button>
                </div>
            </div>
        `;
        document.body.appendChild(dialog);
        confirmDialogEl = dialog;

        dialog.addEventListener('click', (e) => e.stopPropagation());
        dialog.querySelector('.stj-confirm-yes').addEventListener('click', (e) => {
            e.stopPropagation();
            const cb = pendingDeleteCallback;
            hideDeleteConfirmDialog();
            if (typeof cb === 'function') { try { cb(); } catch (err) { console.error(err); } }
        });
        dialog.querySelector('.stj-confirm-no').addEventListener('click', (e) => {
            e.stopPropagation();
            const cb = pendingCancelCallback;
            hideDeleteConfirmDialog();
            if (typeof cb === 'function') { try { cb(); } catch (err) { console.error(err); } }
        });
    }

    function createMessageDialog() {
        const existing = document.getElementById('stj_message_dialog');
        if (existing) existing.remove();
        const dialog = document.createElement('div');
        dialog.id = 'stj_message_dialog';
        dialog.innerHTML = `
            <div class="stj-message-box">
                <div class="stj-message-text"></div>
            </div>
        `;
        document.body.appendChild(dialog);
        messageDialogEl = dialog;
        dialog.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
    }

    function createExportModal() {
        const existingModal = document.getElementById('stj_export_modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'stj_export_modal';
        modal.style.display = 'none';
        modal.style.position = 'fixed';
        modal.style.zIndex = '10001';
        modal.innerHTML = `
            <div id="stj_top_header_bar" class="stj-top-header-bar">
                <button type="button" id="stj_special_toggle" class="stj-test-toggle">${_t('stj.special.toggle_label', 'デフォルト＆サムネイル')} ▼</button>
                <button type="button" id="stj_test_toggle" class="stj-test-toggle">${_t('stj.header.title', '🔍 リアルタイムキーワード反応テスト')} ▼</button>
            </div>
            <div id="stj_special_body" class="stj-horizontal-panel-body" style="display: none;"></div>
            <div id="stj_test_body" style="display: none;">
                <div class="stj-test-header">
                    <strong id="stj_char_name_display"></strong>
                </div>
                <div class="stj-syntax-guide" id="stj_syntax_guide">${buildSyntaxGuideHtml()}</div>
                <textarea id="stj_test_input" placeholder="${_t('stj.header.test_placeholder', '試しに文章を入力してください（例：笑顔で挨拶する）...')}"></textarea>
                <div id="stj_test_result">${_t('stj.test.result_prefix', '判定結果')}: <span style="color: #aaa; font-weight: normal;">${_t('stj.test.empty_hint', '文章を入力するとヒットするキーワードが表示されます')}</span></div>
            </div>
            <div id="stj_test_section">
                <div id="stj_standalone_body" class="stj-horizontal-panel-body" style="display: flex;"></div>
            </div>

            <div class="stj-top-section">
                <div class="stj-special-container">
                    <div class="stj-special-item" data-image-list='[]'>
                        <div class="stj-special-label">${_t('stj.special.default_label', 'デフォルト表示')}</div>
                        <div class="stj-special-preview">
                            <div class="stj-image-preview" id="stj_preview_default" style="position: relative;">
                                <div class="stj-preview-text">${_t('stj.preview.default_placeholder', 'デフォルトメディアプレビュー')}</div>
                            </div>
                        </div>
                    </div>
                    <div class="stj-special-item" data-image-list='[]'>
                        <div class="stj-special-label">${_t('stj.special.thumbnail_label', 'サムネイル表示')}</div>
                        <div class="stj-special-preview">
                            <div class="stj-image-preview" id="stj_preview_thumbnail" style="position: relative;">
                                <div class="stj-preview-text">${_t('stj.preview.thumbnail_placeholder', 'サムネイルプレビュー')}</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="stj-info-panel">
                    <div class="stj-info-note">${_t('stj.info.click_hint', '※セルをクリックすると編集ウインドウが開きます')}</div>
                    <div class="stj-info-guide">
                        <h4>${_t('stj.info.title', '📖 操作方法')}</h4>
                        <ul class="stj-guide-ops">
                            <li>${_t('stj.info.op_click', '<b>セルをクリック</b>：編集ウインドウが開きます')}</li>
                            <li>${_t('stj.info.op_drag_gallery', '<b>ギャラリーからドラッグ&ドロップ</b>：画像を追加できます')}</li>
                            <li>${_t('stj.info.op_drag_cell', '<b>セルをドラッグ</b>：セルの位置を入れ替えられます')}</li>
                            <li>${_t('stj.info.op_hover_remove', '<b>編集ウインドウでホバー</b>：各マスに ❌ ボタン → 登録解除')}</li>
                            <li>${_t('stj.info.op_bulk_delete', '<b>一括削除</b>：複数のセルをまとめて削除')}</li>
                            <li>${_t('stj.info.op_add_cell', '<b>セル追加</b>：新しいセルを追加')}</li>
                        </ul>
                    </div>
                </div>
            </div>
            <div id="stj_keywords_container" class="stj-grid-container">
                <div class="stj-keyword-item" data-image-list='[]' data-keyword=''>
                    <div class="stj-image-preview" id="stj_preview_0" style="position: relative;">
                        <div class="stj-preview-text">${_t('stj.preview.placeholder', 'プレビュー')}</div>
                    </div>
                    <div class="stj-keyword-display"></div>
                </div>
            </div>
            <div class="stj-button-group">
                <div class="stj-button-group-main">
                    <button id="stj_cancel_export">${_t('stj.button.close', '終了')}</button>
                    <button id="stj_add_keyword" title="${_t('stj.button.new_entry_title', '新しいエントリを追加します')}">${_t('stj.button.new_entry', '新規')}</button>
                </div>
            </div>
        `;

        if (!document.getElementById('stj-test-section-style')) {
            const s = document.createElement('style');
            s.id = 'stj-test-section-style';
            s.textContent = `
                #stj_export_modal #stj_test_section,
                #stj_export_modal #stj_test_section .stj-test-header,
                #stj_export_modal #stj_test_section .stj-syntax-guide {
                    position: static !important;
                    top: auto !important;
                }
                #stj_export_modal #stj_test_section {
                    position: sticky;
                    top: calc(var(--exp-scale, 1) * -25px);
                    z-index: 100;
                    background: #1e1e1e;
                    border: 0px solid #555;
                    padding: calc(var(--exp-scale, 1) * 0px) calc(var(--exp-scale, 1) * 0px);
                    margin-bottom: calc(var(--exp-scale, 1) * 0px);
                    border-radius: calc(var(--exp-scale, 1) * 0px);
                    box-shadow: 0 calc(var(--exp-scale, 1) * 0px) calc(var(--exp-scale, 1) * 0px) rgba(0,0,0,0.6);
                }
                #stj_export_modal {
                    display: none;
                    position: fixed;
                    top: 0;
                    left: auto;
                    right: 0;
                    width: 70.5vw;
                    min-width: calc(var(--exp-scale, 1) * 500px);
                    height: 100vh;
                    background-color: #2d3748;
                    border: 1px solid #4a5568;
                    border-radius: calc(var(--exp-scale, 1) * 8px);
                    padding: calc(var(--exp-scale, 1) * 0px) calc(var(--exp-scale, 1) * 20px) calc(var(--exp-scale, 1) * 90px) calc(var(--exp-scale, 1) * 9px);
                    box-shadow: 0 calc(var(--exp-scale, 1) * 4px) calc(var(--exp-scale, 1) * 6px) rgba(0,0,0,0.1);
                    z-index: 10001;
                    overflow-y: auto;
                    overflow-x: auto;
                    box-sizing: border-box;
                }
                .stj-button-group {
                    position: fixed;
                    left: 29.5vw;
                    right: 0;
                    bottom: 0;
                    width: fit-content;
                    min-width: calc(var(--exp-scale, 1) * 50px);
                    z-index: 100;
                    display: flex;
                    justify-content: flex-start;
                    align-items: center;
                    gap: calc(var(--exp-scale, 1) * 0px);
                    margin: 0;
                    padding: calc(var(--exp-scale, 1) * 15px) calc(var(--exp-scale, 1) * 15px) calc(var(--exp-scale, 1) * 15px) calc(var(--exp-scale, 1) * 15px);
                    background-color: #2d3748;
                    border-top: 1px solid #4a5568;
                    border-bottom-left-radius: calc(var(--exp-scale, 1) * 0px);
                    border-bottom-right-radius: calc(var(--exp-scale, 1) * 0px);
                    box-sizing: border-box;
                }
                #stj_export_modal #stj_keywords_container.stj-tree-mode {
                    position: relative !important;
                    margin-top: calc(var(--exp-scale, 1) * 8px) !important;
                    z-index: 1;
                }
                #stj_export_modal #stj_standalone_body {
                    position: relative;
                    z-index: 2;
                }                
                #stj_export_modal #stj_test_toggle {
                    display: inline-block;
                    width: 45%;
                    padding: 0px 12px;
                    margin: 0 0 0px 0;
                    background: #2c5282;
                    color: #fff;
                    border: 1px solid #4299e1;
                    border-radius: 4px;
                    font-size: 14px;
                    font-weight: bold;
                    cursor: pointer;
                    text-align: left;
                    box-sizing: border-box;
                    font-size: calc(var(--exp-scale, 1) * 14px) !important;
                }
                #stj_export_modal #stj_test_toggle:hover {
                    background: #4299e1;
                }
                #stj_export_modal .stj-top-section {
                    display: flex;
                    gap: calc(var(--exp-scale, 1) * 20px);
                    margin-bottom: calc(var(--exp-scale, 1) * 25px);
                    align-items: stretch;
                    display: none !important;
                }
                #stj_export_modal #stj_top_header_bar {
                    display: flex !important;
                    flex-direction: row !important;
                    align-items: center !important;
                    gap: calc(var(--exp-scale, 1) * 10px);
                    width: 39%;
                    margin: 0 0 calc(var(--exp-scale, 1) * 6px) 0;
                    box-sizing: border-box;
                }
                #stj_export_modal #stj_top_header_bar #stj_special_toggle {
                    flex: 0 0 auto;
                    width: auto;
                    min-width: calc(var(--exp-scale, 1) * 180px);
                    margin: 0;
                    color: rgb(0, 0, 0) !important;
                }
                #stj_export_modal #stj_top_header_bar #stj_test_toggle {
                    flex: 1 1 auto;
                    width: auto;
                    margin: 0;
                }
                #stj_export_modal .stj-horizontal-panel-body {
                    display: flex;
                    flex-direction: row;
                    flex-wrap: wrap;
                    align-items: flex-start;
                    gap: calc(var(--exp-scale, 1) * 0px);
                    padding: calc(var(--exp-scale, 1) * 0px);
                    margin: 0 0 calc(var(--exp-scale, 1) * 0px) 0;
                    background: rgba(26, 32, 44, 0.85);
                    border: 0px solid #4a5568;
                    border-radius: 0px;
                    overflow-x: auto;
                    width: fit-content;
                }
                #stj_export_modal .stj-horizontal-panel-body .stj-special-item,
                #stj_export_modal .stj-horizontal-panel-body .stj-standalone-cell-item {
                    flex: 0 0 auto;
                    width: calc(var(--exp-scale, 1) * 160px);
                    height: calc(var(--exp-scale, 1) * 160px);
                    margin: 0;
                }
                #stj_export_modal #stj_special_body,
                #stj_export_modal #stj_special_body * {
                    color: rgb(0, 0, 0);
                }
                #stj_export_modal #stj_special_toggle {
                    color: rgb(0, 0, 0) !important;
                }
                #stj_export_modal .stj-special-label {
                    color: rgb(255, 255, 255) !important;
                    z-index: 10;
                    font-size: calc(var(--exp-scale, 1) * 14px);
                }
                #stj_export_modal .stj-special-preview {
                    position: absolute;
                    width: calc(var(--exp-scale, 1) * 160px);
                    height: calc(var(--exp-scale, 1) * 160px);
                    flex-shrink: 0;
                    border-radius: calc(var(--exp-scale, 1) * 8px);
                }
                #stj_export_modal .stj-image-preview {
                    width: calc(var(--exp-scale, 1) * 160px) !important;
                    height: calc(var(--exp-scale, 1) * 160px) ! important;
                    background-color: #1a202c;
                    border: 2px dashed #0d1117;
                    border-radius: calc(var(--exp-scale, 1) * 8px);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    overflow: hidden;
                    position: relative;
                    flex-shrink: 0;
                    box-sizing: border-box;
                    user-select: none;
                }
                #stj_export_modal #stj_standalone_toggle {
                    display: none !important;
                }
                #stj_export_modal .stj-standalone-empty {
                    color: #a0aec0;
                    padding: 4px 2px;
                }
                #gic-delete-image-button {
                    width: calc(var(--exp-scale, 1) * 50px)
                }
                #gic-unregister-button {
                    width: calc(var(--exp-scale, 1) * 50px)
                }
            `;
            document.head.appendChild(s);
        }

        document.body.appendChild(modal);
        stjModalEl = modal;

        createConfirmDialog();
        createMessageDialog();

        modal.addEventListener('click', (e) => e.stopPropagation());

        const testToggleBtn = document.getElementById('stj_test_toggle');
        const testBody = document.getElementById('stj_test_body');
        if (testToggleBtn && testBody) {
            testToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const expanded = testBody.style.display !== 'none';
                testBody.style.display = expanded ? 'none' : '';
                testToggleBtn.textContent = _t('stj.header.title', '🔍 リアルタイムキーワード反応テスト') + (expanded ? ' ▼' : ' ▲');
            });
        }

        const specialToggleBtn = document.getElementById('stj_special_toggle');
        const specialBody = document.getElementById('stj_special_body');
        if (specialToggleBtn && specialBody) {
            specialToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const expanded = specialBody.style.display !== 'none';
                if (!expanded) {
                    modal.querySelectorAll('.stj-top-section .stj-special-item').forEach((spItem) => {
                        specialBody.appendChild(spItem);
                        updateCellPreview(spItem);
                    });
                    specialBody.style.display = 'flex';
                    specialToggleBtn.textContent = _t('stj.special.toggle_label', 'デフォルト＆サムネイル') + ' ▲';
                } else {
                    modal.querySelectorAll('#stj_special_body .stj-special-item').forEach((spItem) => {
                        const topSpecialContainer = modal.querySelector('.stj-top-section .stj-special-container');
                        if (topSpecialContainer) topSpecialContainer.appendChild(spItem);
                    });
                    specialBody.style.display = 'none';
                    specialToggleBtn.textContent = _t('stj.special.toggle_label', 'デフォルト＆サムネイル') + ' ▼';
                }
            });
        }

        const standaloneBody = document.getElementById('stj_standalone_body');
        if (standaloneBody) {
            standaloneBody.style.display = 'flex';
        }
        
        const testInput = document.getElementById('stj_test_input');
        if (testInput) testInput.addEventListener('input', runLiveTest);

        const helpBtn = document.getElementById('stj_help_button');
        const syntaxGuide = document.getElementById('stj_syntax_guide');
        if (helpBtn && syntaxGuide) {
            helpBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                syntaxGuide.classList.toggle('stj-help-visible');
            });
        }

        if (!helpOutsideHandlerInstalled) {
            helpOutsideHandlerInstalled = true;
            document.addEventListener('click', (e) => {
                const guideEl = document.getElementById('stj_syntax_guide');
                const btnEl = document.getElementById('stj_help_button');
                if (!guideEl || !guideEl.classList.contains('stj-help-visible')) return;
                if (btnEl && btnEl.contains(e.target)) return;
                if (guideEl.contains(e.target)) return;
                guideEl.classList.remove('stj-help-visible');
            }, true);
        }

// ============================================================
// ★ 新規エントリ作成中オーバーレイ + 高速反映待ち
// ============================================================
let newEntryCreationToken = 0;

function showNewEntryCreatingOverlay() {
    hideNewEntryCreatingOverlay();

    const overlay = document.createElement('div');
    overlay.id = 'stj-new-entry-creating-overlay';
    overlay.textContent = _t('stj.toast.newentrycreating', '新規エントリ作成中…');

    Object.assign(overlay.style, {
        position: 'fixed',
        left: '50%',
        bottom: '96px',
        transform: 'translateX(-50%)',
        zIndex: '30000',
        padding: '10px 18px',
        borderRadius: '8px',
        background: 'rgba(20, 20, 20, 0.92)',
        color: '#fff',
        fontSize: '14px',
        fontWeight: '600',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
    });

    document.body.appendChild(overlay);
}

function hideNewEntryCreatingOverlay() {
    document.getElementById('stj-new-entry-creating-overlay')?.remove();
}

function getStandaloneCellElements() {
    return Array.from(
        document.querySelectorAll('#stjkeywordscontainer .stj-keyword-item')
    );
}

async function waitForNewStandaloneCell(beforeUids, beforeCount, timeoutMs = 5000) {
    const token = ++newEntryCreationToken;
    const charName =
        detectCharacterNameFromDOM(
            document.getElementById('stjcharnamedisplay')?.textContent
        ) ||
        detectCharacterNameFromDOM();

    const startedAt = Date.now();
    let lastError = null;

    while (Date.now() - startedAt < timeoutMs) {
        if (token !== newEntryCreationToken) {
            return false;
        }

        try {
            if (charName) {
                await syncEditorWithLatestLorebook(charName);
            }
        } catch (err) {
            lastError = err;
        }

        const cells = getStandaloneCellElements();
        const hasNewUid = cells.some(cell => {
            const uid = getCellUid(cell);
            return uid && !beforeUids.has(uid);
        });

        if (hasNewUid || cells.length > beforeCount) {
            return true;
        }

        await new Promise(resolve => setTimeout(resolve, 80));
    }

    if (lastError) {
        console.warn('[STJ Editor] 新規エントリの高速反映待ちでエラー:', lastError);
    }

    return false;
}

const addBtn = document.getElementById('stjaddkeyword');
if (addBtn) {
    addBtn.addEventListener('click', async (e) => {
        e.stopPropagation();

        console.log('[STJ Editor] 新規ボタン クリック検出', {
            isDialogActive,
            addBtnDisabled: addBtn.disabled,
            worldPopupNew: !!document.getElementById('world_popup_new'),
        });

        if (isDialogActive) {
            console.warn('[STJ Editor] isDialogActive=true のため新規エントリ作成を中止しました');
            return;
        }

        const beforeCells = getStandaloneCellElements();
        const beforeUids = new Set(
            beforeCells
                .map(cell => getCellUid(cell))
                .filter(uid => uid)
        );
        const beforeCount = beforeCells.length;

        addBtn.disabled = true;
        showNewEntryCreatingOverlay();

        try {
            autoSave({ immediate: true });

            const newEntryBtn = document.getElementById('world_popup_new');
            if (!newEntryBtn) {
                throw new Error('world_popup_new button not found');
            }

            newEntryBtn.click();

            // WORLDINFO_UPDATED の遅延同期を待たず、独立セルの出現を高速に監視する
            const appeared = await waitForNewStandaloneCell(
                beforeUids,
                beforeCount,
                5000
            );

            if (stjModalEl) {
                stjModalEl.style.display = 'block';
            }

            runLiveTest();

            if (!appeared) {
                const charName =
                    detectCharacterNameFromDOM(
                        document.getElementById('stjcharnamedisplay')?.textContent
                    ) ||
                    detectCharacterNameFromDOM();

                if (charName) {
                    await syncEditorWithLatestLorebook(charName);
                }
            }
        } catch (err) {
            console.warn('[STJ Editor] 新規エントリ作成に失敗:', err);

            const showToast = window.GicApi?.showBottomToast;
            if (typeof showToast === 'function') {
                showToast(
                    _t('stj.toast.newentryfailed', '新規エントリの作成に失敗しました'),
                    '',
                    'error'
                );
            }
        } finally {
            hideNewEntryCreatingOverlay();
            addBtn.disabled = false;
        }
    });
}

        const cancelBtn = document.getElementById('stj_cancel_export');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isDialogActive) return;
                closeExportModal();
            });
        }

        modal.querySelectorAll('.stj-special-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                if (isDialogActive) return;
                if (Date.now() < _suppressCellClickUntil) {
                    e.stopPropagation();
                    e.preventDefault();
                    return;
                }
                openCellModal(item);
            });
        });

        const firstItem = modal.querySelector('.stj-keyword-item');
        if (firstItem) attachKeywordRowListeners(firstItem, 0);
        setupCellDropTargets(modal);

        installPointerDragHandlers();
        installGlobalDropInterceptor();
        installCustomDropListener();

        const defaultCell = modal.querySelector('.stj-special-item:nth-child(1)');
        const thumbnailCell = modal.querySelector('.stj-special-item:nth-child(2)');
        if (defaultCell) updateCellPreview(defaultCell);
        if (thumbnailCell) updateCellPreview(thumbnailCell);
    }

    function setupImageDeletedListener() {
        if (window.__stjImageDeletedListenerInstalled) return;
        window.__stjImageDeletedListenerInstalled = true;

        window.addEventListener('gic-image-deleted', (e) => {
            const { charName, fileNames } = e.detail || {};
            if (!charName || !Array.isArray(fileNames) || fileNames.length === 0) return;

            const deleteSet = new Set(fileNames.map(n => String(n)));

            try {
                const ctx = getSTContext();
                let char = null;
                if (ctx?.characterId !== undefined && ctx?.characters?.[ctx.characterId]?.name === charName) {
                    char = ctx.characters[ctx.characterId];
                }
                if (!char && ctx?.character?.name === charName) {
                    char = ctx.character;
                }
                if (!char && Array.isArray(ctx?.characters)) {
                    char = ctx.characters.find(c => c?.name === charName);
                }

                const ext = char?.data?.extensions?.image_display_extension;
                if (ext && typeof ext === 'object') {
                    let dataChanged = false;
                    const newExt = {};

                    for (const [key, val] of Object.entries(ext)) {
                        const processValue = (v) => {
                            if (Array.isArray(v)) {
                                const filtered = v.filter(p => {
                                    if (typeof p !== 'string') return true;
                                    const fn = extractFileNameFromPath(p);
                                    if (!fn) return true;
                                    const resolved = resolveThumbToOriginal(fn);
                                    if (deleteSet.has(fn) || deleteSet.has(resolved)) {
                                        dataChanged = true;
                                        return false;
                                    }
                                    return true;
                                });
                                if (filtered.length === 0) return [];
                                return filtered.length === 1 ? filtered[0] : filtered;
                            } else if (typeof v === 'string') {
                                const fn = extractFileNameFromPath(v);
                                if (fn) {
                                    const resolved = resolveThumbToOriginal(fn);
                                    if (deleteSet.has(fn) || deleteSet.has(resolved)) {
                                        dataChanged = true;
                                        return [];
                                    }
                                }
                                return v;
                            }
                            return v;
                        };
                        const result = processValue(val);
                        if (result !== null) newExt[key] = result;
                    }

                    if (dataChanged) {
                        window.CharStore?.saveCharacterExtension?.(
                            'image_display_extension', newExt, { immediate: true }
                        );
                        try {
                            window.dispatchEvent(new CustomEvent('lbe-image-map-updated', {
                                detail: { charName, imageMap: newExt }
                            }));
                        } catch (e) { /* ignore */ }
                    }
                }
            } catch (e) {
                console.warn('[STJ Editor] character.data クリーンアップ失敗:', e);
            }

            const nameEl = document.getElementById('stj_char_name_display');
            const editorCharName = nameEl ? nameEl.textContent : '';
            if (!editorCharName || editorCharName !== charName) {
                return;
            }

            let removedCount = 0;

            document.querySelectorAll('.stj-special-item, .stj-keyword-item').forEach(cell => {
                const currentImages = getCellImages(cell);
                if (currentImages.length === 0) return;

                const filtered = currentImages.filter(fn => {
                    const clean = String(fn).trim();
                    if (!clean) return false;
                    const resolved = resolveThumbToOriginal(clean);
                    if (deleteSet.has(clean) || deleteSet.has(resolved)) {
                        removedCount++;
                        return false;
                    }
                    return true;
                });

                if (filtered.length !== currentImages.length) {
                    setCellImages(cell, filtered);
                    updateCellPreview(cell);

                    if (currentModalCell === cell && currentCellModal && currentCellModal.classList.contains('visible')) {
                        renderCellModalGrid(cell).catch(e => console.warn('[STJ Editor] render error:', e));
                    }
                }
            });

            if (removedCount > 0) {
                autoSave({ immediate: true });
                try { runLiveTest(); } catch (e) { /* ignore */ }
            }
        });
    }

    const AUTO_SYNC_COMMON_RULE_NAME = '00_共通ルール';

    function normalizeCellImages(val) {
        if (!val) return [];
        if (Array.isArray(val)) return val.filter(v => typeof v === 'string');
        if (typeof val === 'string') return [val];
        return [];
    }

    function getCurrentImageMapFromCharData(charName) {
        try {
            const ctx = getSTContext();
            const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
            if (!char || char.name !== charName) return null;
            const ext = char?.data?.extensions?.image_display_extension;
            if (!ext || typeof ext !== 'object') return {};
            return JSON.parse(JSON.stringify(ext));
        } catch (e) {
            console.warn('[STJ Editor] getCurrentImageMapFromCharData error:', e);
            return null;
        }
    }

    function saveImageMapToCharData(charName, imageMap) {
        try {
            const ctx = getSTContext();
            const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
            if (!char || char.name !== charName) {
                return false;
            }
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};
            char.data.extensions.image_display_extension = imageMap;

            window.CharStore?.saveCharacterExtension?.(
                'image_display_extension',
                imageMap,
                { immediate: true }
            );
            window.dispatchEvent(new CustomEvent('lbe-image-map-updated', {
                detail: { charName, imageMap }
            }));
            return true;
        } catch (e) {
            console.warn('[STJ Editor] saveImageMapToCharData error:', e);
            return false;
        }
    }

    function isCommonRuleName(name) {
        if (!name) return false;
        const trimmed = String(name).trim();
        if (!trimmed) return false;
        if (trimmed === AUTO_SYNC_COMMON_RULE_NAME) return true;
        if (trimmed.startsWith(AUTO_SYNC_COMMON_RULE_NAME)) return true;
        return false;
    }

    function _isEmptyImageValue(v) {
        if (v === null || v === undefined) return true;
        if (Array.isArray(v)) return v.length === 0;
        if (typeof v === 'string') return v.trim() === '';
        return false;
    }

    function _restoreImageMapFromBagState(charName) {
        try {
            const ctx = getSTContext();
            const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
            if (!char || char.name !== charName) return null;
            const bagState = char?.data?.extensions?.image_display_bag_state;
            if (!bagState || typeof bagState !== 'object') return null;

            const restored = {};
            for (const [bagKey, state] of Object.entries(bagState)) {
                if (!bagKey.startsWith('kw::')) continue;
                const kw = bagKey.slice('kw::'.length);
                const flags = state?.flags || {};
                const files = Object.keys(flags).filter(p => typeof p === 'string' && p);
                if (files.length > 0) {
                    restored[kw] = files.length === 1 ? files[0] : files;
                }
            }
            if (Object.keys(restored).length === 0) return null;
            return restored;
        } catch (e) {
            console.warn('[STJ Editor] bag_state 復元エラー:', e);
            return null;
        }
    }

    function _countImageFiles(v) {
        if (Array.isArray(v)) return v.length;
        if (typeof v === 'string' && v) return 1;
        return 0;
    }

    function _parseImageFileKey(charName, fileName) {
        if (!fileName || typeof fileName !== 'string') return null;
        const base = fileName.replace(/\.(png|jpe?g|webp|gif|avif|bmp)$/i, '');
        const tsMatch = base.match(/_(\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms)$/);
        if (!tsMatch) return null;
        const beforeTs = base.slice(0, base.length - tsMatch[0].length);
        if (beforeTs === charName) return '__default__';
        const prefix = `${charName}_`;
        if (!beforeTs.startsWith(prefix)) return null;
        const rest = beforeTs.slice(prefix.length);
        if (rest === '') return '__default__';
        if (/^\d+$/.test(rest)) return rest;
        return null;
    }

    const _diskScanCache = new Map();
    const DISK_SCAN_TTL_MS = 5000;

    async function _scanImagesFromDisk(charName) {
        if (!charName) return {};

        const cached = _diskScanCache.get(charName);
        if (cached && Date.now() - cached.ts < DISK_SCAN_TTL_MS) {
            return cached.data;
        }

        try {
            const origFetch = window.__gicOriginalFetch || window.fetch;
            let headers = { 'Content-Type': 'application/json' };
            try {
                const ctx = getSTContext();
                if (ctx && typeof ctx.getRequestHeaders === 'function') {
                    const h = ctx.getRequestHeaders();
                    if (h && typeof h === 'object') headers = h;
                }
            } catch (e) { /* ignore */ }

            const resp = await origFetch.call(window, '/api/images/list', {
                method: 'POST',
                headers,
                body: JSON.stringify({ folder: charName }),
            });
            if (!resp.ok) return {};
            const files = await resp.json();
            if (!Array.isArray(files)) return {};

            const grouped = {};
            for (const f of files) {
                if (typeof f !== 'string') continue;
                if (/_thum\.png$/i.test(f)) continue;
                if (/_img_thum\.png$/i.test(f)) continue;
                const key = _parseImageFileKey(charName, f);
                if (!key) continue;
                if (!grouped[key]) grouped[key] = [];
                grouped[key].push(`user/images/${charName}/${f}`);
            }

            _diskScanCache.set(charName, { data: grouped, ts: Date.now() });
            return grouped;
        } catch (e) {
            console.warn('[STJ Editor] _scanImagesFromDisk error:', e);
            return {};
        }
    }

    function _invalidateDiskScanCache(charName) {
        if (charName) _diskScanCache.delete(charName);
        else _diskScanCache.clear();
    }

    async function _restoreImageMapUnified(charName) {
        const restored = {};

        const bagMap = _restoreImageMapFromBagState(charName);
        if (bagMap) {
            for (const [k, v] of Object.entries(bagMap)) {
                restored[k] = v;
            }
        }

        const diskMap = await _scanImagesFromDisk(charName);
        for (const [k, v] of Object.entries(diskMap)) {
            if (k === '__default__') {
                if (!('default' in restored) || _isEmptyImageValue(restored['default'])) {
                    restored['default'] = v;
                }
            } else {
                if (!(k in restored) || _isEmptyImageValue(restored[k])) {
                    restored[k] = v;
                }
            }
        }

        return restored;
    }

    function getEntryKeyword(entry) {
        if (!entry) return '';
        const comment = (typeof entry.comment === 'string' ? entry.comment.trim() : '');
        if (comment && !isCommonRuleName(comment)) return comment;
        const keys = getEntryKeys(entry);
        if (keys.length > 0 && String(keys[0]).trim()) return String(keys[0]).trim();
        return '';
    }

    async function handleImageGeneratedForKeyword(e) {
        const { charName, entryKey, fileName } = e.detail || {};
        if (!charName || !entryKey || !fileName) return;

        const currentCharName = detectCharacterNameFromDOM();
        if (currentCharName !== charName) {
            return;
        }

        if (isCommonRuleName(entryKey)) {
            return;
        }

        const worldName = getCharacterWorldInfoName();
        if (!worldName) {
            return;
        }

        try {
            window.LorebookExpansion?.clearWorldInfoEntriesCache?.(worldName);
        } catch (err) { /* ignore */ }

        let entries = null;
        try {
            entries = await loadWorldInfoEntries(worldName);
        } catch (err) { /* ignore */ }
        if (!entries) {
            return;
        }

        const list = Array.isArray(entries) ? entries : Object.values(entries);

        let entryExists = false;
        for (const entry of list) {
            if (!entry) continue;
            const comment = (typeof entry.comment === 'string' ? entry.comment.trim() : '');
            const keys = getEntryKeys(entry);
            const firstKey = keys.length > 0 ? String(keys[0]).trim() : '';
            if (comment === entryKey || firstKey === entryKey) {
                entryExists = true;
                break;
            }
        }

        if (!entryExists) {
            return;
        }

        const imageMap = getCurrentImageMapFromCharData(charName);
        if (!imageMap) return;

        if (!Object.prototype.hasOwnProperty.call(imageMap, entryKey)) {
            imageMap[entryKey] = [];
        }

        const fullPath = `user/images/${charName}/${fileName}`;
        const currentList = normalizeCellImages(imageMap[entryKey]);

        const isDuplicate = currentList.some(p => {
            if (typeof p !== 'string') return false;
            const base = p.split('/').pop().split('?')[0].split('#')[0];
            try { return decodeURIComponent(base) === fileName; } catch (err) { return base === fileName; }
        });
        if (isDuplicate) {
            return;
        }

        currentList.push(fullPath);
        imageMap[entryKey] = currentList;

        saveImageMapToCharData(charName, imageMap);

        if (stjModalEl && stjModalEl.style.display === 'block') {
            try {
                populateFormFromImageMap(imageMap);
                autoSave({ immediate: true });
            } catch (err) {
                console.warn('[STJ Editor] UI 更新エラー:', err);
            }
        }
    }

    function setupLorebookEntryWatcher() {
        if (window.__stjLorebookEntryWatcherInstalled) return;
        window.__stjLorebookEntryWatcherInstalled = true;

        const ctx = getSTContext();
        if (!ctx?.eventSource || !ctx?.eventTypes) {
            setTimeout(setupLorebookEntryWatcher, 1000);
            return;
        }

        const es = ctx.eventSource;
        const et = ctx.eventTypes;

        async function syncLorebookEntriesToImageMap() {
            const charName = detectCharacterNameFromDOM()
                || document.getElementById('stj_char_name_display')?.textContent
                || '';
            if (!charName) return false;
            return await syncEditorWithLatestLorebook(charName);
        }        
        
        const syncLater = (delay = 500) => {
            setTimeout(() => {
                syncLorebookEntriesToImageMap()
                    .then(() => scheduleUnifiedBundleExport('', 800))
                    .catch(e => console.warn('[STJ Editor] syncLorebook error:', e));
            }, delay);
        };

        const worldInfoSyncEvents = [
            et.WORLDINFO_UPDATED,
            et.WORLDINFO_SETTINGS_UPDATED,
        ];

        worldInfoSyncEvents.forEach(name => {
            if (name && typeof es.on === 'function') {
                es.on(name, () => syncLater(50));
            }
        });

        const characterSyncEvents = [
            et.CHAT_CHANGED,
            et.CHARACTER_SELECTED,
            et.CHARACTER_PAGE_LOADED,
        ];

        characterSyncEvents.forEach(name => {
            if (name && typeof es.on === 'function') {
                es.on(name, () => syncLater(800));
            }
        });
        
        ['CHAT_CHANGED', 'CHARACTER_SELECTED', 'CHARACTER_PAGE_LOADED'].forEach(name => {
            if (et[name] && typeof es.on === 'function') {
                es.on(et[name], () => syncLater(800));
            }
        });

        window.addEventListener('gic-image-generated-for-keyword', handleImageGeneratedForKeyword);
        
        // ★ 自動更新のためのイベントリスナーを追加
        window.addEventListener('lbe-lex-data-updated', (e) => {
            const { worldName } = e.detail || {};
            if (!worldName) return;
            const currentWorldName = getCharacterWorldInfoName();
            if (currentWorldName !== worldName) return;
            const container = document.getElementById('stj_keywords_container');
            if (!container || !container.classList.contains('stj-tree-mode')) return;
            setTimeout(() => {
                _stjScheduleTreeLayout();
            }, 100);
        });
        // ★ ギャラリーが開く度に最新のロアブック状態へ自動アップデート
        window.addEventListener('gic-gallery-opened', async () => {
            const charName = detectCharacterNameFromDOM()
                || document.getElementById('stj_char_name_display')?.textContent
                || '';
            if (!charName) return;
            const nameEl = document.getElementById('stj_char_name_display');
            if (nameEl) nameEl.textContent = charName;
            await syncEditorWithLatestLorebook(charName);
        });
        // ★ LEXデータ更新や画像生成完了時にも一括JSONを自動出力
        window.addEventListener('lbe-lex-data-updated', () => {
            scheduleUnifiedBundleExport('', 800);
        });
        window.addEventListener('gic-image-generated-for-keyword', (e) => {
            const targetChar = e?.detail?.charName || '';
            scheduleUnifiedBundleExport(targetChar, 800);
        });
        
        syncLater(1500);
    }

    function retranslateStjUI() {
        if (!stjModalEl) return;

        const testToggleBtn = stjModalEl.querySelector('#stj_test_toggle');
        if (testToggleBtn) {
            const testBody = stjModalEl.querySelector('#stj_test_body');
            const expanded = testBody && testBody.style.display !== 'none';
            testToggleBtn.textContent = _t('stj.header.title', '🔍 リアルタイムキーワード反応テスト') + (expanded ? ' ▲' : ' ▼');
        }

        const testInput = stjModalEl.querySelector('#stj_test_input');
        if (testInput) testInput.placeholder = _t('stj.header.test_placeholder', '試しに文章を入力してください（例：笑顔で挨拶する）...');

        const syntaxGuide = stjModalEl.querySelector('#stj_syntax_guide');
        if (syntaxGuide) syntaxGuide.innerHTML = buildSyntaxGuideHtml();

        const specials = stjModalEl.querySelectorAll('.stj-special-item');
        if (specials[0]) {
            const l = specials[0].querySelector('.stj-special-label');
            if (l) l.textContent = _t('stj.special.default_label', 'デフォルト表示');
            const ph = specials[0].querySelector('.stj-preview-text');
            if (ph) { ph.textContent = _t('stj.preview.default_placeholder', 'デフォルトメディアプレビュー'); ph.dataset.originalText = ph.textContent; }
        }
        if (specials[1]) {
            const l = specials[1].querySelector('.stj-special-label');
            if (l) l.textContent = _t('stj.special.thumbnail_label', 'サムネイル表示');
            const ph = specials[1].querySelector('.stj-preview-text');
            if (ph) { ph.textContent = _t('stj.preview.thumbnail_placeholder', 'サムネイルプレビュー'); ph.dataset.originalText = ph.textContent; }
        }

        const infoNote = stjModalEl.querySelector('.stj-info-note');
        if (infoNote) infoNote.textContent = _t('stj.info.click_hint', '※セルをクリックすると編集ウインドウが開きます');

        const infoTitle = stjModalEl.querySelector('.stj-info-guide > h4');
        if (infoTitle) infoTitle.textContent = _t('stj.info.title', '📖 操作方法');

        const infoItems = stjModalEl.querySelectorAll('.stj-info-guide .stj-guide-ops > li');
        const infoKeys = ['stj.info.op_click', 'stj.info.op_drag_gallery', 'stj.info.op_drag_cell', 'stj.info.op_hover_remove', 'stj.info.op_bulk_delete', 'stj.info.op_add_cell'];
        const infoFallbacks = [
            '<b>セルをクリック</b>：編集ウインドウが開きます',
            '<b>ギャラリーからドラッグ&ドロップ</b>：画像を追加できます',
            '<b>セルをドラッグ</b>：セルの位置を入れ替えられます',
            '<b>編集ウインドウでホバー</b>：各マスに ❌ ボタン → 登録解除',
            '<b>一括削除</b>：複数のセルをまとめて削除',
            '<b>セル追加</b>：新しいセルを追加',
        ];
        infoItems.forEach((li, i) => {
            if (i < infoKeys.length) li.innerHTML = _t(infoKeys[i], infoFallbacks[i]);
        });

        const cancelBtn = stjModalEl.querySelector('#stj_cancel_export');
        if (cancelBtn) cancelBtn.textContent = _t('stj.button.close', '終了');
        const addBtn = stjModalEl.querySelector('#stj_add_keyword');
        if (addBtn) {
            addBtn.textContent = _t('stj.button.new_entry', '新規');
            addBtn.title = _t('stj.button.new_entry_title', '新しいエントリを追加します');
        }

        const firstPreview = stjModalEl.querySelector('.stj-keyword-item .stj-preview-text');
        if (firstPreview) {
            firstPreview.textContent = _t('stj.preview.placeholder', 'プレビュー');
            firstPreview.dataset.originalText = firstPreview.textContent;
        }

        if (confirmDialogEl) {
            const yes = confirmDialogEl.querySelector('.stj-confirm-yes');
            if (yes) yes.textContent = _t('stj.confirm.yes', 'はい');
            const no = confirmDialogEl.querySelector('.stj-confirm-no');
            if (no) no.textContent = _t('stj.confirm.no', 'いいえ');
        }

        if (currentCellModal) {
            const a = currentCellModal.querySelector('.stj-cell-modal-apply');
            if (a) a.textContent = _t('stj.cell_modal.apply', '決定');
            const c = currentCellModal.querySelector('.stj-cell-modal-cancel');
            if (c) c.textContent = _t('stj.cell_modal.cancel', 'キャンセル');
            const kw = currentCellModal.querySelector('.stj-cell-modal-keyword');
            if (kw) kw.placeholder = _t('stj.cell_modal.keyword_placeholder', 'キーワード');
        }

        try { runLiveTest(); } catch (e) { /* ignore */ }
    }

    // ===== Panning functionality =====
    let _stjPanningState = null;

    function _stjStartPanning(e) {
        if (e.target.closest('.stj-keyword-item, .stj-special-item')) return;
        if (e.button !== 0) return;

        const container = document.getElementById('stj_keywords_container');
        if (!container || !container.classList.contains('stj-tree-mode')) return;

        const scrollContainer = container.parentElement;
        if (!scrollContainer) return;

        _stjPanningState = {
            startX: e.clientX,
            startY: e.clientY,
            startScrollLeft: scrollContainer.scrollLeft,
            startScrollTop: scrollContainer.scrollTop,
            scrollContainer: scrollContainer
        };

        container.style.cursor = 'grabbing';
        e.preventDefault();
        e.stopPropagation();
    }

    function _stjPan(e) {
        if (!_stjPanningState) return;

        const dx = e.clientX - _stjPanningState.startX;
        const dy = e.clientY - _stjPanningState.startY;

        const scrollContainer = _stjPanningState.scrollContainer;
        if (scrollContainer) {
            scrollContainer.scrollLeft = _stjPanningState.startScrollLeft - dx;
            scrollContainer.scrollTop = _stjPanningState.startScrollTop - dy;
        }

        e.preventDefault();
        e.stopPropagation();
    }

    function _stjEndPanning(e) {
        if (!_stjPanningState) return;

        const container = document.getElementById('stj_keywords_container');
        if (container) {
            container.style.cursor = 'grab';
        }
        _stjPanningState = null;
        e.preventDefault();
        e.stopPropagation();
    }

    function setupPanningHandlers() {
        if (window.__stjPanningHandlersInstalled) return;
        window.__stjPanningHandlersInstalled = true;

        const container = document.getElementById('stj_keywords_container');
        if (!container) {
            setTimeout(setupPanningHandlers, 500);
            return;
        }

        container.addEventListener('mousedown', _stjStartPanning, { passive: false });
        document.addEventListener('mousemove', _stjPan, { passive: false });
        document.addEventListener('mouseup', _stjEndPanning, { passive: false });
        document.addEventListener('mouseleave', _stjEndPanning, { passive: false });

        container.style.cursor = 'grab';
    }    
    
    function initStjEditor() {
        const context = getSTContext();
        if (!context) { setTimeout(initStjEditor, 500); return; }

        if (!stjModalEl || !document.body.contains(stjModalEl)) {
            createExportModal();
        }

        setupImageDeletedListener();
        setupLorebookEntryWatcher();
        setupPanningHandlers();
        _stjInstallPanningHandlers();  // ★ パンニング機能を初期化

        try {
            if (window.ExpI18n?.onLanguageChange) {
                window.ExpI18n.onLanguageChange(() => {
                    try { retranslateStjUI(); } catch (e) { /* ignore */ }
                });
            }
        } catch (e) { /* ignore */ }

        window.STJEditor = {
            open: function () {
                try { openExportModal(); return true; }
                catch (e) { console.warn('[STJ Editor] open エラー:', e); return false; }
            },
            close: function (opts) {
                try { closeExportModal(opts || {}); return true; }
                catch (e) { console.warn('[STJ Editor] close エラー:', e); return false; }
            },
            isOpen: function () {
                return !!(stjModalEl && stjModalEl.style.display === 'block');
            },
            exportUnifiedBundleJson: (opts) => exportUnifiedBundleJson(opts),
            cleanMissingFiles: async function (targetCharName) {
                const charName = targetCharName
                    || document.getElementById('stj_char_name_display')?.textContent
                    || '';
                if (!charName) return { ok: false, message: 'no charName' };
                try {
                    const ctx = getSTContext();
                    let char = null;
                    if (ctx?.characters?.[ctx?.characterId]?.name === charName) {
                        char = ctx.characters[ctx.characterId];
                    }
                    if (!char && ctx?.character?.name === charName) char = ctx.character;
                    if (!char && Array.isArray(ctx?.characters)) {
                        char = ctx.characters.find(c => c?.name === charName);
                    }
                    const ext = char?.data?.extensions?.image_display_extension;
                    if (!ext || typeof ext !== 'object') {
                        return { ok: false, message: 'no data' };
                    }
                    const before = Object.keys(ext).length;
                    const cleaned = await cleanMissingImageFiles(ext, charName);
                    const after = Object.keys(cleaned).length;
                    return {
                        ok: true,
                        charName,
                        before,
                        after,
                        removed: before - after,
                    };
                } catch (e) {
                    return { ok: false, error: String(e) };
                }
            },
            restoreAllKeys: async function () {
                const charName = detectCharacterNameFromDOM();
                if (!charName) return { ok: false, message: 'no charName' };

                try {
                    const ctx = getSTContext();
                    const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
                    if (!char || char.name !== charName) {
                        return { ok: false, message: 'char mismatch' };
                    }

                    const imageMap = getCurrentImageMapFromCharData(charName) || {};

                    _invalidateDiskScanCache(charName);
                    const restoreData = await _restoreImageMapUnified(charName);

                    if (Object.keys(restoreData).length === 0) {
                        return { ok: false, message: 'no restore data (bag_state/disk both empty)' };
                    }

                    const restoredKeys = [];
                    const detail = {};
                    for (const [k, v] of Object.entries(restoreData)) {
                        const cur = imageMap[k];
                        if (_isEmptyImageValue(cur)) {
                            imageMap[k] = v;
                            restoredKeys.push(k);
                            detail[k] = _countImageFiles(v);
                        }
                    }

                    if (restoredKeys.length === 0) {
                        return {
                            ok: true, restored: 0,
                            message: 'no empty keys to restore',
                            availableKeys: Object.keys(restoreData),
                        };
                    }

                    saveImageMapToCharData(charName, imageMap);

                    if (stjModalEl && stjModalEl.style.display === 'block') {
                        populateFormFromImageMap(imageMap);
                        autoSave({ immediate: true });
                    }

                    return {
                        ok: true,
                        restored: restoredKeys.length,
                        keys: restoredKeys,
                        detail,
                        charName,
                    };
                } catch (e) {
                    return { ok: false, error: String(e) };
                }
            },
        };
    }
    $(document).ready(() => { initStjEditor(); });
})();

// ============================================================
// ★ 新規エントリボタン: 自己完結型クリック処理
// ============================================================
(function installStjNewEntryButtonHandler() {
    if (window.__stjNewEntryButtonHandlerInstalled) return;
    window.__stjNewEntryButtonHandlerInstalled = true;

    function showCreatingOverlay() {
        hideCreatingOverlay();

        const overlay = document.createElement('div');
        overlay.id = 'stj-new-entry-creating-overlay';
        overlay.textContent = '新規エントリ作成中…';

        Object.assign(overlay.style, {
            position: 'fixed',
            left: '50%',
            bottom: 'calc(var(--exp-scale, 1) * 140px)',
            transform: 'translateX(-50%)',
            zIndex: '30000',
            padding: '20px 36px',
            minWidth: 'calc(var(--exp-scale, 1) * 420px)',
            textAlign: 'center',
            borderRadius: '16px',
            background: 'rgba(20, 20, 20, 0.95)',
            color: '#fff',
            fontSize: 'calc(var(--exp-scale, 1) * 28px)',
            fontWeight: '800',
            lineHeight: '1.3',
            letterSpacing: '0.02em',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
            border: '2px solid rgba(255, 255, 255, 0.25)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
        });

        document.body.appendChild(overlay);
    }

    function hideCreatingOverlay() {
        document.getElementById('stj-new-entry-creating-overlay')?.remove();
    }

    function isDialogOpen() {
        return !!(
            document.querySelector('.stj-cell-modal.visible') ||
            document.body.classList.contains('stj-cell-modal-active')
        );
    }

    function getCells() {
        return Array.from(
            document.querySelectorAll(
                '#stj_keywords_container .stj-keyword-item, ' +
                '#stjkeywordscontainer .stj-keyword-item'
            )
        );
    }

    function getCellUid(cell) {
        if (!cell) return null;
        const value = cell.getAttribute('data-entry-uid');
        return value ? String(value).trim() : null;
    }

    function requestLorebookSync() {
        try {
            const context = window.SillyTavern?.getContext?.();
            const eventSource = context?.eventSource;
            const eventTypes = context?.eventTypes;

            if (!eventSource || !eventTypes?.WORLDINFO_UPDATED) return;

            const worldName =
                document.querySelector('#world_editor_select')?.selectedOptions?.[0]?.value ||
                document.querySelector('#world_info')?.selectedOptions?.[0]?.value ||
                '';

            eventSource.emit(
                eventTypes.WORLDINFO_UPDATED,
                worldName || null,
                null
            );

            console.log('[STJ Editor] WORLDINFO_UPDATED を送信しました');
        } catch (err) {
            console.warn('[STJ Editor] WORLDINFO_UPDATED 送信に失敗:', err);
        }
    }

    async function waitForNewCell(beforeUids, beforeCount, timeoutMs = 8000) {
        const startedAt = Date.now();
        let syncRequested = false;

        while (Date.now() - startedAt < timeoutMs) {
            const cells = getCells();

            const hasNewUid = cells.some(cell => {
                const uid = getCellUid(cell);
                return uid && !beforeUids.has(uid);
            });

            if (hasNewUid || cells.length > beforeCount) {
                return true;
            }

            if (!syncRequested) {
                requestLorebookSync();
                syncRequested = true;
            }

            await new Promise(resolve => setTimeout(resolve, 50));
        }

        return false;
    }

    async function handleNewEntryClick(button) {
        console.log('[STJ Editor] 新規ボタン クリック検出', {
            dialogOpen: isDialogOpen(),
            buttonDisabled: button.disabled,
            worldPopupNew: !!document.getElementById('world_popup_new'),
        });

        if (isDialogOpen()) {
            console.warn('[STJ Editor] セルモーダルが開いているため新規エントリ作成を中止しました');
            showCreatingOverlay();
            setTimeout(hideCreatingOverlay, 1500);
            return;
        }

        const beforeCells = getCells();
        const beforeUids = new Set(
            beforeCells
                .map(cell => getCellUid(cell))
                .filter(uid => uid)
        );
        const beforeCount = beforeCells.length;

        button.disabled = true;
        showCreatingOverlay();

        try {
            const newEntryBtn = document.getElementById('world_popup_new');
            console.log('[STJ Editor] world_popup_new:', newEntryBtn);

            if (!newEntryBtn) {
                throw new Error('world_popup_new ボタンが見つかりません');
            }

            newEntryBtn.click();
            console.log('[STJ Editor] world_popup_new をクリックしました');

            const appeared = await waitForNewCell(
                beforeUids,
                beforeCount,
                8000
            );

            console.log('[STJ Editor] 新規セル出現判定:', appeared);

            const editor = document.getElementById('stjexportmodal');
            if (editor) {
                editor.style.display = 'block';
            }
        } catch (err) {
            console.error('[STJ Editor] 新規エントリ作成エラー:', err);
            showError('新規エントリの作成に失敗しました');
        } finally {
            hideCreatingOverlay();
            button.disabled = false;
        }
    }

    function showError(message) {
        try {
            if (window.GicApi?.showBottomToast) {
                window.GicApi.showBottomToast(message, '', 'error');
            } else if (window.toastr?.error) {
                window.toastr.error(message);
            }
        } catch (err) {
            console.warn('[STJ Editor] エラートースト表示に失敗:', err);
        }
    }

    document.addEventListener('click', (event) => {
        const button = event.target?.closest?.('#stj_add_keyword');
        if (!button) return;

        event.preventDefault();
        event.stopImmediatePropagation();

        handleNewEntryClick(button);
    }, true);

    console.log('[STJ Editor] 新規エントリボタンの委譲型クリック処理を登録しました');
})();
