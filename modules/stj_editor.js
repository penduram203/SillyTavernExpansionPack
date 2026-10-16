(function() {
    const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'mp4', 'webm'];
    const MODULE_NAME = 'stj_editor';

    const mediaCache = new Map();

    let stjModalEl = null;
    let stjButtonEl = null;
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

    // ===== 自動スクロール =====
    const AUTOSCROLL_EDGE_PX = 200;
    const AUTOSCROLL_MAX_SPEED = 35;
    let autoScrollRAF = null;
    let autoScrollTarget = null;
    let autoScrollDelta = 0;

    // ===== 一括削除モード =====
    let isBulkDeleteMode = false;
    let isDialogActive = false;

    function isVideoUrl(url) {
        if (!url || typeof url !== 'string') return false;
        return !!url.match(/\.(mp4|webm)$/i);
    }

    function getSTContext() {
        if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
            return window.SillyTavern.getContext();
        }
        return null;
    }

    function getExtensionSettings() {
        const context = getSTContext();
        if (!context || !context.extensionSettings) {
            console.warn('[STJ Editor] SillyTavern context が取得できませんでした。');
            return {};
        }
        if (!context.extensionSettings[MODULE_NAME]) {
            context.extensionSettings[MODULE_NAME] = {};
        }
        return context.extensionSettings[MODULE_NAME];
    }

    function persistSettings() {
        const context = getSTContext();
        if (context && typeof context.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
        } else {
            console.warn('[STJ Editor] saveSettingsDebounced が利用できないため設定を保存できませんでした。');
        }
    }

    function detectCharacterNameFromDOM() {
        const nameHolder = document.querySelector('#character_name_holder');
        if (nameHolder && nameHolder.textContent) return nameHolder.textContent.trim();
        const greetingMessage = document.querySelector('.mes[mesid="0"][is_user="false"]');
        if (greetingMessage && greetingMessage.getAttribute('ch_name')) return greetingMessage.getAttribute('ch_name');
        return null;
    }

    function checkMediaExists(mediaUrl) {
        if (mediaCache.has(mediaUrl)) {
            return Promise.resolve(mediaCache.get(mediaUrl));
        }

        return new Promise((resolve) => {
            if (isVideoUrl(mediaUrl)) {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.onloadedmetadata = () => {
                    mediaCache.set(mediaUrl, true);
                    resolve(true);
                };
                video.onerror = () => {
                    mediaCache.set(mediaUrl, false);
                    resolve(false);
                };
                video.src = mediaUrl;
            } else {
                const img = new Image();
                img.onload = () => {
                    mediaCache.set(mediaUrl, true);
                    resolve(true);
                };
                img.onerror = () => {
                    mediaCache.set(mediaUrl, false);
                    resolve(false);
                };
                img.src = mediaUrl;
            }
        });
    }

    async function detectImageExtension(charName, fileNameWithExt) {
        if (!charName || !fileNameWithExt) return null;
        const path = fileNameWithExt.startsWith('addchara/')
            ? fileNameWithExt
            : `addchara/${charName}/${fileNameWithExt}`;
        const exists = await checkMediaExists(path);
        return exists ? path : null;
    }

    function extractFileNameFromPath(path) {
        if (!path) return '';
        const parts = path.split('/');
        return parts[parts.length - 1];
    }

    function parseImageNames(input) {
        if (!input) return [];
        return input.split(',').map(name => name.trim()).filter(name => name.length > 0);
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

    // --- 条件評価エンジン ---
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

    function evaluateCondition(condStr, text) {
        if (!condStr || !text) return false;
        try {
            const normalized = normalizeConditionExpression(condStr);
            const tokens = tokenizeCondition(normalized);
            if (tokens.length === 0) return false;
            const ast = parseConditionTokens(tokens);
            return evaluateConditionNode(ast, text.toLowerCase());
        } catch (error) {
            console.error(`❌ 条件評価エラー "${condStr}":`, error);
            return false;
        }
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

    // ===== 拡張子入力ボタン =====
    function buildExtensionButtonsHtml() {
        return `
            <div class="stj-extension-buttons">
                <div class="stj-ext-row">
                    <button type="button" class="stj-ext-btn" data-ext=".png,">png</button>
                    <button type="button" class="stj-ext-btn" data-ext=".jpg,">jpg</button>
                    <button type="button" class="stj-ext-btn" data-ext=".webp,">webp</button>
                    <button type="button" class="stj-ext-btn" data-ext=".gif,">gif</button>
                    <button type="button" class="stj-ext-btn" data-ext=".avif,">avif</button>
                    <button type="button" class="stj-ext-btn" data-ext=".mp4,">mp4</button>
                    <button type="button" class="stj-ext-btn" data-ext=".webm,">webm</button>
                </div>
            </div>
        `;
    }

    function insertTextAtCursor(input, text) {
        if (!input || typeof text !== 'string') return;
        let start = input.selectionStart;
        let end = input.selectionEnd;
        if (typeof start !== 'number') start = input.value.length;
        if (typeof end !== 'number') end = input.value.length;
        const before = input.value.slice(0, start);
        const after = input.value.slice(end);
        input.value = before + text + after;
        const newPos = start + text.length;
        try {
            input.setSelectionRange(newPos, newPos);
        } catch (err) { /* ignore */ }
    }

    function setupExtensionButtons(input) {
        if (!input) return;
        if (input.dataset.extButtonsSetup === 'true') return;
        input.dataset.extButtonsSetup = 'true';

        const group = input.closest('.stj-input-group');
        if (!group) return;
        const panel = group.querySelector('.stj-extension-buttons');
        if (!panel) return;

        input.addEventListener('focus', () => {
            panel.classList.add('stj-visible');
        });

        input.addEventListener('blur', () => {
            panel.classList.remove('stj-visible');
        });

        panel.addEventListener('mousedown', (e) => {
            e.preventDefault();
        });

        panel.querySelectorAll('.stj-ext-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                const ext = btn.getAttribute('data-ext') || '';
                insertTextAtCursor(input, ext);
                try { input.focus(); } catch (err) { /* ignore */ }
                try {
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                } catch (err) {
                    runLiveTest();
                }
            });
        });
    }

    // ===== 編集スナップショット =====
    function saveEditSnapshot(item) {
        if (!item) return;
        const kw = item.querySelector('.stj-keyword-input');
        const img = item.querySelector('.stj-image-input');
        item.dataset.originalKeyword = kw ? kw.value : '';
        item.dataset.originalImage = img ? img.value : '';
    }

    function restoreEditSnapshot(item) {
        if (!item) return;
        const kw = item.querySelector('.stj-keyword-input');
        const img = item.querySelector('.stj-image-input');
        if (kw && item.dataset.originalKeyword !== undefined) {
            kw.value = item.dataset.originalKeyword;
        }
        if (img && item.dataset.originalImage !== undefined) {
            img.value = item.dataset.originalImage;
        }
    }

    // ===== ダイアログ =====
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

    // ===== 自動スクロール =====
    function findScrollableAncestor(el) {
        let cur = el ? el.parentElement : null;
        while (cur && cur !== document.body && cur !== document.documentElement) {
            const style = window.getComputedStyle(cur);
            const oy = style.overflowY;
            if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay')
                && cur.scrollHeight > cur.clientHeight + 1) {
                return cur;
            }
            cur = cur.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    }

    function stopAutoScroll() {
        if (autoScrollRAF) {
            cancelAnimationFrame(autoScrollRAF);
            autoScrollRAF = null;
        }
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
        if (!container) {
            stopAutoScroll();
            return;
        }
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
            if (!autoScrollRAF) {
                autoScrollRAF = requestAnimationFrame(autoScrollStep);
            }
        } else {
            stopAutoScroll();
        }
    }

    function updateDragTarget(s, x, y) {
        const el = document.elementFromPoint(x, y);
        const target = el && el.closest ? el.closest('.stj-keyword-item') : null;
        const validTarget = (target && target !== s.sourceItem) ? target : null;

        if (s.currentTarget && s.currentTarget !== validTarget) {
            s.currentTarget.classList.remove('stj-drag-over');
        }
        s.currentTarget = validTarget;
        if (validTarget) {
            validTarget.classList.add('stj-drag-over');
        }
    }

    // ===== ドラッグゴースト =====
    function createDragGhost(sourceItem, cursorX, cursorY) {
        const previewEl = sourceItem.querySelector('.stj-image-preview');
        if (!previewEl) return null;

        const rect = previewEl.getBoundingClientRect();

        const ghost = document.createElement('div');
        ghost.className = 'stj-drag-ghost';

        const container = sourceItem.parentNode;
        if (container) {
            const items = Array.from(container.querySelectorAll('.stj-keyword-item'));
            const num = items.indexOf(sourceItem) + 1;
            ghost.dataset.cellNum = String(num);
        }

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
                cloned.muted = true;
                cloned.autoplay = true;
                cloned.loop = true;
                cloned.playsInline = true;
                cloned.play().catch(() => {});
            }
            ghost.appendChild(cloned);
        } else {
            const fallback = document.createElement('div');
            fallback.textContent = 'プレビュー';
            fallback.style.position = 'absolute';
            fallback.style.top = '50%';
            fallback.style.left = '50%';
            fallback.style.transform = 'translate(-50%, -50%)';
            fallback.style.color = '#a0aec0';
            fallback.style.fontSize = '14px';
            fallback.style.pointerEvents = 'none';
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
        if (ghostState.el && ghostState.el.parentNode) {
            ghostState.el.parentNode.removeChild(ghostState.el);
        }
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
                    if (src.classList.contains('stj-marked-for-delete')) {
                        src.classList.remove('stj-marked-for-delete');
                    } else {
                        src.classList.add('stj-marked-for-delete');
                    }
                    return;
                }
                if (!src.classList.contains('editing')) {
                    saveEditSnapshot(src);
                    src.classList.add('editing');
                }
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

    // ===== 一括削除モード =====
    function enterBulkDeleteMode() {
        if (isBulkDeleteMode) return;
        isBulkDeleteMode = true;

        document.querySelectorAll('.stj-keyword-item.editing').forEach(el => {
            el.classList.remove('editing');
        });

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

        document.querySelectorAll('.stj-keyword-item .stj-apply-row, .stj-keyword-item .stj-cancel-row, .stj-keyword-item .stj-delete-row').forEach(btn => {
            btn.disabled = true;
        });
    }

    function exitBulkDeleteMode() {
        if (!isBulkDeleteMode) return;
        isBulkDeleteMode = false;
        isDialogActive = false;

        document.querySelectorAll('.stj-keyword-item.stj-marked-for-delete').forEach(el => {
            el.classList.remove('stj-marked-for-delete');
        });

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

        document.querySelectorAll('.stj-keyword-item .stj-apply-row, .stj-keyword-item .stj-cancel-row, .stj-keyword-item .stj-delete-row').forEach(btn => {
            btn.disabled = false;
        });
    }

    function createExportButton() {
        const buttonContainer = document.querySelector('#rm_ch_create_block .form_create_bottom_buttons_block');
        if (!buttonContainer) return;

        if (stjButtonEl && document.body.contains(stjButtonEl)) {
            if (stjButtonEl.parentNode !== buttonContainer) {
                buttonContainer.prepend(stjButtonEl);
            }
        } else {
            const exportButton = document.createElement('button');
            exportButton.id = 'stj_export_button';
            exportButton.textContent = 'JSONデータ編集';
            exportButton.className = 'menu_button';
            exportButton.addEventListener('click', handleExportButtonClick, true);
            buttonContainer.prepend(exportButton);
            stjButtonEl = exportButton;
        }

        if (!stjModalEl || !document.body.contains(stjModalEl)) {
            createExportModal();
        }
    }

    function handleExportButtonClick(e) {
        e.stopImmediatePropagation();
        e.preventDefault();
        openExportModal();
    }

    function openExportModal() {
        if (!stjModalEl) return;

        stjModalEl.style.display = 'block';
        stjModalEl.style.position = 'fixed';
        stjModalEl.style.top = '0px';
        stjModalEl.style.left = '0vw';
        stjModalEl.style.width = '85vw';
        stjModalEl.style.height = '100vh';
        stjModalEl.style.zIndex = '10001';
        stjModalEl.scrollTop = 0;

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
            } catch (err) {
                console.error('[STJ Editor] モーダル表示エラー:', err);
            }
        })();
    }

    function closeExportModal() {
        if (!stjModalEl) return;
        if (isBulkDeleteMode || isDialogActive) return;
        stjModalEl.style.display = 'none';
    }

    const applyBtnStyle = 'margin: 0; padding: 5px 14px; font-size: 13px; font-weight: bold; color: #000000; background-color: #e0e0e0; border: 1px solid #aaa; border-radius: 4px; cursor: pointer; white-space: nowrap;';

    function buildCellActionRowHtml() {
        return `
            <div class="stj-cell-action-row">
                <button type="button" class="stj-apply-row" style="${applyBtnStyle}">決定</button>
                <button type="button" class="stj-cancel-row">キャンセル</button>
            </div>
        `;
    }

    function buildSyntaxGuideHtml() {
        return `
            <div class="stj-guide-section">
                <div class="stj-guide-section-title">🔧 基本演算子</div>
                <ul class="stj-guide-list">
                    <li>
                        <code class="stj-op">+</code> <b>AND</b>（全て含む）
                        <div class="stj-op-ex">
                            例：<code>山+川</code> → 文章に「山」と「川」の両方が含まれる時にマッチ
                        </div>
                    </li>
                    <li>
                        <code class="stj-op">,</code> <b>OR</b>（いずれか含む）
                        <div class="stj-op-ex">
                            例：<code>山,川</code> → 文章に「山」または「川」のどちらかが含まれる時にマッチ
                        </div>
                    </li>
                    <li>
                        <code class="stj-op">!</code> <b>NOT</b>（除外）
                        <div class="stj-op-ex">
                            例：<code>!山</code> → 文章に「山」が含まれていない時にのみマッチ
                        </div>
                    </li>
                    <li>
                        <code class="stj-op">( )</code> <b>グループ化</b>（入れ子可能）
                        <div class="stj-op-ex">
                            例：<code>(山+川),谷</code> → 「山と川」または「谷」のいずれかにマッチ
                        </div>
                    </li>
                    <li>
                        <code class="stj-op">and</code> <code class="stj-op">or</code> <code class="stj-op">not</code> <b>単語形式も使用可</b>
                        <div class="stj-op-ex">
                            例：<code>山 and 川</code> は <code>山+川</code> と同じ意味になります
                        </div>
                    </li>
                </ul>
            </div>
            <div class="stj-guide-section">
                <div class="stj-guide-section-title">🧪 複合例（実践的な条件式）</div>
                <ul class="stj-guide-list">
                    <li>
                        <code>(山+川),(谷+村)</code>
                        <div class="stj-op-ex">
                            「山と川」または「谷と村」のいずれかにマッチします
                        </div>
                    </li>
                    <li>
                        <code>!(山,川)+道</code>
                        <div class="stj-op-ex">
                            「山」も「川」も含まず、かつ「道」が含まれる時にマッチします
                        </div>
                    </li>
                    <li>
                        <code>(笑+嬉)+!(泣+悲)</code>
                        <div class="stj-op-ex">
                            「笑」と「嬉」の両方を含み、かつ「泣」も「悲」も含まない時にマッチします
                        </div>
                    </li>
                    <li>
                        <code>!(犬,猫,鳥),ペット</code>
                        <div class="stj-op-ex">
                            「犬」「猫」「鳥」のいずれも含まず、「ペット」を含む時にマッチします
                        </div>
                    </li>
                    <li>
                        <code>((山+川)+(谷+村)),海</code>
                        <div class="stj-op-ex">
                            カッコは入れ子にできます。「山と川と谷と村」の全部、または「海」にマッチします
                        </div>
                    </li>
                </ul>
            </div>
            <div class="stj-guide-section">
                <div class="stj-guide-section-title">💡 ヒント</div>
                <ul class="stj-guide-list">
                    <li>
                        <b>複雑な条件ほど優先</b>
                        <div class="stj-op-ex">
                            同じ文章に複数の条件がマッチした場合、より複雑な条件が優先されます
                        </div>
                    </li>
                    <li>
                        <b>NOT単独でも使用可</b>
                        <div class="stj-op-ex">
                            <code>!民家</code> のように、除外条件だけを指定することもできます
                        </div>
                    </li>
                </ul>
            </div>
        `;
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
                <div class="stj-syntax-guide" id="stj_syntax_guide">
                    ${buildSyntaxGuideHtml()}
                </div>
                <textarea id="stj_test_input" placeholder="試しに文章を入力してください（例：笑顔で挨拶する）..."></textarea>
                <div id="stj_test_result">
                    判定結果: <span style="color: #aaa; font-weight: normal;">文章を入力するとヒットするキーワードが表示されます</span>
                </div>
            </div>

            <div class="stj-top-section">
                <div class="stj-special-container">
                    <div class="stj-special-item">
                        <div class="stj-special-preview">
                            <div class="stj-image-preview" id="stj_preview_default" style="position: relative;">
                                <div class="stj-preview-text">デフォルトメディアプレビュー</div>
                            </div>
                        </div>
                        <div class="stj-special-inputs">
                            <div class="stj-input-group">
                                <label for="stj_default_image">ファイル名</label>
                                <input type="text" id="stj_default_image" value="defa" class="stj-image-input" placeholder="複数ファイルはカンマ区切り">
                                ${buildExtensionButtonsHtml()}
                                <div>
                                    <button type="button" class="stj-apply-special" data-target="default" style="${applyBtnStyle}">決定</button>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="stj-special-item">
                        <div class="stj-special-preview">
                            <div class="stj-image-preview" id="stj_preview_thumbnail" style="position: relative;">
                                <div class="stj-preview-text">サムネイルプレビュー</div>
                            </div>
                        </div>
                        <div class="stj-special-inputs">
                            <div class="stj-input-group">
                                <label for="stj_thumbnail_image">ファイル名</label>
                                <input type="text" id="stj_thumbnail_image" value="thum" class="stj-image-input" placeholder="複数ファイルはカンマ区切り">
                                ${buildExtensionButtonsHtml()}
                                <div>
                                    <button type="button" class="stj-apply-special" data-target="thumbnail" style="${applyBtnStyle}">決定</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="stj-info-panel">
                    <div class="stj-info-note">※複数ファイルはカンマ区切りで入力（例: image1,video1,image2）</div>
                    <div class="stj-info-guide">
                        <h4>📖 操作方法</h4>
                        <ul class="stj-guide-ops">
                            <li><b>セルをクリック</b>：編集モードに入りキーワードとファイル名を編集できます</li>
                            <li><b>セルをドラッグ</b>：他のセルと位置を入れ替えられます</li>
                            <li><b>プレビューの左右ボタン</b>：複数ファイルを切り替えられます</li>
                            <li><b>❌ボタン</b>：セルを削除します（確認あり）</li>
                            <li><b>ファイル名入力欄をフォーカス</b>：拡張子入力ボタンが出現します</li>
                            <li><b>一括削除</b>：複数のセルを選択してまとめて削除します</li>
                            <li><b>キーワード追加</b>：新しいセルを追加します</li>
                        </ul>
                    </div>
                </div>
            </div>
            <div id="stj_keywords_container" class="stj-grid-container">
                <div class="stj-keyword-item editing">
                    <div class="stj-image-preview" id="stj_preview_0" style="position: relative;">
                        <div class="stj-preview-text">プレビュー</div>
                    </div>
                    <div class="stj-inputs-container">
                        ${buildCellActionRowHtml()}
                        <div class="stj-input-row">
                            <button class="stj-delete-row">×</button>
                            <div class="stj-input-group stj-keyword-width">
                                <label for="stj_keywords_0">キーワード</label>
                                <input type="text" id="stj_keywords_0" class="stj-keyword-input">
                            </div>
                        </div>
                        <div class="stj-input-row">
                            <div class="stj-input-group stj-image-width">
                                <label for="stj_image_name_0">ファイル名</label>
                                <input type="text" id="stj_image_name_0" class="stj-image-input" placeholder="複数ファイルはカンマ区切り">
                                ${buildExtensionButtonsHtml()}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="stj-button-group">
                <div class="stj-button-group-left">
                    <button id="stj_add_keyword">キーワード追加</button>
                    <button id="stj_bulk_delete">一括削除</button>
                    <button id="stj_delete_cancel" style="display:none;">削除キャンセル</button>
                    <button id="stj_delete_execute" style="display:none;">削除実行</button>
                </div>
                <div class="stj-button-group-right">
                    <button id="stj_save_data">セーブ</button>
                    <button id="stj_cancel_export">キャンセル</button>
                    <button id="stj_export_json">JSON出力</button>
                </div>
            </div>

            <div id="stj_confirm_dialog">
                <div class="stj-confirm-box">
                    <div class="stj-confirm-message">本当に削除しますか？</div>
                    <div class="stj-confirm-buttons">
                        <button type="button" class="stj-confirm-yes">はい</button>
                        <button type="button" class="stj-confirm-no">いいえ</button>
                    </div>
                </div>
            </div>

            <div id="stj_message_dialog">
                <div class="stj-message-box">
                    <div class="stj-message-text"></div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        stjModalEl = modal;
        confirmDialogEl = modal.querySelector('#stj_confirm_dialog');
        messageDialogEl = modal.querySelector('#stj_message_dialog');

        if (confirmDialogEl) {
            confirmDialogEl.addEventListener('click', (e) => e.stopPropagation());
            confirmDialogEl.querySelector('.stj-confirm-yes').addEventListener('click', (e) => {
                e.stopPropagation();
                const cb = pendingDeleteCallback;
                hideDeleteConfirmDialog();
                if (typeof cb === 'function') {
                    try { cb(); } catch (err) { console.error(err); }
                }
            });
            confirmDialogEl.querySelector('.stj-confirm-no').addEventListener('click', (e) => {
                e.stopPropagation();
                const cancelCb = pendingCancelCallback;
                hideDeleteConfirmDialog();
                if (typeof cancelCb === 'function') {
                    try { cancelCb(); } catch (err) { console.error(err); }
                }
            });
        }

        if (messageDialogEl) {
            messageDialogEl.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
            });
        }

        modal.addEventListener('click', (e) => e.stopPropagation());

        const testInput = document.getElementById('stj_test_input');
        if (testInput) {
            testInput.addEventListener('input', runLiveTest);
        }

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
        if (addBtn) {
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isBulkDeleteMode || isDialogActive) return;
                addKeywordRow(modal);
            });
        }

        const bulkDeleteBtn = document.getElementById('stj_bulk_delete');
        if (bulkDeleteBtn) {
            bulkDeleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isBulkDeleteMode || isDialogActive) return;
                enterBulkDeleteMode();
            });
        }

        const delCancelBtn = document.getElementById('stj_delete_cancel');
        if (delCancelBtn) {
            delCancelBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!isBulkDeleteMode) return;
                if (isDialogActive) return;
                exitBulkDeleteMode();
            });
        }

        const delExecBtn = document.getElementById('stj_delete_execute');
        if (delExecBtn) {
            delExecBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!isBulkDeleteMode) return;
                if (isDialogActive) return;
                executeBulkDelete();
            });
        }

        const cancelBtn = document.getElementById('stj_cancel_export');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isBulkDeleteMode || isDialogActive) return;
                closeExportModal();
            });
        }

        const exportBtn = document.getElementById('stj_export_json');
        if (exportBtn) {
            exportBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isBulkDeleteMode || isDialogActive) return;
                exportJSON();
            });
        }

        const saveBtn = document.getElementById('stj_save_data');
        if (saveBtn) {
            saveBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isBulkDeleteMode || isDialogActive) return;
                saveData();
            });
        }

        modal.querySelectorAll('.stj-apply-special').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (isBulkDeleteMode || isDialogActive) return;
                const charName = document.getElementById('stj_char_name_display').textContent;
                const target = this.getAttribute('data-target');
                if (target === 'default') {
                    updateImagePreview('stj_preview_default', charName, document.getElementById('stj_default_image')?.value);
                } else if (target === 'thumbnail') {
                    updateImagePreview('stj_preview_thumbnail', charName, document.getElementById('stj_thumbnail_image')?.value);
                }
            });
        });

        setupExtensionButtons(document.getElementById('stj_default_image'));
        setupExtensionButtons(document.getElementById('stj_thumbnail_image'));

        const firstItem = modal.querySelector('.stj-keyword-item');
        if (firstItem) {
            attachKeywordRowListeners(firstItem, 0);
            saveEditSnapshot(firstItem);
        }

        installPointerDragHandlers();

        if (!outsideClickHandlerInstalled) {
            outsideClickHandlerInstalled = true;
            document.addEventListener('mousedown', (e) => {
                if (!stjModalEl) return;
                if (stjModalEl.style.display !== 'block') return;
                if (isBulkDeleteMode || isDialogActive) return;
                if (Date.now() - modalOpenedTimestamp < MODAL_OPEN_GUARD_MS) return;
                if (stjModalEl.contains(e.target)) return;
                if (stjButtonEl && stjButtonEl.contains(e.target)) return;
                closeExportModal();
            }, true);
        }
    }

    // ===== 一括削除の実行フロー =====
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

                    const targets = document.querySelectorAll('.stj-keyword-item.stj-marked-for-delete');
                    targets.forEach(el => el.remove());
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

    function attachKeywordRowListeners(item, index) {
        const previewEl = item.querySelector('.stj-image-preview');
        if (previewEl) {
            previewEl.addEventListener('mousedown', function(e) {
                if (e.button !== 0) return;

                const target = e.target;
                if (target && target.closest && target.closest('button')) {
                    return;
                }

                if (isBulkDeleteMode) {
                    e.preventDefault();
                    e.stopPropagation();
                    pointerDragState = {
                        sourceItem: item,
                        startX: e.clientX,
                        startY: e.clientY,
                        lastX: e.clientX,
                        lastY: e.clientY,
                        isDragging: false,
                        isBulkDelete: true,
                        currentTarget: null,
                        ghostState: null,
                        scrollContainer: null
                    };
                    return;
                }

                if (item.classList.contains('editing')) return;

                e.preventDefault();
                e.stopPropagation();
                pointerDragState = {
                    sourceItem: item,
                    startX: e.clientX,
                    startY: e.clientY,
                    lastX: e.clientX,
                    lastY: e.clientY,
                    isDragging: false,
                    isBulkDelete: false,
                    currentTarget: null,
                    ghostState: null,
                    scrollContainer: null
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

        const applyButton = item.querySelector('.stj-apply-row');
        if (applyButton) {
            applyButton.addEventListener('click', function(e) {
                e.stopPropagation();
                if (isBulkDeleteMode || isDialogActive) return;
                updateSinglePreviewByItem(item);
                item.classList.remove('editing');
            });
        }

        const cancelButton = item.querySelector('.stj-cancel-row');
        if (cancelButton) {
            cancelButton.addEventListener('click', function(e) {
                e.stopPropagation();
                if (isBulkDeleteMode || isDialogActive) return;
                restoreEditSnapshot(item);
                item.classList.remove('editing');
                runLiveTest();
            });
        }

        const inputs = item.querySelectorAll('input');
        inputs.forEach(input => {
            input.addEventListener('input', runLiveTest);
            input.addEventListener('keydown', function(e) {
                if (e.key !== 'Enter') return;
                if (e.shiftKey) return;
                if (e.isComposing || e.keyCode === 229) return;
                if (isBulkDeleteMode || isDialogActive) return;
                e.preventDefault();
                e.stopPropagation();
                updateSinglePreviewByItem(item);
                item.classList.remove('editing');
            });
        });

        const imageInput = item.querySelector('.stj-image-input');
        if (imageInput) {
            setupExtensionButtons(imageInput);
        }
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
            testResult.innerHTML = '判定結果: <span style="color: #aaa; font-weight: normal;">文章を入力するとヒットするキーワードが表示されます</span>';
            return;
        }

        const candidates = [];
        items.forEach(item => {
            const kwInput = item.querySelector('.stj-keyword-input');
            const imgInput = item.querySelector('.stj-image-input');
            if (!kwInput || !imgInput) return;
            const kw = kwInput.value.trim();
            if (!kw) return;

            candidates.push({
                element: item,
                keyword: kw,
                imageName: imgInput.value.trim(),
                complexity: calcConditionComplexity(kw)
            });
        });
        candidates.sort((a, b) => b.complexity - a.complexity);

        let matched = null;
        for (const c of candidates) {
            try {
                if (evaluateCondition(c.keyword, text)) {
                    matched = c;
                    break;
                }
            } catch (e) {
                console.error(`条件評価エラー "${c.keyword}":`, e);
            }
        }

        if (matched) {
            testResult.innerHTML = `判定結果: <span style="color: #64b5f6; font-size: 16px;">「${matched.keyword}」</span> にマッチしました！ (ファイル: ${matched.imageName || '未指定'})`;
            matched.element.style.border = '2px solid #64b5f6';
            matched.element.style.backgroundColor = 'rgba(100, 181, 246, 0.15)';
        } else {
            const defaultImg = document.getElementById('stj_default_image')?.value.trim();
            testResult.innerHTML = `判定結果: <span style="color: #ffb74d;">一致するキーワードがありません（デフォルト「${defaultImg || 'defa'}」が適用されます）</span>`;
        }
    }

    function addKeywordRow(modal) {
        const container = modal.querySelector('#stj_keywords_container');
        const itemCount = container.querySelectorAll('.stj-keyword-item').length;
        const newItem = document.createElement('div');
        newItem.className = 'stj-keyword-item editing';
        newItem.innerHTML = `
            <div class="stj-image-preview" id="stj_preview_${itemCount}" style="position: relative;">
                <div class="stj-preview-text">プレビュー</div>
            </div>
            <div class="stj-inputs-container">
                ${buildCellActionRowHtml()}
                <div class="stj-input-row">
                    <button class="stj-delete-row">×</button>
                    <div class="stj-input-group stj-keyword-width">
                        <label for="stj_keywords_${itemCount}">キーワード</label>
                        <input type="text" id="stj_keywords_${itemCount}" class="stj-keyword-input">
                    </div>
                </div>
                <div class="stj-input-row">
                    <div class="stj-input-group stj-image-width">
                        <label for="stj_image_name_${itemCount}">ファイル名</label>
                        <input type="text" id="stj_image_name_${itemCount}" class="stj-image-input" placeholder="複数ファイルはカンマ区切り">
                        ${buildExtensionButtonsHtml()}
                    </div>
                </div>
            </div>
        `;
        container.appendChild(newItem);

        attachKeywordRowListeners(newItem, itemCount);
        saveEditSnapshot(newItem);

        modal.scrollTop = modal.scrollHeight;
        setTimeout(() => updateSinglePreviewByItem(newItem), 100);
        runLiveTest();
    }

    async function loadExistingJSONData(charName) {
        if (!charName) return;
        try {
            const jsonPath = `addchara/${charName}/${charName}_ext.json`;
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
        const toInputValue = (val) => {
            const arr = Array.isArray(val) ? val : [val];
            return arr.map(p => extractFileNameFromPath(p)).join(',');
        };

        if (imageMap.default !== undefined) {
            const el = document.getElementById('stj_default_image');
            if (el) el.value = toInputValue(imageMap.default);
        }
        if (imageMap.thumbnail !== undefined) {
            const el = document.getElementById('stj_thumbnail_image');
            if (el) el.value = toInputValue(imageMap.thumbnail);
        }

        const container = document.getElementById('stj_keywords_container');
        if (!container) return;
        container.innerHTML = '';
        let index = 0;
        Object.entries(imageMap).forEach(([key, val]) => {
            if (key === 'default' || key === 'thumbnail') return;
            addKeywordRowWithData(container, index, { keyword: key, imageName: toInputValue(val) });
            index++;
        });
        if (index === 0) {
            addKeywordRowWithData(container, 0, { keyword: '', imageName: '' });
        }
    }

    function setupPreviewListeners() {
        updatePreview();
    }

    async function updatePreview() {
        const nameEl = document.getElementById('stj_char_name_display');
        if (!nameEl) return;
        const charName = nameEl.textContent;
        await updateImagePreview('stj_preview_default', charName, document.getElementById('stj_default_image')?.value);
        await updateImagePreview('stj_preview_thumbnail', charName, document.getElementById('stj_thumbnail_image')?.value);
        const keywordItems = document.querySelectorAll('.stj-keyword-item');
        for (const item of keywordItems) {
            await updateSinglePreviewByItem(item);
        }
    }

    async function updateSinglePreviewByItem(item) {
        if (!item) return;
        const nameEl = document.getElementById('stj_char_name_display');
        if (!nameEl) return;
        const charName = nameEl.textContent;
        const imageInput = item.querySelector('.stj-image-input');
        const previewEl = item.querySelector('.stj-image-preview');
        if (!imageInput || !previewEl) return;
        await updateImagePreview(previewEl.id, charName, imageInput.value);
    }

    function attachPreviewNavButtonGuards(btn) {
        const stopAll = (e) => {
            e.stopPropagation();
            if (e.type === 'mousedown') {
                e.preventDefault();
            }
        };
        btn.addEventListener('mousedown', stopAll);
        btn.addEventListener('mouseup', stopAll);
        btn.addEventListener('dblclick', stopAll);
    }

    async function updateImagePreview(previewId, charName, rawValue, targetIndex = 0) {
        const previewEl = document.getElementById(previewId);
        if (!previewEl) return;

        previewEl.style.position = 'relative';

        const imageNames = parseImageNames(rawValue);
        if (!charName || imageNames.length === 0) {
            previewEl.innerHTML = '<div class="stj-preview-text">プレビュー</div>';
            delete previewEl.dataset.currentIndex;
            return;
        }

        let currentIndex = targetIndex;
        if (currentIndex < 0) currentIndex = imageNames.length - 1;
        if (currentIndex >= imageNames.length) currentIndex = 0;
        previewEl.dataset.currentIndex = currentIndex;

        const fileName = extractFileNameFromPath(imageNames[currentIndex]);
        const fullPath = await detectImageExtension(charName, fileName);

        if (fullPath !== null) {
            let mediaHtml = '';
            if (isVideoUrl(fullPath)) {
                mediaHtml = `
                    <video src="${fullPath}" autoplay loop muted playsinline preload="auto"
                           style="width: 100%; height: 100%; object-fit: contain; display: block; background-color: rgba(0,0,0,0.4);">
                    </video>`;
            } else {
                mediaHtml = `
                    <img src="${fullPath}" alt="${fileName}"
                         style="width: 100%; height: 100%; object-fit: contain; display: block;">`;
            }

            previewEl.innerHTML = mediaHtml;

            if (isVideoUrl(fullPath)) {
                const vid = previewEl.querySelector('video');
                if (vid) vid.play().catch(() => {});
            }

            if (imageNames.length > 1) {
                const leftButton = document.createElement('button');
                leftButton.innerHTML = '←';
                leftButton.type = 'button';
                leftButton.style.position = 'absolute';
                leftButton.style.left = '5px';
                leftButton.style.top = '50%';
                leftButton.style.transform = 'translateY(-50%)';
                leftButton.style.zIndex = '25';
                leftButton.style.background = 'rgba(0,0,0,0.65)';
                leftButton.style.color = 'white';
                leftButton.style.border = '2px solid rgba(255,255,255,0.6)';
                leftButton.style.borderRadius = '4px';
                leftButton.style.padding = '5px 10px';
                leftButton.style.cursor = 'pointer';
                leftButton.style.pointerEvents = 'auto';
                attachPreviewNavButtonGuards(leftButton);
                leftButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    updateImagePreview(previewId, charName, rawValue, currentIndex - 1);
                });
                previewEl.appendChild(leftButton);

                const rightButton = document.createElement('button');
                rightButton.innerHTML = '→';
                rightButton.type = 'button';
                rightButton.style.position = 'absolute';
                rightButton.style.right = '5px';
                rightButton.style.top = '50%';
                rightButton.style.transform = 'translateY(-50%)';
                rightButton.style.zIndex = '25';
                rightButton.style.background = 'rgba(0,0,0,0.65)';
                rightButton.style.color = 'white';
                rightButton.style.border = '2px solid rgba(255,255,255,0.6)';
                rightButton.style.borderRadius = '4px';
                rightButton.style.padding = '5px 10px';
                rightButton.style.cursor = 'pointer';
                rightButton.style.pointerEvents = 'auto';
                attachPreviewNavButtonGuards(rightButton);
                rightButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    updateImagePreview(previewId, charName, rawValue, currentIndex + 1);
                });
                previewEl.appendChild(rightButton);

                const indexDisplay = document.createElement('div');
                indexDisplay.style.position = 'absolute';
                indexDisplay.style.bottom = '5px';
                indexDisplay.style.left = '50%';
                indexDisplay.style.transform = 'translateX(-50%)';
                indexDisplay.style.zIndex = '25';
                indexDisplay.style.background = 'rgba(0,0,0,0.65)';
                indexDisplay.style.color = 'white';
                indexDisplay.style.padding = '2px 8px';
                indexDisplay.style.borderRadius = '3px';
                indexDisplay.style.fontSize = '12px';
                indexDisplay.style.pointerEvents = 'none';
                indexDisplay.textContent = `${currentIndex + 1}/${imageNames.length}`;
                previewEl.appendChild(indexDisplay);
            }
        } else {
            previewEl.innerHTML = '<div class="stj-preview-text stj-preview-error">ファイルが見つかりません</div>';
        }
    }

    function buildImageMapFromForm(charName) {
        const toPaths = (raw) => parseImageNames(raw).map(name => `addchara/${charName}/${extractFileNameFromPath(name)}`);
        const imageMap = {};

        const defaultPaths = toPaths(document.getElementById('stj_default_image').value);
        if (defaultPaths.length > 0) {
            imageMap.default = defaultPaths.length === 1 ? defaultPaths[0] : defaultPaths;
        }

        const thumbnailPaths = toPaths(document.getElementById('stj_thumbnail_image').value);
        if (thumbnailPaths.length > 0) {
            imageMap.thumbnail = thumbnailPaths.length === 1 ? thumbnailPaths[0] : thumbnailPaths;
        }

        document.querySelectorAll('.stj-keyword-item').forEach(item => {
            const keywordInput = item.querySelector('.stj-keyword-input');
            const imageInput = item.querySelector('.stj-image-input');
            if (!keywordInput || !imageInput) return;
            const keyword = keywordInput.value.trim();
            if (!keyword) return;
            const paths = toPaths(imageInput.value);
            if (paths.length === 0) return;
            imageMap[keyword] = paths.length === 1 ? paths[0] : paths;
        });

        return imageMap;
    }

    function exportJSON() {
        const nameEl = document.getElementById('stj_char_name_display');
        const charName = nameEl ? nameEl.textContent : '';
        if (!charName) {
            alert('キャラクター名が設定されていません');
            return;
        }

        const imageMap = buildImageMapFromForm(charName);
        const exportData = {
            image_display_extension: imageMap
        };

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
        if (!charName) {
            alert('キャラクター名が設定されていません');
            return;
        }
        const data = {
            charName: charName,
            defaultImage: document.getElementById('stj_default_image').value,
            thumbnailImage: document.getElementById('stj_thumbnail_image').value,
            keywords: []
        };
        const keywordItems = document.querySelectorAll('.stj-keyword-item');
        keywordItems.forEach(item => {
            const keywordInput = item.querySelector('.stj-keyword-input');
            const imageInput = item.querySelector('.stj-image-input');
            if (keywordInput && imageInput) {
                data.keywords.push({
                    keyword: keywordInput.value,
                    imageName: imageInput.value
                });
            }
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
            const defEl = document.getElementById('stj_default_image');
            if (defEl) defEl.value = data.defaultImage || '';
            const thumbEl = document.getElementById('stj_thumbnail_image');
            if (thumbEl) thumbEl.value = data.thumbnailImage || '';
            const container = document.getElementById('stj_keywords_container');
            if (!container) return;
            container.innerHTML = '';
            if (data.keywords && data.keywords.length > 0) {
                data.keywords.forEach((kw, index) => {
                    addKeywordRowWithData(container, index, kw);
                });
            }
            setTimeout(updatePreview, 100);
        } catch (e) {
            console.error('保存データの読み込みに失敗しました', e);
        }
    }

    function addKeywordRowWithData(container, index, data) {
        const newItem = document.createElement('div');
        newItem.className = 'stj-keyword-item';
        newItem.innerHTML = `
            <div class="stj-image-preview" id="stj_preview_${index}" style="position: relative;">
                <div class="stj-preview-text">プレビュー</div>
            </div>
            <div class="stj-inputs-container">
                ${buildCellActionRowHtml()}
                <div class="stj-input-row">
                    <button class="stj-delete-row">×</button>
                    <div class="stj-input-group stj-keyword-width">
                        <label for="stj_keywords_${index}">キーワード</label>
                        <input type="text" id="stj_keywords_${index}" class="stj-keyword-input" value="${data.keyword || ''}">
                    </div>
                </div>
                <div class="stj-input-row">
                    <div class="stj-input-group stj-image-width">
                        <label for="stj_image_name_${index}">ファイル名</label>
                        <input type="text" id="stj_image_name_${index}" class="stj-image-input" value="${data.imageName || ''}" placeholder="複数ファイルはカンマ区切り">
                        ${buildExtensionButtonsHtml()}
                    </div>
                </div>
            </div>
        `;
        container.appendChild(newItem);

        attachKeywordRowListeners(newItem, index);
    }

    function initStjEditor() {
        const context = getSTContext();
        if (!context) {
            setTimeout(initStjEditor, 500);
            return;
        }

        const eventSource = context.eventSource;
        const eventTypes = context.eventTypes;

        createExportButton();

        if (eventSource && eventTypes) {
            if (eventTypes.CHAT_CHANGED) {
                eventSource.on(eventTypes.CHAT_CHANGED, createExportButton);
            }
            if (eventTypes.CHARACTER_LOADED) {
                eventSource.on(eventTypes.CHARACTER_LOADED, createExportButton);
            }
            if (eventTypes.APP_READY) {
                eventSource.on(eventTypes.APP_READY, createExportButton);
            }
        } else {
            console.warn('[STJ Editor] eventSource or eventTypes not found in context.');
        }
    }

    $(document).ready(() => {
        initStjEditor();
    });
})();
