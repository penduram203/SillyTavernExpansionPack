// Lorebook_Expansion.js
//
// ロアブックの各エントリに Img_prompt / Negative_prompt / variables / choices を
// 追加する拡張。
//   - Img_prompt      : 画像生成プロンプト (gic_lorebook.js が読み取る)
//   - Negative_prompt : ネガティブプロンプト (gic_lorebook.js が読み取る)
//   - variables       : 変数管理 (variable_manager.js が読み取る)
//   - choices         : 応答末尾に自動表示される選択肢群 (番号 + 文言)
//
// ★ データ保存先 (Phase 5 改修):
//   一次: extension_settings.lorebook_expansion.data[worldName][charKey]
//         charKey = entry.comment || entry.keys[0] || String(uid)
//         LEX データは本来ロアブックエントリのプロパティであり、
//         キャラクターには依存しない。per-world ストアで一元管理する。
//         これにより、キャラとロアブックが一致しない場合も正しく反映される。
//
//   移行元: character.data.extensions.lorebook_expansion
//          Phase 2〜4 で保存された旧データを起動時に per-world ストアへ移行する。
//          ・新形式キー (worldName\x1fcharKey): 該当 world へ
//          ・旧形式キー (charKey のみ): キャラ本来のロアブックへ
//
// ★ v6 修正:
//   - ST起動時のWIドロワー自動オープン問題への対策を強化
//     ST本体が jQuery.trigger('click') や classList.add を直接使う場合でも
//     MutationObserver で強制クローズする
//
// ★ Phase 5 修正:
//   - LEX データの保存先を per-world ストアに変更
//   - 旧 character.data からの一括移行 (lexStorageMigratedV1 フラグ)
//   - getDataFor/setDataFor は per-world ストアを一次情報源とする
//   - init() / CHARACTER_PAGE_LOADED で移行を試行
//
// ★ スクロールリセット問題修正 (v2):
//   - setupObserver の監視対象を body 全体 → #world_popup に限定
//   - scheduleInjection にスクロール直後スキップを追加
//   - injectExpansionSections のスクロール位置保存・復元を強化
//   - ST本体の clearEntryList による独立リセットに対抗するため、
//     「永続スクロールトラッカー」を追加:
//       ・ユーザー操作中のスクロール位置を継続記録
//       ・STがリセットしたら毎フレーム強制復元（_lbeScrollEnforceLoop）
//       ・DOM一括削除を検知したら段階的復元（_lbeScheduleRestore）
//
// ★ v4 修正 (Phase 6):
//   - Negative_prompt フィールドを追加（img_prompt 直後に2行のテキストエリア）
//   - contentHeightRatio の既定値を 0.6 → 0.45 に変更（現在の5行 → 4行相当）
//   - v3 設定の contentHeightRatio=0.6 は v4 移行時に自動で 0.45 に更新

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
const SETTINGS_VERSION = 4;

const DEFAULT_SETTINGS = {
    version: SETTINGS_VERSION,
    enabled: true,
    autoAppendChoices: true,
    debug: false,
    extrasCollapsedByDefault: true,
    contentHeightRatio: 0.45,
    lexStorageMigratedV1: false,
};

// ★ リトライ設定
const WORLDIINFO_FETCH_MAX_RETRIES = 3;
const WORLDIINFO_FETCH_RETRY_DELAY_MS = 500;

// ★ Phase 5: ストレージキー区切り文字（ユーザー入力に含まれない制御文字）
const STORAGE_KEY_SEPARATOR = '\x1f';

let settings = { ...DEFAULT_SETTINGS };

// ============================================================
// 設定
// ============================================================
function loadSettings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    const stored = extension_settings[MODULE_NAME];

    if (!stored.version || stored.version < SETTINGS_VERSION) {
        const oldVersion = stored.version ?? 0;
        console.log(`${LOG} 設定を v${SETTINGS_VERSION} に移行します（旧version=${stored.version ?? 'なし'}）`);

        // ★ v3 → v4: contentHeightRatio の既定値を 0.6 → 0.45 に変更
        if (oldVersion < 4 && stored.contentHeightRatio === 0.6) {
            stored.contentHeightRatio = 0.45;
            console.log(`${LOG} contentHeightRatio を 0.6 → 0.45 に更新`);
        }

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
        lexStorageMigratedV1: settings.lexStorageMigratedV1,
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
    s.lexStorageMigratedV1 = settings.lexStorageMigratedV1 === true;

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
    if (!raw || typeof raw !== 'object') {
        return {
            img_prompt: '',
            negative_prompt: '',
            resolution: '1280x720',
            templates: [{ img_prompt: '', negative_prompt: '', resolution: '1280x720' }],
            selectedTemplate: '0',
            choices: [],
            variables: [],
        };
    }

    // ── templates の正規化 ──
    let templates = [];
    if (Array.isArray(raw.templates) && raw.templates.length > 0) {
        templates = raw.templates
            .filter(t => t && typeof t === 'object')
            .map(t => ({
                img_prompt: typeof t.img_prompt === 'string' ? t.img_prompt : '',
                negative_prompt: typeof t.negative_prompt === 'string' ? t.negative_prompt : '',
                // ★ v7: テンプレート毎の解像度
                //   未設定なら旧形式の data.resolution を引き継ぎ、
                //   それも無ければ 1280x720
                resolution: (typeof t.resolution === 'string' && t.resolution.trim())
                    ? t.resolution.trim()
                    : ((typeof raw.resolution === 'string' && raw.resolution.trim())
                        ? raw.resolution.trim()
                        : '1280x720'),
            }));
        if (templates.length === 0) {
            templates = [{ img_prompt: '', negative_prompt: '', resolution: '1280x720' }];
        }
    } else {
        // 旧形式（templates 未定義）: img_prompt / negative_prompt / resolution を template 0 として取り込む
        templates = [{
            img_prompt: typeof raw.img_prompt === 'string' ? raw.img_prompt : '',
            negative_prompt: typeof raw.negative_prompt === 'string' ? raw.negative_prompt : '',
            resolution: (typeof raw.resolution === 'string' && raw.resolution.trim())
                ? raw.resolution.trim()
                : '1280x720',
        }];
    }

    // ── selectedTemplate の正規化 ──
    let selectedTemplate = '0';
    const rawSel = typeof raw.selectedTemplate === 'string' ? raw.selectedTemplate.trim() : '';
    if (rawSel === 'random') {
        selectedTemplate = 'random';
    } else if (/^\d+$/.test(rawSel) && parseInt(rawSel, 10) < templates.length) {
        selectedTemplate = rawSel;
    } else {
        selectedTemplate = '0';
    }

    // ── img_prompt / negative_prompt / resolution ミラー ──
    //   selectedTemplate が数値ならその内容、'random' なら template 0 をミラー
    const mirrorIdx = selectedTemplate === 'random' ? 0 : parseInt(selectedTemplate, 10);
    const mirror = templates[mirrorIdx] || {
        img_prompt: '',
        negative_prompt: '',
        resolution: '1280x720',
    };

    return {
        img_prompt: mirror.img_prompt,
        negative_prompt: mirror.negative_prompt,
        resolution: mirror.resolution,
        templates,
        selectedTemplate,
        choices: Array.isArray(raw.choices)
            ? raw.choices
                  .filter(c => c && typeof c === 'object')
                  .map(c => ({
                      num: typeof c.num === 'string' ? c.num : String(c.num ?? ''),
                      text: typeof c.text === 'string' ? c.text : '',
                  }))
            : [],
        variables: Array.isArray(raw.variables)
            ? raw.variables
                  .filter(v => v && typeof v === 'object')
                  .map(v => ({
                      type: v.type === 'number' ? 'number' : 'string',
                      name: typeof v.name === 'string' ? v.name : '',
                      value: typeof v.value === 'string' ? v.value : String(v.value ?? ''),
                  }))
            : [],
    };
}

// ============================================================
// ★ Phase 5: per-world ストア
// ============================================================
function getWorldLexStore(worldName) {
    const store = getLexStore();
    if (!store[worldName] || typeof store[worldName] !== 'object') {
        store[worldName] = {};
    }
    return store[worldName];
}

function saveLexStore() {
    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
}

// ============================================================
// ★ ST が表示用に comment へ付加する注釈を除去して正規化する
//   - "00_共通ルール（常時有効）" → "00_共通ルール"
//   - "001（無効）"               → "001"
//   - "foo(Disabled)"             → "foo"
//   - "foo(Constant)"             → "foo"
//   これにより per-world store のキーが保存時・読込時で一致する。
// ============================================================
function normalizeEntryComment(comment) {
    if (typeof comment !== 'string') return '';
    let s = comment.trim();
    if (!s) return '';
    s = s.replace(/\s*[（(](?:常時有効|無効|Constant|Disabled)[）)]\s*$/i, '').trim();
    return s;
}

