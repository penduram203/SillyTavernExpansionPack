// media_controller.js
/**
 * Media Controller（最小構成）
 * 残存機能:
 *   1. 🎨 ギャラリーボタンのホバー不透明化（座標監視）
 *   2. 🎨 ギャラリーボタンの疑似要素 opacity 矯正
 */
(function () {
    'use strict';
    console.log('[MediaController] 初期化開始（ホバー制御のみ）');

    // ============================================================
    // 🎨 ギャラリーボタンのホバー不透明化
    //   実ID: #gic-open-gallery-button
    //   ・座標監視方式（:hover に依存しない）
    //   ・子孫要素・疑似要素(::before/::after)・半透明な祖先も矯正
    //   ・デバッグ用API: window.MediaController.debugGalleryButton()
    // ============================================================
    function setupGalleryButtonHoverControl() {
        let lastX = -1, lastY = -1;
        let currentBtn = null;
        let isHovering = false;
        let debugLoggedOnce = false;
        let pendingCheck = false;

        // ─── ボタン探索 ───
        function findGalleryButton() {
            if (currentBtn && document.body.contains(currentBtn)) return currentBtn;

            const selectors = [
                '#gic-open-gallery-button',      // ★ 実ID（最優先）
                '#gic-gallery-button', '#gic_gallery_button', '#gic-gallery-btn',
                '#gallery-button', '#gallery_button', '#gallery-btn',
                '#gic_button', '#gic-btn',
                '[id*="gic"][id*="button"]',
                '[id*="gic"][id*="btn"]',
                '[id*="gallery"][id*="button"]',
                '[id*="gallery"][id*="btn"]',
                '.gic-gallery-button', '.gic-gallery-btn',
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) { currentBtn = el; return el; }
            }

            // 絵文字フォールバック: 🎨 を含む「最も内側の表示要素」
            const all = document.querySelectorAll('body *');
            let best = null, bestDepth = -1;
            for (const el of all) {
                const text = (el.textContent || '').trim();
                if (!text.includes('🎨')) continue;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                if (rect.width > 300 || rect.height > 300) continue;
                let depth = 0, p = el;
                while (p && p !== document.body) { depth++; p = p.parentElement; }
                if (depth > bestDepth) { best = el; bestDepth = depth; }
            }
            currentBtn = best;
            return best;
        }

        // ─── ホバー時: ボタン＋祖先＋疑似要素＋子孫を強制不透明化 ───
        function forceOpaque(el) {
            // 祖先のインライン opacity 矯正
            let node = el, depth = 0;
            while (node && node !== document.documentElement && depth < 10) {
                const op = parseFloat(window.getComputedStyle(node).opacity);
                if (!isNaN(op) && op < 1) {
                    if (node.dataset.mcOpacitySaved !== '1') {
                        node.dataset.mcOpacitySaved = '1';
                        node.dataset.mcOrigOpacityValue = node.style.getPropertyValue('opacity');
                        node.dataset.mcOrigOpacityPriority = node.style.getPropertyPriority('opacity');
                    }
                    node.style.setProperty('opacity', '1', 'important');
                }
                node = node.parentElement; depth++;
            }

            // 疑似要素・子孫要素の opacity をマーカー属性＋CSSで矯正
            let fixStyle = document.getElementById('mc-gallery-hover-fix');
            if (!fixStyle) {
                fixStyle = document.createElement('style');
                fixStyle.id = 'mc-gallery-hover-fix';
                document.head.appendChild(fixStyle);
            }
            el.setAttribute('data-mc-gallery-hover', '1');
            fixStyle.textContent = `
                [data-mc-gallery-hover="1"],
                [data-mc-gallery-hover="1"]::before,
                [data-mc-gallery-hover="1"]::after,
                [data-mc-gallery-hover="1"] *,
                [data-mc-gallery-hover="1"] *::before,
                [data-mc-gallery-hover="1"] *::after { opacity: 1 !important; }
            `;
        }

        // ─── 離脱時: 自分が付けた opacity とマーカーを元に戻す ───
        function restoreOpacity(el) {
            let node = el, depth = 0;
            while (node && node !== document.documentElement && depth < 10) {
                if (node.dataset.mcOpacitySaved === '1') {
                    const curValue = node.style.getPropertyValue('opacity');
                    const curPriority = node.style.getPropertyPriority('opacity');
                    if (curValue === '1' && curPriority === 'important') {
                        const origValue = node.dataset.mcOrigOpacityValue || '';
                        const origPriority = node.dataset.mcOrigOpacityPriority || '';
                        if (origValue) node.style.setProperty('opacity', origValue, origPriority);
                        else node.style.removeProperty('opacity');
                    }
                    delete node.dataset.mcOpacitySaved;
                    delete node.dataset.mcOrigOpacityValue;
                    delete node.dataset.mcOrigOpacityPriority;
                }
                node = node.parentElement; depth++;
            }

            el.removeAttribute('data-mc-gallery-hover');
            const fixStyle = document.getElementById('mc-gallery-hover-fix');
            if (fixStyle) fixStyle.textContent = '';
        }

        // ─── ホバー判定 ───
        function checkHover() {
            const btn = findGalleryButton();
            if (!btn) return;
            const rect = btn.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;

            const inside = lastX >= rect.left && lastX <= rect.right &&
                           lastY >= rect.top  && lastY <= rect.bottom;

            if (inside && !isHovering) {
                isHovering = true;
                forceOpaque(btn);
                if (!debugLoggedOnce) {
                    debugLoggedOnce = true;
                    console.log('[MediaController] 🎨 ボタンを検出しました:',
                        { id: btn.id, className: btn.className, tagName: btn.tagName });
                }
            } else if (!inside && isHovering) {
                isHovering = false;
                restoreOpacity(btn);
            }
        }

        // ─── イベント登録 ───
        document.addEventListener('mousemove', (e) => {
            lastX = e.clientX; lastY = e.clientY; checkHover();
        }, { passive: true });

        document.addEventListener('mouseleave', () => {
            lastX = -1; lastY = -1; checkHover();
        });

        // マウス静止中にボタンが移動したケースにも追従
        setInterval(() => { if (lastX >= 0 && lastY >= 0) checkHover(); }, 100);

        // ボタンが再生成されたら参照をリセット（rAFで間引き）
        const observer = new MutationObserver(() => {
            currentBtn = null;
            if (pendingCheck) return;
            pendingCheck = true;
            requestAnimationFrame(() => {
                pendingCheck = false;
                if (lastX >= 0 && lastY >= 0) checkHover();
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });

        // ─── デバッグ用API（window.MediaController が未定義でも安全） ───
        const api = window.MediaController || (window.MediaController = {});
        api.debugGalleryButton = function () {
            currentBtn = null;
            const btn = findGalleryButton();
            console.log('=== 🎨 Gallery Button Debug ===');
            if (!btn) { console.warn('ボタンが見つかりませんでした'); return; }
            console.log('Element:', btn);
            console.log('  id:', btn.id);
            console.log('  className:', btn.className);
            console.log('  tagName:', btn.tagName);
            console.log('  textContent:', JSON.stringify(btn.textContent));
            const cs = window.getComputedStyle(btn);
            console.log('  computed opacity:', cs.opacity);
            console.log('  computed pointer-events:', cs.pointerEvents);
            console.log('  computed visibility:', cs.visibility);
            console.log('  computed display:', cs.display);
            console.log('  rect:', btn.getBoundingClientRect());
            ['::before', '::after'].forEach(pseudo => {
                const pcs = window.getComputedStyle(btn, pseudo);
                console.log(`  ${pseudo}:`, {
                    content: pcs.content, opacity: pcs.opacity,
                    display: pcs.display, visibility: pcs.visibility,
                });
            });
            btn.querySelectorAll('*').forEach((child, i) => {
                const ccs = window.getComputedStyle(child);
                console.log(`  child[${i}] <${child.tagName}> opacity=${ccs.opacity} text=${JSON.stringify(child.textContent)}`);
            });
            let p = btn.parentElement, i = 1;
            while (p && i <= 10) {
                const op = window.getComputedStyle(p).opacity;
                console.log(`  parent[${i}] <${p.tagName} id="${p.id}" class="${p.className}"> opacity=${op}`);
                if (op !== '1') console.warn(`  ^^ parent[${i}] が半透明です！`);
                p = p.parentElement; i++;
            }
        };

        console.log('[MediaController] 🎨 ギャラリーボタンのホバー制御を開始しました');
    }

    // ============================================================
    // 初期化
    // ============================================================
    function init() {
        try { setupGalleryButtonHoverControl(); }
        catch (e) { console.error('[MediaController] setupGalleryButtonHoverControl でエラー:', e); }
        console.log('[MediaController] 初期化完了');
    }

    // ★ init() より先に window.MediaController を定義
    window.MediaController = window.MediaController || {};

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
