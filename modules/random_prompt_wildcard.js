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
const HELP_MODAL_ID = 'rpw-help-modal';
const TEXTAREA_ID = 'rpw-textarea';
const CLOSE_BTN_ID = 'rpw-close-button';
const HELP_BTN_ID = 'rpw-help-button';
const HELP_CLOSE_BTN_ID = 'rpw-help-close-button';
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

        /* モーダル共通 */
        #${MODAL_ID}, #${HELP_MODAL_ID} {
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
        #${MODAL_ID} {
            z-index: 25000;
        }
        #${HELP_MODAL_ID} {
            z-index: 25100;
            border-color: #64b5f6;
        }
        #${MODAL_ID}.visible,
        #${HELP_MODAL_ID}.visible {
            display: flex;
        }

        /* ヘッダー */
        #${MODAL_ID} .rpw-header,
        #${HELP_MODAL_ID} .rpw-header {
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
        #${HELP_MODAL_ID} .rpw-header-left {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            flex: 1 1 auto;
        }
        #${MODAL_ID} .rpw-title,
        #${HELP_MODAL_ID} .rpw-title {
            font-size: 16px;
            font-weight: bold;
            color: #ffffff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* ヘルプボタン（横長） */
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
        #${HELP_CLOSE_BTN_ID} {
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
        #${HELP_CLOSE_BTN_ID}:hover {
            background-color: #c53030;
        }

        /* テキストエリア */
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

        /* ============================================================
           ヘルプモーダル本文
           ============================================================ */
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
        .rpw-help-section p {
            margin: 8px 0;
            color: #e2e8f0;
        }
        .rpw-help-section ul {
            margin: 8px 0;
            padding-left: 24px;
            color: #e2e8f0;
        }
        .rpw-help-section li {
            margin: 4px 0;
        }
        .rpw-help-section strong {
            color: #ffffff;
            font-weight: bold;
        }
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
    `;
    document.head.appendChild(style);
}

// ============================================================
// ヘルプ本文 HTML
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
1girl,pink hair, miniskirt,
（他にも orange / yellow など）</pre>
            </div>
        </section>

        <section class="rpw-help-section">
            <h3>例 2: 複数の変数を組み合わせる</h3>
            <div class="rpw-example-def">
                <div class="rpw-example-label">定義</div>
                <pre class="rpw-code-block">hair_style? = straight,curly,wavy
hair_color? = black,brown,blonde</pre>
            </div>
            <div class="rpw-example-usage">
                <div class="rpw-example-label">プロンプト</div>
                <pre class="rpw-code-block">1girl,hair_color? hair,hair_style?</pre>
            </div>
            <div class="rpw-example-result">
                <div class="rpw-example-label">生成例</div>
                <pre class="rpw-code-block">1girl,brown hair,wavy
1girl,blonde hair,straight
1girl,black hair,curly</pre>
            </div>
        </section>

        <section class="rpw-help-section rpw-help-section-highlight">
            <h3>例 3: 同じ変数を複数箇所で使う（重要）</h3>
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
            <h3>例 4: スペースや日本語を含む値</h3>
            <div class="rpw-example-def">
                <div class="rpw-example-label">定義</div>
                <pre class="rpw-code-block">pose? = sitting on chair,standing,lying down
expression? = 笑顔,無表情,泣き顔</pre>
            </div>
        </section>

        <section class="rpw-help-section">
            <h3>例 5: カンマを含む値を使いたい場合</h3>
            <p>ダブルクォートまたはシングルクォートで囲ってください。</p>
            <div class="rpw-example-def">
                <div class="rpw-example-label">定義</div>
                <pre class="rpw-code-block">style? = "soft, pastel", "sharp, realistic"</pre>
            </div>
            <p>
                <code>style?</code> を書くと、<code>"soft, pastel"</code> または
                <code>"sharp, realistic"</code> のいずれか（カンマ込みの値）が選ばれます。
            </p>
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
                <li>JSON / PNG エクスポートにもこの設定が含まれます。</li>
            </ul>
        </section>

        <section class="rpw-help-section">
            <h3>サンプル定義</h3>
            <p>以下の例を消して、自由に編集してください。</p>
            <pre class="rpw-code-block">color1? = black,brown,orange,yellow,pink
hair_style? = straight,curly,wavy</pre>
        </section>
    `;
}

// ============================================================
// メインモーダル生成
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
        '# 詳しくは右上の「?」ボタンを押してください',
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
// ヘルプモーダル生成
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
// Escape キー: 開いているモーダルを上から順に閉じる
// ============================================================
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
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
// 開閉
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
    // ヘルプモーダルが開いていれば一緒に閉じる
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
    // 開いた直後は本文の先頭へスクロール
    const body = helpModal.querySelector('.rpw-help-body');
    if (body) body.scrollTop = 0;
}

function closeHelpModal() {
    const helpModal = document.getElementById(HELP_MODAL_ID);
    if (helpModal) helpModal.classList.remove('visible');
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
    ensureHelpModal();
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
    openHelpModal,
    closeHelpModal,
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