// ============================================================
// ★ Phase 5: ストレージキー関連ヘルパー
// ============================================================
function getCharKey(entry, uid) {
    if (entry) {
        const normalized = normalizeEntryComment(
            typeof entry.comment === 'string' ? entry.comment : ''
        );
        if (normalized) return normalized;
    }
    const keys = getEntryKeys(entry);
    if (keys.length > 0 && String(keys[0]).trim()) {
        return String(keys[0]).trim();
    }
    return String(uid);
}

function getStorageKey(worldName, charKey) {
    if (!worldName || charKey === null || charKey === undefined) return null;
    return `${worldName}${STORAGE_KEY_SEPARATOR}${charKey}`;
}

function getCurrentCharacterInfo() {
    try {
        const ctx = getContext();
        const char = ctx?.characters?.[ctx?.characterId];
        if (!char) return null;
        return {
            name: typeof char.name === 'string' ? char.name : '',
            associatedWorld:
                (typeof char.data?.extensions?.world === 'string' && char.data.extensions.world) ||
                (typeof char.data?.world === 'string' && char.data.world) ||
                '',
        };
    } catch (e) {
        return null;
    }
}

/**
 * ★ キャラクターに関連付けられたロアブック名を返す（キャラ関連ワールド）
 *   UI要素ではなく character.data を参照するため、キャラ切替直後でも正確。
 */
function getCharacterWorldInfoName() {
    try {
        const ctx = getContext();
        const char = ctx?.characters?.[ctx?.characterId];
        if (!char) return null;
        const fromExt = char.data?.extensions?.world;
        if (fromExt && typeof fromExt === 'string' && fromExt.trim()) return fromExt.trim();
        const fromData = char.data?.world;
        if (fromData && typeof fromData === 'string' && fromData.trim()) return fromData.trim();
        return null;
    } catch (e) {
        return null;
    }
}

/**
 * ★ 選択肢表示用のワールド名決定
 *   キャラ関連ワールドを最優先（UI要素の stale 状態を回避）
 */
function getChoicesWorldName() {
    const charWorld = getCharacterWorldInfoName();
    if (charWorld) return charWorld;
    return getCurrentWorldName();
}

// ============================================================
// ★ Phase 5: character.data → per-world store の一括移行
// ============================================================
function migrateCharacterLexDataToWorldStore() {
    if (settings.lexStorageMigratedV1 === true) return;

    try {
        const ctx = getContext();
        const chars = ctx?.characters || [];
        if (chars.length === 0) {
            debugLog('移行スキップ: キャラクター未ロード');
            return;
        }

        const store = getLexStore();
        let migrated = 0;
        let conflicts = 0;

        for (const char of chars) {
            const charLex = char?.data?.extensions?.lorebook_expansion;
            if (!charLex || typeof charLex !== 'object') continue;

            const charName = typeof char.name === 'string' ? char.name : '';
            const assocWorld =
                (typeof char.data?.extensions?.world === 'string' && char.data.extensions.world) ||
                (typeof char.data?.world === 'string' && char.data.world) ||
                '';
            const ownWorld = assocWorld || charName;

            for (const [key, value] of Object.entries(charLex)) {
                if (!value || typeof value !== 'object') continue;

                let worldName, charKey;
                if (key.includes(STORAGE_KEY_SEPARATOR)) {
                    const idx = key.indexOf(STORAGE_KEY_SEPARATOR);
                    worldName = key.slice(0, idx);
                    charKey = key.slice(idx + 1);
                } else {
                    if (!ownWorld) continue;
                    worldName = ownWorld;
                    charKey = key;
                }

                if (!worldName || !charKey) continue;

                if (!store[worldName] || typeof store[worldName] !== 'object') {
                    store[worldName] = {};
                }

                if (!store[worldName][charKey]) {
                    store[worldName][charKey] = normalizeLexData(value);
                    migrated++;
                } else {
                    conflicts++;
                }
            }
        }

        if (migrated > 0 || conflicts > 0) {
            saveLexStore();
            console.log(
                `${LOG} character.data → per-world store 移行: ${migrated} 件` +
                (conflicts > 0 ? ` (既存値優先で ${conflicts} 件スキップ)` : '')
            );
        }

        settings.lexStorageMigratedV1 = true;
        saveSettings();
    } catch (e) {
        console.warn(LOG, 'character.data 移行エラー:', e);
    }
}

// ============================================================
// ★ 現在のキャラクターの character.data → per-world store 追加マージ
//   - JSON インポート後に呼ばれる。既存の per-world store に
//     データがある場合は上書きしない（additive）。
//   - これにより、JSON に保存された RPGモード / 選択肢モード が
//     per-world store に復元される。
//   - migrateCharacterLexDataToWorldStore と異なり、フラグで
//     1回限りに制限せず、キャラロード毎に実行される。
// ============================================================
function migrateCurrentCharacterToWorldStore() {
    try {
        const ctx = getContext();
        const char = ctx?.characters?.[ctx?.characterId];
        if (!char) return;

        const charLex = char?.data?.extensions?.lorebook_expansion;
        if (!charLex || typeof charLex !== 'object') return;

        const charName = typeof char.name === 'string' ? char.name : '';
        const assocWorld =
            (typeof char.data?.extensions?.world === 'string' && char.data.extensions.world) ||
            (typeof char.data?.world === 'string' && char.data.world) ||
            '';
        const ownWorld = assocWorld || charName;

        const store = getLexStore();
        let migrated = 0;
        let skipped = 0;

        for (const [key, value] of Object.entries(charLex)) {
            if (!value || typeof value !== 'object') continue;

            let worldName, charKey;
            if (key.includes(STORAGE_KEY_SEPARATOR)) {
                const idx = key.indexOf(STORAGE_KEY_SEPARATOR);
                worldName = key.slice(0, idx);
                charKey = key.slice(idx + 1);
            } else {
                if (!ownWorld) continue;
                worldName = ownWorld;
                charKey = key;
            }

            if (!worldName || !charKey) continue;

            if (!store[worldName] || typeof store[worldName] !== 'object') {
                store[worldName] = {};
            }

            // ★ additive: per-world store にデータが無い場合のみ追加
            if (!store[worldName][charKey]) {
                store[worldName][charKey] = normalizeLexData(value);
                migrated++;
            } else {
                skipped++;
            }
        }

        if (migrated > 0) {
            saveLexStore();
            debugLog(
                `character.data → per-world store: ${migrated} 件移行 ` +
                `(char="${charName}", 既存優先で ${skipped} 件スキップ)`
            );
        }

        // ★ 重複キーをクリーンアップ
        cleanupLexDuplicateKeys();
    } catch (e) {
        console.warn(LOG, 'migrateCurrentCharacterToWorldStore エラー:', e);
    }
}

// ============================================================
// ★ per-world store と char.data の重複キーをクリーンアップ
//   - 正規化後のキー（"00_共通ルール"）が存在する場合、
//     非正規化キー（"00_共通ルール（常時有効）"）を削除
//   - プレフィックス付きキー（"咲葉学園␟XXX"）が存在する場合、
//     プレフィックスなしキー（"XXX"）を削除
//   - データ内容は正規化キーを優先（新しい編集は正規化キーに保存される）
// ============================================================
function cleanupLexDuplicateKeys() {
    try {
        const store = getLexStore();
        let removedStore = 0;

        for (const worldName of Object.keys(store)) {
            const map = store[worldName];
            if (!map || typeof map !== 'object') continue;
            for (const key of Object.keys(map)) {
                const normalizedKey = normalizeEntryComment(key);
                if (normalizedKey !== key && map[normalizedKey]) {
                    delete map[key];
                    removedStore++;
                }
            }
        }

        if (removedStore > 0) {
            saveLexStore();
            debugLog(`per-world store の重複キーを ${removedStore} 件削除`);
        }

        const ctx = getContext();
        const char = ctx?.characters?.[ctx?.characterId];
        if (!char) return;

        const charLex = char?.data?.extensions?.lorebook_expansion;
        if (!charLex || typeof charLex !== 'object') return;

        const charName = typeof char.name === 'string' ? char.name : '';
        const assocWorld =
            (typeof char.data?.extensions?.world === 'string' && char.data.extensions.world) ||
            (typeof char.data?.world === 'string' && char.data.world) ||
            '';
        const ownWorld = assocWorld || charName;

        let removedChar = 0;
        const seenNormalized = new Set();

        for (const key of Object.keys(charLex)) {
            if (key.includes(STORAGE_KEY_SEPARATOR)) {
                const idx = key.indexOf(STORAGE_KEY_SEPARATOR);
                const w = key.slice(0, idx);
                const ck = key.slice(idx + 1);
                const normalizedCk = normalizeEntryComment(ck);
                const normalizedKey = `${w}${STORAGE_KEY_SEPARATOR}${normalizedCk}`;
                if (normalizedKey !== key && charLex[normalizedKey]) {
                    delete charLex[key];
                    removedChar++;
                    continue;
                }
                seenNormalized.add(normalizedKey);
            } else {
                if (!ownWorld) continue;
                const normalizedCk = normalizeEntryComment(key);
                const prefixedKey = `${ownWorld}${STORAGE_KEY_SEPARATOR}${normalizedCk}`;
                if (charLex[prefixedKey]) {
                    delete charLex[key];
                    removedChar++;
                }
            }
        }

        if (removedChar > 0) {
            if (window.CharStore?.saveCharacterExtension) {
                window.CharStore.saveCharacterExtension(
                    MODULE_NAME,
                    charLex,
                    { immediate: true }
                );
            }
            debugLog(`char.data の重複キーを ${removedChar} 件削除`);
        }
    } catch (e) {
        console.warn(LOG, 'cleanupLexDuplicateKeys エラー:', e);
    }
}

