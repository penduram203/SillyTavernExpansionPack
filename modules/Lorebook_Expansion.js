// Lorebook_Expansion.js
//
// ロアブックの各エントリに Img_prompt / choices の2フィールドを追加する拡張。
//   - Img_prompt : 画像生成プロンプト (gic_lorebook.js が読み取る)
//   - choices    : 応答末尾に自動表示される選択肢群 (番号 + 文言)
//
// ★ データ保存先:
//   一次: extension_settings.lorebook_expansion.data[worldName][uid]
//   二次: entry.extensions.lorebook_expansion (best effort ミラー)
//   読込時は一次を優先。一次が無ければ二次から移行（マイグレーション）。
//
// ★ v6 修正:
//   - ST起動時のWIドロワー自動オープン問題への対策を強化
//     ST本体が jQuery.trigger('click') や classList.add を直接使う場合でも
//     MutationObserver で強制クローズする

import {
    extension_settings,
    getContext,
} from '../../../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    getRequestHeaders,
} from '../../../../../script.js';

const MODULE_NAME = 'lorebook_expansion';
const LOG = '[LBE]';
const SETTINGS_VERSION = 3;

const DEFAULT_SETTINGS = {
    version: SETTINGS_VERSION,
    enabled: true,
    autoAppendChoices: true,
    debug: false,
    extrasCollapsedByDefault: true,
    contentHeightRatio: 0.6,
};

// ★ リトライ設定
const WORLDIINFO_FETCH_MAX_RETRIES = 3;
const WORLDIINFO_FETCH_RETRY_DELAY_MS = 500;

let settings = { ...DEFAULT_SETTINGS };

// ============================================================
// 設定
// ============================================================
function loadSettings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    const stored = extension_settings[MODULE_NAME];

    if (!stored.version || stored.version < SETTINGS_VERSION) {
        console.log(`${LOG} 設定を v${SETTINGS_VERSION} に移行します（旧version=${stored.version ?? 'なし'}）`);
        stored.version = SETTINGS_VERSION;
        if (typeof stored.extrasCollapsedByDefault !== 'boolean') {
            stored.extrasCollapsedByDefault = true;
        }
    }

    if (!stored.data || typeof stored.data !== 'object') stored.data = {};

    settings = { ...DEFAULT_SETTINGS, ...stored };
    console.log(`${LOG} 設定:`, {
        version: settings.version,
        enabled: settings.enabled,
        autoAppendChoices: settings.autoAppendChoices,
        debug: settings.debug,
        extrasCollapsedByDefault: settings.extrasCollapsedByDefault,
        contentHeightRatio: settings.contentHeightRatio,
        dataWorlds: Object.keys(stored.data).length,
    });
}

function saveSettings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    const s = extension_settings[MODULE_NAME];

    s.version = SETTINGS_VERSION;
    s.enabled = settings.enabled;
    s.autoAppendChoices = settings.autoAppendChoices;
    s.debug = settings.debug;
    s.extrasCollapsedByDefault = settings.extrasCollapsedByDefault;
    s.contentHeightRatio = settings.contentHeightRatio;

    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
}

function debugLog(...args) {
    if (settings.debug) console.log(LOG, ...args);
}

function wait(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// 永続ストア (extension_settings 内)
// ============================================================
function getLexStore() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    const s = extension_settings[MODULE_NAME];
    if (!s.data || typeof s.data !== 'object') s.data = {};
    return s.data;
}

function normalizeLexData(raw) {
    if (!raw || typeof raw !== 'object') return { img_prompt: '', choices: [] };
    return {
        img_prompt: typeof raw.img_prompt === 'string' ? raw.img_prompt : '',
        choices: Array.isArray(raw.choices)
            ? raw.choices
                  .filter(c => c && typeof c === 'object')
                  .map(c => ({
                      num: typeof c.num === 'string' ? c.num : String(c.num ?? ''),
                      text: typeof c.text === 'string' ? c.text : '',
                  }))
            : [],
    };
}

function getDataFor(worldName, uid, entry) {
    if (!worldName || uid === null || uid === undefined) {
        return { img_prompt: '', choices: [] };
    }
    const store = getLexStore();
    const wKey = String(worldName);
    const uKey = String(uid);

    if (!store[wKey]) store[wKey] = {};
    const wd = store[wKey];

    if (wd[uKey] && typeof wd[uKey] === 'object') {
        return normalizeLexData(wd[uKey]);
    }

    if (entry && entry.extensions && entry.extensions[MODULE_NAME]) {
        const migrated = normalizeLexData(entry.extensions[MODULE_NAME]);
        wd[uKey] = migrated;
        saveSettings();
        debugLog(`レガシーデータを移行: world=${worldName}, uid=${uid}`);
        return migrated;
    }

    const def = { img_prompt: '', choices: [] };
    wd[uKey] = def;
    return def;
}

