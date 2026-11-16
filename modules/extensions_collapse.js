// extensions_collapse.js
// 拡張機能管理パネルの "Built-in Extensions:" 一覧を折りたたみ式にする

(function () {
    'use strict';
    if (window.__expExtCollapseInstalled) return;
    window.__expExtCollapseInstalled = true;

    const LOG = '[ExtCollapse]';

    function setupCollapse() {
        // 既に折りたたみ化済み（トグルが存在する）なら何もしない
        if (document.querySelector('.exp-ext-collapse-toggle')) return false;

        // <h3>Built-in Extensions:</h3> を探す
        let header = null;
        for (const h3 of document.querySelectorAll('h3')) {
            if (h3.textContent.trim() === 'Built-in Extensions:') {
                header = h3;
                break;
            }
        }
        if (!header) return false;

        const container = header.parentElement;
        if (!container) return false;

        // h3 以降の兄弟要素を折りたたみコンテンツへ移動
        const content = document.createElement('div');
        content.className = 'exp-ext-collapse-content';
        content.style.display = 'none';
        content.style.overflow = 'hidden';

        let node = header.nextSibling;
        while (node) {
            const next = node.nextSibling;
            content.appendChild(node);
            node = next;
        }

        // h3 をクリック可能なトグルに置き換え
        const btn = document.createElement('div');
        btn.className = 'exp-ext-collapse-toggle';
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.setAttribute('aria-expanded', 'false');
        btn.style.cssText = [
            'display: flex',
            'align-items: center',
            'gap: 8px',
            'cursor: pointer',
            'user-select: none',
            'padding: 6px 0',
            'font-size: 1.17em',
            'font-weight: bold',
            'color: inherit',
        ].join(';');
        btn.innerHTML = '<i class="fa-solid fa-chevron-right"></i><span>Built-in Extensions:</span>';

        header.replaceWith(btn);
        container.appendChild(content);

        const toggle = () => {
            const isOpen = content.style.display !== 'none';
            if (isOpen) {
                content.style.display = 'none';
                btn.setAttribute('aria-expanded', 'false');
                btn.querySelector('i').className = 'fa-solid fa-chevron-right';
            } else {
                content.style.display = '';
                btn.setAttribute('aria-expanded', 'true');
                btn.querySelector('i').className = 'fa-solid fa-chevron-down';
            }
        };

        btn.addEventListener('click', toggle);
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
            }
        });

        console.log(`${LOG} Built-in Extensions を折りたたみ化`);
        return true;
    }

    // パネルの再描画・再オープンを検知して都度適用
    let pending = false;
    const observer = new MutationObserver(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            setupCollapse();
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 起動直後の取りこぼし対策
    setTimeout(setupCollapse, 1000);
    setTimeout(setupCollapse, 3000);

    // 公開 API
    window.ExtCollapse = {
        refresh: setupCollapse,
        expand: () => {
            const btn = document.querySelector('.exp-ext-collapse-toggle');
            const content = document.querySelector('.exp-ext-collapse-content');
            if (btn && content) {
                content.style.display = '';
                btn.setAttribute('aria-expanded', 'true');
                btn.querySelector('i').className = 'fa-solid fa-chevron-down';
            }
        },
        collapse: () => {
            const btn = document.querySelector('.exp-ext-collapse-toggle');
            const content = document.querySelector('.exp-ext-collapse-content');
            if (btn && content) {
                content.style.display = 'none';
                btn.setAttribute('aria-expanded', 'false');
                btn.querySelector('i').className = 'fa-solid fa-chevron-right';
            }
        },
    };

    console.log(`${LOG} installed`);
})();
