// random_prompt_wildcard.js
// キャラクター毎のランダムプロンプトワイルドカード管理
// ★ 追加: キャラ推奨LoRAボタン + モーダル
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
// ★ キャラ推奨LoRAの保存先: character.data.extensions.character_recommended_lora
//   { recommendedLoras: [{ name, downloadUrl, triggerWords, description }] }
// ★ JSON / PNG エクスポートに含まれる（CharStore 経由）

import { getContext } from '../../../../extensions.js';

const LOG = '[RandomPromptWildcard]';
const NAMESPACE = 'random_prompt_wildcard';
const BUTTON_ID = 'rpw-open-button';
const MODAL_ID = 'rpw-modal';
const HELP_MODAL_ID = 'rpw-help-modal';
const TEXTAREA_ID = 'rpw-textarea';
const CLOSE_BTN_ID = 'rpw-close-button';
const HELP_BTN_ID = 'rpw-help-button';
const HELP_CLOSE_BTN_ID = 'rpw-help-close-button';
const STYLE_ID = 'rpw-style';
const TARGET_HEADER_ID = 'WIEntryHeaderTitlesPC';

// ★ 追加: キャラ推奨LoRA関連の定数
const LORA_NAMESPACE = 'character_recommended_lora';
const LORA_BUTTON_ID = 'crl-open-button';
const LORA_MODAL_ID = 'crl-modal';
const LORA_CLOSE_BTN_ID = 'crl-close-button';
const LORA_LIST_ID = 'crl-lora-list';
const LORA_ADD_BTN_ID = 'crl-add-button';
const BUTTON_CONTAINER_ID = 'rpw-button-container';

// ============================================================
// 状態
// ============================================================
let _currentCharName = null;
let _currentLoraCharName = null;

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
// ============================================================
function applyWildcards(prompt, wildcards) {
    if (!prompt || typeof prompt !== 'string') return prompt;
    if (!wildcards || typeof wildcards !== 'object') return prompt;

    const keys = Object.keys(wildcards)
        .filter(k => k && Array.isArray(wildcards[k]) && wildcards[k].length > 0)
        .sort((a, b) => b.length - a.length);

    if (keys.length === 0) return prompt;

    const selections = {};
    for (const key of keys) {
        const values = wildcards[key];
        selections[key] = values[Math.floor(Math.random() * values.length)];
    }

    let result = prompt;
    for (const key of keys) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(escapedKey, 'g');
        result = result.replace(re, () => selections[key]);
    }
    return result;
}

// ============================================================
// Wildcard 永続化
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
// 公開 API（wildcard）
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
// ★ 追加: キャラ推奨LoRA 永続化
// ============================================================
function normalizeLoraEntry(raw) {
    if (!raw || typeof raw !== 'object') {
        return { name: '', downloadUrl: '', triggerWords: '', description: '' };
    }
    return {
        name: typeof raw.name === 'string' ? raw.name : '',
        downloadUrl: typeof raw.downloadUrl === 'string' ? raw.downloadUrl : '',
        triggerWords: typeof raw.triggerWords === 'string' ? raw.triggerWords : '',
        description: typeof raw.description === 'string' ? raw.description : '',
    };
}

function loadLorasForChar(charName) {
    if (!charName) return [];
    try {
        const ctx = getSTContext();
        const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
        if (char?.name !== charName) return [];

        const ext = char?.data?.extensions?.[LORA_NAMESPACE];
        if (ext && typeof ext === 'object' && Array.isArray(ext.recommendedLoras)) {
            return ext.recommendedLoras
                .filter(v => v && typeof v === 'object')
                .map(normalizeLoraEntry);
        }
    } catch (e) {
        console.warn(LOG, 'loadLorasForChar error:', e);
    }
    return [];
}

function saveLorasForChar(charName, loras) {
    if (!charName) return false;
    try {
        const ctx = getSTContext();
        const char = ctx?.characters?.[ctx?.characterId] || ctx?.character;
        if (char?.name !== charName) {
            console.warn(LOG, 'saveLorasForChar: char mismatch');
            return false;
        }

        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};
        char.data.extensions[LORA_NAMESPACE] = {
            recommendedLoras: (Array.isArray(loras) ? loras : []).map(normalizeLoraEntry),
        };

        if (window.CharStore?.saveCharacterExtension) {
            window.CharStore.saveCharacterExtension(
                LORA_NAMESPACE,
                char.data.extensions[LORA_NAMESPACE],
                { immediate: true }
            );
        }
        return true;
    } catch (e) {
        console.warn(LOG, 'saveLorasForChar error:', e);
        return false;
    }
}

// ============================================================
// ★ キャラ名に応じたボタンラベル / モーダルタイトル
//   キャラ未選択時は「キャラ推奨LoRA」/「キャラ推奨 LoRA 設定」
//   キャラ選択時は「{キャラ名} 推奨LoRA」/「{キャラ名} 推奨 LoRA 設定」
// ============================================================
function getLoraButtonLabel() {
    const charName = getCurrentCharName();
    if (!charName || !charName.trim()) return 'キャラ推奨LoRA';
    return `${charName.trim()} 推奨LoRA`;
}