function getCharacterLexData() {
    try {
        const ctx = getContext();
        const char = ctx?.characters?.[ctx?.characterId];
        const ext = char?.data?.extensions?.lorebook_expansion;
        return ext && typeof ext === 'object' ? ext : {};
    } catch (e) {
        return {};
    }
}

function getDataFor(worldName, uid, entry) {
    const empty = {
        img_prompt: '',
        negative_prompt: '',
        resolution: '1280x720',
        templates: [{ img_prompt: '', negative_prompt: '', resolution: '1280x720' }],
        selectedTemplate: '0',
        choices: [],
        variables: [],
    };

    if (!worldName || uid === null || uid === undefined) {
        return empty;
    }

    const charKey = getCharKey(entry, uid);
    if (!charKey) {
        return empty;
    }

    const store = getWorldLexStore(worldName);
    const rec = store[charKey];
    if (rec && typeof rec === 'object') {
        return normalizeLexData(rec);
    }

    try {
        const charLex = getCharacterLexData();
        const storageKey = getStorageKey(worldName, charKey);
        let legacyData = null;

        if (storageKey && charLex[storageKey] && typeof charLex[storageKey] === 'object') {
            legacyData = normalizeLexData(charLex[storageKey]);
        } else if (charLex[charKey] && typeof charLex[charKey] === 'object') {
            const charInfo = getCurrentCharacterInfo();
            const isOwnLorebook = !!charInfo && (
                (charInfo.name && worldName === charInfo.name) ||
                (charInfo.associatedWorld && worldName === charInfo.associatedWorld)
            );
            if (isOwnLorebook) {
                legacyData = normalizeLexData(charLex[charKey]);
            }
        }

        if (legacyData) {
            store[charKey] = legacyData;
            saveLexStore();
            debugLog(`character.data から per-world store へ移行: ${worldName}::${charKey}`);
            return legacyData;
        }
    } catch (e) {
        console.warn(LOG, 'character.data からの移行に失敗:', e);
    }

    return empty;
}

function setDataFor(worldName, uid, entry, data) {
    if (!worldName || uid === null || uid === undefined) return;

    const normalized = normalizeLexData(data);
    const charKey = getCharKey(entry, uid);
    if (!charKey) {
        debugLog('charKey 取得失敗のため保存スキップ:', { worldName, uid });
        return;
    }

    // ── 1) per-world store へ保存（一次情報源）──
    const store = getWorldLexStore(worldName);
    store[charKey] = normalized;
    saveLexStore();
    debugLog(`per-world store に保存: ${worldName}::${charKey}`);

    // ── 2) character.data にもミラー保存（JSONエクスポート/インポート用）──
    //    プライマリはあくまで per-world store。character.data は
    //    JSON の可搬性のためのコピー。
    try {
        const ctx = getContext();
        const char = ctx?.characters?.[ctx?.characterId];
        if (!char) return;

        if (!char.data) char.data = {};
        if (!char.data.extensions) char.data.extensions = {};
        if (!char.data.extensions[MODULE_NAME] ||
            typeof char.data.extensions[MODULE_NAME] !== 'object') {
            char.data.extensions[MODULE_NAME] = {};
        }

        const storageKey = getStorageKey(worldName, charKey);
        if (!storageKey) return;

        char.data.extensions[MODULE_NAME][storageKey] =
            JSON.parse(JSON.stringify(normalized));

        // CharStore 経由でサーバ保存（デバウンス付き・export時の _backup も同期更新される）
        if (window.CharStore?.saveCharacterExtension) {
            window.CharStore.saveCharacterExtension(
                MODULE_NAME,
                char.data.extensions[MODULE_NAME]
            );
        }
        debugLog(`character.data にミラー保存: ${storageKey}`);
    } catch (e) {
        console.warn(LOG, 'character.data へのミラー保存に失敗:', e);
    }
}