function setDataFor(worldName, uid, entry, data) {
    if (!worldName || uid === null || uid === undefined) return;
    const store = getLexStore();
    const wKey = String(worldName);
    const uKey = String(uid);
    if (!store[wKey]) store[wKey] = {};

    const normalized = normalizeLexData(data);
    store[wKey][uKey] = normalized;
    saveSettings();

    if (entry && typeof entry === 'object') {
        try {
            if (!entry.extensions || typeof entry.extensions !== 'object') entry.extensions = {};
            entry.extensions[MODULE_NAME] = JSON.parse(JSON.stringify(normalized));
            triggerWorldInfoSave();
        } catch (e) {
            debugLog('ミラー書込に失敗:', e);
        }
    }
}

// ============================================================
// レガシー API 互換 (entry 単体で扱う)
// ============================================================
function getExpansionData(entry) {
    if (!entry || typeof entry !== 'object') return { img_prompt: '', choices: [] };
    const ext = entry.extensions?.[MODULE_NAME];
    if (!ext || typeof ext !== 'object') return { img_prompt: '', choices: [] };
    return normalizeLexData(ext);
}

function setExpansionData(entry, data) {
    if (!entry || typeof entry !== 'object') return;
    if (!entry.extensions || typeof entry.extensions !== 'object') entry.extensions = {};
    entry.extensions[MODULE_NAME] = normalizeLexData(data);
}

// ============================================================
// ワールドインフォ取得
// ============================================================
async function getWorldInfoModule() {
    try {
        return await import('../../../../world-info.js');
    } catch (e) {
        console.warn(LOG, 'world-info.js import 失敗:', e);
        return null;
    }
}

function getCurrentWorldName() {
    const ed = document.querySelector('#world_editor_select');
    if (ed) {
        const opt = ed.options?.[ed.selectedIndex];
        if (opt) {
            const v = (opt.value || '').trim();
            const t = (opt.textContent || '').trim();
            if (v && !/^\d+$/.test(v)) {
                debugLog(`world名を #world_editor_select value から取得: "${v}"`);
                return v;
            }
            if (t && t !== '--- Pick to Edit ---' && t !== '--- 編集するものを選択 ---') {
                debugLog(`world名を #world_editor_select text から取得: "${t}"`);
                return t;
            }
        }
    }

    const wi = document.querySelector('#world_info');
    if (wi) {
        const opts = Array.from(wi.selectedOptions || []);
        const opt = opts[0];
        if (opt) {
            const v = (opt.value || '').trim();
            const t = (opt.textContent || '').trim();
            if (v && !/^\d+$/.test(v)) {
                debugLog(`world名を #world_info value から取得: "${v}"`);
                return v;
            }
            if (t) {
                debugLog(`world名を #world_info text から取得: "${t}"`);
                return t;
            }
        }
    }

    const ctx = getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    const fromChar = char?.data?.extensions?.world || char?.data?.world;
    if (fromChar) {
        debugLog(`world名を character.data.extensions.world から取得: "${fromChar}"`);
        return fromChar;
    }

    debugLog('world名を特定できませんでした');
    return null;
}

async function fetchWorldInfoWithRetry(worldName, maxRetries = WORLDIINFO_FETCH_MAX_RETRIES) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const resp = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: worldName }),
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data && data.entries) return data.entries;
            }
            debugLog(`/api/worldinfo/get 試行 ${attempt}/${maxRetries} 失敗 (HTTP ${resp.status})`);
        } catch (e) {
            debugLog(`/api/worldinfo/get 試行 ${attempt}/${maxRetries} 例外: ${e.message || e}`);
        }
        if (attempt < maxRetries) {
            await wait(WORLDIINFO_FETCH_RETRY_DELAY_MS * attempt);
        }
    }
    return null;
}

async function loadWorldInfoEntriesByName(worldName) {
    if (!worldName) return null;

    const mod = await getWorldInfoModule();
    if (mod && mod.world_info && mod.world_info[worldName]?.entries) {
        return mod.world_info[worldName].entries;
    }

    try {
        if (window.world_info && window.world_info[worldName]?.entries) {
            return window.world_info[worldName].entries;
        }
    } catch (e) { /* ignore */ }

    const entries = await fetchWorldInfoWithRetry(worldName);
    if (entries) return entries;

    console.warn(LOG, `/api/worldinfo/get 失敗 (world="${worldName}", リトライ後も取得できず)`);
    return null;
}

