// random_prompt_wildcard.js
// キャラクター毎のランダムプロンプトワイルドカード管理
//
// 使用例:
//   wildcard 設定画面に以下を入力:
//     color1? = black,brown,orange,yellow,pink
//   ロアブックのプロンプトに以下を書くと:
//     1girl,color1? hair, miniskirt,
//   生成時に以下のように置換される:
//     1girl,pink hair, miniskirt,
//
// ★ 同一生成内では同じ wildcard は同じ値になる（変数としての一貫性）
// ★ データ保存先: character.data.extensions.random_prompt_wildcard
//   {
//     rawText: "color1? = black,brown,...",
//     wildcards: { "color1?": ["black", "brown", ...] }
//   }
// ★ JSON / PNG エクスポートに含まれる（CharStore 経由）
// ★ wildcard はキャラクター毎に個別管理される

import { getContext } from '../../../../extensions.js';

const LOG = '[RandomPromptWildcard]';
const NAMESPACE = 'random_prompt_wildcard';
const BUTTON_ID = 'rpw-open-button';
const MODAL_ID = 'rpw-modal';
const TEXTAREA_ID = 'rpw-textarea';
const CLOSE_BTN_ID = 'rpw-close-button';
const STYLE_ID = 'rpw-style';
const TARGET_HEADER_ID = 'WIEntryHeaderTitlesPC';

// ============================================================
// 状態
// ============================================================
let _currentCharName = null;

// ============================================================
// ユーティリティ
// ============================================================
function getSTContext() {
    try {
        if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
            return window.SillyTavern.getContext();
        }
    } catch (e) { /* ignore */ }
    return null;
}

function getCurrentCharName() {
    try {
        const ctx = getSTContext();
        const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
        return char?.name || null;
    } catch (e) { return null; }
}

// ============================================================
// パーサー: テキスト → wildcards オブジェクト
//   対応構文:
//     name? = value1,value2,value3
//     name? = "value with, comma", another
//     # コメント行
//     空行
// ============================================================
function parseWildcardText(text) {
    const result = {};
    if (typeof text !== 'string') return result;

    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith('#')) continue;

        const m = line.match(/^([^=]+?)\s*=\s*(.*)$/);
        if (!m) continue;

        const name = m[1].trim();
        const valuesStr = m[2].trim();
        if (!name || !valuesStr) continue;

        const values = splitValues(valuesStr);
        if (values.length === 0) continue;

        result[name] = values;
    }
    return result;
}

function splitValues(str) {
    const values = [];
    let current = '';
    let inQuote = null;

    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (inQuote) {
            if (ch === inQuote) {
                inQuote = null;
            } else {
                current += ch;
            }
        } else if (ch === '"' || ch === "'") {
            inQuote = ch;
        } else if (ch === ',') {
            const v = current.trim();
            if (v) values.push(v);
            current = '';
        } else {
            current += ch;
        }
    }
    const last = current.trim();
    if (last) values.push(last);

    return values;
}

// ============================================================
// プロンプトへの適用
//   - 長いキーから先に処理（部分一致の事故防止）
//   - 同一生成内では同じキーは同じ値（変数としての一貫性）
// ============================================================
function applyWildcards(prompt, wildcards) {
    if (!prompt || typeof prompt !== 'string') return prompt;
    if (!wildcards || typeof wildcards !== 'object') return prompt;

    const keys = Object.keys(wildcards)
        .filter(k => k && Array.isArray(wildcards[k]) && wildcards[k].length > 0)
        .sort((a, b) => b.length - a.length);

    if (keys.length === 0) return prompt;

    // ★ 同一生成内で同じキーは同じ値になるよう、先に選択を確定
    const selections = {};
    for (const key of keys) {
        const values = wildcards[key];
        selections[key] = values[Math.floor(Math.random() * values.length)];
    }

    let result = prompt;
    for (const key of keys) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(escapedKey, 'g');
        // 関数リプレーサで $ 特殊文字の誤解釈を回避
        result = result.replace(re, () => selections[key]);
    }
    return result;
}