function getExpansionData(entry) {
    const empty = {
        img_prompt: '',
        negative_prompt: '',
        resolution: '1280x720',
        templates: [{ img_prompt: '', negative_prompt: '', resolution: '1280x720' }],
        selectedTemplate: '0',
        choices: [],
        variables: [],
    };

    if (!entry || typeof entry !== 'object') {
        return empty;
    }
    const ext = entry.extensions?.[MODULE_NAME];
    if (!ext || typeof ext !== 'object') {
        return empty;
    }
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

    // ============================================================
    // ★ world_info entries の同期キャッシュ + 失敗キャッシュ
    //   - 一度でも取得成功した worldName → entries を保持
    //   - 失敗時は NEGATIVE_CACHE_MS 間だけ「失敗」を記録し、
    //     連続呼び出しによる fetch の連打を防ぐ
    //   - 並行呼び出しは同じ Promise を共有
    // ============================================================
    const _worldInfoEntriesSyncCache = new Map();
    const _worldInfoEntriesInFlight = new Map();
    const _worldInfoEntriesNegativeCache = new Map(); // worldName -> timestamp
    const WORLD_INFO_NEGATIVE_CACHE_MS = 5000;

    function _hasEntries(entries) {
        return !!entries && typeof entries === 'object' && Object.keys(entries).length > 0;
    }

    function clearWorldInfoEntriesCache(worldName) {
        if (worldName) {
            _worldInfoEntriesSyncCache.delete(worldName);
            _worldInfoEntriesNegativeCache.delete(worldName);
        } else {
            _worldInfoEntriesSyncCache.clear();
            _worldInfoEntriesNegativeCache.clear();
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

        // ── 1. 成功キャッシュ ──
        if (_worldInfoEntriesSyncCache.has(worldName)) {
            const cached = _worldInfoEntriesSyncCache.get(worldName);
            if (_hasEntries(cached)) return cached;
        }

        // ── 2. 失敗キャッシュ（連続 fetch 抑止）──
        const negTs = _worldInfoEntriesNegativeCache.get(worldName);
        if (negTs && (Date.now() - negTs < WORLD_INFO_NEGATIVE_CACHE_MS)) {
            console.warn(`[LBE] "${worldName}" は直前に失敗したため ${WORLD_INFO_NEGATIVE_CACHE_MS}ms 待機中`);
            return null;
        }

        // ── 3. 並行呼び出しの重複排除 ──
        if (_worldInfoEntriesInFlight.has(worldName)) {
            return await _worldInfoEntriesInFlight.get(worldName);
        }

        const promise = (async () => {
            const diag = [];

            // === A. ST 内部キャッシュ (mod.world_info) ===
            try {
                const mod = await getWorldInfoModule();
                if (!mod) {
                    diag.push('A: world-info.js モジュールが null');
                } else {
                    const worldData = mod.world_info?.[worldName];
                    if (!worldData) {
                        const available = mod.world_info ? Object.keys(mod.world_info).slice(0, 5).join(', ') : '(world_info 未定義)';
                        diag.push(`A: mod.world_info["${worldName}"] なし (world_info keys: ${available})`);
                    } else {
                        const e = worldData.entries;
                        if (_hasEntries(e)) {
                            _worldInfoEntriesSyncCache.set(worldName, e);
                            _worldInfoEntriesNegativeCache.delete(worldName);
                            console.warn(`[LBE] ✅ A (mod.world_info) ヒット: "${worldName}" (${Object.keys(e).length}件)`);
                            return e;
                        }
                        diag.push(`A: mod.world_info["${worldName}"].entries が空 (${e ? Object.keys(e).length + 'keys' : 'null'})`);
                    }
                }
            } catch (e) {
                diag.push(`A: 例外 ${e.message || e}`);
            }

            // === B. window.world_info ===
            try {
                const e = window.world_info?.[worldName]?.entries;
                if (_hasEntries(e)) {
                    _worldInfoEntriesSyncCache.set(worldName, e);
                    _worldInfoEntriesNegativeCache.delete(worldName);
                    console.warn(`[LBE] ✅ B (window.world_info) ヒット: "${worldName}" (${Object.keys(e).length}件)`);
                    return e;
                }
                diag.push(`B: window.world_info["${worldName}"].entries なし`);
            } catch (e) {
                diag.push(`B: 例外 ${e.message || e}`);
            }

            // === C. fetch（単発） ===
            try {
                const headers = getRequestHeaders();
                const resp = await fetch('/api/worldinfo/get', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ name: worldName }),
                });
                console.warn(`[LBE] C (fetch /api/worldinfo/get) status=${resp.status} ok=${resp.ok} for "${worldName}"`);
                if (resp.ok) {
                    const data = await resp.json();
                    const e = data?.entries;
                    if (_hasEntries(e)) {
                        _worldInfoEntriesSyncCache.set(worldName, e);
                        _worldInfoEntriesNegativeCache.delete(worldName);
                        try {
                            const mod = await getWorldInfoModule();
                            if (mod) {
                                if (!mod.world_info) mod.world_info = {};
                                mod.world_info[worldName] = { entries: e, name: worldName };
                            }
                        } catch (err) { /* ignore */ }
                        console.warn(`[LBE] ✅ C (fetch) ヒット: "${worldName}" (${Object.keys(e).length}件)`);
                        return e;
                    }
                    diag.push(`C: fetch の entries が空 (data keys: ${data ? Object.keys(data).join(',') : 'null'})`);
                } else {
                    let errBody = '';
                    try { errBody = (await resp.text()).slice(0, 200); } catch (err) {}
                    diag.push(`C: fetch HTTP ${resp.status} body="${errBody}"`);
                }
            } catch (e) {
                diag.push(`C: fetch 例外 ${e.message || e}`);
            }

            // === D. リトライ fetch ===
            const retryEntries = await fetchWorldInfoWithRetry(worldName);
            if (_hasEntries(retryEntries)) {
                _worldInfoEntriesSyncCache.set(worldName, retryEntries);
                _worldInfoEntriesNegativeCache.delete(worldName);
                try {
                    const mod = await getWorldInfoModule();
                    if (mod) {
                        if (!mod.world_info) mod.world_info = {};
                        mod.world_info[worldName] = { entries: retryEntries, name: worldName };
                    }
                } catch (err) { /* ignore */ }
                console.warn(`[LBE] ✅ D (retry fetch) ヒット: "${worldName}" (${Object.keys(retryEntries).length}件)`);
                return retryEntries;
            }
            diag.push('D: リトライ fetch 失敗');

            // === 全滅 ===
            console.warn(
                `[LBE] ❌ world="${worldName}" のエントリを全経路で取得できませんでした。診断:\n  ` +
                diag.join('\n  ')
            );
            _worldInfoEntriesNegativeCache.set(worldName, Date.now());
            return null;
        })();

        _worldInfoEntriesInFlight.set(worldName, promise);
        try {
            return await promise;
        } finally {
            _worldInfoEntriesInFlight.delete(worldName);
        }
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

    const mesTextEl = mesEl.querySelector('.mes_text');
    if (!mesTextEl) return;

    // ★ 同じ内容のブロックが既にあれば再描画をスキップ
    //    (appendChoicesToAllAiMessages が毎回全メッセージを走査するための最適化)
    const newSig = JSON.stringify(choices);
    const existing = mesTextEl.querySelector(':scope > .' + CHOICE_BLOCK_CLASS);
    if (existing && existing.dataset.choiceSig === newSig) return;

    mesEl.querySelectorAll('.' + CHOICE_BLOCK_CLASS).forEach(el => el.remove());

    const block = document.createElement('div');
    block.className = CHOICE_BLOCK_CLASS;
    block.dataset.choiceSig = newSig;

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

    // ★ 非同期処理中のキャラ切替を検出するため、開始時のキャラIDを記録
    const startCharId = ctx?.characterId;
    const startCharName = ctx?.characters?.[ctx?.characterId]?.name || null;

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

    // ★ キャラ関連ワールドを最優先（UIの stale 状態を回避）
    const worldName = getChoicesWorldName();
    if (!worldName) return;

    const entries = await loadWorldInfoEntriesByName(worldName);
    if (!entries) return;

    // ★ 非同期処理後にキャラが切り替わっていないか確認
    const ctxAfter = getContext();
    if (ctxAfter?.characterId !== startCharId) {
        debugLog(
            `キャラが切り替わったため選択肢表示をスキップ ` +
            `(start="${startCharName}", current="${ctxAfter?.characters?.[ctxAfter?.characterId]?.name || '?'}")`
        );
        return;
    }

    const entry = findEntryByChoice(entries, choiceNum);
    if (!entry) return;

    // ★ エントリが実際に期待するワールドのものか防御的チェック
    const entryWorld = typeof entry.world === 'string' ? entry.world : '';
    if (entryWorld && entryWorld !== worldName) {
        debugLog(
            `エントリのワールド不一致を検出: expected="${worldName}", actual="${entryWorld}" ` +
            `（別キャラのロアブック混入を防止）`
        );
        return;
    }

    const uid = entry.uid ?? null;
    if (uid === null || uid === undefined) return;

    const data = getDataFor(worldName, uid, entry);
    if (!data.choices || data.choices.length === 0) return;

    renderChoicesBlock(lastAiIdx, data.choices);
}

// ============================================================
// ★ 全 AI メッセージに対して選択肢ブロックを描画
//   各 AI メッセージの直前のユーザーメッセージが選択肢番号を
//   含む場合、対応するエントリの choices をそのメッセージに描画する。
//   チャット再読み込み (CHAT_CHANGED) で過去の選択肢が失われる
//   問題を修正するため、最新だけでなく全メッセージを対象とする。
//   O(n) 走査: pendingUserText を使い、直前のユーザーメッセージを
//   1 回消費する形で処理する。
// ============================================================
async function appendChoicesToAllAiMessages() {
    if (!settings.enabled || !settings.autoAppendChoices) return;

    const ctx = getContext();
    if (!ctx?.chat || ctx.chat.length === 0) return;

    // ★ 非同期処理中のキャラ切替を検出するため、開始時のキャラIDを記録
    const startCharId = ctx?.characterId;
    const startCharName = ctx?.characters?.[ctx?.characterId]?.name || null;

    // ★ キャラ関連ワールドを最優先
    const worldName = getChoicesWorldName();
    if (!worldName) return;

    const entries = await loadWorldInfoEntriesByName(worldName);
    if (!entries) return;

    // ★ 非同期処理後にキャラが切り替わっていないか確認
    const ctxAfter = getContext();
    if (ctxAfter?.characterId !== startCharId) {
        debugLog(
            `キャラが切り替わったため選択肢表示をスキップ ` +
            `(start="${startCharName}", current="${ctxAfter?.characters?.[ctxAfter?.characterId]?.name || '?'}")`
        );
        return;
    }

    let pendingUserText = null;
    for (let i = 0; i < ctx.chat.length; i++) {
        const m = ctx.chat[i];
        if (m.is_system) continue;
        if (m.is_user) {
            pendingUserText = m.mes || '';
            continue;
        }
        // AI メッセージ
        if (pendingUserText === null) continue;
        const choiceNum = extractChoiceNumber(pendingUserText);
        pendingUserText = null;
        if (!choiceNum) continue;

        const entry = findEntryByChoice(entries, choiceNum);
        if (!entry) continue;

        // ★ エントリのワールド不一致チェック（別キャラのロアブック混入防止）
        const entryWorld = typeof entry.world === 'string' ? entry.world : '';
        if (entryWorld && entryWorld !== worldName) continue;

        const uid = entry.uid ?? null;
        if (uid === null || uid === undefined) continue;

        const data = getDataFor(worldName, uid, entry);
        if (!data.choices || data.choices.length === 0) continue;

        renderChoicesBlock(i, data.choices);
    }
}

function refreshAllChoicesBlocks() {
    removeAllChoicesBlocks();
    appendChoicesToAllAiMessages().catch(e => console.warn(LOG, e));
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
            if (mod && (!mod.world_info || !mod.world_info[worldName])) {
                debugLog(`world_info["${worldName}"] 未ロード → 復元を試行`);
                try {
                    const resp = await fetch('/api/worldinfo/get', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ name: worldName }),
                    });
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data && data.entries) {
                            if (!mod.world_info) mod.world_info = {};
                            mod.world_info[worldName] = {
                                entries: data.entries,
                                name: data.name || worldName,
                            };
                            debugLog(`world_info["${worldName}"] 復元完了`);
                        }
                    }
                } catch (e) {
                    console.warn(LOG, 'world_info 復元失敗:', e);
                }
            }

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