// ============================================================
// 選択肢番号の抽出
// ============================================================
const CHOICE_PATTERNS = [
    /選択肢[「『"']?(\d{1,4})[」』"']?/,
    /choice[^\d]{0,3}(\d{1,4})/i,
    /(?:^|\s)(\d{3,4})(?:\s|$|[\u3000。、,.])/,
    /(\d{3})/,
];

function extractChoiceNumber(text) {
    if (!text || typeof text !== 'string') return null;
    for (const pat of CHOICE_PATTERNS) {
        const m = text.match(pat);
        if (m) return String(m[1]).padStart(3, '0');
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

function findEntryByChoice(entries, choiceNum) {
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

// ============================================================
// 応答末尾に choices を差し込む
// ============================================================
const CHOICE_BLOCK_CLASS = 'lbe-choices-block';

function renderChoicesBlock(msgIdx, choices) {
    const mesEl = document.querySelector(`.mes[mesid="${msgIdx}"]`);
    if (!mesEl) return;

    mesEl.querySelectorAll('.' + CHOICE_BLOCK_CLASS).forEach(el => el.remove());

    const mesTextEl = mesEl.querySelector('.mes_text');
    if (!mesTextEl) return;

    const block = document.createElement('div');
    block.className = CHOICE_BLOCK_CLASS;

    const list = document.createElement('div');
    list.className = 'lbe-choices-list';
    for (const c of choices) {
        const item = document.createElement('div');
        item.className = 'lbe-choice-item';
        item.textContent = `${c.num} ${c.text}`;
        list.appendChild(item);
    }
    block.appendChild(list);

    mesTextEl.appendChild(block);
    debugLog(`選択肢ブロックをメッセージ ${msgIdx} に追加`, choices);
}

function removeAllChoicesBlocks() {
    document.querySelectorAll('.' + CHOICE_BLOCK_CLASS).forEach(el => el.remove());
}

async function appendChoicesToLastAiMessage() {
    if (!settings.enabled || !settings.autoAppendChoices) return;

    const ctx = getContext();
    if (!ctx?.chat || ctx.chat.length === 0) return;

    let lastAiIdx = -1;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (m.is_system) continue;
        if (!m.is_user) { lastAiIdx = i; break; }
    }
    if (lastAiIdx < 0) return;

    let lastUserIdx = -1;
    for (let i = lastAiIdx - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (m.is_system) continue;
        if (m.is_user) { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) return;

    const choiceNum = extractChoiceNumber(ctx.chat[lastUserIdx].mes || '');
    if (!choiceNum) return;

    const worldName = getCurrentWorldName();
    if (!worldName) return;

    const entries = await loadWorldInfoEntriesByName(worldName);
    if (!entries) return;

    const entry = findEntryByChoice(entries, choiceNum);
    if (!entry) return;

    const uid = entry.uid ?? null;
    const data = uid !== null && uid !== undefined
        ? getDataFor(worldName, uid, entry)
        : getExpansionData(entry);
    if (!data.choices || data.choices.length === 0) return;

    renderChoicesBlock(lastAiIdx, data.choices);
}

function refreshAllChoicesBlocks() {
    removeAllChoicesBlocks();
    appendChoicesToLastAiMessage().catch(e => console.warn(LOG, e));
}

// ============================================================
// UI 注入 (ロアブック編集画面)
// ============================================================
const UI_SECTION_CLASS = 'lbe-section';
const ATTR_UID = 'data-lbe-uid';

const COLLAPSIBLE_CLASS = 'lbe-collapsible';
const COLLAPSED_CLASS = 'lbe-extras-collapsed';
const TOGGLE_BTN_CLASS = 'lbe-extras-toggle';
const TOGGLE_ICON_CLASS = 'lbe-extras-icon';

let _saveTimer = null;
function triggerWorldInfoSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(async () => {
        const worldName = getCurrentWorldName();
        if (!worldName) return;
        const mod = await getWorldInfoModule();
        try {
            if (mod && typeof mod.saveWorldInfo === 'function') {
                await mod.saveWorldInfo(worldName, true);
                debugLog('saveWorldInfo 実行:', worldName);
            } else {
                const entryEl = document.querySelector('.world_entry[uid]');
                if (entryEl && window.$) {
                    window.$(entryEl).trigger('change');
                }
            }
        } catch (e) {
            console.warn(LOG, 'world info 保存失敗:', e);
        }
    }, 500);
}

function buildExpansionSection(uid, worldName, data, onChange) {
    const section = document.createElement('div');
    section.className = UI_SECTION_CLASS;
    section.setAttribute(ATTR_UID, String(uid));

    const imgLabel = document.createElement('label');
    imgLabel.className = 'lbe-label';
    imgLabel.textContent = 'Img_prompt (画像生成プロンプト)';
    section.appendChild(imgLabel);

    const imgTextarea = document.createElement('textarea');
    imgTextarea.className = 'lbe-img-prompt text_pole';
    imgTextarea.rows = 3;
    imgTextarea.placeholder = '例: 5girls:1.4, schoo sailor uniform, miniskirt, sitting on chair, looking at viewer, school, classroom, smile, femdom';
    imgTextarea.value = data.img_prompt || '';
    imgTextarea.addEventListener('input', () => {
        data.img_prompt = imgTextarea.value;
        onChange(data);
    });
    section.appendChild(imgTextarea);

    const choicesLabel = document.createElement('label');
    choicesLabel.className = 'lbe-label';
    choicesLabel.textContent = 'choices (選択肢)';
    section.appendChild(choicesLabel);

    const choicesContainer = document.createElement('div');
    choicesContainer.className = 'lbe-choices-editor';
    section.appendChild(choicesContainer);

    const renderChoices = () => {
        choicesContainer.innerHTML = '';

        data.choices.forEach((choice, idx) => {
            const row = document.createElement('div');
            row.className = 'lbe-choice-row';

            const numInput = document.createElement('input');
            numInput.type = 'text';
            numInput.className = 'lbe-choice-num text_pole';
            numInput.maxLength = 4;
            numInput.placeholder = '001';
            numInput.value = choice.num || '';
            numInput.addEventListener('input', () => {
                const v = numInput.value.replace(/[^\d]/g, '');
                numInput.value = v;
                choice.num = v;
                onChange(data);
            });
            numInput.addEventListener('blur', () => {
                let v = numInput.value.replace(/[^\d]/g, '');
                if (v) {
                    v = v.padStart(3, '0');
                    numInput.value = v;
                    choice.num = v;
                    onChange(data);
                }
            });
            row.appendChild(numInput);

            const textInput = document.createElement('input');
            textInput.type = 'text';
            textInput.className = 'lbe-choice-text text_pole';
            textInput.placeholder = '選択肢の内容 (例: 一人の小柄な女子が近づいてきた)';
            textInput.value = choice.text || '';
            textInput.addEventListener('input', () => {
                choice.text = textInput.value;
                onChange(data);
            });
            row.appendChild(textInput);

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'lbe-choice-del menu_button';
            delBtn.textContent = '✕';
            delBtn.title = 'この選択肢を削除';
            delBtn.addEventListener('click', () => {
                data.choices.splice(idx, 1);
                renderChoices();
                onChange(data);
            });
            row.appendChild(delBtn);

            choicesContainer.appendChild(row);
        });

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'lbe-choice-add menu_button';
        addBtn.textContent = '＋ 選択肢を追加';
        addBtn.addEventListener('click', () => {
            let next = '001';
            if (data.choices.length > 0) {
                const nums = data.choices
                    .map(c => parseInt(c.num, 10))
                    .filter(n => !isNaN(n));
                const max = nums.length > 0 ? Math.max(...nums) : 0;
                next = String(max + 1).padStart(3, '0');
            }
            data.choices.push({ num: next, text: '' });
            renderChoices();
            onChange(data);
        });
        choicesContainer.appendChild(addBtn);
    };

    renderChoices();
    return section;
}

function findInsertionPoint(entryEl) {
    const contentTextarea = entryEl.querySelector('textarea[name="content"]');
    if (contentTextarea && contentTextarea.parentElement) {
        return { parent: contentTextarea.parentElement, ref: null };
    }
    const editBlock = entryEl.querySelector('.world_entry_edit');
    return { parent: editBlock || entryEl, ref: null };
}

function shrinkContentTextarea(entryEl) {
    const ta = entryEl.querySelector('textarea[name="content"]');
    if (!ta) return;

    if (!ta.dataset.lbeOriginalRows) {
        const orig = parseInt(ta.getAttribute('rows') || '8', 10);
        if (!isNaN(orig) && orig > 0) {
            ta.dataset.lbeOriginalRows = String(orig);
        }
    }

    const originalRows = parseInt(ta.dataset.lbeOriginalRows || '8', 10);
    const ratio = (typeof settings.contentHeightRatio === 'number' && settings.contentHeightRatio > 0)
        ? settings.contentHeightRatio
        : 0.6;
    const newRows = Math.max(2, Math.round(originalRows * ratio));

    if (parseInt(ta.getAttribute('rows') || '0', 10) !== newRows) {
        ta.setAttribute('rows', String(newRows));
        debugLog(`uid=${entryEl.getAttribute('uid')}: content textarea rows を ${originalRows} → ${newRows} に縮小`);
    }
}

function reorganizeEntryLayout(entryEl) {
    const edit = entryEl.querySelector('.world_entry_edit');
    if (!edit) return;

    const existingToggle = edit.querySelector(':scope > .' + TOGGLE_BTN_CLASS);
    if (existingToggle) {
        return;
    }

    const firstFlex = edit.querySelector(':scope > .flex-container.wide100p.alignitemscenter');
    if (!firstFlex) return;

    let contentLabel = null;
    const contentBlock = firstFlex.querySelector(':scope > [name="contentAndCharFilterBlock"]');
    if (contentBlock) {
        const labels = contentBlock.querySelectorAll('label[for]');
        for (const lbl of labels) {
            const f = (lbl.getAttribute('for') || '').trim();
            if (f === 'content') {
                contentLabel = lbl;
                break;
            }
        }
    }

    const perEntry = firstFlex.querySelector(':scope > [name="perEntryOverridesBlock"]');

    if (perEntry) {
        firstFlex.insertAdjacentElement('afterend', perEntry);
        debugLog('perEntryOverridesBlock を折りたたみエリアへ移動');
    }
    if (contentLabel) {
        firstFlex.insertAdjacentElement('afterend', contentLabel);
        debugLog('label[for="content"] を折りたたみエリアへ移動');
    }

    const togglables = [];
    let node = firstFlex.nextElementSibling;
    while (node) {
        togglables.push(node);
        node = node.nextElementSibling;
    }

    if (togglables.length === 0) return;

    togglables.forEach(el => el.classList.add(COLLAPSIBLE_CLASS));

    const toggleBtn = document.createElement('div');
    toggleBtn.className = TOGGLE_BTN_CLASS;
    toggleBtn.setAttribute('role', 'button');
    toggleBtn.setAttribute('tabindex', '0');

    const labelEl = document.createElement('strong');
    labelEl.textContent = '詳細設定 (キャラクター設定・追加マッチング等)';
    toggleBtn.appendChild(labelEl);

    const iconEl = document.createElement('i');
    iconEl.className = `fa-solid fa-circle-chevron-up ${TOGGLE_ICON_CLASS}`;
    toggleBtn.appendChild(iconEl);

    const setCollapsed = (collapsed) => {
        edit.classList.toggle(COLLAPSED_CLASS, collapsed);
        iconEl.classList.toggle('fa-circle-chevron-down', collapsed);
        iconEl.classList.toggle('fa-circle-chevron-up', !collapsed);
    };

    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const collapsed = !edit.classList.contains(COLLAPSED_CLASS);
        setCollapsed(collapsed);
    });

    firstFlex.insertAdjacentElement('afterend', toggleBtn);

    setCollapsed(!!settings.extrasCollapsedByDefault);

    debugLog(`uid=${entryEl.getAttribute('uid')}: レイアウト再編 + 折りたたみトグル挿入`);
}

async function injectExpansionSections() {
    if (!settings.enabled) return;

    const worldName = getCurrentWorldName();
    if (!worldName) {
        debugLog('inject: world名取得失敗');
        return;
    }

    const entries = await loadWorldInfoEntriesByName(worldName);
    if (!entries) {
        debugLog(`inject: world "${worldName}" のエントリ取得失敗（リトライ後）`);
        return;
    }

    const entryEls = document.querySelectorAll(
        '#world_popup .world_entry[uid], .world_entry[uid]'
    );

    let injected = 0;
    let skippedNoEntry = 0;
    let skippedCollapsed = 0;
    let skippedAlready = 0;

    entryEls.forEach(entryEl => {
        const uid = String(entryEl.getAttribute('uid'));
        if (uid === null) return;

        const entry = entries[uid];
        if (!entry) {
            skippedNoEntry++;
            return;
        }

        const contentTextarea = entryEl.querySelector('textarea[name="content"]');
        if (!contentTextarea) {
            skippedCollapsed++;
            return;
        }

        try {
            shrinkContentTextarea(entryEl);
        } catch (e) {
            console.warn(LOG, 'content textarea 縮小に失敗:', e);
        }

        try {
            reorganizeEntryLayout(entryEl);
        } catch (e) {
            console.warn(LOG, 'レイアウト再編に失敗:', e);
        }

        const existing = entryEl.querySelector('.' + UI_SECTION_CLASS);
        if (existing && existing.getAttribute(ATTR_UID) === uid) {
            skippedAlready++;
            return;
        }
        if (existing) existing.remove();

        const data = getDataFor(worldName, uid, entry);

        const onChange = (newData) => {
            setDataFor(worldName, uid, entry, newData);
        };

        const section = buildExpansionSection(uid, worldName, data, onChange);

        const { parent, ref } = findInsertionPoint(entryEl);
        if (ref) {
            parent.insertBefore(section, ref);
        } else {
            parent.appendChild(section);
        }
        injected++;
        debugLog(`uid=${uid}: LEXセクション注入完了`);
    });

    if (injected > 0 || settings.debug) {
        debugLog(
            `inject完了: world="${worldName}", 注入=${injected}, ` +
            `未展開=${skippedCollapsed}, entryなし=${skippedNoEntry}, 注入済=${skippedAlready}`
        );
    }
}

// ============================================================
// 監視
// ============================================================
let _observer = null;
let _injectTimer = null;
let _pollTimer = null;

function scheduleInjection() {
    if (_injectTimer) clearTimeout(_injectTimer);
    _injectTimer = setTimeout(() => {
        injectExpansionSections().catch(e => console.warn(LOG, e));
    }, 200);
}

function setupObserver() {
    if (_observer) _observer.disconnect();

    _observer = new MutationObserver(() => {
        if (!document.getElementById('world_popup')) return;
        scheduleInjection();
    });

    _observer.observe(document.body, {
        childList: true,
        subtree: true,
    });

    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => {
        if (document.getElementById('world_popup')) {
            scheduleInjection();
        }
    }, 1500);

    console.log(LOG, 'DOM 監視を開始しました');
}

