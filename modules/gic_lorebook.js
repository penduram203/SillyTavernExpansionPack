// gic_lorebook.js
// ロアブック駆動で画像生成プロンプトを切り替えるモジュール。
//
// ★ v5 修正:
//   - 既定トリガーを 'ai_reply' → 'user_send' に変更し、
//     画像生成を LLM 応答と並行実行する
//   - 生成コンテキスト (entryKey 等) を保持し、gic.js が生成画像の
//     ファイル名を「キャラ名_エントリキー_タイムスタンプ.ext」に
//     リネームできるよう window.GicLorebook に公開
//   - v3 マイグレーション（triggerOn の自動切替）
//
// ★ Phase 5 修正:
//   - LEX データの参照先を per-world ストア
//     (extension_settings.lorebook_expansion.data[worldName][charKey])
//     に変更。キャラとロアブックが別でも正しくプロンプトを取得できる。
//   - character.data の旧データはフォールバックとして参照
//
// ★ 画像生成ステータス通知:
//   - /sd 実行前後に gic-image-generation-started / gic-image-generation-ended
//     カスタムイベントを発火し、status_indicator.js が「画像生成中…」を表示する
//
// ★ v4 修正（Phase 6）:
//   - Negative_prompt（ネガティブプロンプト）に対応
//   - per-world ストアの negative_prompt → /sd の negative_prompt 引数として渡す
//   - LorebookExpansion.getDataFor 経由での取得を最優先、直接参照をフォールバック
//
// ★ v5 修正（解像度）:
//   - 解像度（resolution）に対応
//   - エントリ毎に設定された解像度を取得し、/sd 実行前に
//     extensionSettings.sd.resolution を一時差し替え・生成後に復元
//   - 'random' が選択されていれば ①〜⑤ からランダムに選択
//
// ★ v6 修正（テンプレート）:
//   - templates / selectedTemplate に対応
//   - エントリ毎に複数のテンプレート（img_prompt / negative_prompt ペア）を保持
//   - 'random' 選択時は生成時に一度だけランダム選択し、
//     img_prompt と negative_prompt が同じテンプレートから取られることを保証
//   - 生成コンテキストに templateIndex を追加

import { eventSource, event_types, getRequestHeaders } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';

const MODULE_NAME = 'gic_lorebook_sd';
const SETTINGS_VERSION = 3;

const DEFAULT_SETTINGS = {
    version: SETTINGS_VERSION,
    enabled: true,
    triggerOn: 'user_send',
    quiet: false,
    fallbackToLast: false,
    verbose: true,
};

let settings = { ...DEFAULT_SETTINGS };

// ===== 二重実行防止 =====
let processInFlight = false;
let lastProcessedMsgIdx = -1;
let listenersInstalled = false;

// ★ 生成コンテキスト（リネーム用に gic.js へ引き渡す）
let _pendingGenerationContext = null;

// ===== SlashCommand モジュールキャッシュ =====
let _slashParserModule = null;
let _slashCommandModule = null;
let _slashModulesResolved = false;

// ===== インポートパス候補（SillyTavern のバージョン差を吸収） =====
const SLASH_PARSER_PATHS = [
    '../../../slash-commands/SlashCommandParser.js',
    '../../../../slash-commands/SlashCommandParser.js',
    '../../../../../slash-commands/SlashCommandParser.js',
];

const SLASH_COMMAND_PATHS = [
    '../../../slash-commands/SlashCommand.js',
    '../../../../slash-commands/SlashCommand.js',
    '../../../../../slash-commands/SlashCommand.js',
];

// ★ Phase 5: ストレージキー区切り文字（Lorebook_Expansion.js と一致させる）
const STORAGE_KEY_SEPARATOR = '\x1f';

function loadSettings() {
    const ctx = getContext();
    const stored = ctx.extensionSettings[MODULE_NAME] || {};
    let migrated = false;

    // v2 マイグレーション: quiet: true → false
    if (!stored.version || stored.version < 2) {
        console.log('[GIC-Lore] 設定を v2 に移行します（quiet: true → false）');
        stored.quiet = false;
        stored.version = 2;
        migrated = true;
    }

    // v3 マイグレーション: triggerOn の既定値を 'user_send' へ
    if (!stored.version || stored.version < 3) {
        if (!stored.triggerOn || stored.triggerOn === 'ai_reply') {
            stored.triggerOn = 'user_send';
            console.log('[GIC-Lore] 設定を v3 に移行します（triggerOn: ai_reply → user_send）');
        } else {
            console.log(`[GIC-Lore] 設定を v3 に移行します（triggerOn は "${stored.triggerOn}" を維持）`);
        }
        stored.version = 3;
        migrated = true;
    }

    if (migrated) {
        ctx.extensionSettings[MODULE_NAME] = stored;
        ctx.saveSettingsDebounced();
    }

    settings = { ...DEFAULT_SETTINGS, ...stored };
    if (settings.verbose) console.log('[GIC-Lore] 設定:', settings);
}

function saveSettings() {
    const ctx = getContext();
    ctx.extensionSettings[MODULE_NAME] = { ...settings };
    ctx.saveSettingsDebounced();
}

// ===== 選択肢番号の抽出 =====
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

// ===== エントリからプロンプト抽出 =====
const CONTENT_PROMPT_PATTERNS = [
    /\[GIC_IMG:\s*([^\]]+)\]/i,
    /\[IMG:\s*([^\]]+)\]/i,
];