// ============================================================
// ★ SD 拡張が対応している解像度のリストを取得
//    #sd_resolution の option から "sd_res_" を剥がして抽出
//    SD 拡張がまだ読み込まれていない場合はフォールバックを返す
// ============================================================
function getAvailableResolutionsFromSD() {
    const result = [];
    try {
        const sel = document.getElementById('sd_resolution');
        if (sel && sel.options && sel.options.length > 0) {
            for (const opt of sel.options) {
                const v = (opt.value || '').trim();
                const t = (opt.textContent || '').trim();
                if (!v) continue;
                const res = v.replace(/^sd_res_/, '');
                if (/^\d+x\d+$/.test(res)) {
                    // 重複排除（同名 value が複数ある場合）
                    if (!result.some(r => r.value === res)) {
                        result.push({ value: res, label: t || res });
                    }
                }
            }
        }
    } catch (e) { /* ignore */ }
    return result;
}

// ============================================================
// ★ Lorebook Expansion の解像度選択肢を決定
//    SD 拡張が対応している解像度のみを候補にする。
//    取得できない場合はフォールバック（旧来の6項目）を返す。
// ============================================================
function getResolutionOptionsForLex() {
    const fromSD = getAvailableResolutionsFromSD();
    if (fromSD.length > 0) {
        // ★ 1280x720 が SD 拡張の対応リストに無い場合でも必ず含める
        //   （新規エントリ / 新規テンプレートのデフォルト値として使うため）
        if (!fromSD.some(o => o.value === '1280x720')) {
            fromSD.unshift({ value: '1280x720', label: '1280×720 (横長)' });
        }
        return fromSD;
    }
    // フォールバック（SD 拡張が読み込まれていない場合）
    return [
        { value: '1280x720',  label: '1280×720 (横長)' },
        { value: '1152x896',  label: '1152×896' },
        { value: '1024x1024', label: '1024×1024 (正方形)' },
        { value: '896x1152',  label: '896×1152' },
        { value: '720x1280',  label: '720×1280 (縦長)' },
    ];
}

