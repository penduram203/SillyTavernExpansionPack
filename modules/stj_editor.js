// stj_editor.js
(function() {
    const MODULE_NAME = 'stj_editor';

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

    let isBulkDeleteMode = false;
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
        const message = `既に同じキーワードが設定されています: 「${keyword}」`;

        try {
            if (typeof window.toastr !== 'undefined' && typeof window.toastr.warning === 'function') {
                window.toastr.warning(message, 'キーワード重複', {
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
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            padding: '16px 28px',
            background: 'rgba(220, 38, 38, 0.95)',
            color: '#fff',
            fontSize: '16px',
            fontWeight: 'bold',
            borderRadius: '8px',
            boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
            zIndex: '25000',
            pointerEvents: 'none',
            textAlign: 'center',
            maxWidth: '90vw',
            border: '2px solid #fff',
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
        const nameHolder = document.querySelector('#character_name_holder');
        if (nameHolder && nameHolder.textContent) return nameHolder.textContent.trim();
        const greetingMessage = document.querySelector('.mes[mesid="0"][is_user="false"]');
        if (greetingMessage && greetingMessage.getAttribute('ch_name')) return greetingMessage.getAttribute('ch_name');
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
    // ★ ロアブック連携ヘルパー（選択肢ボタン用）
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
        if (window.LorebookExpansion?.loadWorldInfoEntriesByName) {
            try {
                const entries = await window.LorebookExpansion.loadWorldInfoEntriesByName(worldName);
                if (entries) return entries;
            } catch (e) { /* ignore */ }
        }
        try {
            const ctx = getSTContext();
            const headers = (ctx && typeof ctx.getRequestHeaders === 'function')
                ? ctx.getRequestHeaders()
                : { 'Content-Type': 'application/json' };
            const resp = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: worldName }),
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data && data.entries) return data.entries;
            }
        } catch (e) { /* ignore */ }
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
                        choices: data.choices,
                    };
                }
            } catch (e) { /* ignore */ }
        }
        const ext = entry && entry.extensions && entry.extensions.lorebook_expansion;
        if (ext && typeof ext === 'object') {
            return {
                img_prompt: typeof ext.img_prompt === 'string' ? ext.img_prompt : '',
                choices: Array.isArray(ext.choices)
                    ? ext.choices
                        .filter(c => c && typeof c === 'object')
                        .map(c => ({
                            num: typeof c.num === 'string' ? c.num : String(c.num ?? ''),
                            text: typeof c.text === 'string' ? c.text : '',
                        }))
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
            const keys = getEntryKeys(entry);
            for (const k of keys) {
                if (String(k).trim() === target) return entry;
            }
        }
        return null;
    }

    async function updateChoicesButtonState(cell) {
        const modal = currentCellModal;
        if (!modal || !cell) return;
        const btn = modal.querySelector('.stj-cell-modal-choices');
        if (!btn) return;

        btn.classList.add('stj-choices-disabled');
        btn.disabled = true;
        btn.title = '';

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

        const lex = getLexDataFor(worldName, targetEntry.uid, targetEntry);
        const choices = Array.isArray(lex.choices)
            ? lex.choices.filter(c => c && String(c.num || '').trim())
            : [];
        if (choices.length === 0) return;

        if (currentCellModal !== modal || currentModalCell !== cell) return;

        btn.classList.remove('stj-choices-disabled');
        btn.disabled = false;
        btn.title = `選択肢を表示 (${choices.length}件)`;
    }

    async function showChoicesPopup() {
        const cell = currentModalCell;
        if (!cell) return;
        if (cell.classList.contains('stj-special-item')) return;

        const kw = getCellKeyword(cell).trim();
        if (!kw) return;

        const worldName = getCharacterWorldInfoName();
        if (!worldName) return;

        const entries = await loadWorldInfoEntries(worldName);
        if (!entries) return;

        const targetEntry = findEntryByKeyword(entries, kw);
        if (!targetEntry) return;

        const lex = getLexDataFor(worldName, targetEntry.uid, targetEntry);
        const choices = Array.isArray(lex.choices)
            ? lex.choices.filter(c => c && String(c.num || '').trim())
            : [];
        if (choices.length === 0) return;

        const rows = [];
        const seen = new Set([kw]);

        rows.push({
            label: '',
            num: kw,
            text: String(targetEntry.content || '').trim(),
        });

        for (const c of choices) {
            const num = String(c.num).trim();
            if (!num || seen.has(num)) continue;
            seen.add(num);
            const choiceEntry = findEntryByKeyword(entries, num);
            const content = choiceEntry ? String(choiceEntry.content || '').trim() : '';
            rows.push({
                label: '選択肢',
                num,
                text: content || (typeof c.text === 'string' ? c.text : ''),
            });
        }

        showChoicesOverlay(rows);
    }

    function showChoicesOverlay(rows) {
        const existing = document.getElementById('stj_choices_popup');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'stj_choices_popup';
        overlay.className = 'stj-choices-popup';

        const box = document.createElement('div');
        box.className = 'stj-choices-popup-box';

        for (const row of rows) {
            const line = document.createElement('div');
            line.className = 'stj-choices-popup-line';

            if (row.label) {
                const labelEl = document.createElement('span');
                labelEl.className = 'stj-choices-popup-label';
                labelEl.textContent = row.label + '　';
                line.appendChild(labelEl);
            }

            const numEl = document.createElement('span');
            numEl.className = 'stj-choices-popup-num';
            numEl.textContent = row.num + '　';
            line.appendChild(numEl);

            const textEl = document.createElement('span');
            textEl.className = 'stj-choices-popup-text';
            textEl.textContent = row.text;
            line.appendChild(textEl);

            box.appendChild(line);
        }

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const onKeyDown = (e) => {
            if (e.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', onKeyDown);
            }
        };
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.remove();
                document.removeEventListener('keydown', onKeyDown);
            }
        });
        document.addEventListener('keydown', onKeyDown);
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

    // ============================================================
    // ★ サーバー上の実ファイル存在チェック (ブラウザキャッシュ無効)
    //    checkMediaExists は内部で new Image()/video の onload/onerror を
    //    使うため、ブラウザキャッシュに残っている画像は「存在する」と
    //    誤判定される。ローカルディスク削除を確実に検知するため、
    //    fetch HEAD + cache:no-store で実ディスクを確認する。
    // ============================================================
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

    // ============================================================
    // ★ 別キャラの画像エントリ検出・除去（残留データ対策）
    //   image-display.js と同じロジック。
    //   フラグはログ抑制専用。データが壊れている場合は
    //   フラグ済みでも毎回クリーンアップする
    //   (STコアが古いデータを再取得して上書きするケースがあるため)。
    //   ★ 空配列になったキーも保持する(セルとキーワードを残すため)。
    // ============================================================
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

        // ★ フラグは「per-item ログ抑制」のためだけに使う。
        //   データが壊れている場合はフラグ済みでも毎回クリーンアップする
        const alreadyMigrated = isMigrationDoneForChar(charName);

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
                // ★ 空配列でもキーを保持する（画像全削除されたキーワードを残すため）
                if (filtered.length === 0) return [];
                return filtered.length === 1 ? filtered[0] : filtered;
            } else if (typeof val === 'string') {
                const fn = extractFileNameFromPath(val);
                if (fn && isForeignImageFileName(fn, charName)) {
                    if (!alreadyMigrated) {
                        console.log(`[STJ Editor] 🧹 別キャラの画像エントリを除外: ${fn}`);
                    }
                    removed++;
                    // ★ 空配列に変換してキーを保持（セルとキーワードを残す）
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
                    // ★ STコアの再取得で上書きされるのを防ぐため即時保存
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

    // ============================================================
    // ★ ディスク上に存在しない画像エントリを検出・除去
    //    ローカルディスクから画像を直接削除した場合、
    //    character.data.extensions.image_display_extension に
    //    キーワードとファイル名のマッピングだけが残ってしまう。
    //    ここで実ファイルの存在を fetch HEAD で確認し、
    //    無い場合はマッピングを除去する。
    //    ★ 空配列になったキーも保持する(セルとキーワードを残すため)。
    // ============================================================
    async function cleanMissingImageFiles(imageMap, charName) {
        if (!imageMap || typeof imageMap !== 'object' || !charName) return imageMap;

        // 1. 全ファイル名を収集（元ファイル名に正規化）
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

        // 2. 並列で実ファイル存在チェック (ブラウザキャッシュ無効)
        //    ★ checkMediaExists ではなく checkFileExistsOnServer を使う:
        //      checkMediaExists は new Image() の onload で判定するため、
        //      ブラウザキャッシュに残っている画像を「存在する」と誤判定する。
        const existMap = new Map();
        await Promise.all([...fileNames].map(async (fn) => {
            const exists = await checkFileExistsOnServer(charName, fn);
            existMap.set(fn, exists);
        }));

        // 3. 欠損しているファイルを除去（ただしキーは保持）
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
                // ★ 空配列でもキーを保持する（画像全削除されたキーワードを残すため）
                cleaned[key] = filtered.length === 0 ? [] : (filtered.length === 1 ? filtered[0] : filtered);
            } else if (typeof val === 'string') {
                if (isMissing(val)) {
                    console.log(`[STJ Editor] 🗑️ 存在しないファイルを除去: key="${key}" → ${val}`);
                    removed++;
                    // ★ 空配列でキーを保持（セルとキーワードを残す）
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
                // image-display.js に即時反映
                window.dispatchEvent(new CustomEvent('lbe-image-map-updated', {
                    detail: { charName, imageMap: cleaned }
                }));
            } catch (e) { /* ignore */ }
        }

        return cleaned;
    }

    // ===== 条件評価 =====
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

    // ============================================================
    // ★ セル挿入（参照セルの前後に移動し、他セルをずらす）
    // ============================================================
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

    // ============================================================
    // ★ ドロップゾーン判定
    //   セル中央部  → 入れ替え（swap）
    //   セル左/右端 → そのセルの前/後に挿入（insert）
    //   セル間の隙間 → 最近傍セルを基準に挿入
    // ============================================================
    function findDropZone(s, x, y) {
        const container = document.getElementById('stj_keywords_container');
        if (!container) return null;

        const el = document.elementFromPoint(x, y);
        const hoveredCell = el && el.closest ? el.closest('.stj-keyword-item') : null;

        // ① キーワードセルの上
        if (hoveredCell && container.contains(hoveredCell)) {
            if (hoveredCell === s.sourceItem) return null; // 自分自身の上は無反応
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

        // ② セルの上ではない → コンテナ内なら「挿入」扱い
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

    // ============================================================
    // ★ ドラッグモードバッジ（カーソル追従表示）
    //    「⇄ 場所交代」 / 「⬇ 隙間挿入」
    // ============================================================
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
            text = '⇄ 場所交代';
            mode = 'swap';
        } else {
            text = '⬇ 隙間挿入';
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

        // 既存の視覚インジケーターをクリア（対象が変わったものだけ）
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
            fallback.textContent = 'プレビュー';
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
                if (s.isBulkDelete) return;
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
                    // ★ 挿入モード（隙間ドロップ）
                    insertCellAt(s.sourceItem, s.insertZone.reference, s.insertZone.position);
                    runLiveTest();
                    autoSave({ immediate: true });
                } else if (s.currentTarget && s.currentTarget !== s.sourceItem) {
                    // ★ 入れ替えモード（重ねドロップ）
                    swapCells(s.sourceItem, s.currentTarget);
                    runLiveTest();
                    autoSave({ immediate: true });
                }
            } else {
                const src = s.sourceItem;
                if (!src) return;
                if (s.isBulkDelete || isBulkDeleteMode) {
                    if (src.classList.contains('stj-marked-for-delete')) src.classList.remove('stj-marked-for-delete');
                    else src.classList.add('stj-marked-for-delete');
                    return;
                }
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

    function enterBulkDeleteMode() {
        if (isBulkDeleteMode) return;
        isBulkDeleteMode = true;
        closeCellModal(false);
        if (stjModalEl) stjModalEl.classList.add('stj-bulk-delete-mode');

        const addBtn = document.getElementById('stj_add_keyword');
        const bulkBtn = document.getElementById('stj_bulk_delete');
        const delCancelBtn = document.getElementById('stj_delete_cancel');
        const delExecBtn = document.getElementById('stj_delete_execute');
        const cancelBtn = document.getElementById('stj_cancel_export');

        if (addBtn) addBtn.style.display = 'none';
        if (bulkBtn) bulkBtn.style.display = 'none';
        if (delCancelBtn) delCancelBtn.style.display = '';
        if (delExecBtn) delExecBtn.style.display = '';
        if (cancelBtn) cancelBtn.disabled = true;
        document.querySelectorAll('.stj-keyword-item .stj-delete-row').forEach(btn => btn.disabled = true);
    }

    function exitBulkDeleteMode() {
        if (!isBulkDeleteMode) return;
        isBulkDeleteMode = false;
        isDialogActive = false;
        document.querySelectorAll('.stj-keyword-item.stj-marked-for-delete').forEach(el => el.classList.remove('stj-marked-for-delete'));
        hideMessageDialog();
        hideDeleteConfirmDialog();
        if (stjModalEl) stjModalEl.classList.remove('stj-bulk-delete-mode');

        const addBtn = document.getElementById('stj_add_keyword');
        const bulkBtn = document.getElementById('stj_bulk_delete');
        const delCancelBtn = document.getElementById('stj_delete_cancel');
        const delExecBtn = document.getElementById('stj_delete_execute');
        const cancelBtn = document.getElementById('stj_cancel_export');

        if (addBtn) addBtn.style.display = '';
        if (bulkBtn) bulkBtn.style.display = '';
        if (delCancelBtn) delCancelBtn.style.display = 'none';
        if (delExecBtn) delExecBtn.style.display = 'none';
        if (cancelBtn) cancelBtn.disabled = false;
        document.querySelectorAll('.stj-keyword-item .stj-delete-row').forEach(btn => btn.disabled = false);
    }

    // ============================================================
    // ★ フォームを完全リセット（別キャラのセル内容が残らないように）
    //    openExportModal で毎回呼び出し、その後に loadExistingJSONData / loadSavedData
    //    で新しいキャラの内容を読み込む。
    // ============================================================
    function resetFormToEmpty() {
        // 特殊セル（デフォルト・サムネイル）を空に
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

        // キーワードコンテナを空にして、空セル1個だけ配置
        const container = document.getElementById('stj_keywords_container');
        if (container) {
            container.innerHTML = '';
            addKeywordRowWithData(container, 0, { keyword: '', images: [] });
        }

        // テスト入力欄もクリア
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
        stjModalEl.style.width = 'calc(85vw - 280px)';
        stjModalEl.style.minWidth = '500px';
        stjModalEl.style.height = '100vh';
        stjModalEl.style.zIndex = '10001';
        stjModalEl.scrollTop = 0;
        document.body.classList.add('stj-editor-open');
        modalOpenedTimestamp = Date.now();

        const charName = detectCharacterNameFromDOM() || '';
        const nameEl = document.getElementById('stj_char_name_display');
        if (nameEl) nameEl.textContent = charName;

        // ★ エディタ初期化中フラグを立てる
        _editorLoading = true;

        // ★ 前回編集した別キャラのセル内容が残らないよう、必ず先にフォームをリセット
        resetFormToEmpty();

        (async () => {
            try {
                const hasCharData = await loadExistingJSONData(charName);
                // ★ character.data に image_display_extension キーが存在すれば
                //    （空 {} でも）character.data を権威ソースとして扱い、
                //    loadSavedData をスキップする。
                //    これにより、全セル削除後に extensionSettings の古いデータで
                //    セルが復元されるのを防ぐ。
                if (!hasCharData) {
                    loadSavedData(charName);
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
        // ★ モーダルを閉じる前に pending 保存を確実にフラッシュ
        //    （_doAutoSave は immediate: true で保存するが、
        //      saveCharacterExtension を他のコードパスから呼んでいる場合の保険）
        try {
            if (window.CharStore?.flushCharacterExtension) {
                window.CharStore.flushCharacterExtension('image_display_extension');
            }
        } catch (e) { /* ignore */ }
        closeCellModal(false);
        stjModalEl.style.display = 'none';
        document.body.classList.remove('stj-editor-open');
    }

    function closeExportModal(opts = {}) {
        if (!stjModalEl) return;
        const { fromGallery = false, force = false } = opts;
        if (stjModalEl.style.display !== 'block') return;
        if (!force && (isBulkDeleteMode || isDialogActive)) return;
        closeExportModalInternal();
        if (!fromGallery) {
            if (window.GicApi?.closeGallery) {
                try { window.GicApi.closeGallery(); } catch (e) { /* ignore */ }
            }
        }
    }

    // ============================================================
    // セルポップアップモーダル
    // ============================================================
    function createCellModal() {
        const modal = document.createElement('div');
        modal.id = 'stj_cell_modal';
        modal.className = 'stj-cell-modal';
        modal.innerHTML = `
            <div class="stj-cell-modal-content">
                <div class="stj-cell-modal-header">
                    <button type="button" class="stj-cell-modal-apply">決定</button>
                    <button type="button" class="stj-cell-modal-cancel">キャンセル</button>
                    <input type="text" class="stj-cell-modal-keyword" placeholder="キーワード">
                    <button type="button" class="stj-cell-modal-choices stj-choices-disabled" disabled title="">選択肢</button>
                </div>
                <div class="stj-cell-modal-grid"></div>
            </div>
        `;
        document.body.appendChild(modal);

        modal.querySelector('.stj-cell-modal-apply').addEventListener('click', (e) => {
            e.stopPropagation();
            applyCellModal();
        });
        modal.querySelector('.stj-cell-modal-cancel').addEventListener('click', (e) => {
            e.stopPropagation();
            closeCellModal(true);
        });

        const choicesBtn = modal.querySelector('.stj-cell-modal-choices');
        if (choicesBtn) {
            choicesBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (choicesBtn.disabled) return;
                showChoicesPopup().catch(err => console.warn('[STJ Editor] showChoicesPopup error:', err));
            });
        }

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
        if (isBulkDeleteMode || isDialogActive) return;

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
        const kwInput = currentCellModal.querySelector('.stj-cell-modal-keyword');
        const choicesBtn = currentCellModal.querySelector('.stj-cell-modal-choices');

        if (isSpecial) {
            kwInput.style.display = 'none';
            if (choicesBtn) choicesBtn.style.display = 'none';
        } else {
            kwInput.style.display = '';
            kwInput.value = modalOriginalKeyword;
            if (choicesBtn) {
                choicesBtn.style.display = '';
                updateChoicesButtonState(cell).catch(e => console.warn('[STJ Editor] choices state error:', e));
            }
        }

        kwInput.style.borderColor = '';
        kwInput.style.boxShadow = '';
        kwInput.title = '';
        {
            const curKw = kwInput.value.trim();
            if (curKw) {
                const dup = findDuplicateKeyword(cell, curKw);
                if (dup) {
                    kwInput.style.borderColor = '#e53e3e';
                    kwInput.style.boxShadow = '0 0 0 2px rgba(229, 62, 62, 0.4)';
                    kwInput.title = '既に同じキーワードが設定されています';
                }
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

        if (!isSpecial && kwInput) {
            setTimeout(() => {
                try { kwInput.focus(); } catch (e) { /* ignore */ }
            }, 50);
        }
    }

    function closeCellModal(revert) {
        if (!currentCellModal) return;
        const popup = document.getElementById('stj_choices_popup');
        if (popup) popup.remove();
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
                `${removedFiles.length}枚の画像をキーワードから登録解除しますか？`,
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
        if (!cell.classList.contains('stj-special-item')) {
            const kwInput = currentCellModal.querySelector('.stj-cell-modal-keyword');
            if (kwInput) setCellKeyword(cell, kwInput.value.trim());
        }
        updateCellPreview(cell);
        runLiveTest();
        autoSave({ immediate: true });
        const popup = document.getElementById('stj_choices_popup');
        if (popup) popup.remove();
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

    // ============================================================
    // セルモーダル用: 動画サムネイルの IntersectionObserver
    // ============================================================
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

        const neededSlots = Math.max(9, Math.ceil(images.length / 3) * 3);
        const currentCount = grid.children.length;
        for (let i = currentCount; i < neededSlots; i++) {
            const slot = document.createElement('div');
            slot.className = 'stj-cell-modal-slot';
            slot.dataset.index = String(i);
            slot.innerHTML = `<button type="button" class="stj-cell-modal-slot-remove" title="登録解除">×</button>`;
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

    // ============================================================
    // セルへのドロップ処理
    // ============================================================
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
    // セル個別のリスナー
    // ============================================================
    function attachKeywordRowListeners(item, index) {
        const previewEl = item.querySelector('.stj-image-preview');
        if (previewEl) {
            previewEl.addEventListener('mousedown', function(e) {
                if (e.button !== 0) return;
                if (e.target.closest && e.target.closest('button')) return;

                if (isBulkDeleteMode) {
                    e.preventDefault();
                    e.stopPropagation();
                    pointerDragState = {
                        sourceItem: item,
                        startX: e.clientX, startY: e.clientY,
                        lastX: e.clientX, lastY: e.clientY,
                        isDragging: false, isBulkDelete: true,
                        hasMoved: false,
                        currentTarget: null, ghostState: null, scrollContainer: null,
                        insertReference: null, insertZone: null
                    };
                    return;
                }

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

        const deleteButton = item.querySelector('.stj-delete-row');
        if (deleteButton) {
            deleteButton.addEventListener('click', function(e) {
                e.stopPropagation();
                if (isBulkDeleteMode || isDialogActive) return;
                showDeleteConfirmDialog('本当に削除しますか？', () => {
                    item.remove();
                    runLiveTest();
                    autoSave({ immediate: true });
                });
            });
        }

        item.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            if (isBulkDeleteMode || isDialogActive) return;
            if (Date.now() < _suppressCellClickUntil) {
                e.stopPropagation();
                e.preventDefault();
                return;
            }
            openCellModal(item);
        });
    }

    // ============================================================
    // ライブテスト
    // ============================================================
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
            testResult.innerHTML = '判定結果: <span style="color: #aaa; font-weight: normal;">文章を入力するとヒットするキーワードが表示されます</span>';
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

        if (matched) {
            testResult.innerHTML = `判定結果: <span style="color: #64b5f6; font-size: 16px;">「${matched.keyword}」</span> にマッチしました！ (ファイル: ${matched.imageName || '未指定'})`;
            matched.element.style.border = '2px solid #64b5f6';
            matched.element.style.backgroundColor = 'rgba(100, 181, 246, 0.15)';
        } else {
            const defaultCell = document.querySelector('.stj-special-item:nth-child(1)');
            const defaultImages = defaultCell ? getCellImages(defaultCell) : [];
            const defDisplay = defaultImages[0] || 'defa';
            testResult.innerHTML = `判定結果: <span style="color: #ffb74d;">一致するキーワードがありません（デフォルト「${defDisplay}」が適用されます）</span>`;
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
                <div class="stj-preview-text">プレビュー</div>
            </div>
            <div class="stj-keyword-display"></div>
            <button class="stj-delete-row">×</button>
        `;
        container.appendChild(newItem);
        attachKeywordRowListeners(newItem, itemCount);
        setupCellDropTargets(newItem);
        modal.scrollTop = modal.scrollHeight;
        runLiveTest();
        autoSave({ immediate: true });
    }

    // ============================================================
    // ★ extensionSettings のレガシーデータ → image_display_extension 形式に変換
    //    character.data が空で extensionSettings にのみデータがある場合、
    //    この関数で変換して character.data へ移行する。
    // ============================================================
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

    // ============================================================
    // ★ loadExistingJSONData の戻り値 hasCharData:
    //    character.data.extensions.image_display_extension キーが
    //    存在する場合(空 {} でも) true。この場合 loadSavedData をスキップする。
    // ============================================================
    async function loadExistingJSONData(charName) {
        if (!charName) { console.warn('[STJ Editor] charName 空'); return false; }

        let imageMap = null;
        let hasCharData = false;

        // ── ① ctx.characters[characterId] → ctx.character の順（一次情報源）──
        try {
            const context = getSTContext();

            const charFromList = context?.characters?.[context?.characterId];
            let ext = charFromList?.data?.extensions?.image_display_extension;

            if (ext === undefined) {
                ext = context?.character?.data?.extensions?.image_display_extension;
            }

            // ★ character.data.extensions.image_display_extension が undefined でなければ
            //    （空 {} でも）character.data を権威ソースとして扱う
            if (ext !== undefined && typeof ext === 'object') {
                hasCharData = true;
                // ★ null 値（削除マーカー）を除外する
                //    merge-attributes の深いマージで残った削除済みキーを無視するため。
                const filteredExt = {};
                for (const [k, v] of Object.entries(ext)) {
                    if (v !== null && v !== undefined) {
                        filteredExt[k] = v;
                    }
                }
                if (Object.keys(filteredExt).length > 0) {
                    imageMap = filteredExt;
                    console.log(`[STJ Editor] ✅ image_display_extension を読込 (${Object.keys(filteredExt).length} entries)`);
                } else {
                    console.log(`[STJ Editor] image_display_extension は空 ({}) → 空フォーム維持`);
                }
            }
        } catch (e) { /* ignore */ }

        // ── ② 移行フォールバック: _ext.json（character.data にキーが無い時のみ）──
        if (!imageMap && !hasCharData) {
            try {
                const jsonPath = `user/images/${charName}/${charName}_ext.json`;
                const resp = await fetch(jsonPath);
                if (resp.ok) {
                    const data = await resp.json();
                    const legacy = findImageMapInData(data);
                    if (legacy && Object.keys(legacy).length > 0) {
                        imageMap = legacy;
                        console.log(`[STJ Editor] 🔄 _ext.json から読込。character.json へ移行`);
                        try {
                            window.CharStore?.saveCharacterExtension?.(
                                'image_display_extension', legacy, { immediate: true }
                            );
                        } catch (e) { /* ignore */ }
                    } else {
                        // 空の _ext.json → 「確認済み・データなし」として空データ保存
                        window.CharStore?.saveCharacterExtension?.(
                            'image_display_extension', {}, { immediate: true }
                        );
                    }
                } else if (resp.status === 404) {
                    // ★ character.data にも _ext.json にもデータが無い
                    //    → extensionSettings にレガシーデータがあれば character.data へ移行
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
                            console.log('[STJ Editor] 🔄 extensionSettings から character.data へ移行しました');
                        } else {
                            // 本当にデータなし → 空 {} を保存して「確認済み」とする
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

        // ── ③ クリーニング + フォーム反映 ──
        if (imageMap) {
            // ★ 別キャラの画像エントリを先に除外（過去のバグの残留データ対策）
            const cleanedMap = cleanForeignImageEntries(imageMap, charName);
            // ★ ディスク上に存在しないファイルを除去（ローカル削除対策）
            const existingMap = await cleanMissingImageFiles(cleanedMap, charName);
            populateFormFromImageMap(existingMap);
            // ★ extensionSettings も同期
            //    （loadSavedData が後から走るため、旧データで上書きされるのを防ぐ）
            try { saveData({ silent: true }); } catch (e) { /* ignore */ }
        } else {
            // ★ 空の image_display_extension が既に保存されている場合は
            //    「新規作成」ではなく「空データ（確認済み）」とログを分ける
            let hasEmptyExt = false;
            try {
                const ctx = getSTContext();
                const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
                if (char?.name === charName) {
                    const ext = char?.data?.extensions?.image_display_extension;
                    hasEmptyExt = ext !== undefined && typeof ext === 'object';
                }
            } catch (e) { /* ignore */ }
            if (hasEmptyExt) {
                console.log(`[STJ Editor] image_display_extension は空です（確認済み・_ ext.json フォールバック不要）`);
            } else {
                console.log(`[STJ Editor] image_display_extension が見つかりません（新規作成）`);
            }
        }

        return hasCharData;
    }

    function populateFormFromImageMap(imageMap) {
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
        container.innerHTML = '';
        let index = 0;
        Object.entries(imageMap).forEach(([key, val]) => {
            if (key === 'default' || key === 'thumbnail') return;
            addKeywordRowWithData(container, index, { keyword: key, images: toFileNames(val) });
            index++;
        });
        if (index === 0) {
            addKeywordRowWithData(container, 0, { keyword: '', images: [] });
        }
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
            placeholder.textContent = 'プレビュー';
            previewEl.insertBefore(placeholder, previewEl.firstChild);
        }
        if (!placeholder.dataset.originalText) {
            placeholder.dataset.originalText = (placeholder.textContent || 'プレビュー').trim() || 'プレビュー';
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
            placeholder.textContent = 'ファイルが見つかりません';
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
        loadingEl.textContent = '読み込み中...';
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

    function buildImageMapFromForm(charName) {
        const imageMap = {};
        const toPaths = (names) => names.map(name => {
            const cleaned = extractFileNameFromPath(name);
            // ★ サムネイル名を元ファイル名に解決（動画・画像両対応）
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
            // ★ 画像が 0 枚でもキーを保持する（セルとキーワードを残すため）
            //    旧コード: if (images.length === 0) return;
            //              → キーワードのみのセルが imageMap から除外されていた
            const paths = toPaths(images);
            imageMap[kw] = paths.length === 0
                ? []
                : (paths.length === 1 ? paths[0] : paths);
        });

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

    // ============================================================
    // ★ オートセーブ
    //   ユーザー操作（セル追加/削除/入れ替え/キーワード確定/画像登録解除）で
    //   自動保存する。短時間に複数回呼ばれた場合は 400ms デバウンス。
    // ============================================================
    function _doAutoSave() {
        try {
            const nameEl = document.getElementById('stj_char_name_display');
            const charName = nameEl ? nameEl.textContent : '';
            if (!charName) return;

            // ★ 現在アクティブなキャラと不一致なら保存しない（別キャラへのデータ混入防止）
            try {
                const ctx = getSTContext();
                const currentChar = ctx?.characters?.[ctx?.characterId] || ctx?.character;
                const currentCharName = currentChar?.name || '';
                if (currentCharName && currentCharName !== charName) {
                    console.debug(
                        `[STJ Editor] autoSave: キャラ不一致 (editor="${charName}", current="${currentCharName}") → 保存スキップ`
                    );
                    return;
                }
            } catch (e) { /* ignore */ }

            // 既存: UI復元用に editor 状態を extensionSettings に保存（残してよい）
            saveData({ silent: true });

            // ★ 新規: image_display_extension 形式へ変換して character.json に保存
            try {
                const imageMap = buildImageMapFromForm(charName);

                // ★ 削除されたキーを null で明示的に上書きする
                //    merge-attributes は lodash.merge で深いマージを行うため、
                //    フォームにないキーを null で送らないとサーバ側に残り続け、
                //    再起動時に削除したセルが復活してしまう。
                let payload = imageMap;
                let keysToDelete = [];
                try {
                    const ctx = getSTContext();
                    const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
                    if (char?.name === charName) {
                        const currentExt = char?.data?.extensions?.image_display_extension;
                        if (currentExt && typeof currentExt === 'object') {
                            keysToDelete = Object.keys(currentExt).filter(
                                k => !(k in imageMap) && currentExt[k] !== null
                            );
                            if (keysToDelete.length > 0) {
                                payload = { ...imageMap };
                                for (const k of keysToDelete) {
                                    payload[k] = null;
                                }
                                console.log(`[STJ Editor] 🗑️ 削除キーを null で上書き: ${keysToDelete.join(', ')}`);
                            }
                        }
                    }
                } catch (e) { /* ignore */ }

                if (window.CharStore?.saveCharacterExtension) {
                    // ★ { immediate: true } でデバウンスをバイパス
                    //    CharStore は 100ms のデバウンスを持つが、モーダル閉じなどで
                    //    pending 保存がキャンセルされるケースがあるため、即時保存する。
                    //    これによりキーワードのみの編集（画像0枚のセル）も確実に
                    //    character.data に保存される。
                    window.CharStore.saveCharacterExtension(
                        'image_display_extension',
                        payload,
                        { immediate: true }
                    );

                    // ★ _updateMemory が payload（null 付き）でメモリを上書きするため、
                    //    送信後にメモリを正しい imageMap で修正する。
                    if (keysToDelete.length > 0) {
                        try {
                            const ctx = getSTContext();
                            const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
                            if (char?.name === charName && char.data?.extensions) {
                                char.data.extensions.image_display_extension = imageMap;
                            }
                        } catch (e) { /* ignore */ }
                    }

                    // 即時反映用のカスタムイベント（null を除外した imageMap を渡す）
                    window.dispatchEvent(new CustomEvent('lbe-image-map-updated', {
                        detail: { charName, imageMap }
                    }));
                    console.log(`[STJ Editor] image_display_extension を即時保存 (${Object.keys(imageMap).length} entries)`);
                } else {
                    console.warn('[STJ Editor] CharStore 未ロードのため character.json 保存スキップ');
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
            if (!silent) alert('キャラクター名が設定されていません');
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

        // ★ 空フォーム保護: エディタ初期化中のみスキップ
        //    セル全削除後の空フォームは「ユーザーの意図した削除」なので保存する。
        //    （以前は無条件スキップで、全削除が extensionSettings に反映されず
        //      再起動後に loadSavedData が古いセルを復元するバグがあった）
        if (silent &&
            data.keywords.length === 0 &&
            data.defaultImages.length === 0 &&
            data.thumbnailImages.length === 0 &&
            _editorLoading) {
            console.debug('[STJ Editor] autoSave: エディタ初期化中の空フォームのため保存をスキップ');
            return;
        }

        const stjSettings = getExtensionSettings();
        stjSettings[charName] = data;
        persistSettings();

        if (silent) {
            // ★ キーワードのみのセルも保存されていることがわかるログ
            const kwOnlyCount = data.keywords.filter(k => (k.images || []).length === 0).length;
            if (kwOnlyCount > 0) {
                console.debug(
                    `[STJ Editor] autoSave: extensionSettings を保存 ` +
                    `(keywords=${data.keywords.length}, うち画像0枚=${kwOnlyCount})`
                );
            }
        } else {
            showCustomAlert('データを保存しました');
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

            // ★ data.keywords が空の場合は既存のフォーム（_ext.json 由来）を保持
            //   空データで有効な _ext.json を上書きしないための保護
            if (!Array.isArray(data.keywords) || data.keywords.length === 0) {
                const existingCells = container.querySelectorAll('.stj-keyword-item').length;
                console.log(
                    `[STJ Editor] loadSavedData: keywords が空のため既存フォームを保持 ` +
                    `(既存セル ${existingCells} 件)`
                );
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
                <div class="stj-preview-text">プレビュー</div>
            </div>
            <div class="stj-keyword-display"></div>
            <button class="stj-delete-row">×</button>
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
                <div class="stj-guide-section-title">🔧 基本演算子</div>
                <ul class="stj-guide-list">
                    <li><code class="stj-op">+</code> <b>AND</b>（全て含む）<div class="stj-op-ex">例：<code>山+川</code> → 「山」と「川」の両方が含まれる時にマッチ</div></li>
                    <li><code class="stj-op">,</code> <b>OR</b>（いずれか含む）<div class="stj-op-ex">例：<code>山,川</code> → 「山」または「川」のどちらかが含まれる時にマッチ</div></li>
                    <li><code class="stj-op">!</code> <b>NOT</b>（除外）<div class="stj-op-ex">例：<code>!山</code> → 「山」が含まれていない時にのみマッチ</div></li>
                    <li><code class="stj-op">( )</code> <b>グループ化</b>（入れ子可能）<div class="stj-op-ex">例：<code>(山+川),谷</code> → 「山と川」または「谷」のいずれかにマッチ</div></li>
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
                <div class="stj-confirm-message">本当に削除しますか？</div>
                <div class="stj-confirm-buttons">
                    <button type="button" class="stj-confirm-yes">はい</button>
                    <button type="button" class="stj-confirm-no">いいえ</button>
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
                <div class="stj-test-header">
                    <label>🔍 リアルタイムキーワード反応テスト</label>
                    <strong id="stj_char_name_display"></strong>
                    <button type="button" class="stj-help-btn" id="stj_help_button">ヘルプ</button>
                </div>
                <div class="stj-syntax-guide" id="stj_syntax_guide">${buildSyntaxGuideHtml()}</div>
                <textarea id="stj_test_input" placeholder="試しに文章を入力してください（例：笑顔で挨拶する）..."></textarea>
                <div id="stj_test_result">判定結果: <span style="color: #aaa; font-weight: normal;">文章を入力するとヒットするキーワードが表示されます</span></div>
            </div>

            <div class="stj-top-section">
                <div class="stj-special-container">
                    <div class="stj-special-item" data-image-list='[]'>
                        <div class="stj-special-label">デフォルト表示</div>
                        <div class="stj-special-preview">
                            <div class="stj-image-preview" id="stj_preview_default" style="position: relative;">
                                <div class="stj-preview-text">デフォルトメディアプレビュー</div>
                            </div>
                        </div>
                    </div>
                    <div class="stj-special-item" data-image-list='[]'>
                        <div class="stj-special-label">サムネイル表示</div>
                        <div class="stj-special-preview">
                            <div class="stj-image-preview" id="stj_preview_thumbnail" style="position: relative;">
                                <div class="stj-preview-text">サムネイルプレビュー</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="stj-info-panel">
                    <div class="stj-info-note">※セルをクリックすると編集ウインドウが開きます</div>
                    <div class="stj-info-guide">
                        <h4>📖 操作方法</h4>
                        <ul class="stj-guide-ops">
                            <li><b>セルをクリック</b>：編集ウインドウが開きます</li>
                            <li><b>ギャラリーからドラッグ&ドロップ</b>：画像を追加できます</li>
                            <li><b>セルをドラッグ</b>：セルの位置を入れ替えられます</li>
                            <li><b>編集ウインドウでホバー</b>：各マスに ❌ ボタン → 登録解除</li>
                            <li><b>❌ボタン</b>：セルを削除します</li>
                            <li><b>一括削除</b>：複数のセルをまとめて削除</li>
                            <li><b>セル追加</b>：新しいセルを追加</li>
                        </ul>
                    </div>
                </div>
            </div>
            <div id="stj_keywords_container" class="stj-grid-container">
                <div class="stj-keyword-item" data-image-list='[]' data-keyword=''>
                    <div class="stj-image-preview" id="stj_preview_0" style="position: relative;">
                        <div class="stj-preview-text">プレビュー</div>
                    </div>
                    <div class="stj-keyword-display"></div>
                    <button class="stj-delete-row">×</button>
                </div>
            </div>
            <div class="stj-button-group">
                <div class="stj-button-group-main">
                    <button id="stj_cancel_export">終了</button>
                    <button id="stj_add_keyword">セル追加</button>
                    <button id="stj_bulk_delete">一括削除</button>
                    <button id="stj_delete_cancel" style="display:none;">戻る</button>
                    <button id="stj_delete_execute" style="display:none;">削除実行</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        stjModalEl = modal;

        createConfirmDialog();
        createMessageDialog();

        modal.addEventListener('click', (e) => e.stopPropagation());

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
        if (addBtn) addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isBulkDeleteMode || isDialogActive) return;
            addKeywordRow(modal);
        });

        const bulkDeleteBtn = document.getElementById('stj_bulk_delete');
        if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isBulkDeleteMode || isDialogActive) return;
            enterBulkDeleteMode();
        });

        const delCancelBtn = document.getElementById('stj_delete_cancel');
        if (delCancelBtn) delCancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!isBulkDeleteMode || isDialogActive) return;
            exitBulkDeleteMode();
        });

        const delExecBtn = document.getElementById('stj_delete_execute');
        if (delExecBtn) delExecBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!isBulkDeleteMode || isDialogActive) return;
            executeBulkDelete();
        });

        const cancelBtn = document.getElementById('stj_cancel_export');
        if (cancelBtn) cancelBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isBulkDeleteMode || isDialogActive) return;
            closeExportModal();
        });

        modal.querySelectorAll('.stj-special-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                if (isBulkDeleteMode || isDialogActive) return;
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

    function executeBulkDelete() {
        const marked = document.querySelectorAll('.stj-keyword-item.stj-marked-for-delete');
        if (marked.length === 0) return;
        isDialogActive = true;

        const delCancelBtn = document.getElementById('stj_delete_cancel');
        const delExecBtn = document.getElementById('stj_delete_execute');
        if (delCancelBtn) delCancelBtn.disabled = true;
        if (delExecBtn) delExecBtn.disabled = true;

        showMessageDialog('選択されたセルを一括削除します');

        setTimeout(() => {
            hideMessageDialog();
            showDeleteConfirmDialog(
                '本当に一括削除しますか？',
                () => {
                    isDialogActive = false;
                    if (delCancelBtn) delCancelBtn.disabled = false;
                    if (delExecBtn) delExecBtn.disabled = false;
                    document.querySelectorAll('.stj-keyword-item.stj-marked-for-delete').forEach(el => el.remove());
                    runLiveTest();
                    autoSave({ immediate: true });
                },
                () => {
                    isDialogActive = false;
                    if (delCancelBtn) delCancelBtn.disabled = false;
                    if (delExecBtn) delExecBtn.disabled = false;
                }
            );
        }, 1000);
    }

    // ============================================================
    // ★ ギャラリーからの画像削除通知(gic-image-deleted)を購読し、
    //    ・character.data.extensions.image_display_extension から該当ファイルを除去
    //    ・JSON 編集画面が開いていれば、全セルからも除去して autoSave
    //    ★ 空配列になったキーも保持する(セルとキーワードを残すため)。
    // ============================================================
    function setupImageDeletedListener() {
        if (window.__stjImageDeletedListenerInstalled) return;
        window.__stjImageDeletedListenerInstalled = true;

        window.addEventListener('gic-image-deleted', (e) => {
            const { charName, fileNames } = e.detail || {};
            if (!charName || !Array.isArray(fileNames) || fileNames.length === 0) return;

            const deleteSet = new Set(fileNames.map(n => String(n)));
            console.log(
                `[STJ Editor] 📢 gic-image-deleted 受信: ${fileNames.length} 件 (char="${charName}")`
            );

            // ── ① character.data.extensions.image_display_extension を直接クリーン ──
            //    エディタが閉じていてもデータを整合させる。
            //    これを怠ると、後からエディタを開いた時に削除済み画像が復活する。
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
                                // ★ 空配列でもキーを保持（セルとキーワードを残す）
                                if (filtered.length === 0) return [];
                                return filtered.length === 1 ? filtered[0] : filtered;
                            } else if (typeof v === 'string') {
                                const fn = extractFileNameFromPath(v);
                                if (fn) {
                                    const resolved = resolveThumbToOriginal(fn);
                                    if (deleteSet.has(fn) || deleteSet.has(resolved)) {
                                        dataChanged = true;
                                        // ★ 単一文字列 → 空配列に変換してキーを保持
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
                        // image-display.js に即時反映
                        try {
                            window.dispatchEvent(new CustomEvent('lbe-image-map-updated', {
                                detail: { charName, imageMap: newExt }
                            }));
                        } catch (e) { /* ignore */ }
                        console.log(
                            `[STJ Editor] 🧹 character.data から削除画像を除去して保存 ` +
                            `(${Object.keys(ext).length} → ${Object.keys(newExt).length} entries)`
                        );
                    }
                }
            } catch (e) {
                console.warn('[STJ Editor] character.data クリーンアップ失敗:', e);
            }

            // ── ② エディタが開いていて、対象キャラと一致するなら UI も更新 ──
            const nameEl = document.getElementById('stj_char_name_display');
            const editorCharName = nameEl ? nameEl.textContent : '';
            if (!editorCharName || editorCharName !== charName) {
                console.log(
                    `[STJ Editor] エディタのキャラと不一致のため UI 更新スキップ ` +
                    `(editor="${editorCharName}", deleted="${charName}")`
                );
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

                    // セルポップアップモーダルが開いていて対象セルならグリッド再描画
                    if (currentModalCell === cell && currentCellModal && currentCellModal.classList.contains('visible')) {
                        renderCellModalGrid(cell).catch(e => console.warn('[STJ Editor] render error:', e));
                    }
                }
            });

            if (removedCount > 0) {
                console.log(
                    `[STJ Editor] 🧹 ギャラリー削除に追従: ${removedCount} 件の画像を ${affectedCells} セルから除去`
                );
                // 変更を即時保存（キーワードからの画像登録解除を確定させる）
                autoSave({ immediate: true });
                try { runLiveTest(); } catch (e) { /* ignore */ }
            }
        });

        console.log('[STJ Editor] 📢 gic-image-deleted リスナーを設置しました');
    }

    function initStjEditor() {
        const context = getSTContext();
        if (!context) { setTimeout(initStjEditor, 500); return; }

        if (!stjModalEl || !document.body.contains(stjModalEl)) {
            createExportModal();
        }

        // ★ ギャラリーからの画像削除を購読
        setupImageDeletedListener();

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
            // ★ 手動で存在しないファイルを除去（デバッグ・復旧用）
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
        };

        console.log('[STJ Editor] JSONエディタAPIを公開しました（キャラ編集画面のボタンは廃止）');
    }

    $(document).ready(() => { initStjEditor(); });
})();