function cleanPrompt(prompt) {
    return String(prompt)
        .replace(/,\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ===== key / keys 両対応 =====
function getEntryKeys(entry) {
    if (!entry) return [];
    if (Array.isArray(entry.keys) && entry.keys.length) return entry.keys;
    if (Array.isArray(entry.key) && entry.key.length) return entry.key;
    if (typeof entry.keys === 'string' && entry.keys.trim()) return [entry.keys];
    if (typeof entry.key === 'string' && entry.key.trim()) return [entry.key];
    return [];
}

// ★ ST 表示用注釈を除去（Lorebook_Expansion.js と同一ロジック）
function normalizeEntryComment(comment) {
    if (typeof comment !== 'string') return '';
    let s = comment.trim();
    if (!s) return '';
    s = s.replace(/\s*[（(](?:常時有効|無効|Constant|Disabled)[）)]\s*$/i, '').trim();
    return s;
}

// ===== エントリキー決定 =====
function getEntryCharKey(entry, uid) {
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
    return uid !== null && uid !== undefined ? String(uid) : null;
}

// ============================================================
// ★ テンプレート選択ヘルパー（v6 追加 / v7: 解像度も返す）
//    rec（LEX データ）から templates / selectedTemplate を見て
//    実際に使うプロンプト・解像度を 1 つだけ選ぶ。
//    'random' の場合はここでランダムに選ぶ。
// ============================================================
function _pickTemplateFromRecord(rec, logContext = '') {
    if (!rec || typeof rec !== 'object') return null;
    const templates = Array.isArray(rec.templates) ? rec.templates : [];
    if (templates.length === 0) return null;

    const selectedTemplate = typeof rec.selectedTemplate === 'string' ? rec.selectedTemplate : '0';

    let idx;
    if (selectedTemplate === 'random') {
        idx = Math.floor(Math.random() * templates.length);
        console.log(`[GIC-Lore] 🎲${logContext} テンプレートをランダム選択: ${idx}/${templates.length}`);
    } else {
        idx = parseInt(selectedTemplate, 10);
        if (!Number.isFinite(idx) || idx < 0 || idx >= templates.length) idx = 0;
    }

    const t = templates[idx] || {};
    // ★ テンプレート毎の解像度を返す（未設定時は rec.resolution → 1280x720 にフォールバック）
    let resolution = null;
    if (typeof t.resolution === 'string' && t.resolution.trim()) {
        resolution = t.resolution.trim();
    } else if (typeof rec.resolution === 'string' && rec.resolution.trim()) {
        resolution = rec.resolution.trim();
    } else {
        resolution = '1280x720';
    }

    return {
        index: idx,
        img_prompt: (typeof t.img_prompt === 'string' && t.img_prompt.trim()) ? t.img_prompt.trim() : null,
        negative_prompt: (typeof t.negative_prompt === 'string' && t.negative_prompt.trim()) ? t.negative_prompt.trim() : null,
        resolution,
    };
}

// ============================================================
// ★ 生成用のテンプレートを 1 回だけ選択する（v6 追加）
//   - img_prompt と negative_prompt を同一テンプレートから取得するため、
//     processChoice ではこの関数を優先して呼ぶ
//   - templates 未定義（旧データ）の場合は null を返し、
//     従来の extractPromptFromEntry にフォールバックする
// ============================================================
function pickTemplateForGeneration(worldName, entry) {
    if (!entry) return null;
    const uid = entry.uid;
    if (uid === null || uid === undefined) return null;

    let data = null;
    try {
        if (window.LorebookExpansion?.getDataFor) {
            data = window.LorebookExpansion.getDataFor(worldName, uid, entry);
        }
    } catch (e) { /* ignore */ }

    return _pickTemplateFromRecord(data, `(${worldName}::${uid})`);
}

// ============================================================
// ★ Phase 5: LEX データから img_prompt を取得
//   一次: extension_settings.lorebook_expansion.data[worldName][charKey]
//   二次: character.data.extensions.lorebook_expansion
//
//   v6: templates があればそちらを優先（_pickTemplateFromRecord 経由）
// ============================================================
function getLexImgPrompt(worldName, uid, entry) {
    const charKey = getEntryCharKey(entry, uid);
    if (!worldName || !charKey) {
        return getFallbackPromptFromEntry(entry);
    }

    // ── ① Primary: per-world store ──
    try {
        const ctx = getContext();
        const lexData = ctx?.extensionSettings?.lorebook_expansion?.data;
        if (lexData && typeof lexData === 'object' && lexData[worldName]) {
            const rec = lexData[worldName][charKey];
            if (rec && typeof rec === 'object') {
                // templates があれば優先
                const picked = _pickTemplateFromRecord(rec, `(${worldName}::${charKey})`);
                if (picked?.img_prompt) {
                    if (settings.verbose) {
                        console.log(`[GIC-Lore] per-world store から img_prompt 読込 (template ${picked.index}, ${worldName}::${charKey})`);
                    }
                    return cleanPrompt(picked.img_prompt);
                }
                // 後方互換: 直接 img_prompt
                if (typeof rec.img_prompt === 'string' && rec.img_prompt.trim()) {
                    if (settings.verbose) {
                        console.log(`[GIC-Lore] per-world store から img_prompt 読込 (${worldName}::${charKey})`);
                    }
                    return cleanPrompt(rec.img_prompt);
                }
            }
        }
    } catch (e) {
        console.warn('[GIC-Lore] per-world store 読み込み失敗:', e);
    }

    // ── ② Fallback: character.data (旧データ・デバッグ用) ──
    try {
        const ctx = getContext();
        const char = ctx?.characters?.[ctx?.characterId];
        const charLex = char?.data?.extensions?.lorebook_expansion;
        if (charLex && typeof charLex === 'object') {
            const storageKey = `${worldName}${STORAGE_KEY_SEPARATOR}${charKey}`;
            let rec = null;
            if (charLex[storageKey] && typeof charLex[storageKey] === 'object') {
                rec = charLex[storageKey];
            } else if (charLex[charKey] && typeof charLex[charKey] === 'object') {
                const charName = typeof char?.name === 'string' ? char.name : '';
                const associatedWorld =
                    (typeof char?.data?.extensions?.world === 'string' && char.data.extensions.world) ||
                    (typeof char?.data?.world === 'string' && char.data.world) ||
                    '';
                const isOwnLorebook = !!worldName && (
                    (charName && worldName === charName) ||
                    (associatedWorld && worldName === associatedWorld)
                );
                if (isOwnLorebook) {
                    rec = charLex[charKey];
                }
            }
            if (rec && typeof rec === 'object') {
                const picked = _pickTemplateFromRecord(rec, `(${worldName}::${charKey})`);
                if (picked?.img_prompt) {
                    if (settings.verbose) {
                        console.log(`[GIC-Lore] character.data から img_prompt 読込 (template ${picked.index}, フォールバック)`);
                    }
                    return cleanPrompt(picked.img_prompt);
                }
                if (typeof rec.img_prompt === 'string' && rec.img_prompt.trim()) {
                    if (settings.verbose) {
                        console.log(`[GIC-Lore] character.data から img_prompt 読込 (フォールバック)`);
                    }
                    return cleanPrompt(rec.img_prompt);
                }
            }
        }
    } catch (e) {
        console.warn('[GIC-Lore] character.data 読み込み失敗:', e);
    }

    return getFallbackPromptFromEntry(entry);
}

function getFallbackPromptFromEntry(entry) {
    if (entry && typeof entry.prompt === 'string' && entry.prompt.trim()) {
        return cleanPrompt(entry.prompt);
    }

    if (entry && typeof entry.content === 'string') {
        for (const pat of CONTENT_PROMPT_PATTERNS) {
            const m = entry.content.match(pat);
            if (m && m[1]) return cleanPrompt(m[1]);
        }
    }
    return null;
}

function extractPromptFromEntry(entry, worldName) {
    if (!entry) return null;

    const lexPrompt = getLexImgPrompt(worldName, entry.uid, entry);
    if (lexPrompt) return lexPrompt;

    if (entry.prompt && typeof entry.prompt === 'string') {
        return cleanPrompt(entry.prompt);
    }

    if (entry.content && typeof entry.content === 'string') {
        for (const pat of CONTENT_PROMPT_PATTERNS) {
            const m = entry.content.match(pat);
            if (m && m[1]) return cleanPrompt(m[1]);
        }
    }

    return null;
}

// ============================================================
// ★ ネガティブプロンプトの取得（v4 追加 / v6 テンプレート対応）
//    per-world ストア → character.data の順で参照
// ============================================================
function getLexNegativePrompt(worldName, uid, entry) {
    if (!worldName || uid === null || uid === undefined) return null;

    // ① LorebookExpansion.getDataFor 経由（推奨）
    if (window.LorebookExpansion?.getDataFor) {
        try {
            const data = window.LorebookExpansion.getDataFor(worldName, uid, entry);
            if (data && typeof data === 'object') {
                const picked = _pickTemplateFromRecord(data, `(${worldName}::${uid})`);
                if (picked?.negative_prompt) {
                    return cleanPrompt(picked.negative_prompt);
                }
                if (typeof data.negative_prompt === 'string' && data.negative_prompt.trim()) {
                    return cleanPrompt(data.negative_prompt);
                }
            }
        } catch (e) { /* ignore */ }
    }

    // ② extensionSettings を直接参照（フォールバック）
    try {
        const ctx = getContext();
        const charKey = getEntryCharKey(entry, uid);
        if (!charKey) return null;
        const rec = ctx?.extensionSettings?.lorebook_expansion?.data?.[worldName]?.[charKey];
        if (rec && typeof rec === 'object') {
            const picked = _pickTemplateFromRecord(rec, `(${worldName}::${charKey})`);
            if (picked?.negative_prompt) {
                return cleanPrompt(picked.negative_prompt);
            }
            if (typeof rec.negative_prompt === 'string' && rec.negative_prompt.trim()) {
                return cleanPrompt(rec.negative_prompt);
            }
        }
    } catch (e) { /* ignore */ }

    return null;
}

function extractNegativePromptFromEntry(entry, worldName) {
    if (!entry) return null;
    return getLexNegativePrompt(worldName, entry.uid, entry);
}

// ============================================================
// ★ 解像度の取得（v5 追加 / v7: テンプレート対応）
//    per-world ストア → character.data の順で参照
//    templates があれば選択中テンプレートの解像度を優先
// ============================================================
function getLexResolution(worldName, uid, entry) {
    if (!worldName || uid === null || uid === undefined) return null;

    // ① LorebookExpansion.getDataFor 経由（推奨）
    if (window.LorebookExpansion?.getDataFor) {
        try {
            const data = window.LorebookExpansion.getDataFor(worldName, uid, entry);
            if (data && typeof data === 'object') {
                // ★ テンプレートの解像度を優先
                const picked = _pickTemplateFromRecord(data, `(${worldName}::${uid})`);
                if (picked?.resolution) {
                    return picked.resolution;
                }
                // 後方互換: 直接 resolution
                if (typeof data.resolution === 'string' && data.resolution.trim()) {
                    return data.resolution.trim();
                }
            }
        } catch (e) { /* ignore */ }
    }

    // ② extensionSettings を直接参照（フォールバック）
    try {
        const ctx = getContext();
        const charKey = getEntryCharKey(entry, uid);
        if (!charKey) return null;
        const rec = ctx?.extensionSettings?.lorebook_expansion?.data?.[worldName]?.[charKey];
        if (rec && typeof rec === 'object') {
            const picked = _pickTemplateFromRecord(rec, `(${worldName}::${charKey})`);
            if (picked?.resolution) {
                return picked.resolution;
            }
            if (typeof rec.resolution === 'string' && rec.resolution.trim()) {
                return rec.resolution.trim();
            }
        }
    } catch (e) { /* ignore */ }

    return null;
}

// ============================================================
// ★ SD 拡張が対応している解像度のリストを取得
//    #sd_resolution の option から "sd_res_" を剥がして抽出
// ============================================================
function getAvailableSDResolutions() {
    const result = [];
    try {
        const sel = document.getElementById('sd_resolution');
        if (sel && sel.options && sel.options.length > 0) {
            for (const opt of sel.options) {
                const v = (opt.value || '').trim();
                if (!v) continue;
                const res = v.replace(/^sd_res_/, '');
                if (/^\d+x\d+$/.test(res) && !result.includes(res)) {
                    result.push(res);
                }
            }
        }
    } catch (e) { /* ignore */ }
    return result;
}

function extractResolutionFromEntry(entry, worldName) {
    if (!entry) return null;
    return getLexResolution(worldName, entry.uid, entry);
}

// ===== キャラに紐付くロアブック名 =====
function getCharacterWorldInfoName() {
    const ctx = getContext();
    const char = ctx.characters && ctx.characterId !== undefined
        ? ctx.characters[ctx.characterId]
        : null;
    if (!char) return null;

    const fromExt = char.data?.extensions?.world;
    if (fromExt && typeof fromExt === 'string') return fromExt;
    const fromData = char.data?.world;
    if (fromData && typeof fromData === 'string') return fromData;
    return null;
}

// ===== ロアブックのエントリ読込 =====
// ===== ロアブックのエントリ読込 =====
async function loadWorldInfoEntries(worldName) {
    if (!worldName) return [];

    // ★ ① LorebookExpansion の統合キャッシュを最優先
    //    （worldinfo_updated などのイベントで自動クリアされる）
    if (window.LorebookExpansion?.loadWorldInfoEntriesByName) {
        try {
            const entriesObj = await window.LorebookExpansion.loadWorldInfoEntriesByName(worldName);
            if (entriesObj && typeof entriesObj === 'object') {
                const list = Object.values(entriesObj);
                if (list.length > 0) {
                    if (settings.verbose) {
                        console.debug(`[GIC-Lore] LBE統合キャッシュから取得: ${worldName} (${list.length}件)`);
                    }
                    return list;
                }
            }
        } catch (e) { /* fall through */ }
    }

    // ★ ② fetch を必ず実行（cache: no-store でブラウザキャッシュも回避）
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const resp = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: worldName }),
                cache: 'no-store',
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data && data.entries) {
                    const list = Object.values(data.entries);
                    if (settings.verbose) {
                        console.debug(`[GIC-Lore] fetch から取得: ${worldName} (${list.length}件)`);
                    }
                    return list;
                }
            }
        } catch (e) {
            if (settings.verbose) {
                console.debug(`[GIC-Lore] /api/worldinfo/get 試行 ${attempt}/3 失敗: ${e.message || e}`);
            }
        }
        if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
    }

    // ★ ③ 最終フォールバック: window.world_info / mod.world_info
    try {
        if (typeof window.world_info !== 'undefined' && window.world_info[worldName]) {
            const wi = window.world_info[worldName];
            if (wi.entries) {
                const list = Object.values(wi.entries);
                if (settings.verbose) {
                    console.debug(`[GIC-Lore] window.world_info から取得: ${worldName} (${list.length}件)`);
                }
                return list;
            }
        }
    } catch (e) { /* ignore */ }

    try {
        const mod = await import('../../../../world-info.js');
        if (mod.world_info && mod.world_info[worldName] && mod.world_info[worldName].entries) {
            const list = Object.values(mod.world_info[worldName].entries);
            if (settings.verbose) {
                console.debug(`[GIC-Lore] mod.world_info から取得: ${worldName} (${list.length}件)`);
            }
            return list;
        }
    } catch (e) { /* ignore */ }

    console.warn('[GIC-Lore] ロアブックのエントリを取得できませんでした:', worldName);
    return [];
}