function buildExpansionSection(uid, worldName, data, onChange) {
    const section = document.createElement('div');
    section.className = UI_SECTION_CLASS;
    section.setAttribute(ATTR_UID, String(uid));

    // ── data の正規化（念のため） ──
    if (!Array.isArray(data.templates) || data.templates.length === 0) {
        data.templates = [{
            img_prompt: typeof data.img_prompt === 'string' ? data.img_prompt : '',
            negative_prompt: typeof data.negative_prompt === 'string' ? data.negative_prompt : '',
            resolution: (typeof data.resolution === 'string' && data.resolution.trim())
                ? data.resolution.trim()
                : '1280x720',
        }];
    }
    // 各テンプレートに resolution が無ければ補完
    for (const t of data.templates) {
        if (!t || typeof t !== 'object') continue;
        if (typeof t.resolution !== 'string' || !t.resolution.trim()) {
            t.resolution = (typeof data.resolution === 'string' && data.resolution.trim())
                ? data.resolution.trim()
                : '1280x720';
        }
    }
    if (typeof data.selectedTemplate !== 'string' || !data.selectedTemplate) {
        data.selectedTemplate = '0';
    }

    // ── template state ──
    let _activeRandomIndex = null;

    function resolveEditIndex() {
        if (data.selectedTemplate === 'random') {
            if (_activeRandomIndex === null || _activeRandomIndex >= data.templates.length) {
                _activeRandomIndex = Math.floor(Math.random() * data.templates.length);
            }
            return _activeRandomIndex;
        }
        let idx = parseInt(data.selectedTemplate, 10);
        if (!Number.isFinite(idx) || idx < 0 || idx >= data.templates.length) {
            idx = 0;
            data.selectedTemplate = '0';
        }
        return idx;
    }

    // ── template ラベル行（template + 追加 + 削除） ──
    const templateLabelRow = document.createElement('div');
    templateLabelRow.className = 'lbe-label-row lbe-template-row';

    const templateLabel = document.createElement('label');
    templateLabel.className = 'lbe-label';
    templateLabel.textContent = 'template';
    templateLabelRow.appendChild(templateLabel);

    const templateSelect = document.createElement('select');
    templateSelect.className = 'lbe-template-select text_pole';
    templateSelect.title = 'プロンプトのテンプレートを切り替える';
    templateLabelRow.appendChild(templateSelect);

    const templateAddBtn = document.createElement('button');
    templateAddBtn.type = 'button';
    templateAddBtn.className = 'lbe-template-add menu_button';
    templateAddBtn.textContent = '追加';
    templateAddBtn.title = '新しいテンプレートを追加';
    templateLabelRow.appendChild(templateAddBtn);

    const templateDelBtn = document.createElement('button');
    templateDelBtn.type = 'button';
    templateDelBtn.className = 'lbe-template-del menu_button';
    templateDelBtn.textContent = '削除';
    templateDelBtn.title = '現在のテンプレートを削除';
    templateLabelRow.appendChild(templateDelBtn);

    section.appendChild(templateLabelRow);

    // ── 解像度オプション（SD 拡張の対応解像度から動的生成 + ランダム） ──
    const RESOLUTION_OPTIONS = getResolutionOptionsForLex().concat([
        { value: 'random', label: 'ランダム' },
    ]);

    const isResolutionValid = (v) => RESOLUTION_OPTIONS.some(o => o.value === v);

    // ★ SD 拡張の対応解像度リストの先頭（random 以外）をフォールバックに使う
    //   保存済みの解像度が SD 拡張の対応外（例: 720x1280 が resolutions マップに無い）の場合、
    //   この値に置き換える。SD 拡張が読み込まれていない場合は '1280x720'。
    // ★ 新規テンプレート / 既存データのフォールバック値は必ず 1280x720
    const LEX_DEFAULT_RESOLUTION = '1280x720';
    const fallbackResolution = LEX_DEFAULT_RESOLUTION;

    // ── Img_prompt ラベル行（ラベル + 解像度ドロップダウン） ──
    const imgLabelRow = document.createElement('div');
    imgLabelRow.className = 'lbe-label-row';

    const imgLabel = document.createElement('label');
    imgLabel.className = 'lbe-label';
    imgLabel.textContent = 'Img_prompt';
    imgLabelRow.appendChild(imgLabel);

    const resolutionSelect = document.createElement('select');
    resolutionSelect.className = 'lbe-resolution-select text_pole';
    resolutionSelect.title = 'このエントリで画像を生成する際の解像度';
    for (const opt of RESOLUTION_OPTIONS) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        resolutionSelect.appendChild(o);
    }
    imgLabelRow.appendChild(resolutionSelect);

    section.appendChild(imgLabelRow);

    // ── Img_prompt textarea ──
    const imgTextarea = document.createElement('textarea');
    imgTextarea.className = 'lbe-img-prompt text_pole';
    imgTextarea.rows = 3;
    imgTextarea.placeholder = '例: 5girls:1.4, schoo sailor uniform, miniskirt, sitting on chair, looking at viewer, school, classroom, smile, femdom';
    section.appendChild(imgTextarea);

    // ── Negative_prompt ラベル ──
    const negLabel = document.createElement('label');
    negLabel.className = 'lbe-label';
    negLabel.textContent = 'Negative_prompt';
    section.appendChild(negLabel);

    // ── Negative_prompt textarea ──
    const negTextarea = document.createElement('textarea');
    negTextarea.className = 'lbe-negative-prompt text_pole';
    negTextarea.rows = 2;
    negTextarea.placeholder = '例: bad hands, extra fingers, lowres, ugly, blurry, watermark';
    section.appendChild(negTextarea);

    // ── template と textarea / 解像度の連携 ──
    let _currentIndex = resolveEditIndex();

    const rebuildTemplateOptions = (selectedValue) => {
        templateSelect.innerHTML = '';
        data.templates.forEach((_, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = String(i);
            templateSelect.appendChild(opt);
        });
        const rnd = document.createElement('option');
        rnd.value = 'random';
        rnd.textContent = 'ランダム';
        templateSelect.appendChild(rnd);
        templateSelect.value = selectedValue;
    };

    const updateReadOnlyState = () => {
        const isRandom = data.selectedTemplate === 'random';
        imgTextarea.readOnly = isRandom;
        negTextarea.readOnly = isRandom;
        resolutionSelect.disabled = isRandom;
        imgTextarea.classList.toggle('lbe-prompt-readonly', isRandom);
        negTextarea.classList.toggle('lbe-prompt-readonly', isRandom);
        resolutionSelect.classList.toggle('lbe-prompt-readonly', isRandom);
        const msg = isRandom
            ? 'ランダム選択中は編集できません。具体的なテンプレートを選んでください'
            : '';
        imgTextarea.title = msg;
        negTextarea.title = msg;
        resolutionSelect.title = msg || 'このエントリで画像を生成する際の解像度';
    };

    const loadPromptIntoTextareas = () => {
        const t = data.templates[_currentIndex] || {
            img_prompt: '',
            negative_prompt: '',
            resolution: LEX_DEFAULT_RESOLUTION,
        };
        imgTextarea.value = t.img_prompt || '';
        negTextarea.value = t.negative_prompt || '';
        data.img_prompt = t.img_prompt || '';
        data.negative_prompt = t.negative_prompt || '';

        // ★ 解像度もテンプレートから同期
        //   保存済み解像度が SD 拡張の対応リストに無い場合は fallbackResolution に置き換える
        let validRes;
        if (isResolutionValid(t.resolution)) {
            validRes = t.resolution;
        } else {
            if (t.resolution) {
                console.warn(
                    `[LBE] 解像度 "${t.resolution}" は SD 拡張の対応リストに無いため ` +
                    `"${LEX_DEFAULT_RESOLUTION}" にフォールバックします (uid=${uid}, template=${_currentIndex})`
                );
            }
            validRes = LEX_DEFAULT_RESOLUTION;
        }
        resolutionSelect.value = validRes;
        data.resolution = validRes;
        // ★ テンプレート自体の解像度も更新しておく（次回保存時に反映）
        t.resolution = validRes;

        updateReadOnlyState();
    };

    // ── 初期化 ──
    rebuildTemplateOptions(data.selectedTemplate);
    loadPromptIntoTextareas();

    // ── イベント: 解像度変更 ──
    resolutionSelect.addEventListener('change', () => {
        if (data.selectedTemplate === 'random') {
            // ランダム時は編集不可: 表示を現在の値に戻す
            const t = data.templates[_currentIndex];
            const validRes = (t && isResolutionValid(t.resolution)) ? t.resolution : fallbackResolution;
            resolutionSelect.value = validRes;
            return;
        }
        const t = data.templates[_currentIndex];
        if (!t) return;
        t.resolution = resolutionSelect.value;
        data.resolution = resolutionSelect.value;
        onChange(data);
        debugLog(`uid=${uid}: template ${_currentIndex} の解像度を ${t.resolution} に変更`);
    });

    // ── イベント: textarea 編集 ──
    imgTextarea.addEventListener('input', () => {
        if (data.selectedTemplate === 'random') return;
        const t = data.templates[_currentIndex];
        if (!t) return;
        t.img_prompt = imgTextarea.value;
        data.img_prompt = imgTextarea.value;
        onChange(data);
    });

    negTextarea.addEventListener('input', () => {
        if (data.selectedTemplate === 'random') return;
        const t = data.templates[_currentIndex];
        if (!t) return;
        t.negative_prompt = negTextarea.value;
        data.negative_prompt = negTextarea.value;
        onChange(data);
    });

    // ── イベント: template 切替 ──
    templateSelect.addEventListener('change', () => {
        data.selectedTemplate = templateSelect.value;
        if (data.selectedTemplate === 'random') {
            _activeRandomIndex = null;
        }
        _currentIndex = resolveEditIndex();
        loadPromptIntoTextareas();
        onChange(data);
        debugLog(`uid=${uid}: template=${data.selectedTemplate} に切替`);
    });

    // ── イベント: template 追加 ──
    templateAddBtn.addEventListener('click', () => {
        if (data.templates.length >= 99) {
            console.warn(`${LOG} テンプレートは最大99個までです`);
            return;
        }
        // ★ 新規テンプレートの解像度は必ず 1280x720
        data.templates.push({
            img_prompt: '',
            negative_prompt: '',
            resolution: LEX_DEFAULT_RESOLUTION,
        });
        const newIdx = data.templates.length - 1;
        data.selectedTemplate = String(newIdx);
        _activeRandomIndex = null;
        _currentIndex = newIdx;
        rebuildTemplateOptions(String(newIdx));
        loadPromptIntoTextareas();
        onChange(data);
        debugLog(`uid=${uid}: テンプレート ${newIdx} を追加 (解像度=${LEX_DEFAULT_RESOLUTION})`);
    });

    // ── イベント: template 削除 ──
    templateDelBtn.addEventListener('click', () => {
        if (data.templates.length <= 1) {
            console.warn(`${LOG} テンプレートは最低1つ必要です`);
            return;
        }
        if (data.selectedTemplate === 'random') {
            console.warn(`${LOG} ランダム選択中は削除できません`);
            return;
        }
        const idx = parseInt(data.selectedTemplate, 10);
        if (!Number.isFinite(idx) || idx < 0 || idx >= data.templates.length) return;
        if (!confirm(`テンプレート「${idx}」を削除しますか？\nこの操作は取り消せません。`)) return;
        data.templates.splice(idx, 1);
        data.selectedTemplate = '0';
        _activeRandomIndex = null;
        _currentIndex = 0;
        rebuildTemplateOptions('0');
        loadPromptIntoTextareas();
        onChange(data);
        debugLog(`uid=${uid}: テンプレート ${idx} を削除、テンプレート 0 にフォールバック`);
    });

    // ── variables セクション ──
    const varsLabel = document.createElement('label');
    varsLabel.className = 'lbe-label';
    varsLabel.textContent = 'variables';
    section.appendChild(varsLabel);

    const varsContainer = document.createElement('div');
    varsContainer.className = 'lbe-variables-editor';
    section.appendChild(varsContainer);

    const updateValuePlaceholder = (input, type) => {
        if (!input) return;
        if (type === 'number') {
            input.placeholder = '例: 594, 122224, +60, -599';
            input.title = '絶対値 または 増減値（+60 / -599 など）';
        } else {
            input.placeholder = '例: テキスト';
            input.title = '任意の文字列';
        }
    };

    const renderVariables = () => {
        varsContainer.innerHTML = '';

        const variables = Array.isArray(data.variables) ? data.variables : [];

        variables.forEach((v, idx) => {
            const row = document.createElement('div');
            row.className = 'lbe-variable-row';

            const typeSelect = document.createElement('select');
            typeSelect.className = 'lbe-variable-type text_pole';
            typeSelect.title = '変数の型';

            const optNumber = document.createElement('option');
            optNumber.value = 'number';
            optNumber.textContent = '数値';
            const optString = document.createElement('option');
            optString.value = 'string';
            optString.textContent = '文字列';
            typeSelect.appendChild(optNumber);
            typeSelect.appendChild(optString);
            typeSelect.value = v.type === 'number' ? 'number' : 'string';
            row.appendChild(typeSelect);

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'lbe-variable-name text_pole';
            nameInput.placeholder = '変数名';
            nameInput.value = v.name || '';
            nameInput.addEventListener('input', () => {
                v.name = nameInput.value;
                onChange(data);
            });
            row.appendChild(nameInput);

            const valueInput = document.createElement('input');
            valueInput.type = 'text';
            valueInput.className = 'lbe-variable-value text_pole';
            valueInput.value = v.value || '';
            updateValuePlaceholder(valueInput, v.type);
            valueInput.addEventListener('input', () => {
                v.value = valueInput.value;
                onChange(data);
            });
            row.appendChild(valueInput);

            typeSelect.addEventListener('change', () => {
                v.type = typeSelect.value === 'number' ? 'number' : 'string';
                updateValuePlaceholder(valueInput, v.type);
                onChange(data);
            });

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'lbe-variable-del menu_button';
            delBtn.textContent = '✕';
            delBtn.title = 'この変数を削除';
            delBtn.addEventListener('click', () => {
                data.variables.splice(idx, 1);
                renderVariables();
                onChange(data);
            });
            row.appendChild(delBtn);

            varsContainer.appendChild(row);
        });

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'lbe-variable-add menu_button';
        addBtn.textContent = '＋ 変数を追加';
        addBtn.addEventListener('click', () => {
            if (!Array.isArray(data.variables)) data.variables = [];
            data.variables.push({ type: 'string', name: '', value: '' });
            renderVariables();
            onChange(data);
        });
        varsContainer.appendChild(addBtn);
    };

    renderVariables();

    // ── choices セクション ──
    const choicesLabel = document.createElement('label');
    choicesLabel.className = 'lbe-label';
    choicesLabel.textContent = 'choices';
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
        : 0.45;
    const newRows = Math.max(2, Math.round(originalRows * ratio));

    if (parseInt(ta.getAttribute('rows') || '0', 10) !== newRows) {
        ta.setAttribute('rows', String(newRows));
        debugLog(`uid=${entryEl.getAttribute('uid')}: content textarea rows を ${originalRows} → ${newRows} に縮小`);
    }
}