// ============================================================
// イベントハンドラ
// ============================================================
function onCharacterMessageRendered() {
    setTimeout(() => {
        appendChoicesToLastAiMessage().catch(e => console.warn(LOG, e));
    }, 250);
}

function onChatChanged() {
    setTimeout(() => {
        refreshAllChoicesBlocks();
    }, 400);
}

function onMessageUpdatedOrDeleted() {
    setTimeout(() => {
        refreshAllChoicesBlocks();
    }, 250);
}

// ============================================================
// 初期化
// ============================================================
function registerEventListeners() {
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    if (event_types.MESSAGE_UPDATED) {
        eventSource.on(event_types.MESSAGE_UPDATED, onMessageUpdatedOrDeleted);
    }
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, onMessageUpdatedOrDeleted);
    }
}

async function init() {
    console.log(LOG, 'Lorebook Expansion 初期化開始');
    loadSettings();
    setupObserver();
    registerEventListeners();

    setTimeout(() => {
        injectExpansionSections().catch(() => {});
    }, 1000);

    console.log(LOG, '初期化完了');
}

function bootstrap() {
    let started = false;
    const startOnce = () => {
        if (started) return;
        started = true;
        init().catch(e => console.error(LOG, '初期化中に例外:', e));
    };

    if (eventSource && event_types && event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, startOnce);
        setTimeout(startOnce, 5000);
    } else {
        startOnce();
    }
}

