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
    //   openExportModal の読み込み完了までは true。
    //   この間の空フォーム autosave はスキップする（実データ保護）。
    //   読み込み完了後は false になり、全セル削除後の空フォームも保存される。
    let _editorLoading = false;
    // ★ 明示的に削除されたキーを追跡
    //   「フォームに無い既存キー」を null 送信で誤削除しないための管理。
    //   一括削除でのみ追加され、autoSave 成功後にクリアされる。
    const _explicitlyDeletedKeys = new Set();
    // ============================================================
    // ★ 別キャラ画像エントリの「一度きり」マイグレーション管理
    //   image-display.js と同じフラグを共有する。
    // ============================================================
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
                // ★ STコアの再取得でデータが上書きされるのを防ぐため即時保存
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

    // ============================================================
    // ★ キーワード重複チェック（完全一致）
    // ============================================================
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

    // ============================================================
    // ★ サムネイル名 → 元ファイル名 変換
    // ============================================================
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

    // ============================================================
    // ★ 動画 / アニメ GIF / APNG 用 🎬 バッジ（async）
    // ============================================================
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

    // ============================================================
    // ★ 動画サムネイルキャッシュ用ヘルパー
    // ============================================================
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

    // ============================================================
    // ★ ロアブック連携ヘルパー（エントリ移植用）
    // ============================================================
    function getCharacterWorldInfoName() {
        const ctx = getSTContext();
        if (!ctx) return null;
        let char = null;
        if (ctx.characters && ctx.characterId !== undefined && ctx.characterId !== null) {
            char = ctx.characters[ctx.characterId];
        }
        if (!char && ctx.character) char = ctx.character;
        if (!char) return null;
        const fromExt = char.data?.extensions?.world;
        if (fromExt && typeof fromExt === 'string') return fromExt;
        const fromData = char.data?.world;
        if (fromData && typeof fromData === 'string') return fromData;
        return null;
    }

    async function loadWorldInfoEntries(worldName) {
        if (!worldName) return null;

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const ctx = getSTContext();
                const headers = (ctx && typeof ctx.getRequestHeaders === 'function')
                    ? ctx.getRequestHeaders()
                    : { 'Content-Type': 'application/json' };
                const resp = await fetch('/api/worldinfo/get', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ name: worldName }),
                    cache: 'no-store',
                });
                if (resp.ok) {
                    const data = await resp.json();
                    if (data && data.entries) {
                        return data.entries;
                    }
                }
            } catch (err) {
                console.debug(`[STJ Editor] fetch 試行 ${attempt}/2 例外: ${err.message || err}`);
            }
            if (attempt < 2) await new Promise(r => setTimeout(r, 300));
        }

        if (window.LorebookExpansion?.loadWorldInfoEntriesByName) {
            try {
                const entries = await window.LorebookExpansion.loadWorldInfoEntriesByName(worldName);
                if (entries) return entries;
            } catch (err) { /* ignore */ }
        }

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

    function _getLexData(worldName, entry) {
        const uid = entry?.uid;
        let apiObj = null;
        try {
            if (window.LorebookExpansion?.getDataFor && worldName && uid !== undefined && uid !== null) {
                apiObj = window.LorebookExpansion.getDataFor(worldName, uid, entry);
            }
        } catch (e) { /* ignore */ }

        const extObj = entry?.extensions?.lorebook_expansion;
        const src = (apiObj && typeof apiObj === 'object')
            ? apiObj
            : ((extObj && typeof extObj === 'object') ? extObj : {});

        return JSON.parse(JSON.stringify(src));
    }

    function _setLexData(worldName, entry, dataObj) {
        if (!entry || !dataObj || typeof dataObj !== 'object') return;
        const copy = JSON.parse(JSON.stringify(dataObj));
        if (!entry.extensions || typeof entry.extensions !== 'object') {
            entry.extensions = {};
        }
        entry.extensions.lorebook_expansion = copy;

        const lex = window.LorebookExpansion;
        const uid = entry.uid;
        if (lex && worldName && uid !== undefined && uid !== null) {
            for (const fn of ['setDataFor', 'saveDataFor', 'updateEntryData']) {
                if (typeof lex[fn] === 'function') {
                    try { lex[fn](worldName, uid, copy, entry); } catch (e) { /* ignore */ }
                }
            }
        }
    }

    function _syncClonedEntryToTarget(clonedEl, sourceEl, worldName, targetEntry) {
        if (!clonedEl || !targetEntry) return;

        const lexData = _getLexData(worldName, targetEntry);
        let lexChanged = false;

        const controls = Array.from(clonedEl.querySelectorAll('input, textarea, select'));
        const srcControls = sourceEl ? Array.from(sourceEl.querySelectorAll('input, textarea, select')) : [];

        controls.forEach((ctrl, idx) => {
            const name = (ctrl.getAttribute('name') || '').trim();
            const dataKey = (ctrl.getAttribute('data-field') || ctrl.getAttribute('data-name') || ctrl.getAttribute('data-key') || '').trim();
            const cls = (ctrl.className || '').toLowerCase();
            const idAttr = (ctrl.getAttribute('data-lbe-field') || ctrl.dataset?.field || '').trim();
            const keyHint = (idAttr || dataKey || name || cls).toLowerCase();

            // 元DOM要素へ同期
            let srcCtrl = null;
            if (sourceEl && name) {
                srcCtrl = sourceEl.querySelector(`[name="${escapeCssAttrValue(name)}"]`);
            }
            if (!srcCtrl && sourceEl && dataKey) {
                srcCtrl = sourceEl.querySelector(
                    `[data-field="${escapeCssAttrValue(dataKey)}"], [data-name="${escapeCssAttrValue(dataKey)}"], [data-key="${escapeCssAttrValue(dataKey)}"]`
                );
            }
            if (!srcCtrl && srcControls[idx] && srcControls[idx].tagName === ctrl.tagName) {
                srcCtrl = srcControls[idx];
            }

            if (srcCtrl) {
                if (ctrl.type === 'checkbox' || ctrl.type === 'radio') {
                    if (srcCtrl.checked !== ctrl.checked) {
                        srcCtrl.checked = ctrl.checked;
                        srcCtrl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                } else if (srcCtrl.value !== ctrl.value) {
                    srcCtrl.value = ctrl.value;
                    srcCtrl.dispatchEvent(new Event(ctrl.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
                    if (ctrl.tagName !== 'SELECT') {
                        srcCtrl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
            }

            // 標準WIフィールドの同期
            if (name === 'comment') {
                targetEntry.comment = ctrl.value;
            } else if (name === 'key' || name === 'keys') {
                const arr = String(ctrl.value || '').split(',').map(s => s.trim()).filter(Boolean);
                targetEntry.key = arr;
                targetEntry.keys = arr;
            } else if (name === 'content') {
                targetEntry.content = ctrl.value;
            } else if (name === 'position') {
                const num = Number(ctrl.value);
                targetEntry.position = Number.isNaN(num) ? ctrl.value : num;
            } else if (name === 'entryStateSelector') {
                targetEntry.entryStateSelector = ctrl.value;
            }

            // LorebookExpansion 拡張フィールド（プロンプト・選択肢・解像度など）の同期
            const propName = idAttr || dataKey || (name && !['comment', 'key', 'keys', 'content', 'position', 'entryStateSelector'].includes(name) ? name : '');
            if (propName) {
                const nextVal = ctrl.type === 'checkbox' ? ctrl.checked : ctrl.value;
                if (lexData[propName] !== nextVal) {
                    lexData[propName] = nextVal;
                    lexChanged = true;
                }
            } else if (keyHint.includes('prompt') && typeof ctrl.value === 'string') {
                if (lexData.img_prompt !== ctrl.value) {
                    lexData.img_prompt = ctrl.value;
                    lexChanged = true;
                }
            }
        });

        // 選択肢（choices）要素がDOM上に存在する場合の同期
        const choiceInputs = clonedEl.querySelectorAll('[data-choice-index], .lbe-choice-input, input[name*="choice"], textarea[name*="choice"]');
        if (choiceInputs.length > 0) {
            const nextChoices = Array.from(choiceInputs).map(el => el.value).filter(v => typeof v === 'string');
            if (JSON.stringify(lexData.choices || []) !== JSON.stringify(nextChoices)) {
                lexData.choices = nextChoices;
                lexChanged = true;
            }
        }

        if (lexChanged || !targetEntry.extensions?.lorebook_expansion) {
            _setLexData(worldName, targetEntry, lexData);
        }
    }

    let _saveQueue = Promise.resolve();

    async function _persistEntryNow(worldName, targetEntry, sourceEl, clonedEl) {
        if (!worldName || !targetEntry || targetEntry.uid === undefined || targetEntry.uid === null) return;

        _saveQueue = _saveQueue.then(async () => {
            if (clonedEl) {
                _syncClonedEntryToTarget(clonedEl, sourceEl, worldName, targetEntry);
            }
            const uid = String(targetEntry.uid);
            const lexSnap = _getLexData(worldName, targetEntry);

            const ctx = getSTContext();
            const headers = (ctx && typeof ctx.getRequestHeaders === 'function')
                ? ctx.getRequestHeaders()
                : { 'Content-Type': 'application/json' };

            const getResp = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: worldName }),
                cache: 'no-store',
            });
            if (!getResp.ok) return;

            const wiJson = await getResp.json();
            const entriesObj = wiJson?.entries || wiJson?.data?.entries;
            if (!entriesObj || !entriesObj[uid]) return;

            const srvEntry = entriesObj[uid];
            if (targetEntry.comment !== undefined) srvEntry.comment = targetEntry.comment;
            if (targetEntry.key !== undefined) srvEntry.key = targetEntry.key;
            if (targetEntry.keys !== undefined) srvEntry.keys = targetEntry.keys;
            if (targetEntry.content !== undefined) srvEntry.content = targetEntry.content;
            if (targetEntry.position !== undefined) srvEntry.position = targetEntry.position;
            if (targetEntry.entryStateSelector !== undefined) srvEntry.entryStateSelector = targetEntry.entryStateSelector;

            const mergedLex = {
                ..._getLexData(worldName, srvEntry),
                ...lexSnap,
            };
            _setLexData(worldName, srvEntry, mergedLex);

            await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    name: worldName,
                    data: { entries: entriesObj },
                }),
            });

            window.LorebookExpansion?.clearWorldInfoEntriesCache?.(worldName);
        }).catch(err => {
            console.warn('[STJ Editor] エントリ保存エラー:', err);
        });

        return _saveQueue;
    }

    function _getLexDataSafe(worldName, entry) {
        const uid = entry?.uid;
        let apiData = null;
        try {
            if (window.LorebookExpansion?.getDataFor && worldName && uid !== undefined && uid !== null) {
                apiData = window.LorebookExpansion.getDataFor(worldName, uid, entry);
            }
        } catch (err) { /* ignore */ }

        const extData = entry?.extensions?.lorebook_expansion;
        const base = (apiData && typeof apiData === 'object')
            ? apiData
            : ((extData && typeof extData === 'object') ? extData : {});

        try {
            return JSON.parse(JSON.stringify(base));
        } catch (err) {
            return {};
        }
    }

    function _setLexDataSafe(worldName, entry, dataObj) {
        if (!entry || !dataObj || typeof dataObj !== 'object') return;
        const copy = JSON.parse(JSON.stringify(dataObj));
        if (!entry.extensions || typeof entry.extensions !== 'object') {
            entry.extensions = {};
        }
        entry.extensions.lorebook_expansion = copy;

        const lex = window.LorebookExpansion;
        const uid = entry.uid;
        if (lex && worldName && uid !== undefined && uid !== null) {
            for (const fnName of ['setDataFor', 'saveDataFor', 'updateEntryData']) {
                if (typeof lex[fnName] === 'function') {
                    try { lex[fnName](worldName, uid, copy, entry); } catch (err) { /* ignore */ }
                }
            }
        }
    }

    function _syncClonedEntryFields(clonedEl, sourceEl, worldName, targetEntry) {
        if (!clonedEl || !targetEntry) return;

        const lexData = _getLexDataSafe(worldName, targetEntry);
        let lexUpdated = false;

        const clonedControls = Array.from(clonedEl.querySelectorAll('input, textarea, select'));
        const sourceControls = sourceEl ? Array.from(sourceEl.querySelectorAll('input, textarea, select')) : [];

        clonedControls.forEach((ctrl, idx) => {
            const name = (ctrl.getAttribute('name') || '').trim();
            const dataKey = (
                ctrl.getAttribute('data-field') ||
                ctrl.getAttribute('data-name') ||
                ctrl.getAttribute('data-key') ||
                ctrl.dataset?.field ||
                ''
            ).trim();
            const cls = (ctrl.className || '').toLowerCase();

            let srcCtrl = null;
            if (sourceEl && name) {
                srcCtrl = sourceEl.querySelector(`[name="${escapeCssAttrValue(name)}"]`);
            }
            if (!srcCtrl && sourceEl && dataKey) {
                srcCtrl = sourceEl.querySelector(
                    `[data-field="${escapeCssAttrValue(dataKey)}"], [data-name="${escapeCssAttrValue(dataKey)}"], [data-key="${escapeCssAttrValue(dataKey)}"]`
                );
            }
            if (!srcCtrl && sourceControls[idx] && sourceControls[idx].tagName === ctrl.tagName) {
                srcCtrl = sourceControls[idx];
            }

            if (srcCtrl) {
                if (ctrl.type === 'checkbox' || ctrl.type === 'radio') {
                    if (srcCtrl.checked !== ctrl.checked) {
                        srcCtrl.checked = ctrl.checked;
                        srcCtrl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                } else if (srcCtrl.value !== ctrl.value) {
                    srcCtrl.value = ctrl.value;
                    srcCtrl.dispatchEvent(new Event('input', { bubbles: true }));
                    srcCtrl.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }

            if (name === 'comment') {
                targetEntry.comment = ctrl.value;
            } else if (name === 'key' || name === 'keys') {
                const keysArr = String(ctrl.value || '').split(',').map(s => s.trim()).filter(Boolean);
                targetEntry.key = keysArr;
                targetEntry.keys = keysArr;
            } else if (name === 'content') {
                targetEntry.content = ctrl.value;
            } else if (name === 'position') {
                const parsedNum = Number(ctrl.value);
                targetEntry.position = Number.isNaN(parsedNum) ? ctrl.value : parsedNum;
            } else if (name === 'entryStateSelector') {
                targetEntry.entryStateSelector = ctrl.value;
            }

            const lexKey = dataKey || (
                name && !['comment', 'key', 'keys', 'content', 'position', 'entryStateSelector'].includes(name)
                    ? name
                    : ''
            );
            if (lexKey) {
                const nextVal = ctrl.type === 'checkbox' ? ctrl.checked : ctrl.value;
                if (lexData[lexKey] !== nextVal) {
                    lexData[lexKey] = nextVal;
                    lexUpdated = true;
                }
            } else if ((name.toLowerCase().includes('prompt') || cls.includes('prompt')) && typeof ctrl.value === 'string') {
                if (lexData.img_prompt !== ctrl.value) {
                    lexData.img_prompt = ctrl.value;
                    lexUpdated = true;
                }
            }
        });

        const choiceEls = clonedEl.querySelectorAll('[data-choice-index], .lbe-choice-input, input[name*="choice"], textarea[name*="choice"]');
        if (choiceEls.length > 0) {
            const choicesArr = Array.from(choiceEls).map(el => el.value).filter(v => typeof v === 'string');
            if (JSON.stringify(lexData.choices || []) !== JSON.stringify(choicesArr)) {
                lexData.choices = choicesArr;
                lexUpdated = true;
            }
        }

        if (lexUpdated || !targetEntry.extensions?.lorebook_expansion) {
            _setLexDataSafe(worldName, targetEntry, lexData);
        }
    }

    let _persistChain = Promise.resolve();

    async function _saveLorebookEntryDirect(worldName, targetEntry, sourceEl, clonedEl) {
        if (!worldName || !targetEntry || targetEntry.uid === undefined || targetEntry.uid === null) return;

        _persistChain = _persistChain.then(async () => {
            if (clonedEl) {
                _syncClonedEntryFields(clonedEl, sourceEl, worldName, targetEntry);
            }

            const uid = String(targetEntry.uid);
            const lexSnap = _getLexDataSafe(worldName, targetEntry);
            _setLexDataSafe(worldName, targetEntry, lexSnap);

            const ctx = getSTContext();
            const headers = (ctx && typeof ctx.getRequestHeaders === 'function')
                ? ctx.getRequestHeaders()
                : { 'Content-Type': 'application/json' };

            const getResp = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: worldName }),
                cache: 'no-store',
            });
            if (!getResp.ok) return;

            const wiJson = await getResp.json();
            const entriesMap = wiJson?.entries || wiJson?.data?.entries;
            if (!entriesMap || !entriesMap[uid]) return;

            const srvEntry = entriesMap[uid];
            if (targetEntry.comment !== undefined) srvEntry.comment = targetEntry.comment;
            if (targetEntry.key !== undefined) srvEntry.key = targetEntry.key;
            if (targetEntry.keys !== undefined) srvEntry.keys = targetEntry.keys;
            if (targetEntry.content !== undefined) srvEntry.content = targetEntry.content;
            if (targetEntry.position !== undefined) srvEntry.position = targetEntry.position;
            if (targetEntry.entryStateSelector !== undefined) srvEntry.entryStateSelector = targetEntry.entryStateSelector;

            const mergedLex = {
                ..._getLexDataSafe(worldName, srvEntry),
                ...lexSnap,
            };
            _setLexDataSafe(worldName, srvEntry, mergedLex);

            await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    name: worldName,
                    data: { entries: entriesMap },
                }),
            });

            window.LorebookExpansion?.clearWorldInfoEntriesCache?.(worldName);
        }).catch((err) => {
            console.warn('[STJ Editor] ロアブック保存エラー:', err);
        });

        return _persistChain;
    }

    async function _applyKeywordToCellAndLorebook(newKwRaw) {
        const cell = currentModalCell;
        if (!cell || cell.classList.contains('stj-special-item')) return;

        const newKw = String(newKwRaw || '').trim();
        const oldKw = getCellKeyword(cell).trim();
        if (!newKw || newKw === oldKw) return;

        if (findDuplicateKeyword(cell, newKw)) {
            showKeywordDuplicateWarning(newKw);
            return;
        }

        const charName = document.getElementById('stj_char_name_display')?.textContent || detectCharacterNameFromDOM() || '';
        const worldName = getCharacterWorldInfoName();
        const entryHostEl = currentCellModal?.querySelector('#stj_cell_modal_entry_host');

        let targetEntry = entryHostEl?._targetEntry || null;
        if (!targetEntry && worldName) {
            const entries = await loadWorldInfoEntries(worldName);
            targetEntry = findEntryByKeyword(entries, oldKw) || findEntryByKeyword(entries, newKw);
        }

        const lexSnap = (worldName && targetEntry) ? _getLexDataSafe(worldName, targetEntry) : null;

        if (targetEntry) {
            targetEntry.comment = newKw;
            const curKeys = getEntryKeys(targetEntry);
            if (curKeys.length === 0 || (curKeys.length === 1 && String(curKeys[0]).trim() === oldKw)) {
                targetEntry.key = [newKw];
                targetEntry.keys = [newKw];
            }
            if (worldName && lexSnap) {
                _setLexDataSafe(worldName, targetEntry, lexSnap);
            }
        }

        if (charName) {
            const curMap = getCurrentImageMapFromCharData(charName) || {};
            if (Object.prototype.hasOwnProperty.call(curMap, oldKw)) {
                const nextMap = {};
                for (const [k, v] of Object.entries(curMap)) {
                    if (k === oldKw) {
                        nextMap[newKw] = v;
                    } else if (!Object.prototype.hasOwnProperty.call(nextMap, k)) {
                        nextMap[k] = v;
                    }
                }
                saveImageMapToCharData(charName, nextMap);
            }
        }

        setCellKeyword(cell, newKw);
        modalOriginalKeyword = newKw;

        if (entryHostEl?._clonedEntryEl) {
            const cComment = entryHostEl._clonedEntryEl.querySelector('textarea[name="comment"], input[name="comment"]');
            if (cComment) cComment.value = newKw;
        }
        if (entryHostEl?._sourceEntryEl) {
            const sComment = entryHostEl._sourceEntryEl.querySelector('textarea[name="comment"], input[name="comment"]');
            if (sComment) {
                sComment.value = newKw;
                sComment.dispatchEvent(new Event('input', { bubbles: true }));
                sComment.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }

        if (worldName && targetEntry) {
            await _saveLorebookEntryDirect(
                worldName,
                targetEntry,
                entryHostEl?._sourceEntryEl || null,
                entryHostEl?._clonedEntryEl || null
            );
        }

        updateCellPreview(cell);
        autoSave({ immediate: true });
    }
    
    function _installKeywordDisplayDelegate() {
        if (window._stjKeywordDisplayDelegateInstalled) return;
        window._stjKeywordDisplayDelegateInstalled = true;

        document.addEventListener('click', (e) => {
            const kwDisplayEl = e.target.closest('#stj_cell_modal_keyword_display, .stj-cell-modal-keyword-display');
            if (!kwDisplayEl) return;
            if (e.target.closest('input.stj-kw-inline-input')) return;
            if (!currentModalCell || currentModalCell.classList.contains('stj-special-item')) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const startText = getCellKeyword(currentModalCell) || kwDisplayEl.textContent || '';
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'stj-kw-inline-input';
            input.value = startText;
            input.style.cssText = [
                'width: 100%',
                'max-width: 480px',
                'padding: 4px 10px',
                'font-size: 20px',
                'font-weight: bold',
                'color: #ffffff',
                'background: #0f172a',
                'border: 2px solid #38bdf8',
                'border-radius: 6px',
                'outline: none',
                'box-sizing: border-box',
                'position: relative',
                'z-index: 30',
            ].join(';');

            let finalized = false;
            const commitOrCancel = async (shouldSave) => {
                if (finalized) return;
                finalized = true;
                const rawVal = input.value;
                if (input.parentNode === kwDisplayEl) {
                    kwDisplayEl.removeChild(input);
                }
                const fallbackKw = getCellKeyword(currentModalCell) || '';
                if (shouldSave) {
                    const nextKw = rawVal.trim();
                    if (nextKw && !findDuplicateKeyword(currentModalCell, nextKw)) {
                        kwDisplayEl.textContent = nextKw;
                        await _applyKeywordToCellAndLorebook(nextKw);
                        return;
                    }
                }
                kwDisplayEl.textContent = fallbackKw;
            };

            input.addEventListener('click', (ev) => {
                ev.stopPropagation();
                ev.stopImmediatePropagation();
            }, true);
            input.addEventListener('mousedown', (ev) => {
                ev.stopPropagation();
                ev.stopImmediatePropagation();
            }, true);
            input.addEventListener('keydown', (ev) => {
                ev.stopPropagation();
                if (ev.key === 'Enter' && !ev.isComposing) {
                    ev.preventDefault();
                    commitOrCancel(true);
                } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    commitOrCancel(false);
                }
            });
            input.addEventListener('blur', () => {
                commitOrCancel(true);
            });

            kwDisplayEl.textContent = '';
            kwDisplayEl.appendChild(input);
            requestAnimationFrame(() => {
                input.focus();
                input.select();
            });
        }, true);
    }
    
    async function _commitKeywordEdit(newKwRaw) {
        const cell = currentModalCell;
        if (!cell || cell.classList.contains('stj-special-item')) return;

        const newKw = String(newKwRaw || '').trim();
        const oldKw = getCellKeyword(cell).trim();
        if (!newKw || newKw === oldKw) return;

        if (findDuplicateKeyword(cell, newKw)) {
            showKeywordDuplicateWarning(newKw);
            return;
        }

        const charName = document.getElementById('stj_char_name_display')?.textContent || detectCharacterNameFromDOM() || '';
        const worldName = getCharacterWorldInfoName();
        const entryHostEl = currentCellModal?.querySelector('#stj_cell_modal_entry_host');

        let targetEntry = entryHostEl?._targetEntry || null;
        if (!targetEntry && worldName) {
            const entries = await loadWorldInfoEntries(worldName);
            targetEntry = findEntryByKeyword(entries, oldKw) || findEntryByKeyword(entries, newKw);
        }

        const lexSnap = (worldName && targetEntry) ? _getLexData(worldName, targetEntry) : null;

        if (targetEntry) {
            targetEntry.comment = newKw;
            const curKeys = getEntryKeys(targetEntry);
            if (curKeys.length === 0 || (curKeys.length === 1 && String(curKeys[0]).trim() === oldKw)) {
                targetEntry.key = [newKw];
                targetEntry.keys = [newKw];
            }
            if (worldName && lexSnap) {
                _setLexData(worldName, targetEntry, lexSnap);
            }
        }

        if (charName) {
            const curMap = getCurrentImageMapFromCharData(charName) || {};
            if (Object.prototype.hasOwnProperty.call(curMap, oldKw)) {
                const nextMap = {};
                for (const [k, v] of Object.entries(curMap)) {
                    if (k === oldKw) {
                        nextMap[newKw] = v;
                    } else if (!Object.prototype.hasOwnProperty.call(nextMap, k)) {
                        nextMap[k] = v;
                    }
                }
                saveImageMapToCharData(charName, nextMap);
            }
        }

        setCellKeyword(cell, newKw);
        modalOriginalKeyword = newKw;

        if (entryHostEl?._clonedEntryEl) {
            const cComment = entryHostEl._clonedEntryEl.querySelector('textarea[name="comment"], input[name="comment"]');
            if (cComment) cComment.value = newKw;
        }
        if (entryHostEl?._sourceEntryEl) {
            const sComment = entryHostEl._sourceEntryEl.querySelector('textarea[name="comment"], input[name="comment"]');
            if (sComment) {
                sComment.value = newKw;
                sComment.dispatchEvent(new Event('input', { bubbles: true }));
                sComment.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }

        if (worldName && targetEntry) {
            await _persistEntryNow(
                worldName,
                targetEntry,
                entryHostEl?._sourceEntryEl || null,
                entryHostEl?._clonedEntryEl || null
            );
        }

        updateCellPreview(cell);
        autoSave({ immediate: true });
    }

    function _enableKeywordInlineEdit(kwDisplayEl) {
        if (!kwDisplayEl) return;
        kwDisplayEl.style.cursor = 'pointer';
        kwDisplayEl.style.pointerEvents = 'auto';
        kwDisplayEl.title = _t('stj.cell_modal.keyword_edit_hint', 'クリックしてキーワードを編集');

        if (kwDisplayEl._kwEditHandler) {
            kwDisplayEl.removeEventListener('click', kwDisplayEl._kwEditHandler, true);
        }

        const onClick = (e) => {
            if (!currentModalCell || currentModalCell.classList.contains('stj-special-item')) return;
            if (kwDisplayEl.querySelector('input.stj-kw-inline-edit')) return;

            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const startVal = getCellKeyword(currentModalCell) || kwDisplayEl.textContent || '';
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'stj-kw-inline-edit';
            input.value = startVal;
            input.style.cssText =
                'width:100%;max-width:460px;padding:4px 10px;font-size:20px;font-weight:bold;' +
                'color:#fff;background:#0f172a;border:2px solid #60a5fa;' +
                'border-radius:6px;outline:none;box-sizing:border-box;position:relative;z-index:20;';

            let settled = false;
            const finalize = async (commit) => {
                if (settled) return;
                settled = true;
                const raw = input.value;
                if (input.parentNode === kwDisplayEl) {
                    kwDisplayEl.removeChild(input);
                }
                const fallbackKw = getCellKeyword(currentModalCell) || '';
                if (commit) {
                    const trimmed = raw.trim();
                    if (trimmed && !findDuplicateKeyword(currentModalCell, trimmed)) {
                        kwDisplayEl.textContent = trimmed;
                        await _commitKeywordEdit(trimmed);
                        return;
                    }
                }
                kwDisplayEl.textContent = fallbackKw;
            };

            input.addEventListener('click', (ev) => ev.stopPropagation(), true);
            input.addEventListener('mousedown', (ev) => ev.stopPropagation(), true);
            input.addEventListener('keydown', (ev) => {
                ev.stopPropagation();
                if (ev.key === 'Enter' && !ev.isComposing) {
                    ev.preventDefault();
                    finalize(true);
                } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    finalize(false);
                }
            });
            input.addEventListener('blur', () => finalize(true));

            kwDisplayEl.textContent = '';
            kwDisplayEl.appendChild(input);
            setTimeout(() => {
                input.focus();
                input.select();
            }, 0);
        };

        kwDisplayEl._kwEditHandler = onClick;
        kwDisplayEl.addEventListener('click', onClick, true);
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

        // ★ 1st pass: getEntryKeyword（comment 優先）で一致判定
        //   ツリーレイアウト（_stjBuildChoiceGraph）と同一ロジックに揃える
        for (const entry of list) {
            if (!entry) continue;
            if (getEntryKeyword(entry) === target) return entry;
        }

        // ★ 2nd pass: keys 配列でも一致判定（後方互換）
        for (const entry of list) {
            if (!entry) continue;
            const keys = getEntryKeys(entry);
            for (const k of keys) {
                if (String(k).trim() === target) return entry;
            }
        }

        // ★ 3rd pass: 緩い一致（全角/半角・接頭辞・部分一致）
        //   ツリー側と同じ救済経路を通す
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

    function captureEntrySnapshot(el) {
        if (!el) return null;
        const fields = new Map();
        const heights = new Map();
        el.querySelectorAll('input, textarea, select').forEach((field, idx) => {
            const key = field.getAttribute('name') || `idx_${idx}`;
            if (field.type === 'checkbox' || field.type === 'radio') {
                fields.set(key, { type: 'check', checked: field.checked });
            } else if (field.tagName === 'SELECT') {
                fields.set(key, {
                    type: 'select',
                    value: field.value,
                    selectedIndex: field.selectedIndex,
                });
            } else {
                fields.set(key, { type: 'val', value: field.value });
            }
            if (field.tagName === 'TEXTAREA') {
                const h = field.style.height;
                if (h) heights.set(key, h);
            }
        });
        return { fields, heights, userModified: new Set() };
    }

    function updateSnapshotForField(snap, field, idx) {
        if (!snap || !field) return;
        const key = field.getAttribute('name') || `idx_${idx}`;
        snap.userModified.add(key);
        if (field.type === 'checkbox' || field.type === 'radio') {
            snap.fields.set(key, { type: 'check', checked: field.checked });
        } else if (field.tagName === 'SELECT') {
            snap.fields.set(key, {
                type: 'select',
                value: field.value,
                selectedIndex: field.selectedIndex,
            });
        } else {
            snap.fields.set(key, { type: 'val', value: field.value });
        }
        if (field.tagName === 'TEXTAREA' && field.style.height) {
            snap.heights.set(key, field.style.height);
        }
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

        // ドラッグハンドルおよび指定の2要素を削除
        clonedEl.querySelectorAll('.drag-handle, .inline-drawer-header, [name="keywordsAndLogicBlock"]').forEach((el) => {
            el.remove();
        });

        const collapseClasses = [
            'collapsed',
            'closed',
            'is-collapsed',
            'inline-drawer-collapsed',
        ];
        clonedEl.classList.remove(...collapseClasses);
        clonedEl.classList.add('open', 'expanded');

        // トグルアイコンを下向き(down)から上向き(up)に切り替え（lbe-extras-toggle は除外）
        clonedEl.querySelectorAll('.inline-drawer-toggle').forEach((toggle) => {
            toggle.classList.remove('down', 'fa-circle-chevron-down', 'fa-chevron-down', 'fa-caret-down');
            toggle.classList.add('up', 'fa-circle-chevron-up');
        });

        clonedEl.querySelectorAll('*').forEach((el) => {
            // 詳細設定パネル(.lbe-extras-panel)とその内部は常時展開の対象から除外する
            if (el.closest('.lbe-extras-panel') || el.classList.contains('lbe-extras-panel')) {
                return;
            }
            collapseClasses.forEach((cls) => {
                if (el.classList.contains(cls)) {
                    el.classList.remove(cls);
                }
            });
            if (
                el.classList.contains('inline-drawer-content') ||
                el.classList.contains('world_entry_edit') ||
                el.classList.contains('world_entry_form') ||
                el.classList.contains('world_entry_body') ||
                el.getAttribute('name') === 'PositionBlock'
            ) {
                el.classList.add('open', 'expanded');
                el.style.setProperty('display', 'block', 'important');
                el.style.setProperty('visibility', 'visible', 'important');
                el.style.setProperty('opacity', '1', 'important');
                el.style.setProperty('height', 'auto', 'important');
                el.style.setProperty('max-height', 'none', 'important');
                el.style.setProperty('overflow', 'visible', 'important');
            } else if (el.style && el.style.display === 'none') {
                el.style.setProperty('display', '', 'important');
            }
        });

        // 詳細設定パネルが手動で開かれていなければ閉じた状態を維持
        if (clonedEl.dataset.lbeExtrasUserOpened !== '1') {
            collapseLbeExtrasPanel(clonedEl);
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

    function _getLexSnapshot(worldName, entry) {
        const uid = entry?.uid;
        let apiData = null;
        try {
            if (window.LorebookExpansion?.getDataFor && worldName && uid !== undefined && uid !== null) {
                apiData = window.LorebookExpansion.getDataFor(worldName, uid, entry);
            }
        } catch (e) { /* ignore */ }

        const extData = entry?.extensions?.lorebook_expansion;
        const base = (apiData && typeof apiData === 'object')
            ? apiData
            : ((extData && typeof extData === 'object') ? extData : {});

        try {
            return JSON.parse(JSON.stringify(base));
        } catch (e) {
            return {
                img_prompt: typeof base.img_prompt === 'string' ? base.img_prompt : '',
                choices: Array.isArray(base.choices) ? [...base.choices] : [],
            };
        }
    }

    function _applyLexSnapshot(worldName, entry, snap) {
        if (!entry || !snap || typeof snap !== 'object') return;
        const copy = JSON.parse(JSON.stringify(snap));
        if (!entry.extensions || typeof entry.extensions !== 'object') {
            entry.extensions = {};
        }
        entry.extensions.lorebook_expansion = copy;

        const lex = window.LorebookExpansion;
        const uid = entry.uid;
        if (lex && worldName && uid !== undefined && uid !== null) {
            for (const fnName of ['setDataFor', 'saveDataFor', 'updateEntryData']) {
                if (typeof lex[fnName] === 'function') {
                    try { lex[fnName](worldName, uid, copy, entry); } catch (e) { /* ignore */ }
                }
            }
        }
    }

    function _syncClonedFieldsToSource(clonedEl, sourceEl) {
        if (!clonedEl || !sourceEl) return false;
        let changed = false;

        const clonedControls = Array.from(clonedEl.querySelectorAll('input, textarea, select'));
        const sourceControls = Array.from(sourceEl.querySelectorAll('input, textarea, select'));

        clonedControls.forEach((ctrl, idx) => {
            let target = null;
            const name = ctrl.getAttribute('name');
            if (name) {
                target = sourceEl.querySelector(`[name="${escapeCssAttrValue(name)}"]`);
            }
            if (!target) {
                const dataAttr = ctrl.getAttribute('data-name') || ctrl.getAttribute('data-field') || ctrl.getAttribute('data-key');
                if (dataAttr) {
                    target = sourceEl.querySelector(
                        `[data-name="${escapeCssAttrValue(dataAttr)}"], [data-field="${escapeCssAttrValue(dataAttr)}"], [data-key="${escapeCssAttrValue(dataAttr)}"]`
                    );
                }
            }
            if (!target && sourceControls[idx] && sourceControls[idx].tagName === ctrl.tagName) {
                target = sourceControls[idx];
            }
            if (!target) return;

            if (ctrl.type === 'checkbox' || ctrl.type === 'radio') {
                if (target.checked !== ctrl.checked) {
                    target.checked = ctrl.checked;
                    target.dispatchEvent(new Event('change', { bubbles: true }));
                    changed = true;
                }
            } else if (ctrl.tagName === 'SELECT') {
                if (target.value !== ctrl.value) {
                    target.value = ctrl.value;
                    target.dispatchEvent(new Event('change', { bubbles: true }));
                    changed = true;
                }
            } else {
                if (target.value !== ctrl.value) {
                    target.value = ctrl.value;
                    target.dispatchEvent(new Event('input', { bubbles: true }));
                    target.dispatchEvent(new Event('change', { bubbles: true }));
                    changed = true;
                }
            }
        });

        if (changed && window.$) {
            window.$(sourceEl).triggerHandler('change');
        }
        return changed;
    }

    let _wiSaveInFlight = null;
    
    async function _saveWorldEntryToServer(worldName, entry, sourceEl) {
        if (!worldName || !entry || entry.uid === undefined || entry.uid === null) return;

        if (_wiSaveInFlight) {
            try { await _wiSaveInFlight; } catch (e) { /* ignore */ }
        }

        const runSave = async () => {
            const uid = String(entry.uid);
            const lexSnap = _getLexSnapshot(worldName, entry);

            if (sourceEl) {
                const commentCtrl = sourceEl.querySelector('textarea[name="comment"], input[name="comment"]');
                if (commentCtrl) entry.comment = commentCtrl.value;

                const keyCtrl = sourceEl.querySelector('textarea[name="key"], input[name="key"], textarea[name="keys"], input[name="keys"]');
                if (keyCtrl) {
                    const keysArr = String(keyCtrl.value || '').split(',').map(s => s.trim()).filter(Boolean);
                    entry.key = keysArr;
                    entry.keys = keysArr;
                }

                const contentCtrl = sourceEl.querySelector('textarea[name="content"], textarea.world_entry_content');
                if (contentCtrl) entry.content = contentCtrl.value;
            }

            _applyLexSnapshot(worldName, entry, lexSnap);

            const ctx = getSTContext();
            const headers = (ctx && typeof ctx.getRequestHeaders === 'function')
                ? ctx.getRequestHeaders()
                : { 'Content-Type': 'application/json' };

            const getResp = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: worldName }),
                cache: 'no-store',
            });
            if (!getResp.ok) return;

            const wiData = await getResp.json();
            if (!wiData?.entries || !wiData.entries[uid]) return;

            const serverEntry = wiData.entries[uid];
            if (entry.comment !== undefined) serverEntry.comment = entry.comment;
            if (entry.key !== undefined) serverEntry.key = entry.key;
            if (entry.keys !== undefined) serverEntry.keys = entry.keys;
            if (entry.content !== undefined) serverEntry.content = entry.content;
            if (entry.position !== undefined) serverEntry.position = entry.position;
            if (entry.disable !== undefined) serverEntry.disable = entry.disable;
            if (entry.constant !== undefined) serverEntry.constant = entry.constant;
            if (entry.vectorized !== undefined) serverEntry.vectorized = entry.vectorized;

            const mergedLex = {
                ..._getLexSnapshot(worldName, serverEntry),
                ...lexSnap,
            };
            _applyLexSnapshot(worldName, serverEntry, mergedLex);

            const editResp = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    name: worldName,
                    data: { entries: wiData.entries },
                }),
            });

            if (editResp.ok) {
                window.LorebookExpansion?.clearWorldInfoEntriesCache?.(worldName);
            }
        };

        _wiSaveInFlight = runSave().finally(() => {
            _wiSaveInFlight = null;
        });
        return _wiSaveInFlight;
    }