function reorganizeEntryLayout(entryEl) {
    const edit = entryEl.querySelector('.world_entry_edit');
    if (!edit) return;

    const existingToggle = edit.querySelector(':scope > ' + TOGGLE_BTN_CLASS);
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

// ============================================================
// ★ 新規エントリ用フォールバック:
//    entries に未登録の uid について、DOM 上の .world_entry から
//    comment / keys / content を読み取って仮 entry を構築する。
//    これにより、サーバー未保存の新規エントリにも LEX UI を注入できる。
// ============================================================
function buildFallbackEntryFromDOM(entryEl, uid, worldName) {
    if (!entryEl) return null;
    try {
        // comment を複数パターンで探索
        let comment = '';
        const commentInput = entryEl.querySelector(
            'input[name="comment"], textarea[name="comment"], ' +
            '.world_entry_comment input, .world_entry_comment textarea'
        );
        if (commentInput) {
            comment = (commentInput.value || '').trim();
        }

        // keys を探索
        let keys = [];
        const keysInput = entryEl.querySelector(
            'textarea[name="key"], textarea[name="keys"], ' +
            'input[name="key"], input[name="keys"]'
        );
        if (keysInput && keysInput.value) {
            keys = keysInput.value
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);
        }

        // content を探索
        let content = '';
        const contentTextarea = entryEl.querySelector('textarea[name="content"]');
        if (contentTextarea) {
            content = contentTextarea.value || '';
        }

        const numericUid = /^\d+$/.test(String(uid)) ? Number(uid) : uid;
        return {
            uid: numericUid,
            comment,
            key: keys,
            keys,
            content,
            world: worldName,
        };
    } catch (e) {
        console.warn(LOG, 'buildFallbackEntryFromDOM error:', e);
        return null;
    }
}

async function injectExpansionSections() {
    if (!settings.enabled) return;

    const worldName = getCurrentWorldName();
    if (!worldName) {
        debugLog('inject: world名取得失敗');
        return;
    }

    const entryEls = document.querySelectorAll(
        '#world_popup .world_entry[uid], .world_entry[uid]'
    );

    let needsWork = false;
    for (const entryEl of entryEls) {
        const uid = String(entryEl.getAttribute('uid'));
        const contentTextarea = entryEl.querySelector('textarea[name="content"]');
        if (!contentTextarea) continue;

        const existing = entryEl.querySelector('.' + UI_SECTION_CLASS);
        if (!existing || existing.getAttribute(ATTR_UID) !== uid) {
            needsWork = true;
            break;
        }
        const edit = entryEl.querySelector('.world_entry_edit');
        if (edit && !edit.querySelector(':scope > ' + TOGGLE_BTN_CLASS)) {
            needsWork = true;
            break;
        }
        // ★ negative_prompt 欄の存在チェック
        if (!entryEl.querySelector('.lbe-negative-prompt')) {
            needsWork = true;
            break;
        }
    }

    if (!needsWork) {
        return;
    }

    let entries = await loadWorldInfoEntriesByName(worldName);
    if (!entries) {
        // ★ entries が取得できなくても DOM フォールバックで続行
        entries = {};
        debugLog(`inject: world "${worldName}" のエントリ取得失敗 → DOM フォールバックで続行`);
    }

    // ★ 新規エントリ（サーバー未保存）のチェック
    //   DOM 上に存在するが entries に無い uid がある場合、
    //   ST 内部の world_info から再取得を試みる。
    //   ST は新規エントリ作成時に world_info[worldName].entries へ登録する場合がある。
    const domUids = Array.from(entryEls)
        .map(el => String(el.getAttribute('uid')))
        .filter(uid => uid && uid !== 'null' && uid !== 'undefined');
    const missingUids = domUids.filter(uid => !entries[uid]);
    if (missingUids.length > 0) {
        debugLog(`DOM 上に存在するが entries に無い uid: [${missingUids.join(', ')}] → 再取得を試行`);

        // ① ST 内部の world_info から再取得
        try {
            const mod = await getWorldInfoModule();
            const liveEntries = mod?.world_info?.[worldName]?.entries;
            if (liveEntries && typeof liveEntries === 'object') {
                const liveCount = Object.keys(liveEntries).length;
                const curCount = Object.keys(entries).length;
                if (liveCount > curCount) {
                    entries = liveEntries;
                    debugLog(`ST 内部の world_info から再取得: ${liveCount} 件 (旧: ${curCount} 件)`);
                }
            }
        } catch (e) {
            debugLog('ST 内部 world_info 参照エラー:', e);
        }

        // ② それでも見つからない場合、キャッシュをクリアして fetch 再取得
        const stillMissing = domUids.filter(uid => !entries[uid]);
        if (stillMissing.length > 0) {
            try {
                clearWorldInfoEntriesCache(worldName);
                const freshEntries = await loadWorldInfoEntriesByName(worldName);
                if (freshEntries && typeof freshEntries === 'object') {
                    entries = freshEntries;
                    debugLog(`キャッシュクリア後の再取得: ${Object.keys(entries).length} 件`);
                }
            } catch (e) {
                debugLog('キャッシュクリア後の再取得エラー:', e);
            }
        }
    }

    const scrollSnapshots = [];
    try {
        const seen = new Set();
        const collect = (el) => {
            if (!el || seen.has(el)) return;
            seen.add(el);
            if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight + 1) {
                scrollSnapshots.push({ el, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft });
            }
        };

        const popup = document.getElementById('world_popup');
        if (popup) {
            popup.querySelectorAll('*').forEach(collect);
            collect(popup);
            let p = popup.parentElement;
            while (p && p !== document.body) {
                collect(p);
                p = p.parentElement;
            }
        }
        if (document.scrollingElement) collect(document.scrollingElement);
    } catch (e) { /* ignore */ }

    let injected = 0;
    let skippedNoEntry = 0;
    let skippedCollapsed = 0;
    let skippedAlready = 0;

    // ★ forEach → for...of（await を使うため）
    for (const entryEl of entryEls) {
        const uid = String(entryEl.getAttribute('uid'));
        if (uid === null || uid === 'null' || uid === 'undefined') continue;

        // ★ entries[uid] が無い場合、DOM から仮 entry を構築
        let entry = entries[uid];
        if (!entry) {
            entry = buildFallbackEntryFromDOM(entryEl, uid, worldName);
            if (!entry) {
                skippedNoEntry++;
                continue;
            }
            debugLog(`uid=${uid}: entries に無いため DOM から仮 entry を構築 (comment="${entry.comment}", keys=[${entry.keys.join(',')}])`);
        }

        const contentTextarea = entryEl.querySelector('textarea[name="content"]');
        if (!contentTextarea) {
            skippedCollapsed++;
            continue;
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
        if (existing && existing.getAttribute(ATTR_UID) === uid
            && entryEl.querySelector('.lbe-negative-prompt')) {
            skippedAlready++;
            continue;
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
    }

    if (injected > 0 || settings.debug) {
        debugLog(
            `inject完了: world="${worldName}", 注入=${injected}, ` +
            `未展開=${skippedCollapsed}, entryなし=${skippedNoEntry}, 注入済=${skippedAlready}`
        );
    }

    const restore = () => {
        scrollSnapshots.forEach(({ el, scrollTop, scrollLeft }) => {
            try {
                if (el.scrollTop !== scrollTop) el.scrollTop = scrollTop;
                if (el.scrollLeft !== scrollLeft) el.scrollLeft = scrollLeft;
            } catch (e) { /* ignore */ }
        });
    };
    restore();
    requestAnimationFrame(restore);
    requestAnimationFrame(() => requestAnimationFrame(restore));
}

// ============================================================
// 監視
// ============================================================
let _observer = null;
let _injectTimer = null;
let _pollTimer = null;
let _lastWorldPopupScrollAt = 0;

// ★ 永続スクロールトラッカー（ST再構築対策）
let _lbeLastScrollTop = 0;
let _lbeLastScrollLeft = 0;
let _lbeLastUserInputAt = 0;
let _lbeScrollEnforceUntil = 0;
let _lbeScrollEnforceRunning = false;
let _lbeRestoreScheduled = false;

function _lbeFindScrollable() {
    const popup = document.getElementById('world_popup');
    if (!popup) return null;
    const candidates = [popup, ...popup.querySelectorAll('*')];
    for (const el of candidates) {
        if (el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) {
            return el;
        }
    }
    return null;
}

function _lbeRestoreScroll() {
    if (_lbeLastScrollTop <= 0) return false;
    const el = _lbeFindScrollable();
    if (!el) return false;
    if (Math.abs(el.scrollTop - _lbeLastScrollTop) <= 0.5) return false;
    el.scrollTop = _lbeLastScrollTop;
    if (Math.abs(el.scrollLeft - _lbeLastScrollLeft) > 0.5) {
        el.scrollLeft = _lbeLastScrollLeft;
    }
    return true;
}

function _lbeScrollEnforceLoop() {
    if (Date.now() > _lbeScrollEnforceUntil) {
        _lbeScrollEnforceRunning = false;
        return;
    }
    _lbeRestoreScroll();
    requestAnimationFrame(_lbeScrollEnforceLoop);
}

function _lbeStartScrollEnforcement(durationMs = 1500) {
    _lbeScrollEnforceUntil = Math.max(_lbeScrollEnforceUntil, Date.now() + durationMs);
    if (!_lbeScrollEnforceRunning) {
        _lbeScrollEnforceRunning = true;
        requestAnimationFrame(_lbeScrollEnforceLoop);
    }
}

function _lbeScheduleRestore() {
    if (_lbeRestoreScheduled) return;
    _lbeRestoreScheduled = true;
    _lbeRestoreScroll();
    requestAnimationFrame(() => {
        _lbeRestoreScroll();
        requestAnimationFrame(() => {
            _lbeRestoreScroll();
            _lbeRestoreScheduled = false;
        });
    });
    setTimeout(_lbeRestoreScroll, 30);
    setTimeout(_lbeRestoreScroll, 100);
    setTimeout(_lbeRestoreScroll, 250);
    setTimeout(_lbeRestoreScroll, 500);
}

(function installWorldPopupScrollTracker() {
    if (window.__lbeScrollTrackerInstalled) return;
    window.__lbeScrollTrackerInstalled = true;

    const trackUser = (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('#world_popup')) {
            _lbeLastUserInputAt = Date.now();
        }
    };
    document.addEventListener('pointerdown', trackUser, true);
    document.addEventListener('pointermove', trackUser, true);
    document.addEventListener('wheel', trackUser, { capture: true, passive: true });
    document.addEventListener('keydown', trackUser, true);

    document.addEventListener('scroll', (e) => {
        const t = e.target;
        if (!t || !t.closest || !t.closest('#world_popup')) return;
        _lastWorldPopupScrollAt = Date.now();
        const recentInput = (Date.now() - _lbeLastUserInputAt) < 100;
        if (recentInput || t.scrollTop > _lbeLastScrollTop) {
            _lbeLastScrollTop = t.scrollTop;
            _lbeLastScrollLeft = t.scrollLeft;
        }
        _lbeStartScrollEnforcement(1500);
        if (_injectTimer) {
            clearTimeout(_injectTimer);
            _injectTimer = null;
        }
    }, true);
})();