function getLoraModalTitle() {
    const charName = getCurrentCharName();
    if (!charName || !charName.trim()) return 'キャラ推奨 LoRA 設定';
    return `${charName.trim()} 推奨 LoRA 設定`;
}

// ============================================================
// CSS 注入
// ============================================================
function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        /* ★ ボタンコンテナ（中央配置） */
        #${BUTTON_CONTAINER_ID} {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 8px;
            margin: 6px 0;
            width: 100%;
            box-sizing: border-box;
        }

        /* Random_Prompt_Wildcard ボタン */
        #${BUTTON_ID},
        #${LORA_BUTTON_ID} {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            flex: 0 0 auto;
            margin: 0;
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
            min-width: max-content;
        }
        #${BUTTON_ID}:hover {
            background-color: #2d3748;
        }
        #${LORA_BUTTON_ID} {
            background-color: #6b46c1;
            border-color: #9f7aea;
        }
        #${LORA_BUTTON_ID}:hover {
            background-color: #553c9a;
        }

        /* モーダル共通 */
        #${MODAL_ID}, #${HELP_MODAL_ID}, #${LORA_MODAL_ID} {
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
            display: none;
            flex-direction: column;
            overflow: hidden;
            box-sizing: border-box;
        }
        #${MODAL_ID} { z-index: 25000; }
        #${HELP_MODAL_ID} { z-index: 25100; border-color: #64b5f6; }
        #${LORA_MODAL_ID} { z-index: 25000; border-color: #9f7aea; }
        #${MODAL_ID}.visible,
        #${HELP_MODAL_ID}.visible,
        #${LORA_MODAL_ID}.visible {
            display: flex;
        }

        /* ヘッダー */
        #${MODAL_ID} .rpw-header,
        #${HELP_MODAL_ID} .rpw-header,
        #${LORA_MODAL_ID} .rpw-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 16px;
            background-color: #2d3748;
            border-bottom: 1px solid #4a5568;
            flex: 0 0 auto;
            gap: 12px;
        }
        #${MODAL_ID} .rpw-header-left,
        #${HELP_MODAL_ID} .rpw-header-left,
        #${LORA_MODAL_ID} .rpw-header-left {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            flex: 1 1 auto;
        }
        #${MODAL_ID} .rpw-title,
        #${HELP_MODAL_ID} .rpw-title,
        #${LORA_MODAL_ID} .rpw-title {
            font-size: 16px;
            font-weight: bold;
            color: #ffffff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* ヘルプボタン */
        #${HELP_BTN_ID} {
            flex: 0 0 auto;
            height: 28px;
            padding: 0 14px;
            background-color: #2c5282;
            color: #ffffff;
            border: 1px solid #63b3ed;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: bold;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            line-height: 1;
            white-space: nowrap;
            box-sizing: border-box;
            letter-spacing: 0.05em;
        }
        #${HELP_BTN_ID}:hover {
            background-color: #4299e1;
        }

        /* 閉じるボタン */
        #${CLOSE_BTN_ID},
        #${HELP_CLOSE_BTN_ID},
        #${LORA_CLOSE_BTN_ID} {
            flex: 0 0 auto;
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
        #${CLOSE_BTN_ID}:hover,
        #${HELP_CLOSE_BTN_ID}:hover,
        #${LORA_CLOSE_BTN_ID}:hover {
            background-color: #c53030;
        }

        /* テキストエリア（wildcard用） */
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

        /* ヘルプモーダル本文 */
        #${HELP_MODAL_ID} .rpw-help-body {
            flex: 1 1 auto;
            overflow-y: auto;
            padding: 20px 24px;
            background-color: #1a202c;
            color: #e2e8f0;
            font-size: 14px;
            line-height: 1.7;
        }
        #${HELP_MODAL_ID} .rpw-help-body::-webkit-scrollbar {
            width: 12px;
        }
        #${HELP_MODAL_ID} .rpw-help-body::-webkit-scrollbar-track {
            background: #0d1117;
        }
        #${HELP_MODAL_ID} .rpw-help-body::-webkit-scrollbar-thumb {
            background: #4a5568;
            border-radius: 6px;
        }

        .rpw-help-section {
            margin-bottom: 24px;
            padding: 14px 18px;
            background-color: #2d3748;
            border-left: 4px solid #64b5f6;
            border-radius: 4px;
        }
        .rpw-help-section-highlight {
            background-color: #3a2d4d;
            border-left-color: #b794f4;
        }
        .rpw-help-section h3 {
            margin: 0 0 12px 0;
            font-size: 17px;
            color: #64b5f6;
            font-weight: bold;
            border-bottom: 1px solid #4a5568;
            padding-bottom: 6px;
        }
        .rpw-help-section-highlight h3 {
            color: #d6bcfa;
            border-bottom-color: #b794f4;
        }
        .rpw-help-section p { margin: 8px 0; color: #e2e8f0; }
        .rpw-help-section ul { margin: 8px 0; padding-left: 24px; color: #e2e8f0; }
        .rpw-help-section li { margin: 4px 0; }
        .rpw-help-section strong { color: #ffffff; font-weight: bold; }
        .rpw-help-section code {
            background-color: #0d1117;
            color: #fbd38d;
            padding: 1px 6px;
            border-radius: 3px;
            font-family: monospace;
            font-size: 13px;
            border: 1px solid #4a5568;
        }
        .rpw-help-section .rpw-code-block {
            margin: 8px 0;
            padding: 10px 14px;
            background-color: #0d1117;
            color: #aed581;
            border: 1px solid #2d3748;
            border-radius: 4px;
            font-family: monospace;
            font-size: 13px;
            line-height: 1.6;
            white-space: pre-wrap;
            word-break: break-all;
            overflow-x: auto;
        }
        .rpw-example-def,
        .rpw-example-usage,
        .rpw-example-result {
            margin: 8px 0;
        }
        .rpw-example-label {
            display: inline-block;
            font-size: 12px;
            font-weight: bold;
            color: #90cdf4;
            background-color: #2c5282;
            padding: 2px 10px;
            border-radius: 3px;
            margin-bottom: 4px;
        }
        .rpw-example-result .rpw-example-label {
            color: #c6f6d5;
            background-color: #276749;
        }
        .rpw-note {
            margin: 10px 0 0 0;
            padding: 8px 12px;
            background-color: #1a202c;
            border-left: 3px solid #fbd38d;
            color: #fbd38d;
            font-size: 13px;
            border-radius: 3px;
        }

        /* ============================================================
           キャラ推奨LoRA モーダル
           ============================================================ */
        #${LORA_MODAL_ID} .crl-body {
            flex: 1 1 auto;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        #${LORA_MODAL_ID} .crl-top-section {
            flex: 1 1 55%;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            border-bottom: 2px solid #4a5568;
        }
        #${LORA_MODAL_ID} .crl-top-header {
            flex: 0 0 auto;
            padding: 8px 16px;
            background-color: #2d3748;
            color: #d6bcfa;
            font-size: 14px;
            font-weight: bold;
            border-bottom: 1px solid #4a5568;
        }
        #${LORA_MODAL_ID} .crl-list {
            flex: 1 1 auto;
            overflow-y: auto;
            padding: 12px 16px;
            background-color: #1a202c;
        }
        #${LORA_MODAL_ID} .crl-list::-webkit-scrollbar { width: 10px; }
        #${LORA_MODAL_ID} .crl-list::-webkit-scrollbar-track { background: #0d1117; }
        #${LORA_MODAL_ID} .crl-list::-webkit-scrollbar-thumb { background: #4a5568; border-radius: 5px; }

        #${LORA_MODAL_ID} .crl-entry {
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
            padding: 10px;
            background-color: #2d3748;
            border: 1px solid #4a5568;
            border-radius: 6px;
            align-items: stretch;
        }
        #${LORA_MODAL_ID} .crl-entry-fields {
            flex: 1 1 auto;
            display: flex;
            flex-direction: column;
            gap: 6px;
            min-width: 0;
        }
        #${LORA_MODAL_ID} .crl-label {
            display: block;
            font-size: 12px;
            font-weight: bold;
            color: #e2e8f0;
            margin-bottom: 2px;
        }
        #${LORA_MODAL_ID} .crl-label-required {
            color: #fbd38d;
        }
        #${LORA_MODAL_ID} .crl-name,
        #${LORA_MODAL_ID} .crl-url,
        #${LORA_MODAL_ID} .crl-trigger {
            width: 100%;
            padding: 6px 10px;
            background-color: #0d1117;
            color: #ffffff;
            border: 1px solid #4a5568;
            border-radius: 4px;
            font-size: 13px;
            box-sizing: border-box;
            outline: none;
        }
        #${LORA_MODAL_ID} .crl-name:focus,
        #${LORA_MODAL_ID} .crl-url:focus,
        #${LORA_MODAL_ID} .crl-trigger:focus,
        #${LORA_MODAL_ID} .crl-description:focus {
            border-color: #9f7aea;
            box-shadow: 0 0 0 2px rgba(159, 122, 234, 0.3);
        }
        #${LORA_MODAL_ID} .crl-name {
            font-weight: bold;
            font-size: 14px;
            color: #fbd38d;
        }
        #${LORA_MODAL_ID} .crl-description {
            width: 100%;
            min-height: 50px;
            padding: 6px 10px;
            background-color: #0d1117;
            color: #ffffff;
            border: 1px solid #4a5568;
            border-radius: 4px;
            font-size: 13px;
            box-sizing: border-box;
            resize: vertical;
            font-family: inherit;
            outline: none;
        }
        #${LORA_MODAL_ID} .crl-delete {
            flex: 0 0 auto;
            width: 48px;
            padding: 0;
            background-color: #e53e3e;
            color: #ffffff;
            border: 1px solid #c53030;
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
            font-weight: bold;
            display: flex;
            align-items: center;
            justify-content: center;
            align-self: stretch;
        }
        #${LORA_MODAL_ID} .crl-delete:hover {
            background-color: #c53030;
        }

        #${LORA_MODAL_ID} .crl-add-row {
            flex: 0 0 auto;
            padding: 8px 16px;
            background-color: #2d3748;
            border-top: 1px solid #4a5568;
            text-align: center;
        }
        #${LORA_ADD_BTN_ID} {
            padding: 8px 24px;
            background-color: #38a169;
            color: #ffffff;
            border: 1px solid #2f855a;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            font-weight: bold;
        }
        #${LORA_ADD_BTN_ID}:hover {
            background-color: #2f855a;
        }

        #${LORA_MODAL_ID} .crl-help-section {
            flex: 1 1 45%;
            overflow-y: auto;
            padding: 14px 20px;
            background-color: #1a202c;
            color: #e2e8f0;
            font-size: 13px;
            line-height: 1.7;
        }
        #${LORA_MODAL_ID} .crl-help-section::-webkit-scrollbar { width: 10px; }
        #${LORA_MODAL_ID} .crl-help-section::-webkit-scrollbar-track { background: #0d1117; }
        #${LORA_MODAL_ID} .crl-help-section::-webkit-scrollbar-thumb { background: #4a5568; border-radius: 5px; }

        .crl-help-block {
            margin-bottom: 14px;
            padding: 10px 14px;
            background-color: #2d3748;
            border-left: 4px solid #9f7aea;
            border-radius: 4px;
        }
        .crl-help-block h4 {
            margin: 0 0 8px 0;
            font-size: 14px;
            color: #d6bcfa;
            font-weight: bold;
            border-bottom: 1px solid #4a5568;
            padding-bottom: 4px;
        }
        .crl-help-block p { margin: 6px 0; }
        .crl-help-block ul { margin: 6px 0; padding-left: 20px; }
        .crl-help-block li { margin: 3px 0; }
        .crl-help-block strong { color: #ffffff; }
        .crl-help-block code {
            background-color: #0d1117;
            color: #fbd38d;
            padding: 1px 6px;
            border-radius: 3px;
            font-family: monospace;
            font-size: 12px;
            border: 1px solid #4a5568;
        }
        .crl-code-block {
            margin: 6px 0;
            padding: 8px 12px;
            background-color: #0d1117;
            color: #aed581;
            border: 1px solid #2d3748;
            border-radius: 4px;
            font-family: monospace;
            font-size: 12px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .crl-warn {
            margin: 8px 0 0 0;
            padding: 6px 10px;
            background-color: #1a202c;
            border-left: 3px solid #fbd38d;
            color: #fbd38d;
            font-size: 12px;
            border-radius: 3px;
        }
    `;
    document.head.appendChild(style);
}

// ============================================================
// ヘルプ本文 HTML（wildcard）
// ============================================================
function getHelpContentHTML() {
    return `
        <section class="rpw-help-section">
            <h3>概要</h3>
            <p>
                ここに定義したワイルドカードは、このキャラクター専用のプロンプト変数として記録されます。
                ロアブックの <code>Img_prompt</code> や <code>Negative_prompt</code> に含まれる
                <strong>変数名</strong>が、画像生成時に自動的に<strong>ランダムな値</strong>へ置き換えられます。
            </p>
        </section>

        <section class="rpw-help-section">
            <h3>基本構文</h3>
            <pre class="rpw-code-block">変数名 = 値1,値2,値3, ...</pre>
            <ul>
                <li>「変数名」と <code>=</code> の間にスペースを入れてください。</li>
                <li>値はカンマ <code>,</code> で区切ってください。</li>
                <li>1行につき1つの変数を定義します。</li>
                <li>変数名には好きな文字を使えます（例: <code>color1?</code>, <code>eyes</code>）</li>
            </ul>
        </section>

        <section class="rpw-help-section">
            <h3>例 1: 髪の色をランダム化</h3>
            <div class="rpw-example-def">
                <div class="rpw-example-label">定義</div>
                <pre class="rpw-code-block">color1? = black,brown,orange,yellow,pink</pre>
            </div>
            <div class="rpw-example-usage">
                <div class="rpw-example-label">ロアブックのプロンプト</div>
                <pre class="rpw-code-block">1girl,color1? hair, miniskirt,</pre>
            </div>
            <div class="rpw-example-result">
                <div class="rpw-example-label">生成結果の例</div>
                <pre class="rpw-code-block">1girl,black hair, miniskirt,
1girl,brown hair, miniskirt,
1girl,pink hair, miniskirt,</pre>
            </div>
        </section>

        <section class="rpw-help-section rpw-help-section-highlight">
            <h3>例 2: 同じ変数を複数箇所で使う（重要）</h3>
            <p>1回の画像生成で<strong>同じ変数は同じ値</strong>になります。</p>
            <div class="rpw-example-usage">
                <div class="rpw-example-label">プロンプト</div>
                <pre class="rpw-code-block">color1? hair, color1? eyes, 1girl</pre>
            </div>
            <div class="rpw-example-result">
                <div class="rpw-example-label">生成例（髪と瞳が同じ色になる）</div>
                <pre class="rpw-code-block">pink hair, pink eyes, 1girl
brown hair, brown eyes, 1girl</pre>
            </div>
            <p class="rpw-note">
                ※ 別々の色にしたい場合は <code>color1?</code> <code>color2?</code> と別名の変数を定義してください。
            </p>
        </section>

        <section class="rpw-help-section">
            <h3>例 3: カンマを含む値を使いたい場合</h3>
            <p>ダブルクォートまたはシングルクォートで囲ってください。</p>
            <div class="rpw-example-def">
                <div class="rpw-example-label">定義</div>
                <pre class="rpw-code-block">style? = "soft, pastel", "sharp, realistic"</pre>
            </div>
        </section>

        <section class="rpw-help-section">
            <h3>注意事項</h3>
            <ul>
                <li><code>#</code> で始まる行はコメントとして無視されます。</li>
                <li>空行も無視されます。</li>
                <li>値が空の変数（例: <code>foo =</code>）は無視されます。</li>
                <li>変数名が同じ場合は、後から書いた定義が優先されます。</li>
                <li>ロアブックに変数名が含まれていない場合は何も変化しません。</li>
                <li>入力内容は自動的に保存されます（キャラクター毎に独立管理）。</li>
            </ul>
        </section>
    `;
}

// ============================================================
// キャラ推奨LoRA ヘルプ本文 HTML
// ============================================================
function getLoraHelpHTML() {
    return `
        <div class="crl-help-block">
            <h4>📖 LoRAとは</h4>
            <p>
                LoRA（Low-Rank Adaptation）は、ベースモデルの画風やキャラクターを
                <strong>追加学習</strong>するための軽量な追加ファイルです。
                ベースモデルを変えずに、特定のスタイル・キャラクター・構図を再現できます。
            </p>
        </div>

        <div class="crl-help-block">
            <h4>📦 LoRAファイルの配置</h4>
            <p>ダウンロードした <code>.safetensors</code> ファイルを以下に配置してください。</p>
            <ul>
                <li><strong>ComfyUI ローカル:</strong> <code>ComfyUI/models/loras/</code></li>
                <li><strong>Colab + Google Drive:</strong> <code>MyDrive/ComfyUI/models/loras/</code></li>
                <li><strong>SillyTavern SD拡張:</strong> <code>data/default-user/extensions/sd/models/lora/</code></li>
            </ul>
            <p class="crl-warn">
                ⚠️ ファイル名は<strong>完全一致</strong>が必要です（大文字小文字・拡張子まで）。
            </p>
        </div>

        <div class="crl-help-block">
            <h4>✍️ プロンプトへの記述</h4>
            <p>Img_prompt に以下のタグを書くと、LoRAが適用されます。</p>
            <pre class="crl-code-block">&lt;lora:ファイル名:強度&gt;</pre>
            <p>例:</p>
            <pre class="crl-code-block">&lt;lora:myCharacterLora.safetensors:0.8&gt; 1girl, school uniform</pre>
            <p>
                <strong>強度</strong>は <code>0.0</code> 〜 <code>1.0</code> の範囲で指定します。
                <code>0.6</code> 〜 <code>0.8</code> が一般的です。
            </p>
        </div>

        <div class="crl-help-block">
            <h4>🔑 トリガーワード</h4>
            <p>
                LoRAによっては、効果を発動させるために<strong>特定のキーワード</strong>
                （トリガーワード）をプロンプトに含める必要があります。
                Civitai のLoRAページの説明欄に記載されています。
            </p>
            <pre class="crl-code-block">&lt;lora:myLora:0.8&gt;, myStyle, 1girl</pre>
        </div>

        <div class="crl-help-block">
            <h4>💡 強度の目安</h4>
            <ul>
                <li><strong>0.3〜0.5:</strong> 控えめ。ベースモデルの画風を残す</li>
                <li><strong>0.6〜0.8:</strong> 標準。バランスが良い</li>
                <li><strong>0.9〜1.0:</strong> 強め。LoRAの特徴を強く出す</li>
                <li><strong>1.0超:</strong> 過飽和・アーティファクトの原因になる</li>
            </ul>
        </div>

        <div class="crl-help-block">
            <h4>⚠️ SDXL / SD1.5 の互換性</h4>
            <p>
                LoRAは<strong>ベースモデルと同じ系統</strong>でなければ動作しません。
                NovaAnimeXL は <strong>SDXL</strong> ベースなので、
                <strong>SDXL用LoRA</strong>（Civitaiで「SDXL 1.0」「Pony」「Illustrious」等）を使ってください。
            </p>
            <p class="crl-warn">
                ⚠️ SD1.5用LoRAはSDXLモデルでは効果がほとんど出ません。
            </p>
        </div>

        <div class="crl-help-block">
            <h4>🔄 複数LoRAの併用</h4>
            <p>1つのプロンプトに複数のLoRAタグを書けます。</p>
            <pre class="crl-code-block">&lt;lora:styleA:0.7&gt; &lt;lora:styleB:0.5&gt; 1girl, ...</pre>
            <p>合計強度が <code>1.5</code> を超えると画質劣化の原因になるため注意してください。</p>
        </div>

        <div class="crl-help-block">
            <h4>🧪 動作確認のポイント</h4>
            <ul>
                <li>ComfyUIのサーバーログに <code>detected lora tag: (...)</code> が出れば認識成功</li>
                <li><code>patches attached: N</code> の N が 0 より大きければ適用成功</li>
                <li>LoRAを外して同じプロンプトで生成し、見た目を比較する</li>
                <li>強度を <code>1.5</code> まで上げて変化が強調されるか確認する</li>
            </ul>
        </div>
    `;
}

// ============================================================
// メインモーダル生成（wildcard）
// ============================================================
function ensureModal() {
    let modal = document.getElementById(MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = MODAL_ID;

    const header = document.createElement('div');
    header.className = 'rpw-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'rpw-header-left';

    const title = document.createElement('div');
    title.className = 'rpw-title';
    title.textContent = 'Random Prompt Wildcard 設定';
    headerLeft.appendChild(title);

    const helpBtn = document.createElement('button');
    helpBtn.id = HELP_BTN_ID;
    helpBtn.type = 'button';
    helpBtn.textContent = 'ヘルプ';
    helpBtn.title = '使い方（ヘルプ）を表示';
    helpBtn.addEventListener('click', () => openHelpModal());
    headerLeft.appendChild(helpBtn);

    header.appendChild(headerLeft);

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
        '# 例: color1? = black,brown,orange,yellow,pink',
        '# 詳しくは右上の「ヘルプ」ボタンを押してください',
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

    document.body.appendChild(modal);
    return modal;
}

// ============================================================
// ヘルプモーダル生成（wildcard）
// ============================================================
function ensureHelpModal() {
    let modal = document.getElementById(HELP_MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = HELP_MODAL_ID;

    const header = document.createElement('div');
    header.className = 'rpw-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'rpw-header-left';

    const title = document.createElement('div');
    title.className = 'rpw-title';
    title.textContent = 'Random Prompt Wildcard の使い方';
    headerLeft.appendChild(title);

    header.appendChild(headerLeft);

    const closeBtn = document.createElement('button');
    closeBtn.id = HELP_CLOSE_BTN_ID;
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.title = '閉じる (Escape)';
    closeBtn.addEventListener('click', () => closeHelpModal());
    header.appendChild(closeBtn);

    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'rpw-help-body';
    body.innerHTML = getHelpContentHTML();
    modal.appendChild(body);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeHelpModal();
    });

    document.body.appendChild(modal);
    return modal;
}

// ============================================================
// ★ 追加: キャラ推奨LoRA モーダル
// ============================================================
function ensureLoraModal() {
    let modal = document.getElementById(LORA_MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = LORA_MODAL_ID;

    const header = document.createElement('div');
    header.className = 'rpw-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'rpw-header-left';

    const title = document.createElement('div');
    title.className = 'rpw-title';
    title.textContent = 'キャラ推奨 LoRA 設定';
    headerLeft.appendChild(title);

    header.appendChild(headerLeft);

    const closeBtn = document.createElement('button');
    closeBtn.id = LORA_CLOSE_BTN_ID;
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.title = '閉じる (Escape)';
    closeBtn.addEventListener('click', () => closeLoraModal());
    header.appendChild(closeBtn);

    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'crl-body';

    // ── 上部: 推奨LoRA入力エリア ──
    const topSection = document.createElement('div');
    topSection.className = 'crl-top-section';

    const topHeader = document.createElement('div');
    topHeader.className = 'crl-top-header';
    topHeader.textContent = '推奨 LoRA 入力エリア';
    topSection.appendChild(topHeader);

    const list = document.createElement('div');
    list.className = 'crl-list';
    list.id = LORA_LIST_ID;
    topSection.appendChild(list);

    const addRow = document.createElement('div');
    addRow.className = 'crl-add-row';

    const addBtn = document.createElement('button');
    addBtn.id = LORA_ADD_BTN_ID;
    addBtn.type = 'button';
    addBtn.textContent = '＋ LoRAを追加';
    addBtn.addEventListener('click', () => addLoraEntry());
    addRow.appendChild(addBtn);

    topSection.appendChild(addRow);
    body.appendChild(topSection);

    // ── 下部: LoRA使用法ヘルプ ──
    const helpSection = document.createElement('div');
    helpSection.className = 'crl-help-section';
    helpSection.innerHTML = getLoraHelpHTML();
    body.appendChild(helpSection);

    modal.appendChild(body);

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeLoraModal();
    });

    document.body.appendChild(modal);
    return modal;
}

// ============================================================
// ★ 追加: LoRAエントリ行の生成
// ============================================================
function createLoraEntryRow(entry, index) {
    const row = document.createElement('div');
    row.className = 'crl-entry';
    row.dataset.index = String(index);

    const fields = document.createElement('div');
    fields.className = 'crl-entry-fields';

    // ① Lora名
    const nameLabel = document.createElement('label');
    nameLabel.className = 'crl-label crl-label-required';
    nameLabel.textContent = '① LoRA名（ファイル名）';
    fields.appendChild(nameLabel);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'crl-name';
    nameInput.placeholder = '例: myCharacterLora.safetensors';
    nameInput.value = entry.name || '';
    nameInput.addEventListener('input', () => {
        entry.name = nameInput.value;
        saveCurrentLoras();
    });
    fields.appendChild(nameInput);

    // ② ダウンロードURL
    const urlLabel = document.createElement('label');
    urlLabel.className = 'crl-label';
    urlLabel.textContent = '② ダウンロードURL';
    fields.appendChild(urlLabel);

    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.className = 'crl-url';
    urlInput.placeholder = '例: https://civitai.com/models/xxxxx';
    urlInput.value = entry.downloadUrl || '';
    urlInput.addEventListener('input', () => {
        entry.downloadUrl = urlInput.value;
        saveCurrentLoras();
    });
    fields.appendChild(urlInput);

    // ③ トリガーワード
    const triggerLabel = document.createElement('label');
    triggerLabel.className = 'crl-label';
    triggerLabel.textContent = '③ トリガーワード';
    fields.appendChild(triggerLabel);

    const triggerInput = document.createElement('input');
    triggerInput.type = 'text';
    triggerInput.className = 'crl-trigger';
    triggerInput.placeholder = '例: myStyle, characterName';
    triggerInput.value = entry.triggerWords || '';
    triggerInput.addEventListener('input', () => {
        entry.triggerWords = triggerInput.value;
        saveCurrentLoras();
    });
    fields.appendChild(triggerInput);

    // ④ 説明
    const descLabel = document.createElement('label');
    descLabel.className = 'crl-label';
    descLabel.textContent = '④ 説明';
    fields.appendChild(descLabel);

    const descInput = document.createElement('textarea');
    descInput.className = 'crl-description';
    descInput.placeholder = 'このLoRAの説明、推奨強度、注意点など';
    descInput.value = entry.description || '';
    descInput.addEventListener('input', () => {
        entry.description = descInput.value;
        saveCurrentLoras();
    });
    fields.appendChild(descInput);

    row.appendChild(fields);

    // 削除ボタン（右端）
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'crl-delete';
    delBtn.textContent = '✕';
    delBtn.title = 'このLoRAを削除';
    delBtn.addEventListener('click', () => {
        if (!confirm('この LoRA を削除しますか？\nこの操作は取り消せません。')) return;
        const charName = _currentLoraCharName;
        if (!charName) return;

        const loras = loadLorasForChar(charName);
        loras.splice(index, 1);
        saveLorasForChar(charName, loras);
        renderLoraEntries();
        console.log(`${LOG} LoRA ${index} を削除`);
    });
    row.appendChild(delBtn);

    return row;
}

function renderLoraEntries() {
    const modal = document.getElementById(LORA_MODAL_ID);
    if (!modal) return;
    const list = modal.querySelector('#' + LORA_LIST_ID);
    if (!list) return;

    list.innerHTML = '';

    const charName = _currentLoraCharName;
    if (!charName) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color: #a0aec0; text-align: center; padding: 20px;';
        empty.textContent = 'キャラクターが選択されていません';
        list.appendChild(empty);
        return;
    }

    const loras = loadLorasForChar(charName);
    if (loras.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color: #a0aec0; text-align: center; padding: 20px; font-size: 13px;';
        empty.textContent = 'まだ LoRA が登録されていません。「＋ LoRAを追加」を押してください。';
        list.appendChild(empty);
        return;
    }

    loras.forEach((entry, idx) => {
        const row = createLoraEntryRow(entry, idx);
        list.appendChild(row);
    });
}

function addLoraEntry() {
    const charName = _currentLoraCharName;
    if (!charName) return;

    const loras = loadLorasForChar(charName);
    loras.push({ name: '', downloadUrl: '', triggerWords: '', description: '' });
    saveLorasForChar(charName, loras);
    renderLoraEntries();

    // 追加した行までスクロール
    const modal = document.getElementById(LORA_MODAL_ID);
    if (modal) {
        const list = modal.querySelector('#' + LORA_LIST_ID);
        if (list) {
            setTimeout(() => {
                list.scrollTop = list.scrollHeight;
            }, 30);
        }
    }
}

function saveCurrentLoras() {
    const charName = _currentLoraCharName;
    if (!charName) return;

    const modal = document.getElementById(LORA_MODAL_ID);
    if (!modal) return;
    const list = modal.querySelector('#' + LORA_LIST_ID);
    if (!list) return;

    const rows = list.querySelectorAll('.crl-entry');
    const loras = [];
    rows.forEach(row => {
        const name = row.querySelector('.crl-name')?.value || '';
        const downloadUrl = row.querySelector('.crl-url')?.value || '';
        const triggerWords = row.querySelector('.crl-trigger')?.value || '';
        const description = row.querySelector('.crl-description')?.value || '';
        loras.push({ name, downloadUrl, triggerWords, description });
    });

    saveLorasForChar(charName, loras);
}

// ============================================================
// Escape キー: 開いているモーダルを上から順に閉じる
// ============================================================
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;

    const loraModal = document.getElementById(LORA_MODAL_ID);
    if (loraModal && loraModal.classList.contains('visible')) {
        e.preventDefault();
        e.stopPropagation();
        closeLoraModal();
        return;
    }

    const helpModal = document.getElementById(HELP_MODAL_ID);
    if (helpModal && helpModal.classList.contains('visible')) {
        e.preventDefault();
        e.stopPropagation();
        closeHelpModal();
        return;
    }

    const modal = document.getElementById(MODAL_ID);
    if (modal && modal.classList.contains('visible')) {
        e.preventDefault();
        e.stopPropagation();
        closeModal();
    }
});

// ============================================================
// wildcard モーダル 開閉
// ============================================================
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
    closeHelpModal();

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

function openHelpModal() {
    const helpModal = ensureHelpModal();
    helpModal.classList.add('visible');
    const body = helpModal.querySelector('.rpw-help-body');
    if (body) body.scrollTop = 0;
}

function closeHelpModal() {
    const helpModal = document.getElementById(HELP_MODAL_ID);
    if (helpModal) helpModal.classList.remove('visible');
}

// ============================================================
// ★ 追加: キャラ推奨LoRA モーダル 開閉
// ============================================================
function openLoraModal() {
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

    _currentLoraCharName = charName;
    ensureLoraModal();

    const modal = document.getElementById(LORA_MODAL_ID);

    // ★ モーダルタイトルをキャラ名に応じて更新
    if (modal) {
        const titleEl = modal.querySelector('.rpw-title');
        if (titleEl) {
            titleEl.textContent = getLoraModalTitle();
        }
    }

    renderLoraEntries();

    if (modal) modal.classList.add('visible');
}

function closeLoraModal() {
    const modal = document.getElementById(LORA_MODAL_ID);
    if (!modal) return;

    saveCurrentLoras();
    modal.classList.remove('visible');
    _currentLoraCharName = null;
}

// ============================================================
// ボタン生成・注入
// ============================================================
function createWildcardButton() {
    let btn = document.getElementById(BUTTON_ID);
    if (btn) return btn;

    btn = document.createElement('button');
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

function createLoraButton() {
    let btn = document.getElementById(LORA_BUTTON_ID);
    if (btn) return btn;

    btn = document.createElement('button');
    btn.id = LORA_BUTTON_ID;
    btn.type = 'button';
    btn.textContent = getLoraButtonLabel();   // ★ キャラ名に応じたラベル
    btn.title = 'キャラクター推奨のLoRA情報を登録する';
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openLoraModal();
    });
    return btn;
}

function syncButton() {
    const target = document.getElementById(TARGET_HEADER_ID);
    let container = document.getElementById(BUTTON_CONTAINER_ID);

    if (!target) {
        if (container) container.remove();
        return;
    }

    // 既に正しい位置にある場合は中身だけ確認
    if (container && container.nextElementSibling === target && container.parentElement === target.parentElement) {
        const wildcardBtn = container.querySelector('#' + BUTTON_ID);
        const loraBtn = container.querySelector('#' + LORA_BUTTON_ID);
        if (wildcardBtn && loraBtn) {
            // ★ キャラ名変更に追従してラベルを更新
            const newLabel = getLoraButtonLabel();
            if (loraBtn.textContent !== newLabel) {
                loraBtn.textContent = newLabel;
            }
            return;
        }
    }

    // 既存の単独ボタンを削除（旧バージョンからの移行）
    const oldBtn = document.getElementById(BUTTON_ID);
    if (oldBtn && !container?.contains(oldBtn)) oldBtn.remove();
    const oldLoraBtn = document.getElementById(LORA_BUTTON_ID);
    if (oldLoraBtn && !container?.contains(oldLoraBtn)) oldLoraBtn.remove();

    if (container) container.remove();

    // コンテナ生成
    container = document.createElement('div');
    container.id = BUTTON_CONTAINER_ID;

    container.appendChild(createWildcardButton());
    container.appendChild(createLoraButton());

    target.parentElement.insertBefore(container, target);
    console.log(LOG, 'ボタンコンテナを #' + TARGET_HEADER_ID + ' の真上に注入しました');
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

    syncButton();
}

// ============================================================
// 初期化
// ============================================================
function init() {
    console.log(LOG, '初期化開始');
    injectStyle();
    ensureModal();
    ensureHelpModal();
    ensureLoraModal();
    setupObserver();

    try {
        const ctx = getSTContext();
        if (ctx?.eventSource && ctx?.eventTypes) {
            const et = ctx.eventTypes;
            const es = ctx.eventSource;
            const onCharChange = () => {
                _currentCharName = null;
                _currentLoraCharName = null;
                // ★ キャラ切替時にボタンラベルを即座に更新
                try { syncButton(); } catch (e) { /* ignore */ }
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
    openHelpModal,
    closeHelpModal,
    parseWildcardText,
    applyWildcards,
    testApply: (prompt) => applyWildcards(prompt, getCurrentWildcards()),
};

window.CharacterRecommendedLora = {
    openModal: openLoraModal,
    closeModal: closeLoraModal,
    loadLorasForChar,
    saveLorasForChar,
    getCurrentLoras: () => {
        const charName = getCurrentCharName();
        return charName ? loadLorasForChar(charName) : [];
    },
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
console.log(LOG, 'window.RandomPromptWildcard / window.CharacterRecommendedLora に API を公開しました');