// ============================================================
// ★ エントリの「タイトル」を抽出（ファイル名に使う）
// ============================================================
function extractEntryKey(entry) {
    if (!entry) return '';
    let raw = '';
    if (typeof entry.comment === 'string' && entry.comment.trim()) {
        raw = entry.comment.trim();
    } else {
        const keys = getEntryKeys(entry);
        if (keys.length > 0) raw = String(keys[0]).trim();
    }
    if (!raw) return '';
    return raw
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, '_')
        .trim();
}

function findEntryByChoice(entries, choiceNum) {
    if (!Array.isArray(entries) || !choiceNum) return null;

    let partialMatch = null;

    for (const entry of entries) {
        if (!entry) continue;
        const keys = getEntryKeys(entry);
        for (const key of keys) {
            const k = String(key).trim();
            if (k === choiceNum) return entry;
            if (!partialMatch && (k.startsWith(choiceNum) || k.includes(choiceNum))) {
                partialMatch = entry;
            }
        }
    }
    return partialMatch;
}

// ===== メッセージ取得 =====
function getLastUserMessageIndex() {
    const ctx = getContext();
    if (!ctx.chat || ctx.chat.length === 0) return -1;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (m.is_system) continue;
        if (m.is_user) return i;
    }
    return -1;
}

function getLastUserMessageText() {
    const idx = getLastUserMessageIndex();
    if (idx < 0) return null;
    const ctx = getContext();
    return ctx.chat[idx]?.mes || '';
}