function scheduleInjection() {
    if (Date.now() - _lastWorldPopupScrollAt < 400) {
        if (_injectTimer) clearTimeout(_injectTimer);
        _injectTimer = setTimeout(() => {
            _injectTimer = null;
            scheduleInjection();
        }, 400);
        return;
    }

    if (_injectTimer) clearTimeout(_injectTimer);
    _injectTimer = setTimeout(() => {
        _injectTimer = null;
        injectExpansionSections().catch(e => console.warn(LOG, e));
    }, 500);
}

function setupObserver() {
    if (_observer) _observer.disconnect();

    const target = document.getElementById('world_popup');
    if (!target) {
        setTimeout(setupObserver, 500);
        return;
    }

    _observer = new MutationObserver((mutations) => {
        if (!document.getElementById('world_popup')) return;

        if (_lbeLastScrollTop > 0) {
            let bulkRemoval = false;
            for (const m of mutations) {
                if (m.type === 'childList' && m.removedNodes.length > 3) {
                    bulkRemoval = true;
                    break;
                }
            }
            if (bulkRemoval || Date.now() < _lbeScrollEnforceUntil) {
                _lbeScheduleRestore();
            }
        }

        scheduleInjection();
    });

    _observer.observe(target, {
        childList: true,
        subtree: true,
    });

    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => {
        if (document.getElementById('world_popup')) {
            scheduleInjection();
        }
    }, 1500);

    console.log(LOG, 'DOM 監視を開始しました（#world_popup 限定 + スクロール保護強化）');
}

// ============================================================
// イベントハンドラ
// ============================================================
function onCharacterMessageRendered() {
    setTimeout(() => {
        appendChoicesToAllAiMessages().catch(e => console.warn(LOG, e));
    }, 250);
}

function onChatChanged() {
    // ★ 即座に古い選択肢ブロックを削除（キャラ切替時に旧キャラの選択肢が残らないように）
    removeAllChoicesBlocks();
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
    if (event_types.CHARACTER_SELECTED) {
        eventSource.on(event_types.CHARACTER_SELECTED, () => {
            removeAllChoicesBlocks();
            setTimeout(() => {
                refreshAllChoicesBlocks();
            }, 500);
        });
    }
    if (event_types.CHARACTER_PAGE_LOADED) {
        eventSource.on(event_types.CHARACTER_PAGE_LOADED, () => {
            // 初回起動時の一括移行（フラグで制御・後方互換）
            migrateCharacterLexDataToWorldStore();
            // ★ 現在キャラの character.data → per-world store 追加マージ
            migrateCurrentCharacterToWorldStore();
        });
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            setTimeout(() => {
                try { migrateCurrentCharacterToWorldStore(); } catch (e) { /* ignore */ }
            }, 200);
        });
    }
}

async function init() {
    console.log(LOG, 'Lorebook Expansion 初期化開始');
    loadSettings();

    migrateCharacterLexDataToWorldStore();

    try {
        const ctx = getContext();
        const char = ctx?.characters?.[ctx?.characterId];
        if (char?.data && char?.data?.extensions) {
            const existing = char.data.extensions.lorebook_expansion;
            console.log(
                LOG,
                `character.data.extensions.lorebook_expansion: ${
                    existing ? Object.keys(existing).length : 0
                } 件`
            );
        }
    } catch (e) { /* ignore */ }

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
// ============================================================
(function setupWIDrawerAutoOpenBlocker() {
    let blocking = true;
    let released = false;

    function findWIDrawer() {
        return document.getElementById('WorldInfo') ||
               document.querySelector('#world_info') ||
               document.querySelector('.drawer[id*="WorldInfo" i]');
    }

    function forceCloseWIDrawer(reason) {
        const wi = findWIDrawer();
        if (!wi) return false;

        let changed = false;

        if (wi.classList.contains('openDrawer')) {
            wi.classList.remove('openDrawer');
            changed = true;
        }

        wi.querySelectorAll('.drawer-content, .drawer-toggle, .drawer-header, .drawer-icon').forEach(el => {
            if (el.classList.contains('openDrawer')) {
                el.classList.remove('openDrawer');
                changed = true;
            }
        });

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

    const safetyWatcher = setInterval(() => {
        if (!blocking) return;
        forceCloseWIDrawer('safety-net');
    }, 100);

    function releaseBlocking() {
        if (released) return;
        released = true;

        forceCloseWIDrawer('final-close');

        blocking = false;
        clearInterval(attachWatcher);
        clearInterval(safetyWatcher);
        console.log(`${LOG} 🔓 WIドロワー自動オープンブロックを解除しました`);
    }

    let releaseScheduled = false;
    const scheduleRelease = () => {
        if (releaseScheduled) return;
        releaseScheduled = true;
        setTimeout(releaseBlocking, 1500);
    };

    if (eventSource && event_types && event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, scheduleRelease);
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

    dumpCharacterLex: () => {
        try {
            const ctx = getContext();
            const char = ctx?.characters?.[ctx?.characterId];
            const lex = char?.data?.extensions?.lorebook_expansion || {};
            return JSON.parse(JSON.stringify(lex));
        } catch (e) { return {}; }
    },

    dumpWorldLex: () => {
        try {
            return JSON.parse(JSON.stringify(getLexStore()));
        } catch (e) { return {}; }
    },

    resetMigration: () => {
        settings.lexStorageMigratedV1 = false;
        saveSettings();
        console.log(`${LOG} 移行フラグをリセットしました（次回起動時に再移行）`);
        return true;
    },

    getCharKey,
    getStorageKey,

    extractChoiceNumber,
    findEntryByChoice,
    getEntryKeys,

    appendChoicesToLastAiMessage,
    appendChoicesToAllAiMessages,
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
        const charLex = (() => {
            try {
                const ctx = getContext();
                const char = ctx?.characters?.[ctx?.characterId];
                return char?.data?.extensions?.lorebook_expansion || {};
            } catch (e) { return {}; }
        })();
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
            characterLexCount: Object.keys(charLex).length,
            characterLexKeys: Object.keys(charLex),
            lexStorageMigratedV1: settings.lexStorageMigratedV1,
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

    // ★ スクロールトラッカー制御用（デバッグ・復旧用）
    _lbeDebugScrollState: () => ({
        lastScrollTop: _lbeLastScrollTop,
        lastScrollLeft: _lbeLastScrollLeft,
        enforceUntil: _lbeScrollEnforceUntil,
        enforceRunning: _lbeScrollEnforceRunning,
        lastUserInputAt: _lbeLastUserInputAt,
        lastScrollAt: _lastWorldPopupScrollAt,
    }),
    _lbeForceRestoreScroll: () => _lbeRestoreScroll(),
    _lbeResetScrollTracker: () => {
        _lbeLastScrollTop = 0;
        _lbeLastScrollLeft = 0;
        _lbeScrollEnforceUntil = 0;
        console.log(`${LOG} スクロールトラッカーをリセットしました`);
    },
    getCharacterWorldInfoName,
    getChoicesWorldName,
    
    MODULE_NAME,
    clearWorldInfoEntriesCache,
    migrateCurrentCharacterToWorldStore,
    cleanupLexDuplicateKeys,
};
console.log(LOG, 'window.LorebookExpansion に API を公開しました');