// ============================================================
// ★ ST起動時のWIドロワー自動オープン問題への対策（強化版）
//
//   ST本体は起動時、キャラクターに紐付くロアブックがあると
//   RossAscends-mods.js 経由で WI ドロワー（#WorldInfo）を
//   自動で開く。これが「起動直後からロアブック設定ウインドウが
//   開いた状態になっている」問題の原因。
//
//   ST本体の実装揺れに対応するため、以下の3段構えで防御する:
//     (A) MutationObserver で #WorldInfo の class/style 変更を監視し、
//         openDrawer が付いた瞬間に同期強制クローズ
//     (B) click / mousedown / pointerdown をキャプチャフェーズで捕捉し、
//         WIドロワーのトグルへの操作を抑止
//     (C) 100ms 間隔の安全網で強制クローズを繰り返す
//
//   ブロックは APP_READY + 1500ms で解除する。
//   ユーザーの意図的なクリックは以降 通常通り動作する。
// ============================================================
(function setupWIDrawerAutoOpenBlocker() {
    let blocking = true;
    let released = false;

    function findWIDrawer() {
        return document.getElementById('WorldInfo') ||
               document.querySelector('#world_info') ||
               document.querySelector('.drawer[id*="WorldInfo" i]');
    }

    /**
     * WIドロワーを閉じた状態に強制する。
     * 変更があれば true を返す。
     */
    function forceCloseWIDrawer(reason) {
        const wi = findWIDrawer();
        if (!wi) return false;

        let changed = false;

        // #WorldInfo 本体の openDrawer クラス除去
        if (wi.classList.contains('openDrawer')) {
            wi.classList.remove('openDrawer');
            changed = true;
        }

        // 内部の drawer 関連要素から openDrawer を除去
        wi.querySelectorAll('.drawer-content, .drawer-toggle, .drawer-header, .drawer-icon').forEach(el => {
            if (el.classList.contains('openDrawer')) {
                el.classList.remove('openDrawer');
                changed = true;
            }
        });

        // .drawer-content は closedDrawer 状態を保証
        const content = wi.querySelector('.drawer-content');
        if (content && !content.classList.contains('closedDrawer')) {
            content.classList.add('closedDrawer');
            changed = true;
        }

        if (changed) {
            console.log(`${LOG} 🚫 WIドロワー自動オープンを検知して強制クローズ (${reason})`);
        }
        return changed;
    }

    // ==========================================================
    // (A) MutationObserver
    // ==========================================================
    const observedEls = new WeakSet();

    function attachObserverTo(el) {
        if (!el || observedEls.has(el)) return;
        observedEls.add(el);

        const mo = new MutationObserver(() => {
            if (!blocking) return;
            forceCloseWIDrawer('MutationObserver');
        });
        mo.observe(el, {
            attributes: true,
            attributeFilter: ['class', 'style'],
        });
    }

    function attachAll() {
        const wi = findWIDrawer();
        if (!wi) return;
        attachObserverTo(wi);
        wi.querySelectorAll('.drawer-content, .drawer-toggle, .drawer-header, .drawer-icon')
          .forEach(attachObserverTo);
    }

    attachAll();
    const attachWatcher = setInterval(attachAll, 300);

    // ==========================================================
    // (B) click / mousedown / pointerdown キャプチャフェーズブロック
    // ==========================================================
    ['click', 'mousedown', 'pointerdown'].forEach(evtType => {
        document.addEventListener(evtType, (e) => {
            if (!blocking) return;
            if (!e.target || !e.target.closest) return;

            const wi = findWIDrawer();
            if (!wi || !wi.contains(e.target)) return;

            const toggleHit = e.target.closest('.drawer-toggle, .drawer-header, .drawer-icon');
            if (!toggleHit) return;

            e.stopImmediatePropagation();
            e.preventDefault();
            console.log(`${LOG} 🚫 起動時のWIドロワー自動オープンをブロック (${evtType})`);
        }, true);
    });

    // ==========================================================
    // (C) 100ms 間隔の安全網
    // ==========================================================
    const safetyWatcher = setInterval(() => {
        if (!blocking) return;
        forceCloseWIDrawer('safety-net');
    }, 100);

    // ==========================================================
    // ブロック解除
    // ==========================================================
    function releaseBlocking() {
        if (released) return;
        released = true;

        // 解除直前に最終強制クローズ（まだ blocking=true のうち）
        forceCloseWIDrawer('final-close');

        // その後でブロック解除
        blocking = false;
        clearInterval(attachWatcher);
        clearInterval(safetyWatcher);
        console.log(`${LOG} 🔓 WIドロワー自動オープンブロックを解除しました`);
    }

    let releaseScheduled = false;
    const scheduleRelease = () => {
        if (releaseScheduled) return;
        releaseScheduled = true;
        // ST本体のオープン処理が済むまで十分待つ
        setTimeout(releaseBlocking, 1500);
    };

    if (eventSource && event_types && event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, scheduleRelease);
        // フォールバック: APP_READY が来ない環境向け
        setTimeout(scheduleRelease, 8000);
    } else {
        setTimeout(scheduleRelease, 8000);
    }
})();