// ===== [GIC_IMG: ] 除去 =====
const GIC_IMG_STRIP_REGEX = /\[GIC_IMG:[^\]]*\]\s*/gi;

function stripGicImgFromMessage(messageId) {
    const ctx = getContext();
    if (!ctx.chat || messageId === undefined || messageId < 0) return;
    const msg = ctx.chat[messageId];
    if (!msg || msg.is_user || msg.is_system) return;
    if (typeof msg.mes !== 'string') return;

    GIC_IMG_STRIP_REGEX.lastIndex = 0;
    if (!GIC_IMG_STRIP_REGEX.test(msg.mes)) return;
    GIC_IMG_STRIP_REGEX.lastIndex = 0;

    msg.mes = msg.mes.replace(GIC_IMG_STRIP_REGEX, '').replace(/\s+$/g, '');
    if (settings.verbose) {
        console.log('[GIC-Lore] AIメッセージから [GIC_IMG: ] を除去しました');
    }
}

function stripGicImgFromDom() {
    document.querySelectorAll('.mes_text').forEach(el => {
        if (!el.textContent || !el.textContent.includes('[GIC_IMG:')) return;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        const targets = [];
        let node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue && node.nodeValue.includes('[GIC_IMG:')) {
                targets.push(node);
            }
        }
        targets.forEach(n => {
            n.nodeValue = n.nodeValue.replace(/\[GIC_IMG:[^\]]*\]\s*/gi, '');
        });
    });
}

// ===== パス存在チェック（HEAD リクエスト） =====
async function urlExists(url) {
    try {
        const resp = await fetch(url, { method: 'HEAD' });
        if (!resp.ok) return false;
        const ct = (resp.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('text/html')) return false;
        return true;
    } catch (e) {
        return false;
    }
}

// ===== SlashCommand モジュールの安全なロード =====
async function loadSlashModules() {
    if (_slashModulesResolved) {
        return { parser: _slashParserModule, command: _slashCommandModule };
    }
    _slashModulesResolved = true;

    if (typeof window !== 'undefined') {
        if (window.SlashCommandParser && !_slashParserModule) {
            _slashParserModule = window.SlashCommandParser;
            if (settings.verbose) console.log('[GIC-Lore] SlashCommandParser を window から取得');
        }
        if (window.SlashCommand && !_slashCommandModule) {
            _slashCommandModule = window.SlashCommand;
            if (settings.verbose) console.log('[GIC-Lore] SlashCommand を window から取得');
        }
    }

    if (!_slashParserModule) {
        try {
            const ctx = getContext();
            if (ctx && ctx.SlashCommandParser) {
                _slashParserModule = ctx.SlashCommandParser;
                if (settings.verbose) console.log('[GIC-Lore] SlashCommandParser を context から取得');
            }
            if (ctx && ctx.SlashCommand && !_slashCommandModule) {
                _slashCommandModule = ctx.SlashCommand;
                if (settings.verbose) console.log('[GIC-Lore] SlashCommand を context から取得');
            }
        } catch (e) { /* ignore */ }
    }

    if (!_slashParserModule) {
        for (const path of SLASH_PARSER_PATHS) {
            try {
                const absUrl = new URL(path, import.meta.url).href;
                const exists = await urlExists(absUrl);
                if (!exists) {
                    if (settings.verbose) {
                        console.debug(`[GIC-Lore] SlashCommandParser パス存在せず: ${absUrl}`);
                    }
                    continue;
                }
                const mod = await import(/* @vite-ignore */ path);
                _slashParserModule = mod?.SlashCommandParser || mod?.default || null;
                if (_slashParserModule) {
                    if (settings.verbose) console.log(`[GIC-Lore] SlashCommandParser 読み込み成功: ${path}`);
                    break;
                }
            } catch (e) {
                // 次のパスへ
            }
        }
    }

    if (!_slashCommandModule) {
        for (const path of SLASH_COMMAND_PATHS) {
            try {
                const absUrl = new URL(path, import.meta.url).href;
                const exists = await urlExists(absUrl);
                if (!exists) continue;
                const mod = await import(/* @vite-ignore */ path);
                _slashCommandModule = mod?.SlashCommand || null;
                if (_slashCommandModule) {
                    if (settings.verbose) console.log(`[GIC-Lore] SlashCommand 読み込み成功: ${path}`);
                    break;
                }
            } catch (e) {
                // 次のパスへ
            }
        }
    }

    return { parser: _slashParserModule, command: _slashCommandModule };
}

