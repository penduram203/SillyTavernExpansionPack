// stj_editor.js
(function() {
    const MODULE_NAME = 'stj_editor';

    const mediaCache = new Map();
    const MEDIA_CACHE_FALSE_TTL_MS = 3000;
    const MEDIA_CHECK_TIMEOUT_MS = 5000;

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

    // ===== セルデータヘルパー =====
    function getCellImages(cell) {
        try {
            const raw = cell.getAttribute('data-image-list');
            if (!raw) return [];
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return [];
            // ★ 有効な拡張子を持つファイル名のみ返す（Z / 9k= 等を除外）
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

    async function detectImageExtension(charName, fileNameWithExt) {
        if (!charName || !fileNameWithExt) return null;
        const path = fileNameWithExt.startsWith('user/images/')
            ? fileNameWithExt
            : `user/images/${charName}/${fileNameWithExt}`;
        const exists = await checkMediaExists(path);
        return exists ? path : null;
    }

    // ★ base64 データURI・クエリ・フラグメント・拡張子なし断片を除外
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

    function updateDragTarget(s, x, y) {
        const el = document.elementFromPoint(x, y);
        const target = el && el.closest ? el.closest('.stj-keyword-item') : null;
        const validTarget = (target && target !== s.sourceItem) ? target : null;
        if (s.currentTarget && s.currentTarget !== validTarget) {
            s.currentTarget.classList.remove('stj-drag-over');
        }
        s.currentTarget = validTarget;
        if (validTarget) validTarget.classList.add('stj-drag-over');
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
            updateDragTarget(s, e.clientX, e.clientY);
            updateAutoScroll(s.scrollContainer, e.clientY);
        });

        document.addEventListener('mouseup', () => {
            if (!pointerDragState) return;
            const s = pointerDragState;
            pointerDragState = null;
            stopAutoScroll();
            if (stjModalEl) stjModalEl.classList.remove('stj-drag-active');
            if (s.sourceItem) s.sourceItem.classList.remove('stj-dragging');
            if (s.currentTarget) s.currentTarget.classList.remove('stj-drag-over');
            removeDragGhost(s.ghostState);

            if (s.isDragging) {
                if (s.currentTarget && s.currentTarget !== s.sourceItem) {
                    swapCells(s.sourceItem, s.currentTarget);
                    runLiveTest();
                }
            } else {
                const src = s.sourceItem;
                if (!src) return;
                if (s.isBulkDelete || isBulkDeleteMode) {
                    if (src.classList.contains('stj-marked-for-delete')) src.classList.remove('stj-marked-for-delete');
                    else src.classList.add('stj-marked-for-delete');
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
            if (stjModalEl) stjModalEl.classList.remove('stj-drag-active');
            if (s.sourceItem) s.sourceItem.classList.remove('stj-dragging');
            if (s.currentTarget) s.currentTarget.classList.remove('stj-drag-over');
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
        const saveBtn = document.getElementById('stj_save_data');
        const cancelBtn = document.getElementById('stj_cancel_export');
        const exportBtn = document.getElementById('stj_export_json');

        if (addBtn) addBtn.style.display = 'none';
        if (bulkBtn) bulkBtn.style.display = 'none';
        if (delCancelBtn) delCancelBtn.style.display = '';
        if (delExecBtn) delExecBtn.style.display = '';
        if (saveBtn) saveBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = true;
        if (exportBtn) exportBtn.disabled = true;
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
        const saveBtn = document.getElementById('stj_save_data');
        const cancelBtn = document.getElementById('stj_cancel_export');
        const exportBtn = document.getElementById('stj_export_json');

        if (addBtn) addBtn.style.display = '';
        if (bulkBtn) bulkBtn.style.display = '';
        if (delCancelBtn) delCancelBtn.style.display = 'none';
        if (delExecBtn) delExecBtn.style.display = 'none';
        if (saveBtn) saveBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
        if (exportBtn) exportBtn.disabled = false;
        document.querySelectorAll('.stj-keyword-item .stj-delete-row').forEach(btn => btn.disabled = false);
    }

    function openExportModal() {
        if (!stjModalEl) return;
        if (stjModalEl.style.display === 'block') return;

        stjModalEl.style.display = 'block';
        stjModalEl.style.position = 'fixed';
        stjModalEl.style.top = '0px';
        stjModalEl.style.left = '480px';
        stjModalEl.style.width = 'calc(85vw - 200px)';
        stjModalEl.style.height = '100vh';
        stjModalEl.style.zIndex = '10001';
        stjModalEl.scrollTop = 0;
        document.body.classList.add('stj-editor-open');
        modalOpenedTimestamp = Date.now();

        const charName = detectCharacterNameFromDOM() || '';
        const nameEl = document.getElementById('stj_char_name_display');
        if (nameEl) nameEl.textContent = charName;

        (async () => {
            try {
                await loadExistingJSONData(charName);
                loadSavedData(charName);
                setupPreviewListeners();
                runLiveTest();
            } catch (err) { console.error('[STJ Editor] モーダル表示エラー:', err); }
        })();
    }

    function closeExportModalInternal() {
        if (!stjModalEl) return;
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
                    <span class="stj-cell-modal-number"></span>
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
                renderCellModalGrid(currentModalCell);
                updateCellPreview(currentModalCell);
            }
        });

        return modal;
    }

    // ★ requestAnimationFrame 二重化でレイアウト確定後にレンダリング
    function openCellModal(cell) {
        if (!cell) return;
        if (isBulkDeleteMode || isDialogActive) return;
        if (!currentCellModal) currentCellModal = createCellModal();

        currentModalCell = cell;
        modalOriginalImages = [...getCellImages(cell)];
        modalOriginalKeyword = getCellKeyword(cell);

        const isSpecial = cell.classList.contains('stj-special-item');
        const kwInput = currentCellModal.querySelector('.stj-cell-modal-keyword');
        const numberEl = currentCellModal.querySelector('.stj-cell-modal-number');
        const choicesBtn = currentCellModal.querySelector('.stj-cell-modal-choices');

        if (isSpecial) {
            kwInput.style.display = 'none';
            numberEl.style.display = 'none';
            if (choicesBtn) choicesBtn.style.display = 'none';
        } else {
            kwInput.style.display = '';
            numberEl.style.display = '';
            kwInput.value = modalOriginalKeyword;
            const allCells = Array.from(document.querySelectorAll('#stj_keywords_container .stj-keyword-item'));
            numberEl.textContent = String(allCells.indexOf(cell) + 1);
            if (choicesBtn) {
                choicesBtn.style.display = '';
                updateChoicesButtonState(cell).catch(e => console.warn('[STJ Editor] choices state error:', e));
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
                    renderCellModalGrid(cell);
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
    // ★ セルモーダル用: 動画サムネイルの IntersectionObserver
    //    ★ 静止画サムネイル化: play/pause 制御は行わない（no-op）
    // ============================================================
    let _cellVideoIO = null;
    let _cellVideoIORoot = null;

    function ensureCellVideoIO(grid) {
        if (_cellVideoIO && _cellVideoIORoot === grid) return _cellVideoIO;
        if (_cellVideoIO) {
            try { _cellVideoIO.disconnect(); } catch (e) { /* ignore */ }
        }
        _cellVideoIORoot = grid;
        // ★ 静止画サムネイルのため、IntersectionObserver による play/pause は行わない
        _cellVideoIO = new IntersectionObserver(() => { /* no-op */ }, {
            threshold: 0.1,
            root: grid,
        });
        return _cellVideoIO;
    }

    // ============================================================
    // ★ セルモーダル用パス解決（ギャラリーと同一方式）
    // ============================================================
    function resolveModalMediaPath(fileName, charName) {
        if (!fileName || typeof fileName !== 'string') return '';
        if (/^https?:\/\//i.test(fileName)) return fileName;
        if (fileName.startsWith('/')) return fileName;
        if (fileName.startsWith('user/images/')) return '/' + fileName;
        if (!charName) return '/' + fileName;
        return '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(fileName);
    }

    function renderCellModalGrid(cell) {
        if (!currentCellModal || !cell) return;
        const images = getCellImages(cell);
        const grid = currentCellModal.querySelector('.stj-cell-modal-grid');
        if (!grid) return;

        console.log('[STJ Grid] renderCellModalGrid called, images=', images);

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

        slots.forEach((slot, i) => {
            const fileName = images[i];

            console.log(`[STJ Grid] slot[${i}] fileName=`, fileName, 'isVideo=', fileName ? isVideoUrl(fileName) : false);

            if (!fileName) {
                slot.querySelectorAll(':scope > img, :scope > video').forEach(el => {
                    if (el.tagName === 'VIDEO') {
                        try { el.pause(); } catch (e) { /* ignore */ }
                    }
                    el.remove();
                });
                try { io.unobserve(slot); } catch (e) { /* ignore */ }
                slot.removeAttribute('data-file-name');
                delete slot.dataset.fileName;
                return;
            }

            const fullPath = resolveModalMediaPath(fileName, charName);
            const isVideo = isVideoUrl(fileName);
            slot.dataset.fileName = fileName;

            console.log(`[STJ Grid] slot[${i}] fullPath=`, fullPath, 'isVideo=', isVideo);

            const existing = slot.querySelector(':scope > img, :scope > video');
            if (existing) {
                const existingSrc = existing.getAttribute('data-src') || existing.getAttribute('src');
                const existingIsVideo = existing.tagName === 'VIDEO';
                if (existingIsVideo === isVideo && existingSrc === fullPath) {
                    // ★ 静止画化: 既存動画が paused でも再開しない
                    return;
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
                const v = document.createElement('video');
                v.className = 'gic-cell-video';
                v.dataset.src = fullPath;

                v.setAttribute('muted', '');
                v.setAttribute('loop', '');
                v.setAttribute('playsinline', '');
                v.setAttribute('webkit-playsinline', '');
                v.setAttribute('preload', 'auto');
                v.setAttribute('disablepictureinpicture', '');
                v.setAttribute('disableremoteplayback', '');
                v.muted = true;
                v.loop = true;
                v.playsInline = true;
                v.preload = 'auto';

                v.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#000;pointer-events:auto;cursor:zoom-in;';
                v.addEventListener('click', openZoom);

                v.addEventListener('loadstart', () => {
                    console.log('[STJ Video] loadstart:', fullPath);
                }, { once: true });
                v.addEventListener('loadedmetadata', () => {
                    console.log('[STJ Video] metadata:', fullPath, `${v.videoWidth}x${v.videoHeight}`);
                }, { once: true });
                v.addEventListener('loadeddata', () => {
                    // ★ 静止画サムネイル: 第一フレーム（冒頭10%・最大1秒）へシーク
                    try {
                        if (Number.isFinite(v.duration) && v.duration > 0.1) {
                            v.currentTime = Math.min(1, v.duration * 0.1);
                        } else {
                            v.currentTime = 0;
                        }
                    } catch (e) { /* ignore */ }
                    console.log('[STJ Video] loaded (static):', fullPath);
                }, { once: true });
                v.addEventListener('error', () => {
                    console.warn('[STJ Video] error:', fullPath, v.error?.code, v.error?.message);
                }, { once: true });

                v.src = fullPath;
                slot.insertBefore(v, slot.firstChild);

                // ★ 自動再生しない（静止画サムネイル）

                setTimeout(() => {
                    if (v.parentNode && v.readyState === 0) {
                        console.warn('[STJ Video] still not loaded after 3s:', fullPath, 'error=', v.error);
                        try {
                            const retrySrc = v.src;
                            v.src = '';
                            v.src = retrySrc;
                            v.load();
                        } catch (e) { /* ignore */ }
                    }
                }, 3000);

                io.observe(slot);
            } else {
                const img = document.createElement('img');
                img.src = fullPath;
                img.dataset.src = fullPath;
                img.alt = fileName;
                img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;pointer-events:auto;cursor:zoom-in;';
                img.addEventListener('click', openZoom);
                slot.insertBefore(img, slot.firstChild);
            }
        });
    }

    function showMediaZoom(src, isVideo) {
        const existing = document.getElementById('stj_media_zoom');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'stj_media_zoom';
        overlay.className = 'stj-media-zoom';

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'stj-media-zoom-close';
        closeBtn.textContent = '×';
        closeBtn.title = '閉じる (Esc / 外側クリック)';
        overlay.appendChild(closeBtn);

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
            if (e.target === closeBtn || closeBtn.contains(e.target)) {
                e.stopPropagation();
                e.preventDefault();
                close();
                return;
            }
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

        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            close();
        });

        document.addEventListener('keydown', onKeyDown);
        document.body.classList.add('stj-zoom-active');
        document.body.appendChild(overlay);

        // ★ 拡大表示はユーザー操作起点なので再生を許可
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
        const fileName = extractFileNameFromPath(path);
        if (!fileName) {
            console.log(`[STJ Editor] 無効なファイル名のためスキップ: ${String(path).slice(0, 80)}`);
            return;
        }
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
            renderCellModalGrid(cell);
        }

        try { runLiveTest(); } catch (_) {}
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
                        currentTarget: null, ghostState: null, scrollContainer: null
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
                    currentTarget: null, ghostState: null, scrollContainer: null
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
                });
            });
        }

        item.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            if (isBulkDeleteMode || isDialogActive) return;
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
    }

    async function loadExistingJSONData(charName) {
        if (!charName) return;
        try {
            const jsonPath = `user/images/${charName}/${charName}_ext.json`;
            const response = await fetch(jsonPath);
            if (response.ok) {
                const data = await response.json();
                const imageMap = findImageMapInData(data);
                if (imageMap) {
                    console.log(`✅ ${charName}_ext.json から既存データを読み込みました`);
                    populateFormFromImageMap(imageMap);
                }
            }
        } catch (e) {
            console.warn('既存JSONデータの取得に失敗しました:', e);
        }
    }

    function populateFormFromImageMap(imageMap) {
        const toFileNames = (val) => {
            const arr = Array.isArray(val) ? val : [val];
            return arr.map(p => extractFileNameFromPath(p)).filter(Boolean);
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

        const removeMedia = () => previewEl.querySelectorAll(':scope > img, :scope > video').forEach(el => {
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
            placeholderShowError();
            previewEl.dataset.currentPath = '__missing__';
            return;
        }
        const fullPath = await detectImageExtension(charName, fileName);
        if (_previewLoadGen.get(previewEl) !== myGen) return;

        if (fullPath === null) {
            removeMedia(); removeLoading();
            placeholderShowError();
            previewEl.dataset.currentPath = '__missing__';
            return;
        }

        if (previewEl.dataset.currentPath === fullPath) {
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
            // ★ 静止画プレビュー: 第一フレームのみ表示し、再生しない
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
                    // ★ 第一フレーム（冒頭10%・最大1秒）へシーク
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
                placeholderShowError();
                previewEl.dataset.currentPath = '__missing__';
                return;
            }
            video.style.width = '100%'; video.style.height = '100%';
            video.style.objectFit = 'contain'; video.style.display = 'block';
            video.style.backgroundColor = 'transparent';
            previewEl.appendChild(video);
            // ★ 再生しない（静止画プレビュー）
            previewEl.dataset.currentPath = fullPath;
            removeLoading(); placeholderHide();
        } else {
            const img = new Image();
            img.src = fullPath;
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
                placeholderShowError();
                previewEl.dataset.currentPath = '__missing__';
                return;
            }
            img.style.width = '100%'; img.style.height = '100%';
            img.style.objectFit = 'contain'; img.style.display = 'block';
            previewEl.appendChild(img);
            previewEl.dataset.currentPath = fullPath;
            removeLoading(); placeholderHide();
        }
    }

    function buildImageMapFromForm(charName) {
        const imageMap = {};
        const toPaths = (names) => names.map(name => `user/images/${charName}/${extractFileNameFromPath(name)}`);

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
            if (images.length === 0) return;
            const paths = toPaths(images);
            imageMap[kw] = paths.length === 1 ? paths[0] : paths;
        });

        return imageMap;
    }

    function exportJSON() {
        const nameEl = document.getElementById('stj_char_name_display');
        const charName = nameEl ? nameEl.textContent : '';
        if (!charName) { alert('キャラクター名が設定されていません'); return; }

        const imageMap = buildImageMapFromForm(charName);
        const exportData = { image_display_extension: imageMap };

        try {
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${charName}_ext.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showCustomAlert('JSONファイルを出力しました');
            console.log(`✅ ${charName}_ext.json を出力しました`, exportData);
        } catch (e) {
            console.error('[STJ Editor] JSON出力に失敗しました:', e);
            alert('JSON出力に失敗しました。詳細はコンソールを確認してください。');
        }
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

    function saveData() {
        const nameEl = document.getElementById('stj_char_name_display');
        const charName = nameEl ? nameEl.textContent : '';
        if (!charName) { alert('キャラクター名が設定されていません'); return; }

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

        const stjSettings = getExtensionSettings();
        stjSettings[charName] = data;
        persistSettings();
        showCustomAlert('データを保存しました');
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
            container.innerHTML = '';
            if (data.keywords && data.keywords.length > 0) {
                data.keywords.forEach((kw, index) => {
                    const images = kw.images || (kw.imageName ? parseImageNames(kw.imageName) : []);
                    addKeywordRowWithData(container, index, { keyword: kw.keyword, images });
                });
            }
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
                <div class="stj-button-group-left">
                    <button id="stj_save_data">セーブ</button>
                    <button id="stj_cancel_export">終了</button>
                    <button id="stj_export_json">JSON出力</button>
                </div>
                <div class="stj-button-group-right">
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

        const exportBtn = document.getElementById('stj_export_json');
        if (exportBtn) exportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isBulkDeleteMode || isDialogActive) return;
            exportJSON();
        });

        const saveBtn = document.getElementById('stj_save_data');
        if (saveBtn) saveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isBulkDeleteMode || isDialogActive) return;
            saveData();
        });

        modal.querySelectorAll('.stj-special-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                if (isBulkDeleteMode || isDialogActive) return;
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
                },
                () => {
                    isDialogActive = false;
                    if (delCancelBtn) delCancelBtn.disabled = false;
                    if (delExecBtn) delExecBtn.disabled = false;
                }
            );
        }, 1000);
    }

    function initStjEditor() {
        const context = getSTContext();
        if (!context) { setTimeout(initStjEditor, 500); return; }

        if (!stjModalEl || !document.body.contains(stjModalEl)) {
            createExportModal();
        }

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
        };

        console.log('[STJ Editor] JSONエディタAPIを公開しました（キャラ編集画面のボタンは廃止）');
    }

    $(document).ready(() => { initStjEditor(); });
})();