// ============================================================
// 永続化
// ============================================================
function loadWildcardsForChar(charName) {
    if (!charName) return { rawText: '', wildcards: {} };

    try {
        const ctx = getSTContext();
        const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
        if (char?.name !== charName) return { rawText: '', wildcards: {} };

        const ext = char?.data?.extensions?.[NAMESPACE];
        if (ext && typeof ext === 'object') {
            let rawText = typeof ext.rawText === 'string' ? ext.rawText : '';
            const wildcards = (ext.wildcards && typeof ext.wildcards === 'object') ? ext.wildcards : {};

            // 旧形式（rawText 未保存）からの復元
            if (!rawText && Object.keys(wildcards).length > 0) {
                rawText = Object.entries(wildcards)
                    .map(([k, v]) => `${k} = ${Array.isArray(v) ? v.join(',') : v}`)
                    .join('\n');
            }

            return { rawText, wildcards };
        }
    } catch (e) {
        console.warn(LOG, 'loadWildcardsForChar error:', e);
    }
    return { rawText: '', wildcards: {} };
}

function saveWildcardsForChar(charName, rawText, wildcards) {
    if (!charName) return false;

    try {
        const ctx = getSTContext();
        const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
        if (char?.name !== charName) {
            console.warn(LOG, 'saveWildcardsForChar: char mismatch');
            return false;
        }

        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};
        char.data.extensions[NAMESPACE] = { rawText, wildcards };

        if (window.CharStore?.saveCharacterExtension) {
            window.CharStore.saveCharacterExtension(NAMESPACE, { rawText, wildcards }, { immediate: true });
        }
        return true;
    } catch (e) {
        console.warn(LOG, 'saveWildcardsForChar error:', e);
        return false;
    }
}

// ============================================================
// 公開 API（他モジュールから呼ばれる）
// ============================================================
function applyToPrompt(prompt) {
    if (!prompt || typeof prompt !== 'string') return prompt;
    const charName = getCurrentCharName();
    if (!charName) return prompt;

    const { wildcards } = loadWildcardsForChar(charName);
    return applyWildcards(prompt, wildcards);
}

function getCurrentWildcards() {
    const charName = getCurrentCharName();
    if (!charName) return {};
    return loadWildcardsForChar(charName).wildcards;
}

function getCurrentRawText() {
    const charName = getCurrentCharName();
    if (!charName) return '';
    return loadWildcardsForChar(charName).rawText;
}