// ===== /sd 実行 =====
async function executeSd(prompt, negativePrompt = null, resolution = null) {
    const rawPrompt = cleanPrompt(prompt).replace(/[\r\n]+/g, ' ');
    const escaped = rawPrompt.replace(/"/g, '\\"');

    const hasNeg = negativePrompt && negativePrompt.trim();
    const cleanNeg = hasNeg ? cleanPrompt(negativePrompt).replace(/[\r\n]+/g, ' ') : '';

    // ★ 解像度の決定（'random' の場合はここでランダム選択）
    let effectiveResolution = null;
    if (resolution && typeof resolution === 'string') {
        const trimmed = resolution.trim();
        if (trimmed === 'random') {
            const pool = getAvailableSDResolutions();
            const RESOLUTIONS = pool.length > 0
                ? pool
                : ['1280x720', '1152x896', '1024x1024', '896x1152', '720x1280'];
            effectiveResolution = RESOLUTIONS[Math.floor(Math.random() * RESOLUTIONS.length)];
            console.log(`[GIC-Lore] 🎲 解像度をランダム選択: ${effectiveResolution} (候補: ${RESOLUTIONS.join(', ')})`);
        } else if (/^\d+x\d+$/.test(trimmed)) {
            effectiveResolution = trimmed;
        }
    }

    // ★ SD設定の一時変更用状態
    let ctx = null;
    let originalNegPrompt = null;
    let originalResolution = null;
    let settingsModified = false;
    let resolutionModified = false;

    // ★ #sd_resolution DOM 操作のための状態
    let jq = null;
    let $resolutionSelect = null;
    let originalDomResolution = null;
    let addedOptionEl = null;

    if (hasNeg || effectiveResolution) {
        try {
            ctx = getContext();
            const sdSettings = ctx?.extensionSettings?.sd;
            if (!sdSettings) {
                console.warn('[GIC-Lore] SD設定が見つかりません（SD拡張未初期化の可能性）');
            } else {
                // ── negative_prompt ──
                if (hasNeg && typeof sdSettings.negative_prompt === 'string') {
                    originalNegPrompt = sdSettings.negative_prompt;
                    sdSettings.negative_prompt = cleanNeg;
                    settingsModified = true;
                    console.log(`[GIC-Lore] 🔧 SDネガティブプロンプトを一時設定: "${cleanNeg.slice(0, 100)}${cleanNeg.length > 100 ? '...' : ''}"`);
                }

                // ── resolution ──
                if (effectiveResolution) {
                    // ① extensionSettings.sd.resolution を変更（設定経由）
                    originalResolution = sdSettings.resolution;
                    sdSettings.resolution = effectiveResolution;
                    resolutionModified = true;
                    console.log(`[GIC-Lore] 🔧 SD解像度を一時設定: "${effectiveResolution}" (元: "${originalResolution}")`);

                    // ② #sd_resolution の DOM 要素も変更（DOM 経由）
                    //    ★ SD 拡張の option value は "sd_res_XXXX" 形式。
                    //      プレフィックスなしで設定すると getResolution() が解釈できず、
                    //      デフォルト解像度にフォールバックしてしまう。
                    try {
                        jq = window.$ || window.jQuery || null;
                        if (jq) {
                            const $sel = jq('#sd_resolution');
                            if ($sel.length > 0) {
                                $resolutionSelect = $sel;
                                originalDomResolution = $sel.val();
                                console.log(`[GIC-Lore] 🔧 #sd_resolution の現在値: "${originalDomResolution}"`);

                                // ★ SD 拡張の option は "sd_res_XXXX" 形式
                                const prefixedValue = `sd_res_${effectiveResolution}`;
                                const hasOption = $sel.find(`option[value="${prefixedValue}"]`).length > 0;
                                if (!hasOption) {
                                    addedOptionEl = jq('<option>', {
                                        value: prefixedValue,
                                        text: effectiveResolution,
                                    });
                                    $sel.append(addedOptionEl);
                                    console.log(`[GIC-Lore] 🔧 #sd_resolution に option "${prefixedValue}" を追加`);
                                }

                                // 値を変更して change イベントを発火
                                $sel.val(prefixedValue).trigger('change');
                                console.log(`[GIC-Lore] 🔧 #sd_resolution を "${prefixedValue}" に変更`);
                            } else {
                                console.log('[GIC-Lore] #sd_resolution が見つかりません（DOM 操作をスキップ、設定経由のみで試行）');
                            }
                        } else {
                            console.log('[GIC-Lore] jQuery が利用できません（DOM 操作をスキップ、設定経由のみで試行）');
                        }
                    } catch (domErr) {
                        console.warn('[GIC-Lore] #sd_resolution 操作エラー:', domErr);
                    }
                }
            }
        } catch (e) {
            console.warn('[GIC-Lore] SD設定の一時変更エラー:', e);
        }
    }

    // ★ コマンドは quiet のみ（negative_prompt / resolution は設定経由で渡る）
    const cmd = settings.quiet
        ? `/sd quiet=true "${escaped}"`
        : `/sd "${escaped}"`;

    console.log(`[GIC-Lore] /sd 実行試行: ${cmd.slice(0, 120)}${cmd.length > 120 ? '...' : ''}`);

    try {
        // 方式1: script.js 経由
        try {
            const mod = await import('../../../../../script.js');
            if (typeof mod.executeSlashCommandsWithOptions === 'function') {
                await mod.executeSlashCommandsWithOptions(cmd);
                console.log('[GIC-Lore] ✅ 方式1 成功');
                return true;
            }
        } catch (e) {
            console.warn('[GIC-Lore] 方式1 失敗:', e?.message || e);
        }

        // 方式2: window 経由
        try {
            if (typeof window.executeSlashCommandsWithOptions === 'function') {
                await window.executeSlashCommandsWithOptions(cmd);
                console.log('[GIC-Lore] ✅ 方式2 成功');
                return true;
            }
        } catch (e) {
            console.warn('[GIC-Lore] 方式2 失敗:', e?.message || e);
        }

        // 方式3: SlashCommandParser 直叩き
        try {
            const { parser } = await loadSlashModules();
            const sdCmd = parser?.commands?.['sd'];
            if (sdCmd && typeof sdCmd.callback === 'function') {
                const namedArgs = settings.quiet ? { quiet: 'true' } : {};
                const unnamedArgs = rawPrompt;
                try {
                    await sdCmd.callback(namedArgs, unnamedArgs, true);
                } catch (e1) {
                    try {
                        await sdCmd.callback(unnamedArgs, namedArgs);
                    } catch (e2) {
                        await sdCmd.callback({ _scope: null, _abortController: null }, unnamedArgs, true);
                    }
                }
                console.log('[GIC-Lore] ✅ 方式3 成功');
                return true;
            }
        } catch (e) {
            console.warn('[GIC-Lore] 方式3 失敗:', e?.message || e);
        }

        console.error('[GIC-Lore] ❌ /sd を実行する全ての方式が失敗しました');
        return false;
    } finally {
        // ── ① #sd_resolution の DOM 復元 ──
        if (jq && $resolutionSelect && originalDomResolution !== null) {
            try {
                $resolutionSelect.val(originalDomResolution).trigger('change');
                console.log(`[GIC-Lore] 🔧 #sd_resolution を "${originalDomResolution}" に復元`);
            } catch (e) {
                console.warn('[GIC-Lore] #sd_resolution 復元エラー:', e);
            }
            if (addedOptionEl) {
                try {
                    addedOptionEl.remove();
                    console.log(`[GIC-Lore] 🔧 #sd_resolution から追加した option を削除`);
                } catch (e) {
                    console.warn('[GIC-Lore] 追加 option 削除エラー:', e);
                }
            }
        }

        // ── ② extensionSettings の復元 ──
        if (ctx?.extensionSettings?.sd) {
            if (settingsModified) {
                ctx.extensionSettings.sd.negative_prompt = originalNegPrompt;
                console.log(`[GIC-Lore] 🔧 SDネガティブプロンプトを復元: "${(originalNegPrompt || '').slice(0, 100)}${(originalNegPrompt || '').length > 100 ? '...' : ''}"`);
            }
            if (resolutionModified) {
                ctx.extensionSettings.sd.resolution = originalResolution;
                console.log(`[GIC-Lore] 🔧 SD解像度を復元: "${originalResolution}"`);
            }
        }
    }
}

// ===== メイン処理 =====
async function processChoice(force = false) {
    if (!settings.enabled) return;

    // ★ 事前設定モードでは /sd を実行しない
    try {
        let isOverride = false;
        if (typeof window.GicApi?.isOverrideMode === 'function') {
            isOverride = isOverride || window.GicApi.isOverrideMode() === true;
        }
        if (typeof window.ImageDisplayExtension?.isOverride === 'function') {
            isOverride = isOverride || window.ImageDisplayExtension.isOverride() === true;
        }
        if (!isOverride) {
            if (settings.verbose) console.log('[GIC-Lore] 事前設定モードのため /sd をスキップ');
            return;
        }
    } catch (e) { /* ignore */ }

    if (processInFlight) {
        if (settings.verbose) console.log('[GIC-Lore] 処理中のため多重呼び出しをスキップ');
        return;
    }

    const msgIdx = getLastUserMessageIndex();
    if (msgIdx < 0) {
        if (settings.verbose) console.log('[GIC-Lore] ユーザーメッセージが見つかりません');
        return;
    }

    if (!force && msgIdx === lastProcessedMsgIdx) {
        if (settings.verbose) {
            console.log(`[GIC-Lore] 同一メッセージ (idx=${msgIdx}) への重複呼び出しをスキップ`);
        }
        return;
    }

    lastProcessedMsgIdx = msgIdx;
    processInFlight = true;

    try {
        const userText = getLastUserMessageText();
        const choiceNum = extractChoiceNumber(userText);

        if (!choiceNum) {
            if (settings.verbose) console.log('[GIC-Lore] 選択肢番号が検出できませんでした');
            if (settings.fallbackToLast) {
                console.log('[GIC-Lore] /sd last にフォールバック');
                try {
                    const mod = await import('../../../../../script.js');
                    if (typeof mod.executeSlashCommandsWithOptions === 'function') {
                        const cmd = settings.quiet ? '/sd quiet=true' : '/sd';
                        await mod.executeSlashCommandsWithOptions(cmd);
                    }
                } catch (e) {
                    console.error('[GIC-Lore] fallback /sd エラー:', e);
                }
            }
            return;
        }
        if (settings.verbose) console.log(`[GIC-Lore] 選択肢番号: ${choiceNum}`);

        const worldName = getCharacterWorldInfoName();
        if (!worldName) {
            console.warn('[GIC-Lore] キャラクターにロアブックが紐付いていません');
            return;
        }
        if (settings.verbose) console.log(`[GIC-Lore] ロアブック: ${worldName}`);

        const entries = await loadWorldInfoEntries(worldName);
        if (!entries.length) {
            console.warn(`[GIC-Lore] ロアブック "${worldName}" にエントリが見つかりません`);
            return;
        }
        if (settings.verbose) console.log(`[GIC-Lore] エントリ数: ${entries.length}`);

        const entry = findEntryByChoice(entries, choiceNum);
        if (!entry) {
            console.warn(`[GIC-Lore] 選択肢 ${choiceNum} に対応するエントリが見つかりません`);
            if (settings.verbose) {
                entries.forEach(e => {
                    console.log(`  uid=${e.uid} comment="${e.comment}" key=${JSON.stringify(e.key)}`);
                });
            }
            return;
        }
        if (settings.verbose) {
            console.log(`[GIC-Lore] エントリ採用: uid=${entry.uid}, comment="${entry.comment || ''}"`);
        }

        // ★ テンプレートから生成用プロンプトを選択（v6 追加）
        //   'random' の場合はここで一度だけランダム選択し、
        //   img_prompt と negative_prompt が同じテンプレートから取られることを保証する
        const pickedTemplate = pickTemplateForGeneration(worldName, entry);

        let prompt = null;
        if (pickedTemplate?.img_prompt) {
            prompt = cleanPrompt(pickedTemplate.img_prompt);
            if (settings.verbose) {
                console.log(`[GIC-Lore] テンプレート ${pickedTemplate.index} の img_prompt を使用`);
            }
        }
        if (!prompt) {
            prompt = extractPromptFromEntry(entry, worldName);
        }

        let negativePrompt = null;
        if (pickedTemplate?.negative_prompt) {
            negativePrompt = cleanPrompt(pickedTemplate.negative_prompt);
            if (settings.verbose) {
                console.log(`[GIC-Lore] テンプレート ${pickedTemplate.index} の negative_prompt を使用`);
            }
        }
        if (!negativePrompt) {
            negativePrompt = extractNegativePromptFromEntry(entry, worldName);
        }

        // ★ ワイルドカード適用（v8 追加）
        //   RandomPromptWildcard が利用可能なら、プロンプト中の wildcard を
        //   ランダムに選ばれた値に置換する。
        //   ★ applyToPrompt は 1 回の呼び出し内で同じキーは同じ値になるため、
        //     "color1? hair, color1? eyes" は同じ色になる。
        try {
            if (window.RandomPromptWildcard?.applyToPrompt) {
                if (prompt) {
                    const before = prompt;
                    prompt = window.RandomPromptWildcard.applyToPrompt(prompt);
                    if (settings.verbose && prompt !== before) {
                        console.log(`[GIC-Lore] 🎲 wildcard 適用: "${before}" → "${prompt}"`);
                    }
                }
                if (negativePrompt) {
                    const beforeNeg = negativePrompt;
                    negativePrompt = window.RandomPromptWildcard.applyToPrompt(negativePrompt);
                    if (settings.verbose && negativePrompt !== beforeNeg) {
                        console.log(`[GIC-Lore] 🎲 wildcard 適用 (negative): "${beforeNeg}" → "${negativePrompt}"`);
                    }
                }
            }
        } catch (e) {
            console.warn('[GIC-Lore] wildcard 適用エラー:', e);
        }

        // ★ 解像度を取得（v5 追加 / v7: テンプレート優先）
        let resolution = pickedTemplate?.resolution || null;
        if (!resolution) {
            resolution = extractResolutionFromEntry(entry, worldName);
        }
        if (settings.verbose && resolution) {
            console.log(`[GIC-Lore] 解像度: ${resolution}${pickedTemplate ? ` (template ${pickedTemplate.index})` : ''}`);
        }

        if (!prompt) {
            console.warn('[GIC-Lore] プロンプトが抽出できませんでした');
            if (settings.verbose) {
                try {
                    const ctx = getContext();
                    const lex = ctx?.extensionSettings?.lorebook_expansion?.data;
                    if (lex && lex[worldName]) {
                        const charKey = getEntryCharKey(entry, entry.uid);
                        const rec = lex[worldName][charKey];
                        console.log(`[GIC-Lore] per-world ストア[${worldName}][${charKey}] =`, rec);
                    } else {
                        console.log(`[GIC-Lore] per-world ストアに ${worldName} のエントリがありません`);
                    }
                } catch (e) { /* ignore */ }
            }
            return;
        }

        // ★ 生成コンテキストを保存（ファイル名リネーム用）
        _pendingGenerationContext = {
            entryKey: extractEntryKey(entry),
            uid: entry.uid,
            worldName,
            prompt,
            negativePrompt,
            resolution,
            templateIndex: pickedTemplate?.index ?? null,
            triggeredAt: Date.now(),
        };
        if (settings.verbose) {
            console.log(`[GIC-Lore] 生成コンテキスト設定: entryKey="${_pendingGenerationContext.entryKey}", resolution=${resolution || '(未設定)'}, templateIndex=${pickedTemplate?.index ?? '(旧データ)'}`);
        }

        // ★ 画像生成開始を通知（status_indicator.js が「画像生成中…」を表示）
        try {
            window.dispatchEvent(new CustomEvent('gic-image-generation-started', {
                detail: {
                    entryKey: _pendingGenerationContext.entryKey,
                    worldName,
                    prompt,
                    negativePrompt,
                    resolution,
                    templateIndex: _pendingGenerationContext.templateIndex,
                },
            }));
        } catch (e) { /* ignore */ }

        try {
            await executeSd(prompt, negativePrompt, resolution);
        } finally {
            // ★ 画像生成終了を通知（成功・失敗にかかわらず必ず発火）
            try {
                window.dispatchEvent(new CustomEvent('gic-image-generation-ended', {
                    detail: { entryKey: _pendingGenerationContext?.entryKey },
                }));
            } catch (e) { /* ignore */ }
        }
    } catch (e) {
        console.error('[GIC-Lore] processChoice エラー:', e);
    } finally {
        processInFlight = false;
    }
}

// ===== スラッシュコマンド登録 =====
async function registerSlashCommand() {
    const { parser: Parser, command: Command } = await loadSlashModules();

    if (!Parser || typeof Parser.addCommandObject !== 'function') {
        console.warn('[GIC-Lore] SlashCommandParser が利用できません。スラッシュコマンド登録をスキップします（他の機能は動作します）');
        return;
    }

    const callbackFn = async () => {
        try { await processChoice(true); } catch (e) { console.error('[GIC-Lore] /gic-sd エラー:', e); }
        return '';
    };

    const testCallbackFn = async () => {
        try {
            console.group('[GIC-Lore] === 診断 ===');
            console.log('1) 直前ユーザーメッセージ idx:', getLastUserMessageIndex());
            console.log('   内容:', JSON.stringify(getLastUserMessageText()));
            const cn = extractChoiceNumber(getLastUserMessageText());
            console.log('2) 抽出選択肢番号:', cn);
            const wn = getCharacterWorldInfoName();
            console.log('3) ロアブック名:', wn);
            if (wn) {
                const entries = await loadWorldInfoEntries(wn);
                console.log(`4) エントリ数: ${entries.length}`);
                entries.forEach(e => {
                    console.log(`   uid=${e.uid} comment="${e.comment}" key=${JSON.stringify(e.key)}`);
                });
                if (cn) {
                    const found = findEntryByChoice(entries, cn);
                    console.log('5) 一致エントリ:', found ? `uid=${found.uid}` : 'なし');
                    if (found) {
                        console.log('6) 抽出プロンプト:', extractPromptFromEntry(found, wn));
                        console.log('6b) ネガティブプロンプト:', extractNegativePromptFromEntry(found, wn));
                        console.log('6c) 解像度:', extractResolutionFromEntry(found, wn));
                        console.log('6d) テンプレート選択:', pickTemplateForGeneration(wn, found));
                        console.log('6e) entryKey (ファイル名用):', extractEntryKey(found));
                    }
                }
                try {
                    const ctx = getContext();
                    const lex = ctx?.extensionSettings?.lorebook_expansion?.data;
                    if (lex && lex[wn]) {
                        console.log(`7) per-world ストア[${wn}]:`);
                        Object.entries(lex[wn]).forEach(([charKey, rec]) => {
                            console.log(`   charKey=${charKey}:`, rec);
                        });
                    } else {
                        console.log(`7) per-world ストアに ${wn} のエントリがありません`);
                    }
                } catch (e) {
                    console.log('7) per-world ストア読み込みエラー:', e);
                }
            }
            console.log('8) 設定:', window.GicLorebook?.getSettings?.() || '(non-public)');
            console.log('9) 保留中コンテキスト:', _pendingGenerationContext);
            console.groupEnd();
        } catch (e) {
            console.error('[GIC-Lore] 診断エラー:', e);
        }
        return '';
    };

    if (Command && typeof Command.fromProps === 'function') {
        try {
            Parser.addCommandObject(Command.fromProps({
                name: 'gic-sd',
                callback: callbackFn,
                helpString: 'ロアブックから選択肢に対応したプロンプトを読み込み、画像を生成します。',
                returns: '',
                namedArgumentList: [],
                unnamedArgumentList: [],
            }));

            Parser.addCommandObject(Command.fromProps({
                name: 'gic-test',
                callback: testCallbackFn,
                helpString: 'ロアブック連携の診断情報を出力します。',
                returns: '',
                namedArgumentList: [],
                unnamedArgumentList: [],
            }));
            console.log('[GIC-Lore] ✅ /gic-sd, /gic-test 登録完了 (fromProps)');
            return;
        } catch (e) {
            console.warn('[GIC-Lore] fromProps 登録失敗:', e);
        }
    }

    try {
        Parser.addCommandObject({
            name: 'gic-sd',
            callback: callbackFn,
            helpString: 'ロアブックから選択肢に対応したプロンプトを読み込み、画像を生成します。',
        });
        console.log('[GIC-Lore] ✅ /gic-sd 登録完了 (legacy)');
    } catch (e) {
        console.error('[GIC-Lore] 登録失敗:', e);
    }
}

// ===== イベント登録 =====
function setupListeners() {
    if (listenersInstalled) {
        console.log('[GIC-Lore] リスナーは既に登録済みのためスキップ');
        return;
    }
    if (!eventSource || !event_types) return;
    listenersInstalled = true;

    const safeOn = (evt, handler) => { if (evt && eventSource.on) eventSource.on(evt, handler); };

    safeOn(event_types.MESSAGE_RECEIVED, (messageId) => {
        try { stripGicImgFromMessage(messageId); } catch (e) { console.error(e); }
    });

    if (settings.triggerOn === 'user_send') {
        // ★ 画像生成と LLM 応答を並行実行するため、ユーザー送信直後に開始する
        safeOn(event_types.USER_MESSAGE_RENDERED, () => {
            setTimeout(() => {
                processChoice(false).catch(e => console.error('[GIC-Lore] 処理エラー:', e));
            }, 150);
        });
        console.log('[GIC-Lore] トリガー: user_send（画像生成と LLM 応答を並行実行）');
    } else {
        // 従来の ai_reply モード（フォールバック / 明示的に選択した場合）
        safeOn(event_types.CHARACTER_MESSAGE_RENDERED, () => {
            setTimeout(() => {
                try { stripGicImgFromDom(); } catch (e) { /* ignore */ }
                processChoice(false).catch(e => console.error('[GIC-Lore] 処理エラー:', e));
            }, 100);
        });
        console.log('[GIC-Lore] トリガー: ai_reply（LLM 応答完了後に画像生成）');
    }

    console.log(`[GIC-Lore] イベント登録完了 (triggerOn=${settings.triggerOn}, quiet=${settings.quiet})`);
}

// ===== 初期化 =====
async function initialize() {
    console.log('[GIC-Lore] 初期化開始');
    loadSettings();
    await registerSlashCommand();
    setupListeners();
    try { stripGicImgFromDom(); } catch (e) { /* ignore */ }
    console.log('[GIC-Lore] 初期化完了');
}

function bootstrap() {
    let started = false;
    const startOnce = () => {
        if (started) return;
        started = true;
        initialize().catch(e => console.error('[GIC-Lore] 初期化中に例外:', e));
    };

    if (eventSource && event_types && event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, startOnce);
        setTimeout(startOnce, 5000);
    } else {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startOnce);
        } else {
            startOnce();
        }
    }
}

