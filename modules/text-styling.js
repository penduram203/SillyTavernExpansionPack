// SillyTavern.getContext() を実行時に呼び出す方式（公式ドキュメント推奨）
function initTextStyling() {
    console.log('テキストスタイル拡張機能 (修正版): 初期化開始');

    const MODULE_NAME = 'text_styling';
    const OLD_STORAGE_KEY = 'textStylingSettings_v6_modified';

    const TAG_CONFIG = {
        p: {
            label: '通常テキスト',
            isDynamic: false,
            defaults: { enabled: true, fontSize: 100, fontWeight: 400, textColor: '#dddddd', outlineColor: '#000000', outlineWidth: 1, lineHeight: 1.5, letterSpacing: 0, bottomMargin: 0, textOpacity: 1.0 }
        },
        q: {
            label: 'セリフ',
            isDynamic: false,
            defaults: { enabled: true, fontSize: 100, fontWeight: 400, textColor: '#dddddd', outlineColor: '#000000', outlineWidth: 1, lineHeight: 1.5, letterSpacing: 0, bottomMargin: 0, textOpacity: 1.0 }
        }
    };

    const OTHER_DEFAULTS = {
        chatWindowOpacity: 1.0,
        panelMinimized: false,
        activeTab: 'p',
        layoutMode: 'center'  // 'center' | 'split' | 'manual'
    };

    // ★ 3状態のレイアウトモード
    const LAYOUT_MODES = ['center', 'split', 'manual'];

    const controls = {};
    let chatObserver = null;

    // ★ 現在のレイアウトモード
    let currentLayoutMode = OTHER_DEFAULTS.layoutMode;

    function getSTContext() {
        return (window.SillyTavern && typeof window.SillyTavern.getContext === 'function')
            ? window.SillyTavern.getContext()
            : null;
    }

    function hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : '0, 0, 0';
    }

    // ============================================================
    //  セグメントのラップ処理（2パス方式）
    // ============================================================
    function ensureSegmentsWrapped(mesTextEl) {
        if (!mesTextEl) return;

        const rejectInsideSegments = (node) => {
            let p = node.parentNode;
            while (p && p !== mesTextEl) {
                if (p.classList && (p.classList.contains('stj-dialogue') || p.classList.contains('stj-normal-text'))) {
                    return NodeFilter.FILTER_REJECT;
                }
                p = p.parentNode;
            }
            return NodeFilter.FILTER_ACCEPT;
        };

        const walker1 = document.createTreeWalker(mesTextEl, NodeFilter.SHOW_TEXT, { acceptNode: rejectInsideSegments });
        const nodes1 = [];
        let n1;
        while ((n1 = walker1.nextNode())) nodes1.push(n1);

        nodes1.forEach(textNode => {
            const txt = textNode.nodeValue;
            if (!txt || txt.indexOf('「') < 0) return;

            const regex = /「[^」]*」/g;
            const segments = [];
            let last = 0;
            let m;
            let hasDialogue = false;
            while ((m = regex.exec(txt)) !== null) {
                hasDialogue = true;
                if (m.index > last) {
                    segments.push({ text: txt.slice(last, m.index), isDialogue: false });
                }
                segments.push({ text: m[0], isDialogue: true });
                last = regex.lastIndex;
            }
            if (!hasDialogue) return;
            if (last < txt.length) {
                segments.push({ text: txt.slice(last), isDialogue: false });
            }

            const frag = document.createDocumentFragment();
            segments.forEach(seg => {
                if (seg.text === '') return;
                if (!seg.isDialogue && seg.text.trim() === '') {
                    frag.appendChild(document.createTextNode(seg.text));
                    return;
                }
                const span = document.createElement('span');
                span.className = seg.isDialogue ? 'stj-dialogue' : 'stj-normal-text';
                span.textContent = seg.text;
                frag.appendChild(span);
            });
            if (textNode.parentNode) {
                textNode.parentNode.replaceChild(frag, textNode);
            }
        });

        const hasAnySegment = mesTextEl.querySelector('.stj-dialogue, .stj-normal-text');
        if (hasAnySegment) {
            const walker2 = document.createTreeWalker(mesTextEl, NodeFilter.SHOW_TEXT, { acceptNode: rejectInsideSegments });
            const nodes2 = [];
            let n2;
            while ((n2 = walker2.nextNode())) nodes2.push(n2);

            nodes2.forEach(textNode => {
                const txt = textNode.nodeValue;
                if (!txt || txt.trim() === '') return;
                const parent = textNode.parentNode;
                if (!parent) return;
                const span = document.createElement('span');
                span.className = 'stj-normal-text';
                span.textContent = txt;
                parent.replaceChild(span, textNode);
            });
        }

        mesTextEl.querySelectorAll('p').forEach(p => {
            if (p.querySelector('.stj-dialogue, .stj-normal-text')) {
                p.classList.add('stj-has-segment');
            } else {
                p.classList.remove('stj-has-segment');
            }
        });

        const hasP = mesTextEl.querySelector('p');
        if (!hasP && !hasAnySegment) {
            mesTextEl.classList.add('stj-empty-text');
        } else {
            mesTextEl.classList.remove('stj-empty-text');
        }
    }

    // ============================================================
    //  UI生成
    // ============================================================
    const panel = document.createElement('div');
    panel.id = 'text-styling-panel';
    document.body.appendChild(panel);

    const header = document.createElement('div');
    header.id = 'text-styling-header';
    header.textContent = 'テキストスタイル設定';
    panel.appendChild(header);

    // 左下の T アイコン
    const restoreButton = document.createElement('button');
    restoreButton.id = 'restore-panel-button';
    restoreButton.textContent = 'T';
    restoreButton.title = '設定パネルの表示/非表示';
    restoreButton.onclick = () => {
        panel.classList.toggle('hidden');
        saveSettings();
    };
    document.body.appendChild(restoreButton);

    const tabContainer = document.createElement('div');
    tabContainer.className = 'tab-container';
    panel.appendChild(tabContainer);

    const tabButtons = document.createElement('div');
    tabButtons.className = 'tab-buttons';
    tabContainer.appendChild(tabButtons);

    const tabContents = document.createElement('div');
    tabContents.className = 'tab-contents';
    tabContainer.appendChild(tabContents);

    function createTagControlSection(tagName) {
        return `
            <div class="enable-styling-toggle">
                <input type="checkbox" id="${tagName}-enabled">
                <label for="${tagName}-enabled">このスタイルを有効にする</label>
            </div>
            <div class="columns-container">
                <div class="column">
                    <div class="text-styling-control-group">
                        <label for="${tagName}-font-size">文字サイズ: <span id="${tagName}-font-size-value"></span>%</label>
                        <input type="range" id="${tagName}-font-size" min="50" max="250" step="10">
                    </div>
                    <div class="text-styling-control-group">
                        <label for="${tagName}-font-weight">文字の太さ: <span id="${tagName}-font-weight-value"></span></label>
                        <input type="range" id="${tagName}-font-weight" min="100" max="900" step="100">
                    </div>
                    <div class="text-styling-control-group">
                        <label for="${tagName}-line-height">行間: <span id="${tagName}-line-height-value"></span></label>
                        <input type="range" id="${tagName}-line-height" min="1.0" max="3.0" step="0.1">
                    </div>
                    <div class="text-styling-control-group">
                        <label for="${tagName}-letter-spacing">字間: <span id="${tagName}-letter-spacing-value"></span>px</label>
                        <input type="range" id="${tagName}-letter-spacing" min="-5" max="20" step="0.5">
                    </div>
                    <div class="text-styling-control-group">
                        <label for="${tagName}-text-opacity">透過度: <span id="${tagName}-text-opacity-value"></span>%</label>
                        <input type="range" id="${tagName}-text-opacity" min="0" max="100" step="1">
                    </div>
                </div>
                <div class="column">
                    <div class="text-styling-control-group">
                        <label for="${tagName}-text-color">文字色</label>
                        <input type="color" id="${tagName}-text-color">
                    </div>
                    <div class="text-styling-control-group">
                        <label for="${tagName}-outline-color">縁取り色</label>
                        <input type="color" id="${tagName}-outline-color">
                    </div>
                    <div class="text-styling-control-group">
                        <label for="${tagName}-outline-width">縁取り幅: <span id="${tagName}-outline-width-value"></span>px</label>
                        <input type="range" id="${tagName}-outline-width" min="0" max="10" step="0.5">
                    </div>
                    <div class="text-styling-control-group">
                        <label for="${tagName}-bottom-margin">下余白: <span id="${tagName}-bottom-margin-value"></span>px</label>
                        <input type="range" id="${tagName}-bottom-margin" min="0" max="200" step="1">
                    </div>
                </div>
            </div>`;
    }

    Object.keys(TAG_CONFIG).forEach(tagName => {
        const button = document.createElement('button');
        button.className = 'tab-button';
        button.dataset.tab = tagName;
        button.textContent = TAG_CONFIG[tagName].label;
        tabButtons.appendChild(button);

        const content = document.createElement('div');
        content.className = 'tab-content';
        content.dataset.tabContent = tagName;
        content.innerHTML = createTagControlSection(tagName);
        tabContents.appendChild(content);

        controls[tagName] = {
            content: content,
            enabledCheckbox: content.querySelector(`#${tagName}-enabled`),
            fontSizeInput: content.querySelector(`#${tagName}-font-size`),
            fontSizeValue: content.querySelector(`#${tagName}-font-size-value`),
            fontWeightInput: content.querySelector(`#${tagName}-font-weight`),
            fontWeightValue: content.querySelector(`#${tagName}-font-weight-value`),
            lineHeightInput: content.querySelector(`#${tagName}-line-height`),
            lineHeightValue: content.querySelector(`#${tagName}-line-height-value`),
            letterSpacingInput: content.querySelector(`#${tagName}-letter-spacing`),
            letterSpacingValue: content.querySelector(`#${tagName}-letter-spacing-value`),
            bottomMarginInput: content.querySelector(`#${tagName}-bottom-margin`),
            bottomMarginValue: content.querySelector(`#${tagName}-bottom-margin-value`),
            textColorInput: content.querySelector(`#${tagName}-text-color`),
            outlineColorInput: content.querySelector(`#${tagName}-outline-color`),
            outlineWidthInput: content.querySelector(`#${tagName}-outline-width`),
            outlineWidthValue: content.querySelector(`#${tagName}-outline-width-value`),
            textOpacityInput: content.querySelector(`#${tagName}-text-opacity`),
            textOpacityValue: content.querySelector(`#${tagName}-text-opacity-value`)
        };

        controls[tagName].enabledCheckbox.addEventListener('change', () => updateStyleAndAllMessages(tagName));
        Object.values(controls[tagName]).forEach(element => {
            if (element && element.tagName === 'INPUT' && element.type !== 'checkbox') {
                element.addEventListener('input', () => updateStyleAndAllMessages(tagName));
            }
        });
    });

    const chatSection = document.createElement('div');
    chatSection.className = 'text-styling-section';
    chatSection.style.marginTop = '15px';
    chatSection.innerHTML = `
        <h3>チャットウィンドウ設定</h3>
        <div class="text-styling-control-group">
            <label for="chat-opacity">透過度: <span id="chat-opacity-value"></span>%</label>
            <input type="range" id="chat-opacity" min="0" max="100" step="1">
        </div>`;
    panel.appendChild(chatSection);

    controls.chatOpacityInput = chatSection.querySelector('#chat-opacity');
    controls.chatOpacityValue = chatSection.querySelector('#chat-opacity-value');
    controls.chatOpacityInput.addEventListener('input', updateChatWindowOpacity);

    tabButtons.addEventListener('click', e => {
        if (e.target.matches('.tab-button')) {
            setActiveTab(e.target.dataset.tab);
            saveSettings();
        }
    });

    function setActiveTab(tabId) {
        tabButtons.querySelectorAll('.tab-button').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
        tabContents.querySelectorAll('.tab-content').forEach(content => content.classList.toggle('active', content.dataset.tabContent === tabId));
    }

    function applyStylesToMessage(mesTextElement) {
        if (!mesTextElement) return;
        ensureSegmentsWrapped(mesTextElement);
        Object.keys(TAG_CONFIG).forEach(tagName => {
            if (!TAG_CONFIG[tagName].isDynamic) {
                const isEnabled = controls[tagName].enabledCheckbox.checked;
                mesTextElement.classList.toggle(`style-${tagName}-enabled`, isEnabled);
            }
        });
    }

    function updateStyleAndAllMessages(tagName) {
        const tagControls = controls[tagName];
        const rootStyle = document.documentElement.style;
        const enabled = tagControls.enabledCheckbox.checked;
        tagControls.content.classList.toggle('disabled', !enabled);

        if (enabled) {
            const fontSize = parseInt(tagControls.fontSizeInput.value);
            const fontWeight = parseInt(tagControls.fontWeightInput.value);
            const lineHeight = parseFloat(tagControls.lineHeightInput.value);
            const letterSpacing = parseFloat(tagControls.letterSpacingInput.value);
            const bottomMargin = parseInt(tagControls.bottomMarginInput.value);
            const textColor = tagControls.textColorInput.value;
            const outlineColor = tagControls.outlineColorInput.value;
            const outlineWidth = parseFloat(tagControls.outlineWidthInput.value);
            const textOpacity = parseFloat(tagControls.textOpacityInput.value) / 100;

            tagControls.fontSizeValue.textContent = fontSize;
            tagControls.fontWeightValue.textContent = fontWeight;
            tagControls.lineHeightValue.textContent = lineHeight.toFixed(1);
            tagControls.letterSpacingValue.textContent = letterSpacing.toFixed(1);
            tagControls.bottomMarginValue.textContent = bottomMargin;
            tagControls.outlineWidthValue.textContent = outlineWidth.toFixed(1);
            tagControls.textOpacityValue.textContent = Math.round(textOpacity * 100);

            rootStyle.setProperty(`--${tagName}-font-size`, `${fontSize}%`);
            rootStyle.setProperty(`--${tagName}-font-weight`, fontWeight);
            rootStyle.setProperty(`--${tagName}-line-height`, lineHeight);
            rootStyle.setProperty(`--${tagName}-letter-spacing`, `${letterSpacing}px`);
            rootStyle.setProperty(`--${tagName}-bottom-margin`, `${bottomMargin}px`);
            rootStyle.setProperty(`--${tagName}-text-rgb`, hexToRgb(textColor));
            rootStyle.setProperty(`--${tagName}-text-opacity`, textOpacity);
            rootStyle.setProperty(`--${tagName}-outline-width`, `${outlineWidth}px`);
            rootStyle.setProperty(`--${tagName}-outline-rgb`, hexToRgb(outlineColor));
        }

        document.querySelectorAll('#chat .mes_text').forEach(applyStylesToMessage);
        saveSettings();
    }

    function updateChatWindowOpacity() {
        const opacity = parseInt(controls.chatOpacityInput.value) / 100;
        controls.chatOpacityValue.textContent = controls.chatOpacityInput.value;
        document.documentElement.style.setProperty('--chat-opacity', opacity);
        saveSettings();
    }

    function setupObservers() {
        if (chatObserver) chatObserver.disconnect();
        const chatElement = document.getElementById('chat');
        if (!chatElement) return;

        const pending = new Set();
        let timer = null;

        function scheduleProcess(el) {
            if (!el) return;
            pending.add(el);
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                pending.forEach(x => applyStylesToMessage(x));
                pending.clear();
            }, 100);
        }

        chatObserver = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                if (mutation.type === 'characterData') {
                    const parent = mutation.target.parentNode;
                    const mesTextEl = parent && parent.closest ? parent.closest('.mes_text') : null;
                    if (mesTextEl) scheduleProcess(mesTextEl);
                } else if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            if (node.classList.contains('mes_text')) {
                                scheduleProcess(node);
                            } else if (node.querySelectorAll) {
                                node.querySelectorAll('.mes_text').forEach(scheduleProcess);
                            }
                        }
                    }
                }
            }
        });
        chatObserver.observe(chatElement, { childList: true, subtree: true, characterData: true });
        console.log("チャット監視オブザーバーをセットアップしました。");
    }

    function saveSettings() {
        const settings = {
            tags: {},
            chatWindowOpacity: parseFloat(controls.chatOpacityInput.value) / 100,
            panelMinimized: panel.classList.contains("hidden"),
            activeTab: tabButtons.querySelector(".tab-button.active")?.dataset.tab || "p",
            layoutMode: currentLayoutMode,
        };
        Object.keys(TAG_CONFIG).forEach(tagName => {
            const t = controls[tagName];
            settings.tags[tagName] = {
                enabled: t.enabledCheckbox.checked,
                fontSize: parseInt(t.fontSizeInput.value),
                fontWeight: parseInt(t.fontWeightInput.value),
                lineHeight: parseFloat(t.lineHeightInput.value),
                letterSpacing: parseFloat(t.letterSpacingInput.value),
                bottomMargin: parseInt(t.bottomMarginInput.value),
                textColor: t.textColorInput.value,
                outlineColor: t.outlineColorInput.value,
                outlineWidth: parseFloat(t.outlineWidthInput.value),
                textOpacity: parseFloat(t.textOpacityInput.value) / 100,
            };
        });

        const context = getSTContext();
        if (context && context.extensionSettings) {
            context.extensionSettings[MODULE_NAME] = settings;
            if (typeof context.saveSettingsDebounced === 'function') {
                context.saveSettingsDebounced();
            }
        } else {
            localStorage.setItem(OLD_STORAGE_KEY, JSON.stringify(settings));
        }
    }

    function restoreSettings() {
        const context = getSTContext();
        let settings = context && context.extensionSettings ? context.extensionSettings[MODULE_NAME] : null;

        if (!settings) {
            const oldSaved = localStorage.getItem(OLD_STORAGE_KEY);
            if (oldSaved) {
                try {
                    settings = JSON.parse(oldSaved);
                    if (context && context.extensionSettings) {
                        context.extensionSettings[MODULE_NAME] = settings;
                        if (typeof context.saveSettingsDebounced === 'function') {
                            context.saveSettingsDebounced();
                        }
                        localStorage.removeItem(OLD_STORAGE_KEY);
                        console.log('[Text Styling] localStorage から extensionSettings に移行しました。');
                    }
                } catch (e) {
                    console.error('[Text Styling] 旧データの移行に失敗しました:', e);
                }
            }
        }

        if (settings) {
            try {
                Object.keys(TAG_CONFIG).forEach(tagName => {
                    const savedTag = settings.tags?.[tagName] || {};
                    const defaultTag = TAG_CONFIG[tagName].defaults;
                    const tagControls = controls[tagName];
                    tagControls.enabledCheckbox.checked = savedTag.enabled ?? defaultTag.enabled;
                    tagControls.fontSizeInput.value = savedTag.fontSize ?? defaultTag.fontSize;
                    tagControls.fontWeightInput.value = savedTag.fontWeight ?? defaultTag.fontWeight;
                    tagControls.lineHeightInput.value = savedTag.lineHeight ?? defaultTag.lineHeight;
                    tagControls.letterSpacingInput.value = savedTag.letterSpacing ?? defaultTag.letterSpacing;
                    tagControls.bottomMarginInput.value = savedTag.bottomMargin ?? defaultTag.bottomMargin;
                    tagControls.textColorInput.value = savedTag.textColor ?? defaultTag.textColor;
                    tagControls.outlineColorInput.value = savedTag.outlineColor ?? defaultTag.outlineColor;
                    tagControls.outlineWidthInput.value = savedTag.outlineWidth ?? defaultTag.outlineWidth;
                    tagControls.textOpacityInput.value = Math.round((savedTag.textOpacity ?? defaultTag.textOpacity) * 100);
                });
                controls.chatOpacityInput.value = Math.round((settings.chatWindowOpacity ?? OTHER_DEFAULTS.chatWindowOpacity) * 100);
                if (settings.panelMinimized) {
                    panel.classList.add('hidden');
                }
                setActiveTab(settings.activeTab || OTHER_DEFAULTS.activeTab);

                // レイアウトモードの復元
                const savedMode = settings.layoutMode || OTHER_DEFAULTS.layoutMode;
                currentLayoutMode = LAYOUT_MODES.includes(savedMode) ? savedMode : 'center';
            } catch (e) {
                console.error('設定復元エラー:', e);
                setDefaultSettings();
            }
        } else {
            setDefaultSettings();
        }

        const originalSave = saveSettings;
        saveSettings = () => {};
        Object.keys(TAG_CONFIG).forEach(tagName => updateStyleAndAllMessages(tagName));
        updateChatWindowOpacity();
        document.querySelectorAll('#chat .mes_text').forEach(applyStylesToMessage);
        saveSettings = originalSave;
    }

    function setDefaultSettings() {
        Object.keys(TAG_CONFIG).forEach(tagName => {
            const defaults = TAG_CONFIG[tagName].defaults;
            const tagControls = controls[tagName];
            tagControls.enabledCheckbox.checked = defaults.enabled;
            Object.keys(defaults).forEach(key => {
                if (key !== "enabled") {
                    const input = tagControls[key + "Input"] || tagControls[key];
                    if (input) {
                        if (key.includes("Color")) {
                            input.value = defaults[key];
                        } else if (key === "textOpacity") {
                            input.value = defaults[key] * 100;
                        } else {
                            input.value = defaults[key];
                        }
                    }
                }
            });
        });

        controls.chatOpacityInput.value = Math.round(OTHER_DEFAULTS.chatWindowOpacity * 100);
        panel.classList.remove('hidden');
        setActiveTab(OTHER_DEFAULTS.activeTab);
        currentLayoutMode = OTHER_DEFAULTS.layoutMode;

        const originalSave = saveSettings;
        saveSettings = () => {};
        Object.keys(TAG_CONFIG).forEach(tagName => updateStyleAndAllMessages(tagName));
        updateChatWindowOpacity();
        saveSettings = originalSave;
    }

    // ============================================================
    // ★ レイアウト適用関数
    // ============================================================
    function applyCenterLayout() {
        const sheld = document.getElementById('sheld');
        if (!sheld) return;

        sheld.style.resize = 'none';
        sheld.style.inset = '3.5vh 0px 60px 25vw';
        sheld.style.height = '100vh';
        sheld.style.width = '50vw';
        sheld.style.margin = 'unset';

        try {
            if (window.ImageDisplayExtension?.applyMaximizeMode) {
                window.ImageDisplayExtension.applyMaximizeMode();
                console.log('[Text Styling] レイアウト: 中央（画像フル）');
            }
        } catch (e) {
            console.warn('[Text Styling] Image Display 連携エラー（中央）:', e);
        }
    }

    function applySplitLayout() {
        const sheld = document.getElementById('sheld');
        if (!sheld) return;

        sheld.style.resize = 'none';
        sheld.style.inset = '3.5vh 0px 60px 50vw';
        sheld.style.height = '100vh';
        sheld.style.width = '50vw';
        sheld.style.margin = 'unset';

        try {
            if (window.ImageDisplayExtension?.applyHalfMaximizeMode) {
                window.ImageDisplayExtension.applyHalfMaximizeMode();
                console.log('[Text Styling] レイアウト: 左右（テキスト右、画像左）');
            }
        } catch (e) {
            console.warn('[Text Styling] Image Display 連携エラー（左右）:', e);
        }
    }

    // ★ 手動モード: テキストは中央配置、画像は通常モード
    //    カスタムウィンドウの自動オープンは行わない（ボタン経由で開く）
    function applyManualLayout() {
        const sheld = document.getElementById('sheld');
        if (sheld) {
            sheld.style.resize = 'none';
            sheld.style.inset = '3.5vh 0px 60px 25vw';
            sheld.style.height = '100vh';
            sheld.style.width = '50vw';
            sheld.style.margin = 'unset';
        }

        try {
            if (window.ImageDisplayExtension?.applyNormalMode) {
                window.ImageDisplayExtension.applyNormalMode();
            }
            // ★ openCustomWindow の自動呼び出しは行わない
            console.log('[Text Styling] レイアウト: 手動（画像位置・サイズを手動設定）');
        } catch (e) {
            console.warn('[Text Styling] Image Display 連携エラー（手動）:', e);
        }
    }

    /**
     * ★ レイアウトモードを設定し、ボタンのテキストも同期する。
     */
    function setLayoutMode(mode, options = {}) {
        const prevMode = currentLayoutMode;

        if (!LAYOUT_MODES.includes(mode)) mode = 'center';
        currentLayoutMode = mode;

        // ★ 手動モードから抜けるとき、カスタムウィンドウを閉じる
        if (prevMode === 'manual' && currentLayoutMode !== 'manual') {
            try {
                if (window.ImageDisplayExtension?.closeCustomWindow) {
                    window.ImageDisplayExtension.closeCustomWindow();
                    console.log('[Text Styling] 手動モードを抜けるため、カスタムウィンドウを閉じました');
                }
            } catch (e) {
                console.warn('[Text Styling] closeCustomWindow エラー:', e);
            }
        }

        // ボタンテキストの更新
        const toggleBtn = document.getElementById('center-button');
        if (toggleBtn) {
            switch (currentLayoutMode) {
                case 'center':
                    toggleBtn.textContent = '中央';
                    toggleBtn.title = 'クリックで「左右」に切替';
                    break;
                case 'split':
                    toggleBtn.textContent = '左右';
                    toggleBtn.title = 'クリックで「手動」に切替';
                    break;
                case 'manual':
                    toggleBtn.textContent = '手動';
                    toggleBtn.title = 'クリックで「中央」に切替';
                    break;
            }
            console.log(`[Text Styling] ボタンテキスト更新: "${toggleBtn.textContent}" (mode=${currentLayoutMode})`);
        } else {
            console.warn('[Text Styling] center-button が見つかりません');
        }

        // ★ 「位置・サイズの設定」ボタンの表示/非表示
        const manualSettingsBtn = document.getElementById('manual-settings-button');
        if (manualSettingsBtn) {
            if (currentLayoutMode === 'manual') {
                manualSettingsBtn.style.removeProperty('display');
            } else {
                manualSettingsBtn.style.display = 'none';
            }
        }

        // モード別のレイアウト適用
        switch (currentLayoutMode) {
            case 'center':
                applyCenterLayout();
                break;
            case 'split':
                applySplitLayout();
                break;
            case 'manual':
                applyManualLayout();
                break;
        }

        if (!options.skipSave) {
            saveSettings();
        }
    }

    // ★ 3状態をサイクルで切替
    function cycleLayoutMode() {
        const currentIdx = LAYOUT_MODES.indexOf(currentLayoutMode);
        const nextIdx = (currentIdx + 1) % LAYOUT_MODES.length;
        const nextMode = LAYOUT_MODES[nextIdx];
        console.log(`[Text Styling] トグル: ${currentLayoutMode} → ${nextMode}`);
        setLayoutMode(nextMode);
    }

    // --- 初期化処理 ---
    setTimeout(() => {
        console.log('拡張機能の初期化処理を開始');

        const windowControlContainer = document.createElement('div');
        windowControlContainer.id = 'window-control-buttons';
        document.body.appendChild(windowControlContainer);

        // ★ 統合トグルボタン（中央 ⇄ 左右 ⇄ 手動）
        const layoutToggleButton = document.createElement('button');
        layoutToggleButton.id = 'center-button';
        layoutToggleButton.className = 'window-control-button';
        layoutToggleButton.textContent = '中央';
        layoutToggleButton.title = 'クリックで「左右」に切替';
        windowControlContainer.appendChild(layoutToggleButton);

        // ★ 「位置・サイズの設定」ボタン（手動モード専用）
        //    初期状態は非表示。手動モード時のみ表示する。
        const manualSettingsButton = document.createElement('button');
        manualSettingsButton.id = 'manual-settings-button';
        manualSettingsButton.className = 'window-control-button';
        manualSettingsButton.textContent = '位置・サイズの設定';
        manualSettingsButton.title = '背景画像ウィンドウの位置とサイズを設定';
        manualSettingsButton.style.display = 'none';
        manualSettingsButton.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                if (window.ImageDisplayExtension?.openCustomWindow) {
                    window.ImageDisplayExtension.openCustomWindow();
                }
            } catch (err) {
                console.warn('[Text Styling] openCustomWindow エラー:', err);
            }
        });
        windowControlContainer.appendChild(manualSettingsButton);

        const sheld = document.getElementById('sheld');
        const sheldheader = document.getElementById('sheldheader');

        // クリックハンドラ: 中央 → 左右 → 手動 → 中央 ...
        layoutToggleButton.addEventListener('click', () => {
            cycleLayoutMode();
        });

        if (sheld && sheldheader) {
            const topLimit = 35;
            sheldheader.addEventListener('mousedown', () => {
                sheld.style.resize = 'both';
                const onMouseUp = () => {
                    requestAnimationFrame(() => {
                        const top = parseFloat(sheld.style.top);
                        if (!isNaN(top) && top < topLimit) {
                            sheld.style.top = `${topLimit}px`;
                        }
                    });
                };
                document.addEventListener('mouseup', onMouseUp, { once: true });
            });
        }

        restoreSettings();
        setupObservers();

        // ★ 保存されたレイアウトモードを適用（保存はしない）
        setLayoutMode(currentLayoutMode, { skipSave: true });
    }, 500);
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    initTextStyling();
} else {
    document.addEventListener('DOMContentLoaded', initTextStyling);
}