async function _applyKeywordChangeToCellAndEntry(newKwRaw) {
        if (!currentModalCell || currentModalCell.classList.contains('stj-special-item')) return;
        const newKw = String(newKwRaw || '').trim();
        const oldKw = getCellKeyword(currentModalCell).trim();
        if (!newKw || newKw === oldKw) return;

        if (findDuplicateKeyword(currentModalCell, newKw)) {
            showKeywordDuplicateWarning(newKw);
            return;
        }

        const charName = document.getElementById('stj_char_name_display')?.textContent || detectCharacterNameFromDOM() || '';
        const worldName = getCharacterWorldInfoName();
        const entryHostEl = currentCellModal?.querySelector('#stj_cell_modal_entry_host');

        let targetEntry = entryHostEl?._targetEntry || null;
        if (!targetEntry && worldName) {
            const entries = await loadWorldInfoEntries(worldName);
            targetEntry = findEntryByKeyword(entries, oldKw) || findEntryByKeyword(entries, newKw);
        }

        const lexSnap = (worldName && targetEntry) ? _getLexSnapshot(worldName, targetEntry) : null;

        if (targetEntry) {
            targetEntry.comment = newKw;
            const curKeys = getEntryKeys(targetEntry);
            if (curKeys.length === 0 || (curKeys.length === 1 && String(curKeys[0]).trim() === oldKw)) {
                targetEntry.key = [newKw];
                targetEntry.keys = [newKw];
            }
            if (worldName && lexSnap) {
                _applyLexSnapshot(worldName, targetEntry, lexSnap);
            }
        }

        if (charName) {
            const curMap = getCurrentImageMapFromCharData(charName) || {};
            if (Object.prototype.hasOwnProperty.call(curMap, oldKw)) {
                const nextMap = {};
                for (const [k, v] of Object.entries(curMap)) {
                    if (k === oldKw) {
                        nextMap[newKw] = v;
                    } else if (!Object.prototype.hasOwnProperty.call(nextMap, k)) {
                        nextMap[k] = v;
                    }
                }
                saveImageMapToCharData(charName, nextMap);
            }
        }

        setCellKeyword(currentModalCell, newKw);
        modalOriginalKeyword = newKw;

        if (entryHostEl?._clonedEntryEl) {
            const cComment = entryHostEl._clonedEntryEl.querySelector('textarea[name="comment"], input[name="comment"]');
            if (cComment) cComment.value = newKw;
        }
        if (entryHostEl?._sourceEntryEl) {
            const sComment = entryHostEl._sourceEntryEl.querySelector('textarea[name="comment"], input[name="comment"]');
            if (sComment) {
                sComment.value = newKw;
                sComment.dispatchEvent(new Event('input', { bubbles: true }));
                sComment.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }

        if (worldName && targetEntry) {
            await _saveWorldEntryToServer(worldName, targetEntry, entryHostEl?._sourceEntryEl || null);
        }

        updateCellPreview(currentModalCell);
        autoSave({ immediate: true });
    }

    function _bindModalKeywordClickEdit(kwDisplayEl) {
        if (!kwDisplayEl || kwDisplayEl.dataset.kwClickBound === '1') return;
        kwDisplayEl.dataset.kwClickBound = '1';
        kwDisplayEl.style.cursor = 'pointer';
        kwDisplayEl.title = _t('stj.cell_modal.keyword_edit_hint', 'クリックしてキーワードを編集');

        kwDisplayEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!currentModalCell || currentModalCell.classList.contains('stj-special-item')) return;
            if (kwDisplayEl.querySelector('input.stj-modal-kw-editor')) return;

            const currentKw = getCellKeyword(currentModalCell) || kwDisplayEl.textContent || '';
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'stj-modal-kw-editor';
            input.value = currentKw;
            input.style.cssText =
                'width:100%;max-width:460px;padding:4px 10px;font-size:20px;font-weight:bold;' +
                'color:#fff;background:rgba(15,23,42,0.95);border:2px solid #60a5fa;' +
                'border-radius:6px;outline:none;box-sizing:border-box;';

            let done = false;
            const finish = async (save) => {
                if (done) return;
                done = true;
                const val = input.value;
                if (input.parentElement === kwDisplayEl) {
                    input.remove();
                }
                const latestKw = getCellKeyword(currentModalCell) || '';
                if (save) {
                    const trimmed = val.trim();
                    if (trimmed && !findDuplicateKeyword(currentModalCell, trimmed)) {
                        kwDisplayEl.textContent = trimmed;
                        await _applyKeywordChangeToCellAndEntry(trimmed);
                        return;
                    }
                }
                kwDisplayEl.textContent = latestKw;
            };

            input.addEventListener('click', (ev) => ev.stopPropagation());
            input.addEventListener('keydown', (ev) => {
                ev.stopPropagation();
                if (ev.key === 'Enter' && !ev.isComposing) {
                    ev.preventDefault();
                    finish(true);
                } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    finish(false);
                }
            });
            input.addEventListener('blur', () => finish(true));

            kwDisplayEl.textContent = '';
            kwDisplayEl.appendChild(input);
            input.focus();
            input.select();
        });
    }
    
    function applyEntrySnapshotToEl(el, snap) {
        if (!el || !snap) return;

        expandClonedEntryPanels(el);

        el.querySelectorAll('input, textarea, select').forEach((field, idx) => {
            const key = field.getAttribute('name') || `idx_${idx}`;
            const info = snap.fields.get(key);
            if (!info) return;

            if (info.type === 'check') {
                if (field.checked !== info.checked) {
                    field.checked = info.checked;
                }
            } else if (info.type === 'select') {
                const matchedOpt = Array.from(field.options || []).find(opt => opt.value === info.value);
                if (matchedOpt && field.value !== info.value) {
                    field.value = info.value;
                } else if (info.selectedIndex >= 0 && field.selectedIndex !== info.selectedIndex) {
                    field.selectedIndex = info.selectedIndex;
                }
            } else {
                if (field.value !== info.value) {
                    field.value = info.value;
                }
            }

            if (field.tagName === 'TEXTAREA' && snap.heights.has(key)) {
                const h = snap.heights.get(key);
                if (field.style.height !== h) {
                    field.style.height = h;
                }
            }
        });
    }
    
    function findMatchingSourceField(sourceEl, field, fallbackIndex) {
        if (!sourceEl || !field) return null;

        const name = field.getAttribute('name');
        if (name) {
            const byName = sourceEl.querySelector(`[name="${escapeCssAttrValue(name)}"]`);
            if (byName) return byName;
        }

        const dataField = field.getAttribute('data-field') || field.getAttribute('data-name') || field.getAttribute('data-key');
        if (dataField) {
            const byData = sourceEl.querySelector(`[data-field="${escapeCssAttrValue(dataField)}"], [data-name="${escapeCssAttrValue(dataField)}"], [data-key="${escapeCssAttrValue(dataField)}"]`);
            if (byData) return byData;
        }

        const clsList = (field.className || '').trim().split(/\s+/).filter(Boolean);
        const specificCls = clsList.find(c =>
            c.startsWith('lbe-') ||
            c.startsWith('world_entry') ||
            c.includes('prompt') ||
            c.includes('choice') ||
            c.includes('resolution') ||
            c.includes('width') ||
            c.includes('height')
        );
        if (specificCls) {
            const byCls = sourceEl.querySelector('.' + escapeCssAttrValue(specificCls));
            if (byCls) return byCls;
        }

        if (typeof fallbackIndex === 'number' && fallbackIndex >= 0) {
            const srcFields = sourceEl.querySelectorAll('input, textarea, select');
            if (srcFields[fallbackIndex] && srcFields[fallbackIndex].tagName === field.tagName) {
                return srcFields[fallbackIndex];
            }
        }

        return null;
    }

    function getLorebookExpansionExt(entry) {
        if (!entry || typeof entry !== 'object') return null;
        if (!entry.extensions || typeof entry.extensions !== 'object') {
            entry.extensions = {};
        }
        if (!entry.extensions.lorebook_expansion || typeof entry.extensions.lorebook_expansion !== 'object') {
            entry.extensions.lorebook_expansion = {};
        }
        return entry.extensions.lorebook_expansion;
    }

    function snapshotLorebookExpansionPayload(worldName, entry) {
        const uid = entry?.uid;
        let fromApi = null;
        try {
            if (window.LorebookExpansion?.getDataFor && worldName && uid !== undefined && uid !== null) {
                fromApi = window.LorebookExpansion.getDataFor(worldName, uid, entry);
            }
        } catch (e) { /* ignore */ }

        const rawExt = entry?.extensions?.lorebook_expansion || {};
        const merged = {
            ...JSON.parse(JSON.stringify(rawExt || {})),
            ...(fromApi && typeof fromApi === 'object' ? JSON.parse(JSON.stringify(fromApi)) : {}),
        };
        if (typeof merged.img_prompt !== 'string') merged.img_prompt = '';
        if (!Array.isArray(merged.choices)) merged.choices = [];
        return merged;
    }

    function restoreLorebookExpansionPayload(worldName, entry, payload) {
        if (!entry || !payload || typeof payload !== 'object') return;
        const clonedPayload = JSON.parse(JSON.stringify(payload));
        const ext = getLorebookExpansionExt(entry);
        for (const [k, v] of Object.entries(clonedPayload)) {
            ext[k] = v;
        }
        try {
            if (window.LorebookExpansion?.setDataFor && worldName && entry.uid !== undefined && entry.uid !== null) {
                window.LorebookExpansion.setDataFor(worldName, entry.uid, clonedPayload, entry);
            } else if (window.LorebookExpansion?.saveDataFor && worldName && entry.uid !== undefined && entry.uid !== null) {
                window.LorebookExpansion.saveDataFor(worldName, entry.uid, clonedPayload, entry);
            }
        } catch (e) { /* ignore */ }
    }

    async function persistWorldInfoEntryChanges(worldName, targetEntry, sourceEl) {
        if (!worldName || !targetEntry) return;

        const uid = targetEntry.uid;
        if (uid === undefined || uid === null) return;

        // 最新のプロンプト・選択肢・フィールド値を保持
        const preservedLex = snapshotLorebookExpansionPayload(worldName, targetEntry);

        if (sourceEl) {
            const commentField = sourceEl.querySelector('textarea[name="comment"], input[name="comment"]');
            if (commentField && typeof commentField.value === 'string') {
                targetEntry.comment = commentField.value;
            }
            const keyField = sourceEl.querySelector('textarea[name="key"], input[name="key"], textarea[name="keys"], input[name="keys"]');
            if (keyField && typeof keyField.value === 'string') {
                const parsedKeys = keyField.value.split(',').map(s => s.trim()).filter(Boolean);
                targetEntry.key = parsedKeys;
                targetEntry.keys = parsedKeys;
            }
            const contentField = sourceEl.querySelector('textarea[name="content"], textarea.world_entry_content');
            if (contentField && typeof contentField.value === 'string') {
                targetEntry.content = contentField.value;
            }
            const posSelect = sourceEl.querySelector('select[name="position"]');
            if (posSelect) {
                const numPos = Number(posSelect.value);
                targetEntry.position = Number.isNaN(numPos) ? posSelect.value : numPos;
            }
            const stateSelect = sourceEl.querySelector('select[name="entryStateSelector"]');
            if (stateSelect) {
                targetEntry.entryStateSelector = stateSelect.value;
            }
        }

        restoreLorebookExpansionPayload(worldName, targetEntry, preservedLex);

        try {
            window.LorebookExpansion?.clearWorldInfoEntriesCache?.(worldName);
        } catch (e) { /* ignore */ }

        try {
            const ctx = getSTContext();
            const headers = (ctx && typeof ctx.getRequestHeaders === 'function')
                ? ctx.getRequestHeaders()
                : { 'Content-Type': 'application/json' };

            const resp = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: worldName }),
                cache: 'no-store',
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data && data.entries && data.entries[uid]) {
                    const serverEntry = data.entries[uid];
                    if (targetEntry.comment !== undefined) serverEntry.comment = targetEntry.comment;
                    if (targetEntry.key !== undefined) serverEntry.key = targetEntry.key;
                    if (targetEntry.keys !== undefined) serverEntry.keys = targetEntry.keys;
                    if (targetEntry.content !== undefined) serverEntry.content = targetEntry.content;
                    if (targetEntry.position !== undefined) serverEntry.position = targetEntry.position;
                    if (targetEntry.entryStateSelector !== undefined) serverEntry.entryStateSelector = targetEntry.entryStateSelector;

                    const serverLex = snapshotLorebookExpansionPayload(worldName, serverEntry);
                    const finalLex = {
                        ...serverLex,
                        ...preservedLex,
                        img_prompt: preservedLex.img_prompt || serverLex.img_prompt || '',
                        choices: (Array.isArray(preservedLex.choices) && preservedLex.choices.length > 0)
                            ? preservedLex.choices
                            : (serverLex.choices || []),
                    };
                    restoreLorebookExpansionPayload(worldName, serverEntry, finalLex);

                    await fetch('/api/worldinfo/edit', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            name: worldName,
                            entries: data.entries,
                        }),
                    });
                }
            }
        } catch (e) {
            console.warn('[STJ Editor] WorldInfo 保存エラー:', e);
        }

        try {
            if (window.LorebookExpansion?.forceInject) {
                await window.LorebookExpansion.forceInject();
            }
        } catch (e) { /* ignore */ }
    }
    
    function syncClonedEntryToSource(clonedEl, sourceEl, isSyncingRef, worldName, targetEntry) {
        if (!clonedEl || !sourceEl) return;
        if (isSyncingRef && isSyncingRef.active) return;

        isSyncingRef.active = true;
        let changed = false;

        try {
            const fields = Array.from(clonedEl.querySelectorAll('input, textarea, select'));
            fields.forEach((field, idx) => {
                const target = findMatchingSourceField(sourceEl, field, idx);
                if (!target) return;

                if (field.type === 'checkbox' || field.type === 'radio') {
                    if (target.checked !== field.checked) {
                        target.checked = field.checked;
                        target.dispatchEvent(new Event('change', { bubbles: true }));
                        changed = true;
                    }
                } else if (field.tagName === 'SELECT') {
                    if (target.value !== field.value || target.selectedIndex !== field.selectedIndex) {
                        target.value = field.value;
                        if (target.value !== field.value && field.selectedIndex >= 0) {
                            target.selectedIndex = field.selectedIndex;
                        }
                        target.dispatchEvent(new Event('change', { bubbles: true }));
                        changed = true;
                    }
                } else {
                    if (target.value !== field.value) {
                        target.value = field.value;
                        target.dispatchEvent(new Event('input', { bubbles: true }));
                        target.dispatchEvent(new Event('change', { bubbles: true }));
                        changed = true;
                    }
                }
            });

            if (changed) {
                if (window.$) {
                    window.$(sourceEl).triggerHandler('change');
                }
                if (worldName && targetEntry) {
                    const lexData = snapshotLorebookExpansionPayload(worldName, targetEntry);
                    clonedEl.querySelectorAll('input, textarea, select').forEach((f) => {
                        const n = (f.getAttribute('name') || f.dataset.field || f.className || '').toLowerCase();
                        if (n.includes('prompt')) lexData.img_prompt = f.value;
                    });
                    restoreLorebookExpansionPayload(worldName, targetEntry, lexData);
                }
            }
        } finally {
            setTimeout(() => {
                isSyncingRef.active = false;
            }, 20);
        }
    }

    async function mountWorldEntryInCellModal(cell) {
        const modal = currentCellModal;
        if (!modal || !cell) return;
        const hostEl = modal.querySelector('#stj_cell_modal_entry_host');
        if (!hostEl) return;

        hostEl.innerHTML = '';
        hostEl.style.display = 'none';
        delete hostEl._sourceEntryEl;
        delete hostEl._clonedEntryEl;
        delete hostEl._targetEntry;
        delete hostEl._worldName;
        delete hostEl._flushSave;

        if (cell.classList.contains('stj-special-item')) return;
        const kw = getCellKeyword(cell).trim();
        if (!kw) return;

        const worldName = getCharacterWorldInfoName();
        if (!worldName) return;

        let entries = null;
        try {
            entries = await loadWorldInfoEntries(worldName);
        } catch (e) { return; }

        if (currentCellModal !== modal || currentModalCell !== cell) return;
        if (!entries) return;

        const targetEntry = findEntryByKeyword(entries, kw);
        if (!targetEntry) return;

        const sourceEl = findSourceWorldEntryEl(entries, targetEntry, kw);
        if (!sourceEl) return;

        await ensureSourceEntryExpanded(sourceEl);
        if (currentCellModal !== modal || currentModalCell !== cell) return;

        const cloned = sourceEl.cloneNode(true);
        cloned.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
        expandClonedEntryPanels(cloned);
        collapseLbeExtrasPanel(cloned);

        let saveTimer = null;
        const syncAndSchedule = () => {
            _syncClonedEntryToTarget(cloned, sourceEl, worldName, targetEntry);
            if (saveTimer) clearTimeout(saveTimer);
            saveTimer = setTimeout(() => {
                saveTimer = null;
                _persistEntryNow(worldName, targetEntry, sourceEl, cloned);
            }, 150);
        };

        const flushSave = async () => {
            if (saveTimer) {
                clearTimeout(saveTimer);
                saveTimer = null;
            }
            await _persistEntryNow(worldName, targetEntry, sourceEl, cloned);
        };

        cloned.addEventListener('input', syncAndSchedule);
        cloned.addEventListener('change', syncAndSchedule);
        cloned.addEventListener('click', (e) => {
            if (e.target.closest('button, input, select, textarea, .lbe-extras-toggle')) {
                setTimeout(syncAndSchedule, 15);
            }
        });

        hostEl._sourceEntryEl = sourceEl;
        hostEl._clonedEntryEl = cloned;
        hostEl._targetEntry = targetEntry;
        hostEl._worldName = worldName;
        hostEl._flushSave = flushSave;
        hostEl.appendChild(cloned);
        hostEl.style.display = 'block';
        hostEl.style.height = '35%';
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

// --- 選択肢の正規化ヘルパー (stj_editor.js用) ---
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
                    _stjScheduleTreeLayout();  // ★ 追加
                } else if (s.currentTarget && s.currentTarget !== s.sourceItem) {
                    swapCells(s.sourceItem, s.currentTarget);
                    runLiveTest();
                    autoSave({ immediate: true });
                    _stjScheduleTreeLayout();  // ★ 追加
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
            container.innerHTML = '';
            addKeywordRowWithData(container, 0, { keyword: '', images: [] });
        }

        const testInput = document.getElementById('stj_test_input');
        if (testInput) testInput.value = '';

        runLiveTest();
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
        stjModalEl.style.display = 'none'; // ← ここで非表示にしているか確認
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
                </div>
                <div class="stj-cell-modal-entry-host" id="stj_cell_modal_entry_host" style="display: block; height: 35%;"></div>
                <div class="stj-cell-modal-grid"></div>
            </div>
        `;

        if (!document.getElementById('stj-cell-keyword-style')) {
            const s = document.createElement('style');
            s.id = 'stj-cell-keyword-style';
            s.textContent = `
                #stj_cell_modal .stj-cell-modal-content {
                    display: flex !important;
                    flex-direction: column !important;
                    width: calc(var(--stj-cell-modal-base-w, 720px) * 1.35) !important;
                    max-width: 96vw !important;
                    height: calc(var(--stj-cell-modal-base-h, 80vh) * 1.15) !important;
                    max-height: 96vh !important;
                    overflow: hidden;
                }
                #stj_cell_modal .stj-cell-modal-header {
                    display: flex !important;
                    flex-direction: row !important;
                    flex-wrap: nowrap !important;
                    align-items: center !important;
                    gap: 8px;
                    width: 100%;
                    flex-shrink: 0;
                }
                #stj_cell_modal .stj-cell-modal-entry-host {
                    display: block !important;
                    width: 100%;
                    height: 35% !important;
                    min-height: 0;
                    overflow-y: auto;
                    margin: 6px 0 10px;
                    padding: 8px;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 6px;
                    background: rgba(0, 0, 0, 0.25);
                    box-sizing: border-box;
                    flex: 0 0 35% !important;
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
                    font-size: 28px;
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
        modalOriginalKeyword = getCellKeyword(cell); // キーワード保持のみ（表示・編集はしない）

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
            if (entryHostEl._guardObserver) {
                try { entryHostEl._guardObserver.disconnect(); } catch (e) { /* ignore */ }
            }
            entryHostEl.innerHTML = '';
            entryHostEl.style.display = 'block';
            entryHostEl.style.height = '35%';
            delete entryHostEl._sourceEntryEl;
            delete entryHostEl._clonedEntryEl;
            delete entryHostEl._syncEntry;
            delete entryHostEl._guardObserver;
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

    async function commitModalKeywordEdit(newKwRaw) {
        if (!currentModalCell || currentModalCell.classList.contains('stj-special-item')) return;

        const newKw = String(newKwRaw || '').trim();
        const oldKw = getCellKeyword(currentModalCell).trim();
        if (!newKw || newKw === oldKw) return;

        const dup = findDuplicateKeyword(currentModalCell, newKw);
        if (dup) {
            showKeywordDuplicateWarning(newKw);
            return;
        }

        const charName = document.getElementById('stj_char_name_display')?.textContent || detectCharacterNameFromDOM() || '';
        const worldName = getCharacterWorldInfoName();

        let targetEntry = null;
        let preservedLex = null;
        if (worldName) {
            try {
                const entries = await loadWorldInfoEntries(worldName);
                targetEntry = findEntryByKeyword(entries, oldKw) || findEntryByKeyword(entries, newKw);
                if (targetEntry) {
                    preservedLex = snapshotLorebookExpansionPayload(worldName, targetEntry);
                    targetEntry.comment = newKw;
                    const existingKeys = getEntryKeys(targetEntry);
                    if (existingKeys.length === 0 || (existingKeys.length === 1 && existingKeys[0] === oldKw)) {
                        targetEntry.key = [newKw];
                        targetEntry.keys = [newKw];
                    }
                    restoreLorebookExpansionPayload(worldName, targetEntry, preservedLex);
                }
            } catch (e) {
                console.warn('[STJ Editor] キーワード反映前のロアブック取得エラー:', e);
            }
        }

        if (charName) {
            const currentMap = getCurrentImageMapFromCharData(charName) || {};
            if (Object.prototype.hasOwnProperty.call(currentMap, oldKw)) {
                const updatedMap = {};
                for (const [k, v] of Object.entries(currentMap)) {
                    if (k === oldKw) {
                        updatedMap[newKw] = v;
                    } else if (!Object.prototype.hasOwnProperty.call(updatedMap, k)) {
                        updatedMap[k] = v;
                    }
                }
                saveImageMapToCharData(charName, updatedMap);
            }
        }

        setCellKeyword(currentModalCell, newKw);
        modalOriginalKeyword = newKw;

        const entryHostEl = currentCellModal?.querySelector('#stj_cell_modal_entry_host');
        if (entryHostEl?._clonedEntryEl) {
            const clonedComment = entryHostEl._clonedEntryEl.querySelector('textarea[name="comment"], input[name="comment"]');
            if (clonedComment) clonedComment.value = newKw;
        }
        if (entryHostEl?._sourceEntryEl) {
            const srcComment = entryHostEl._sourceEntryEl.querySelector('textarea[name="comment"], input[name="comment"]');
            if (srcComment) {
                srcComment.value = newKw;
                srcComment.dispatchEvent(new Event('input', { bubbles: true }));
                srcComment.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }

        if (worldName && targetEntry) {
            if (preservedLex) {
                restoreLorebookExpansionPayload(worldName, targetEntry, preservedLex);
            }
            await persistWorldInfoEntryChanges(worldName, targetEntry, entryHostEl?._sourceEntryEl || null);
        }

        runLiveTest();
        autoSave({ immediate: true });
        _stjScheduleTreeLayout();
    }

    function attachKeywordDisplayEditor(modal, kwDisplayEl) {
        if (!modal || !kwDisplayEl || kwDisplayEl.dataset.editableReady === '1') return;
        kwDisplayEl.dataset.editableReady = '1';
        kwDisplayEl.style.cursor = 'text';
        kwDisplayEl.title = _t('stj.cell_modal.keyword_edit_hint', 'クリックしてキーワードを編集');

        kwDisplayEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!currentModalCell || currentModalCell.classList.contains('stj-special-item')) return;
            if (kwDisplayEl.querySelector('input.stj-keyword-inline-input')) return;

            const currentVal = getCellKeyword(currentModalCell) || kwDisplayEl.textContent || '';
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'stj-keyword-inline-input';
            input.value = currentVal;
            input.style.cssText = [
                'width: 100%',
                'max-width: 480px',
                'padding: 4px 10px',
                'font-size: 20px',
                'font-weight: bold',
                'color: #fff',
                'background: rgba(15, 23, 42, 0.92)',
                'border: 2px solid #60a5fa',
                'border-radius: 6px',
                'outline: none',
                'box-sizing: border-box',
            ].join(';');

            let committed = false;
            const finishEdit = async (shouldSave) => {
                if (committed) return;
                committed = true;
                const val = input.value;
                input.remove();
                if (shouldSave) {
                    const trimmed = val.trim();
                    if (trimmed && !findDuplicateKeyword(currentModalCell, trimmed)) {
                        kwDisplayEl.textContent = trimmed;
                        await commitModalKeywordEdit(trimmed);
                    } else {
                        kwDisplayEl.textContent = getCellKeyword(currentModalCell) || '';
                    }
                } else {
                    kwDisplayEl.textContent = getCellKeyword(currentModalCell) || '';
                }
            };

            input.addEventListener('click', (ev) => ev.stopPropagation());
            input.addEventListener('keydown', (ev) => {
                ev.stopPropagation();
                if (ev.key === 'Enter' && !ev.isComposing) {
                    ev.preventDefault();
                    finishEdit(true);
                } else if (ev.key === 'Escape') {
                    ev.preventDefault();
                    finishEdit(false);
                }
            });
            input.addEventListener('blur', () => finishEdit(true));

            kwDisplayEl.textContent = '';
            kwDisplayEl.appendChild(input);
            input.focus();
            input.select();
        });
    }

    function doApplyCellModal() {
        if (!currentCellModal || !currentModalCell) return;
        const cell = currentModalCell;

        const kwDisplayEl = currentCellModal.querySelector('#stj_cell_modal_keyword_display');
        const inlineInput = kwDisplayEl?.querySelector('input.stj-kw-inline-edit');
        const pendingKw = inlineInput ? inlineInput.value.trim() : '';

        const entryHostEl = currentCellModal.querySelector('#stj_cell_modal_entry_host');
        const flushFn = entryHostEl?._flushSave;

        if (entryHostEl) {
            if (entryHostEl._guardObserver) {
                try { entryHostEl._guardObserver.disconnect(); } catch (e) { /* ignore */ }
            }
            if (typeof flushFn === 'function') {
                flushFn();
            }
            entryHostEl.innerHTML = '';
            entryHostEl.style.display = 'block';
            entryHostEl.style.height = '35%';
            delete entryHostEl._sourceEntryEl;
            delete entryHostEl._clonedEntryEl;
            delete entryHostEl._targetEntry;
            delete entryHostEl._worldName;
            delete entryHostEl._flushSave;
            delete entryHostEl._guardObserver;
        }

        if (pendingKw && !cell.classList.contains('stj-special-item')) {
            _commitKeywordEdit(pendingKw);
        }

        updateCellPreview(cell);
        autoSave({ immediate: true });

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

    // ============================================================
    // セル個別のリスナー（❌ボタン関連コードを削除）
    // ============================================================
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
        } else {
            let hasEmptyExt = false;
            try {
                const ctx = getSTContext();
                const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
                if (char?.name === charName) {
                    const ext = char?.data?.extensions?.image_display_extension;
                    hasEmptyExt = ext !== undefined && typeof ext === 'object';
                }
            } catch (e) { /* ignore */ }
        }

        return hasCharData;
    }

    // ============================================================
    // ★ 選択肢分岐ツリーレイアウト
    //   - imageMap の各キー(=エントリ)について LEX の choices を読み、
    //     選択肢番号→対応エントリキー の有向グラフを構築
    //   - 左→右のツリーとして絶対座標を算出（親は子の中央）
    //   - 単独セル（親なし・子なし）は左端に縦積み
    //   - 接続線は SVG の elbow パスで描画
    // ============================================================
    const STJ_TREE_CELL_W = 140;
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

    function _stjExtractChoiceNumber(text) {
        if (!text || typeof text !== 'string') return null;
        // ★ 全角数字を半角化してから抽出（LorebookExpansion 側は全角非対応）
        const normalized = _stjToHalfWidth(text);
        if (window.LorebookExpansion?.extractChoiceNumber) {
            return window.LorebookExpansion.extractChoiceNumber(normalized);
        }
        const pats = [
            /選択肢[「『"']?(\d{1,4})[」』"']?/,
            /choice[^\d]{0,3}(\d{1,4})/i,
            /(?:^|\s)(\d{3,4})(?:\s|$|[\u3000。.,])/,
            /(\d{3})/,
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
        let partial = null;
        for (const entry of list) {
            if (!entry) continue;
            for (const key of getEntryKeys(entry)) {
                const k = String(key).trim();
                if (k === choiceNum) return entry;
                if (!partial && (k.startsWith(choiceNum) || k.includes(choiceNum))) {
                    partial = entry;
                }
            }
        }
        return partial;
    }

    function _stjFindEntryByKeywordLoose(list, choiceStr) {
        if (!Array.isArray(list) || !choiceStr) return null;
        const raw = String(choiceStr).trim();
        if (!raw) return null;

        // 全角/半角の相互バリアント
        const variants = new Set([raw]);
        variants.add(_stjToHalfWidth(raw));
        variants.add(_stjToFullWidth(raw));

        // 接頭辞除去バリアント（選択肢 / choice / 先頭番号）
        const base = [...variants];
        for (const v of base) {
            const s1 = v.replace(/^選択肢[「『"']?/, '').replace(/[」』"']$/, '').trim();
            if (s1 && s1 !== v) variants.add(s1);
            const s2 = v.replace(/^choice[:\s]*/i, '').trim();
            if (s2 && s2 !== v) variants.add(s2);
            const s3 = v.replace(/^[０-９\d]{1,4}[:：\s]*/, '').trim();
            if (s3 && s3 !== v) variants.add(s3);
        }

        const lowerVariants = new Set([...variants].map(v => v.toLowerCase()));

        // キーワード長の降順（長い＝具体的なキーワード優先）で評価
        const entriesWithKw = [];
        for (const e of list) {
            const kw = getEntryKeyword(e);
            if (kw) entriesWithKw.push({ entry: e, kw });
        }
        entriesWithKw.sort((a, b) => b.kw.length - a.kw.length);

        // 1. 完全一致（大文字小文字区別）
        for (const { entry, kw } of entriesWithKw) {
            if (variants.has(kw)) return entry;
        }
        // 1b. 完全一致（大文字小文字無視）
        for (const { entry, kw } of entriesWithKw) {
            if (lowerVariants.has(kw.toLowerCase())) return entry;
        }
        // 2. 選択肢がキーワードで始まる
        for (const { entry, kw } of entriesWithKw) {
            for (const v of variants) {
                if (v.startsWith(kw)) return entry;
            }
        }
        for (const { entry, kw } of entriesWithKw) {
            const kwL = kw.toLowerCase();
            for (const v of variants) {
                if (v.toLowerCase().startsWith(kwL)) return entry;
            }
        }
        // 3. 選択肢にキーワードが含まれる（2文字以上のキーワードのみ・誤爆防止）
        for (const { entry, kw } of entriesWithKw) {
            if (kw.length < 2) continue;
            for (const v of variants) {
                if (v.includes(kw)) return entry;
            }
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
                // ① 数字抽出で試す（既存動作を保持）
                let target = null;
                const num = _stjExtractChoiceNumber(choiceStr);
                if (num) {
                    target = _stjFindEntryByChoice(list, num);
                }
                // ② 数字で見つからない、または数字が抽出できない場合、
                //    選択肢文字列を直接キーワードとしてマッチ（非数値キー対応）
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
        const svgW = maxX + STJ_TREE_PADDING * 2;
        const svgH = maxY + STJ_TREE_PADDING * 2;

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

                const x1 = parentPos.x + STJ_TREE_CELL_W;
                const y1 = parentPos.y + STJ_TREE_CELL_H / 2;
                const x2 = childPos.x;
                const y2 = childPos.y + STJ_TREE_CELL_H / 2;
                const midX = x1 + (x2 - x1) / 2;

                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d',
                    `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`);
                path.setAttribute('stroke', '#4a90e2');
                path.setAttribute('stroke-width', '2');
                path.setAttribute('fill', 'none');
                path.setAttribute('stroke-linejoin', 'round');
                svg.appendChild(path);

                const sz = 7;
                const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                arrow.setAttribute('points',
                    `${x2},${y2} ${x2 - sz},${y2 - sz / 1.5} ${x2 - sz},${y2 + sz / 1.5}`);
                arrow.setAttribute('fill', '#4a90e2');
                svg.appendChild(arrow);
            }
        }

        container.insertBefore(svg, container.firstChild);
    }

    let _stjTreeLayoutInFlight = false;
    let _stjTreeLayoutPending = false;

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

            const startCharName = document.getElementById('stj_char_name_display')?.textContent;
            if (!startCharName) return;

            const imageMap = {};
            container.querySelectorAll(':scope > .stj-keyword-item').forEach(cell => {
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
                return;
            }

            const graph = await _stjBuildChoiceGraph(imageMap);

            const endCharName = document.getElementById('stj_char_name_display')?.textContent;
            if (endCharName !== startCharName) return;
            if (!document.body.contains(container)) return;

            const { positions, children } = _stjComputeTreeLayout(graph);

            let maxX = 0, maxY = 0, minX = 0, minY = 0;
            for (const pos of positions.values()) {
                maxX = Math.max(maxX, pos.x + STJ_TREE_CELL_W);
                maxY = Math.max(maxY, pos.y + STJ_TREE_CELL_H);
                minX = Math.min(minX, pos.x);
                minY = Math.min(minY, pos.y);
            }
            const offsetX = STJ_TREE_PADDING - minX;
            const offsetY = STJ_TREE_PADDING - minY;

            const unpositioned = [];
            container.querySelectorAll(':scope > .stj-keyword-item').forEach(cell => {
                const kw = getCellKeyword(cell).trim();
                const pos = kw ? positions.get(kw) : null;
                if (pos) {
                    cell.style.position = 'absolute';
                    cell.style.left = (pos.x + offsetX) + 'px';
                    cell.style.top = (pos.y + offsetY) + 'px';
                    cell.style.width = STJ_TREE_CELL_W + 'px';
                    cell.style.height = STJ_TREE_CELL_H + 'px';
                } else {
                    unpositioned.push(cell);
                }
            });

            let totalHeight = maxY - minY + STJ_TREE_PADDING * 2;
            if (unpositioned.length > 0) {
                let unposY = totalHeight;
                for (const cell of unpositioned) {
                    cell.style.position = 'absolute';
                    cell.style.left = STJ_TREE_PADDING + 'px';
                    cell.style.top = unposY + 'px';
                    cell.style.width = STJ_TREE_CELL_W + 'px';
                    cell.style.height = STJ_TREE_CELL_H + 'px';
                    unposY += STJ_TREE_CELL_H + STJ_TREE_V_GAP;
                }
                totalHeight = unposY;
            }

            container.classList.add('stj-tree-mode');
            container.style.minWidth = (maxX - minX + STJ_TREE_PADDING * 2) + 'px';
            container.style.minHeight = totalHeight + 'px';

            const offsetPositions = new Map();
            for (const [kw, pos] of positions) {
                offsetPositions.set(kw, { x: pos.x + offsetX, y: pos.y + offsetY });
            }
            _stjDrawConnections(container, offsetPositions, children);
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

// ロアブックの正しい並び順を完全に維持してJSON編集画面のセルを構築・同期する関数
function populateFormFromImageMap(imageMap, preserveOrder = false) {
    const toFileNames = (val) => {
        if (val === null || val === undefined) return [];
        const arr = Array.isArray(val) ? val : [val];
        return arr
            .filter(p => p !== null && p !== undefined)
            .map(p => extractFileNameFromPath(p))
            .filter(Boolean);
    };

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

    // 現在 imageMap に存在する有効なキーワードのリスト（＝ロアブックの現在の正しい並び順）
    const activeKeys = Object.keys(imageMap).filter(k => k !== 'default' && k !== 'thumbnail');

    if (preserveOrder) {
        const existingItems = Array.from(container.querySelectorAll('.stj-keyword-item'));
        const itemMapByKeyword = new Map();

        // 既存のDOM要素を現在のキーワード名でマップ化
        existingItems.forEach(item => {
            const kw = getCellKeyword(item);
            if (kw) {
                itemMapByKeyword.set(kw, item);
            }
        });

        // 変更されたキー（改名等）の追従：マップにないDOM要素があれば、まだ使われていない古いDOMをそれに割り当てる
        const unmatchedItems = existingItems.filter(item => !activeKeys.includes(getCellKeyword(item)));

        // ロアブックの正しい並び順（activeKeys）に従ってDOM要素を並べ替えながら更新する
        activeKeys.forEach((key, index) => {
            let item = itemMapByKeyword.get(key);

            // もし完全一致するDOMがなく、使い回せる未マッチのDOMがあればそれをリネームして再利用（位置を維持）
            if (!item && unmatchedItems.length > 0) {
                item = unmatchedItems.shift();
                setCellKeyword(item, key);
            }

            if (item) {
                // データを更新
                const files = toFileNames(imageMap[key]);
                setCellImages(item, files);
                updateCellPreview(item);

                // 正しい順番（ロアブックのインデックス順）にDOMをコンテナ内で移動させる
                container.appendChild(item);
            } else {
                // 完全に新規のキーの場合は新しく行を追加
                addKeywordRowWithData(container, index, { keyword: key, images: toFileNames(imageMap[key]) });
            }
        });

        // ロアブックから削除された古いDOM要素をすべて削除
        unmatchedItems.forEach(item => item.remove());

        // セルが1つも無くなった場合のフォールバック
        if (container.querySelectorAll('.stj-keyword-item').length === 0) {
            addKeywordRowWithData(container, 0, { keyword: '', images: [] });
        }
    } else {
        // 初期ロード時など
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
    // ★ 追加: 選択肢分岐のツリーレイアウトを適用
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

    function addKeywordRowWithData(container, index, data) {
        const newItem = document.createElement('div');
        newItem.className = 'stj-keyword-item';
        const images = data.images || [];
        newItem.setAttribute('data-image-list', JSON.stringify(images));
        newItem.setAttribute('data-keyword', data.keyword || '');
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
            <div id="stj_test_section">
                <button type="button" id="stj_test_toggle" class="stj-test-toggle">${_t('stj.header.title', '🔍 リアルタイムキーワード反応テスト')} ▼</button>
                <div id="stj_test_body" style="display: none;">
                    <div class="stj-test-header">
                        <strong id="stj_char_name_display"></strong>
                        <button type="button" class="stj-help-btn" id="stj_help_button">${_t('stj.header.help', 'ヘルプ')}</button>
                    </div>
                    <div class="stj-syntax-guide" id="stj_syntax_guide">${buildSyntaxGuideHtml()}</div>
                    <textarea id="stj_test_input" placeholder="${_t('stj.header.test_placeholder', '試しに文章を入力してください（例：笑顔で挨拶する）...')}"></textarea>
                    <div id="stj_test_result">${_t('stj.test.result_prefix', '判定結果')}: <span style="color: #aaa; font-weight: normal;">${_t('stj.test.empty_hint', '文章を入力するとヒットするキーワードが表示されます')}</span></div>
                </div>
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
                    <button id="stj_add_keyword" title="${_t('stj.button.update_title', 'ロアブックのエントリと同期してセルを自動作成します（自動削除はしません）')}">${_t('stj.button.update', '更新')}</button>
                </div>
            </div>
        `;

        // ★ スクロール追従停止 + トグルボタン用CSS
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
                #stj_export_modal #stj_test_toggle {
                    display: block;
                    width: 100%;
                    padding: 8px 12px;
                    margin: 0 0 6px 0;
                    background: #2c5282;
                    color: #fff;
                    border: 1px solid #4299e1;
                    border-radius: 4px;
                    font-size: 14px;
                    font-weight: bold;
                    cursor: pointer;
                    text-align: left;
                    box-sizing: border-box;
                }
                #stj_export_modal #stj_test_toggle:hover {
                    background: #4299e1;
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

        const addBtn = document.getElementById('stj_add_keyword');
        if (addBtn) addBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (isDialogActive) return;

            try {
                autoSave({ immediate: true });
                const added = await syncLorebookEntriesToImageMap();

                const showToast = window.GicApi?.showBottomToast;
                if (added > 0) {
                    if (typeof showToast === 'function') {
                        showToast(_t('stj.toast.sync_added', `ロアブックと同期しました（${added} 件追加）`, { count: added }));
                    }
                } else {
                    if (typeof showToast === 'function') {
                        showToast(_t('stj.toast.sync_no_add', '同期する新規セルはありませんでした'), { type: 'warning' });
                    }
                }

                if (stjModalEl && stjModalEl.style.display === 'block') {
                    const charName = detectCharacterNameFromDOM();
                    if (charName) {
                        const currentMap = getCurrentImageMapFromCharData(charName);
                        if (currentMap) populateFormFromImageMap(currentMap);
                    }
                    runLiveTest();
                }
            } catch (err) {
                console.warn('[STJ Editor] 同期エラー:', err);
                const showToast = window.GicApi?.showBottomToast;
                if (typeof showToast === 'function') {
                    showToast(_t('stj.toast.sync_failed', '同期に失敗しました'), { type: 'error' });
                }
            }
        });

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

            let affectedCells = 0;
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
                    affectedCells++;

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

function _getBagStateFilesForKeyword(charName, keyword) {
    try {
        const ctx = getSTContext();
        const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
        if (!char || char.name !== charName) return [];
        const bagState = char?.data?.extensions?.image_display_bag_state;
        if (!bagState || typeof bagState !== 'object') return [];
        const state = bagState[`kw::${keyword}`];
        if (!state?.flags) return [];
        return Object.keys(state.flags).filter(p => typeof p === 'string' && p);
    } catch (e) { return []; }
}

function getEntryKeyword(entry) {
    if (!entry) return '';
    const comment = (typeof entry.comment === 'string' ? entry.comment.trim() : '');
    if (comment && !isCommonRuleName(comment)) return comment;
    const keys = getEntryKeys(entry);
    if (keys.length > 0 && String(keys[0]).trim()) return String(keys[0]).trim();
    return '';
}

function getStjCharSettings(charName) {
    const settings = getExtensionSettings();
    if (!settings[charName]) settings[charName] = {};
    if (!settings[charName].uidMap) settings[charName].uidMap = {};
    return settings[charName];
}

async function syncLorebookEntriesToImageMap() {
    const charName = detectCharacterNameFromDOM();
    if (!charName) {
        return 0;
    }

    const worldName = getCharacterWorldInfoName();
    if (!worldName) {
        return 0;
    }

    try {
        window.LorebookExpansion?.clearWorldInfoEntriesCache?.(worldName);
    } catch (err) { /* ignore */ }

    const entries = await loadWorldInfoEntries(worldName);
    if (!entries) return 0;

    const list = Array.isArray(entries) ? entries : Object.values(entries);
    let imageMap = getCurrentImageMapFromCharData(charName);
    if (!imageMap) imageMap = {};

    const activeKeywords = new Set();
    for (const entry of list) {
        if (!entry) continue;
        const kw = getEntryKeyword(entry);
        if (!kw || isCommonRuleName(kw)) continue;
        activeKeywords.add(kw);
    }

    let hasEmptyKeys = Object.entries(imageMap).some(
        ([k, v]) => !UNREGISTER_EXCLUDED_KEYS.has(k) && _isEmptyImageValue(v)
    );
    let restoreData = {};
    if (hasEmptyKeys) {
        restoreData = await _restoreImageMapUnified(charName);
    }

// --- 1. 確実な改名（リネーム）検出と、元の位置を維持したキーのインプレース置換 ---
    const existingImageKeys = Object.keys(imageMap).filter(k => !UNREGISTER_EXCLUDED_KEYS.has(k));
    const missingKeys = existingImageKeys.filter(k => !activeKeywords.has(k));
    const newKeywords = [...activeKeywords].filter(k => imageMap[k] === undefined);

    if (missingKeys.length > 0 && newKeywords.length > 0) {
        const count = Math.min(missingKeys.length, newKeywords.length);
        for (let i = 0; i < count; i++) {
            const oldKw = missingKeys[i];
            const newKw = newKeywords[i];
            if (imageMap[oldKw] !== undefined) {
                const oldData = imageMap[oldKw];

                // ★ 古いキーの「オブジェクト内の位置（順序）」を完全に維持したまま新しいキー名に変更する
                const newImageMap = {};
                for (const [k, v] of Object.entries(imageMap)) {
                    if (k === oldKw) {
                        // 古いキーの位置にそのまま新しいキー名でデータを配置
                        newImageMap[newKw] = !_isEmptyImageValue(oldData) ? oldData : [];
                    } else if (!Object.prototype.hasOwnProperty.call(newImageMap, k)) {
                        newImageMap[k] = v;
                    }
                }
                imageMap = newImageMap;
                console.log(`[STJ Editor] 🔄 位置を維持して改名キーを置換: "${oldKw}" → "${newKw}"`);
            }
        }
    }

    // --- 2. 完全に削除されたエントリのクリーンアップ ---
    const removedKeys = [];
    for (const key of Object.keys(imageMap)) {
        if (UNREGISTER_EXCLUDED_KEYS.has(key)) continue;
        if (!activeKeywords.has(key)) {
            delete imageMap[key];
            removedKeys.push(key);
        }
    }

    // --- 3. 新規追加・既存維持・復元処理 ---
    const addedKeys = [];
    const restoredKeys = [];
    for (const keyword of activeKeywords) {
        if (UNREGISTER_EXCLUDED_KEYS.has(keyword)) continue;

        const exists = Object.prototype.hasOwnProperty.call(imageMap, keyword) && !_isEmptyImageValue(imageMap[keyword]);
        const rv = restoreData[keyword];
        const hasRestore = rv && !_isEmptyImageValue(rv);

        if (!exists) {
            if (hasRestore) {
                imageMap[keyword] = rv;
                restoredKeys.push(keyword);
            } else if (imageMap[keyword] === undefined || _isEmptyImageValue(imageMap[keyword])) {
                imageMap[keyword] = [];
                addedKeys.push(keyword);
            }
        }
    }

    const changed = removedKeys.length > 0 || addedKeys.length > 0 || restoredKeys.length > 0 || missingKeys.length > 0;

    if (changed) {
        saveImageMapToCharData(charName, imageMap);

        if (stjModalEl && stjModalEl.style.display === 'block' && !_editorLoading) {
            try {
                populateFormFromImageMap(imageMap, true);
                runLiveTest();
                autoSave({ immediate: true });
                console.log('[STJ Editor] 🔄 順序を完全に維持してJSON編集画面を更新しました');
            } catch (e) {
                console.warn('[STJ Editor] UI 再描画エラー:', e);
            }
        }
    }

    return addedKeys.length;
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

    const syncLater = (delay = 500) => {
        setTimeout(() => {
            syncLorebookEntriesToImageMap().catch(e => console.warn('[STJ Editor] syncLorebook error:', e));
        }, delay);
    };

    ['WORLDINFO_UPDATED', 'WORLDINFO_SETTINGS_UPDATED'].forEach(name => {
        if (et[name] && typeof es.on === 'function') {
            es.on(et[name], () => syncLater(600));
        }
    });

    ['CHAT_CHANGED', 'CHARACTER_SELECTED', 'CHARACTER_PAGE_LOADED'].forEach(name => {
        if (et[name] && typeof es.on === 'function') {
            es.on(et[name], () => syncLater(800));
        }
    });

    window.addEventListener('gic-image-generated-for-keyword', handleImageGeneratedForKeyword);

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

        const helpBtn = stjModalEl.querySelector('#stj_help_button');
        if (helpBtn) helpBtn.textContent = _t('stj.header.help', 'ヘルプ');

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
            addBtn.textContent = _t('stj.button.update', '更新');
            addBtn.title = _t('stj.button.update_title', 'ロアブックのエントリと同期してセルを自動作成します（自動削除はしません）');
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

    function initStjEditor() {
        const context = getSTContext();
        if (!context) { setTimeout(initStjEditor, 500); return; }

        if (!stjModalEl || !document.body.contains(stjModalEl)) {
            createExportModal();
        }

        setupImageDeletedListener();
        setupLorebookEntryWatcher();

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
            syncLorebookEntries: () => syncLorebookEntriesToImageMap(),
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