bootstrap();

// ===== 公開 API =====
window.GicLorebook = {
    getSettings: () => ({ ...settings }),
    setSettings: (patch) => {
        settings = { ...settings, ...patch };
        saveSettings();
        console.log('[GIC-Lore] 設定更新:', settings);
    },
    processChoice,
    extractChoiceNumber,
    extractPromptFromEntry,
    extractEntryKey,
    getLexImgPrompt,
    getLexNegativePrompt,
    getLexResolution,
    getAvailableSDResolutions,
    extractNegativePromptFromEntry,
    extractResolutionFromEntry,
    pickTemplateForGeneration,
    loadWorldInfoEntries,
    findEntryByChoice,
    getEntryKeys,
    stripGicImgFromDom,
    executeSd,
    resetDedup: () => {
        lastProcessedMsgIdx = -1;
        console.log('[GIC-Lore] 重複防止状態をリセット');
    },

    // ★ 生成コンテキスト（リネーム用）
    getPendingGenerationContext: () => _pendingGenerationContext,
    clearPendingGenerationContext: () => { _pendingGenerationContext = null; },

    // ★ デバッグ用: SlashCommand モジュールの状態を確認
    diagnoseSlashModules: () => {
        return {
            parserLoaded: !!_slashParserModule,
            commandLoaded: !!_slashCommandModule,
            parserFromWindow: typeof window !== 'undefined' ? !!window.SlashCommandParser : false,
            commandFromWindow: typeof window !== 'undefined' ? !!window.SlashCommand : false,
        };
    },
};
console.log('[GIC-Lore] window.GicLorebook にAPIを公開しました');