// ============================================================
// CSS 注入
// ============================================================
function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        /* Random_Prompt_Wildcard ボタン */
        #${BUTTON_ID} {
            display: block;
            margin: 6px auto;
            padding: 6px 16px;
            font-size: 13px;
            font-weight: bold;
            background-color: #4a5568;
            color: #ffffff;
            border: 1px solid #718096;
            border-radius: 4px;
            cursor: pointer;
            white-space: nowrap;
            box-sizing: border-box;
        }
        #${BUTTON_ID}:hover {
            background-color: #2d3748;
        }

        /* モーダル */
        #${MODAL_ID} {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 900px;
            height: 900px;
            max-width: calc(100vw - 40px);
            max-height: calc(100vh - 40px);
            background-color: #1a202c;
            border: 2px solid #4a5568;
            border-radius: 8px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.8);
            z-index: 25000;
            display: none;
            flex-direction: column;
            overflow: hidden;
            box-sizing: border-box;
        }
        #${MODAL_ID}.visible {
            display: flex;
        }

        #${MODAL_ID} .rpw-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 16px;
            background-color: #2d3748;
            border-bottom: 1px solid #4a5568;
            flex: 0 0 auto;
        }
        #${MODAL_ID} .rpw-title {
            font-size: 16px;
            font-weight: bold;
            color: #ffffff;
        }
        #${CLOSE_BTN_ID} {
            width: 32px;
            height: 32px;
            padding: 0;
            background-color: #e53e3e;
            color: #ffffff;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 18px;
            font-weight: bold;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        #${CLOSE_BTN_ID}:hover {
            background-color: #c53030;
        }

        #${TEXTAREA_ID} {
            flex: 1 1 auto;
            width: 100%;
            height: 100%;
            padding: 12px;
            background-color: #0d1117;
            color: #e2e8f0;
            border: none;
            outline: none;
            resize: none;
            font-family: monospace;
            font-size: 14px;
            line-height: 1.6;
            box-sizing: border-box;
            overflow-y: scroll;
            overflow-x: auto;
            white-space: pre;
            tab-size: 4;
        }
        #${TEXTAREA_ID}::placeholder {
            color: #4a5568;
        }
    `;
    document.head.appendChild(style);
}

// ============================================================
// モーダル生成
// ============================================================
function ensureModal() {
    let modal = document.getElementById(MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = MODAL_ID;

    const header = document.createElement('div');
    header.className = 'rpw-header';

    const title = document.createElement('div');
    title.className = 'rpw-title';
    title.textContent = 'Random Prompt Wildcard 設定';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.id = CLOSE_BTN_ID;
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.title = '閉じる (Escape)';
    closeBtn.addEventListener('click', () => closeModal());
    header.appendChild(closeBtn);

    modal.appendChild(header);

    const textarea = document.createElement('textarea');
    textarea.id = TEXTAREA_ID;
    textarea.spellcheck = false;
    textarea.placeholder = [
        '# 1行1定義: name? = value1,value2,value3',
        '# プロンプト中の name? がランダムに置換されます',
        'color1? = black,brown,orange,yellow,pink',
        'hair_style? = straight,curly,wavy',
    ].join('\n');
    textarea.addEventListener('input', () => {
        const charName = _currentCharName;
        if (!charName) return;
        const rawText = textarea.value;
        const wildcards = parseWildcardText(rawText);
        saveWildcardsForChar(charName, rawText, wildcards);
    });
    modal.appendChild(textarea);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('visible')) {
            closeModal();
        }
    });

    document.body.appendChild(modal);
    return modal;
}

function openModal() {
    const charName = getCurrentCharName();
    if (!charName) {
        console.warn(LOG, 'キャラクターが選択されていません');
        if (typeof window.toastr !== 'undefined' && typeof window.toastr.warning === 'function') {
            window.toastr.warning('キャラクターを選択してください');
        } else {
            alert('キャラクターを選択してください');
        }
        return;
    }

    _currentCharName = charName;
    const modal = ensureModal();
    const textarea = modal.querySelector('#' + TEXTAREA_ID);

    const { rawText } = loadWildcardsForChar(charName);
    textarea.value = rawText;

    modal.classList.add('visible');
    setTimeout(() => {
        try { textarea.focus(); } catch (e) { /* ignore */ }
    }, 50);
}

function closeModal() {
    const modal = document.getElementById(MODAL_ID);
    if (modal) modal.classList.remove('visible');

    if (_currentCharName) {
        const textarea = modal?.querySelector('#' + TEXTAREA_ID);
        if (textarea) {
            const rawText = textarea.value;
            const wildcards = parseWildcardText(rawText);
            saveWildcardsForChar(_currentCharName, rawText, wildcards);
        }
    }
    _currentCharName = null;
}

// ============================================================
// ボタン注入・監視
// ============================================================
function createButton() {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.textContent = 'Random_Prompt_Wildcard';
    btn.title = 'キャラクター毎のランダムプロンプトワイルドカードを設定';
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openModal();
    });
    return btn;
}

function syncButton() {
    const target = document.getElementById(TARGET_HEADER_ID);
    let btn = document.getElementById(BUTTON_ID);

    if (!target) {
        if (btn) btn.remove();
        return;
    }

    // 正しい位置に既にある場合は何もしない
    if (btn && btn.nextElementSibling === target && btn.parentElement === target.parentElement) {
        return;
    }

    if (btn) btn.remove();
    btn = createButton();
    target.parentElement.insertBefore(btn, target);
    console.log(LOG, 'ボタンを #' + TARGET_HEADER_ID + ' の真上に注入しました');
}

let _observer = null;

function setupObserver() {
    if (_observer) _observer.disconnect();

    _observer = new MutationObserver(() => {
        syncButton();
    });

    _observer.observe(document.body, {
        childList: true,
        subtree: true,
    });

    // 初回注入
    syncButton();
}

// ============================================================
// 初期化
// ============================================================
function init() {
    console.log(LOG, '初期化開始');
    injectStyle();
    ensureModal();
    setupObserver();

    try {
        const ctx = getSTContext();
        if (ctx?.eventSource && ctx?.eventTypes) {
            const et = ctx.eventTypes;
            const es = ctx.eventSource;
            const onCharChange = () => {
                _currentCharName = null;
            };
            ['CHAT_CHANGED', 'CHARACTER_SELECTED', 'CHARACTER_PAGE_LOADED'].forEach(name => {
                if (et[name] && typeof es.on === 'function') es.on(et[name], onCharChange);
            });
        }
    } catch (e) { /* ignore */ }

    console.log(LOG, '初期化完了');
}

// ============================================================
// 公開 API
// ============================================================
window.RandomPromptWildcard = {
    applyToPrompt,
    getCurrentWildcards,
    getCurrentRawText,
    openModal,
    closeModal,
    parseWildcardText,
    applyWildcards,
    testApply: (prompt) => applyWildcards(prompt, getCurrentWildcards()),
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
console.log(LOG, 'window.RandomPromptWildcard に API を公開しました');