jQuery(async () => {
    bootstrap();
});

// ============================================================
// 外部公開 API
// ============================================================
window.LorebookExpansion = {
    getDataFor,
    setDataFor,

    getData: getExpansionData,
    setData: setExpansionData,

    dumpStore: () => JSON.parse(JSON.stringify(getLexStore())),

    clearWorldData: (worldName) => {
        const store = getLexStore();
        if (store[worldName]) {
            delete store[worldName];
            saveSettings();
            console.log(LOG, `world "${worldName}" の LEX データを削除`);
        }
    },

    extractChoiceNumber,
    findEntryByChoice,
    getEntryKeys,

    appendChoicesToLastAiMessage,
    refreshAllChoicesBlocks,

    loadWorldInfoEntriesByName,
    getCurrentWorldName,

    forceInject: () => injectExpansionSections(),
    debugInfo: async () => {
        const worldName = getCurrentWorldName();
        const entries = await loadWorldInfoEntriesByName(worldName);
        const entryEls = document.querySelectorAll('#world_popup .world_entry[uid]');
        const textareaEls = document.querySelectorAll('#world_popup .world_entry textarea[name="content"]');
        const sections = document.querySelectorAll('.lbe-section');
        const toggles = document.querySelectorAll('.lbe-extras-toggle');
        const togglables = document.querySelectorAll('.lbe-collapsible');
        const store = getLexStore();
        return {
            worldName,
            entryCount: entries ? Object.keys(entries).length : 0,
            entryElsCount: entryEls.length,
            expandedEntryCount: textareaEls.length,
            injectedSectionCount: sections.length,
            toggleCount: toggles.length,
            collapsibleCount: togglables.length,
            storeWorlds: Object.keys(store),
            storeEntryCounts: Object.fromEntries(
                Object.entries(store).map(([w, m]) => [w, Object.keys(m).length])
            ),
            settings: { ...settings, data: undefined },
        };
    },
    setDebug: (enabled) => {
        settings.debug = !!enabled;
        saveSettings();
        console.log(LOG, `debug=${settings.debug}`);
    },
    setExtrasCollapsedByDefault: (collapsed) => {
        settings.extrasCollapsedByDefault = !!collapsed;
        saveSettings();
        if (settings.extrasCollapsedByDefault) {
            window.LorebookExpansion.collapseAll();
        } else {
            window.LorebookExpansion.expandAll();
        }
        console.log(LOG, `extrasCollapsedByDefault=${settings.extrasCollapsedByDefault}`);
    },
    setContentHeightRatio: (ratio) => {
        const r = Number(ratio);
        if (!isFinite(r) || r <= 0 || r > 2) {
            console.warn(LOG, `不正な比率: ${ratio} (0 < ratio <= 2 で指定してください)`);
            return;
        }
        settings.contentHeightRatio = r;
        saveSettings();
        document.querySelectorAll('.world_entry[uid]').forEach(entryEl => {
            const ta = entryEl.querySelector('textarea[name="content"]');
            if (ta && ta.dataset.lbeOriginalRows) {
                ta.setAttribute('rows', ta.dataset.lbeOriginalRows);
                delete ta.dataset.lbeOriginalRows;
            }
            shrinkContentTextarea(entryEl);
        });
        console.log(LOG, `contentHeightRatio=${r}`);
    },
    collapseAll: () => {
        document.querySelectorAll('.world_entry_edit').forEach(edit => {
            edit.classList.add(COLLAPSED_CLASS);
            const icon = edit.querySelector(':scope > ' + TOGGLE_BTN_CLASS + ' .' + TOGGLE_ICON_CLASS);
            if (icon) {
                icon.classList.remove('fa-circle-chevron-up');
                icon.classList.add('fa-circle-chevron-down');
            }
        });
        console.log(LOG, '全詳細設定エリアを折りたたみました');
    },
    expandAll: () => {
        document.querySelectorAll('.world_entry_edit').forEach(edit => {
            edit.classList.remove(COLLAPSED_CLASS);
            const icon = edit.querySelector(':scope > ' + TOGGLE_BTN_CLASS + ' .' + TOGGLE_ICON_CLASS);
            if (icon) {
                icon.classList.remove('fa-circle-chevron-down');
                icon.classList.add('fa-circle-chevron-up');
            }
        });
        console.log(LOG, '全詳細設定エリアを展開しました');
    },
    forceMigrateSettings: () => {
        const stored = extension_settings[MODULE_NAME];
        if (stored) {
            stored.version = SETTINGS_VERSION;
            if (typeof stored.extrasCollapsedByDefault !== 'boolean') {
                stored.extrasCollapsedByDefault = true;
            }
            if (!stored.data || typeof stored.data !== 'object') stored.data = {};
            saveSettings();
            console.log(LOG, `設定を v${SETTINGS_VERSION} に移行しました`);
        }
    },

    MODULE_NAME,
};
console.log(LOG, 'window.LorebookExpansion に API を公開しました');
