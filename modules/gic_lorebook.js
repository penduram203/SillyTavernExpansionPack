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

// ===== エントリキー決定 =====
function getEntryCharKey(entry, uid) {
    if (entry && typeof entry.comment === 'string' && entry.comment.trim()) {
        return entry.comment.trim();
    }
    const keys = getEntryKeys(entry);
    if (keys.length > 0 && String(keys[0]).trim()) {
        return String(keys[0]).trim();
    }
    return uid !== null && uid !== undefined ? String(uid) : null;
}

// ============================================================
// ★ Phase 5: LEX データから img_prompt を取得
//   一次: extension_settings.lorebook_expansion.data[worldName][charKey]
//   二次: character.data.extensions.lorebook_expansion
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
            if (rec && typeof rec === 'object' &&
                typeof rec.img_prompt === 'string' && rec.img_prompt.trim()) {
                if (settings.verbose) {
                    console.log(`[GIC-Lore] per-world store から img_prompt 読込 (${worldName}::${charKey})`);
                }
                return cleanPrompt(rec.img_prompt);
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
            if (rec && typeof rec.img_prompt === 'string' && rec.img_prompt.trim()) {
                if (settings.verbose) {
                    console.log(`[GIC-Lore] character.data から img_prompt 読込 (フォールバック)`);
                }
                return cleanPrompt(rec.img_prompt);
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
// ★ ネガティブプロンプトの取得（v4 追加）
//    per-world ストア → character.data の順で参照
// ============================================================
function getLexNegativePrompt(worldName, uid, entry) {
    if (!worldName || uid === null || uid === undefined) return null;

    // ① LorebookExpansion.getDataFor 経由（推奨）
    if (window.LorebookExpansion?.getDataFor) {
        try {
            const data = window.LorebookExpansion.getDataFor(worldName, uid, entry);
            if (data && typeof data.negative_prompt === 'string' && data.negative_prompt.trim()) {
                return cleanPrompt(data.negative_prompt);
            }
        } catch (e) { /* ignore */ }
    }

    // ② extensionSettings を直接参照（フォールバック）
    try {
        const ctx = getContext();
        const charKey = getEntryCharKey(entry, uid);
        if (!charKey) return null;
        const rec = ctx?.extensionSettings?.lorebook_expansion?.data?.[worldName]?.[charKey];
        if (rec && typeof rec.negative_prompt === 'string' && rec.negative_prompt.trim()) {
            return cleanPrompt(rec.negative_prompt);
        }
    } catch (e) { /* ignore */ }

    return null;
}

function extractNegativePromptFromEntry(entry, worldName) {
    if (!entry) return null;
    return getLexNegativePrompt(worldName, entry.uid, entry);
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
async function loadWorldInfoEntries(worldName) {
    if (!worldName) return [];

    try {
        if (typeof window.world_info !== 'undefined' && window.world_info[worldName]) {
            const wi = window.world_info[worldName];
            if (wi.entries) return Object.values(wi.entries);
        }
    } catch (e) { /* ignore */ }

    try {
        const mod = await import('../../../../world-info.js');
        if (mod.world_info && mod.world_info[worldName] && mod.world_info[worldName].entries) {
            return Object.values(mod.world_info[worldName].entries);
        }
    } catch (e) { /* ignore */ }

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const resp = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: worldName }),
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data && data.entries) return Object.values(data.entries);
            }
        } catch (e) {
            if (settings.verbose) {
                console.debug(`[GIC-Lore] /api/worldinfo/get 試行 ${attempt}/3 失敗: ${e.message || e}`);
            }
        }
        if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
    }

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
async function executeSd(prompt, negativePrompt = null) {
    const rawPrompt = cleanPrompt(prompt).replace(/[\r\n]+/g, ' ');
    const escaped = rawPrompt.replace(/"/g, '\\"');

    const hasNeg = negativePrompt && negativePrompt.trim();
    const cleanNeg = hasNeg ? cleanPrompt(negativePrompt).replace(/[\r\n]+/g, ' ') : '';

    // ★ SillyTavern の SD 拡張は negative_prompt を「名前付き引数」では受け付けない。
    //    代わりに extensionSettings.sd.negative_prompt を直接読み取って
    //    ComfyUI ワークフローの {{negative_prompt}} に流し込む仕様。
    //    → 生成直前に一時的に設定を差し替え、生成完了後に元に戻す。
    let ctx = null;
    let originalNegPrompt = null;
    let settingsModified = false;

    if (hasNeg) {
        try {
            ctx = getContext();
            const sdSettings = ctx?.extensionSettings?.sd;
            if (sdSettings && typeof sdSettings.negative_prompt === 'string') {
                originalNegPrompt = sdSettings.negative_prompt;
                sdSettings.negative_prompt = cleanNeg;
                settingsModified = true;
                console.log(`[GIC-Lore] 🔧 SDネガティブプロンプトを一時設定: "${cleanNeg.slice(0, 100)}${cleanNeg.length > 100 ? '...' : ''}"`);
            } else {
                console.warn('[GIC-Lore] SD設定に negative_prompt が見つかりません（SD拡張未初期化の可能性）');
            }
        } catch (e) {
            console.warn('[GIC-Lore] SDネガティブプロンプト設定エラー:', e);
        }
    }

    // ★ コマンドは quiet のみ（negative_prompt は設定経由で渡る）
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
        // ★ SD設定のネガティブプロンプトを元に戻す
        if (settingsModified && ctx?.extensionSettings?.sd) {
            ctx.extensionSettings.sd.negative_prompt = originalNegPrompt;
            console.log(`[GIC-Lore] 🔧 SDネガティブプロンプトを復元: "${(originalNegPrompt || '').slice(0, 100)}${(originalNegPrompt || '').length > 100 ? '...' : ''}"`);
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

        const prompt = extractPromptFromEntry(entry, worldName);
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

        // ★ ネガティブプロンプトを取得（v4 追加）
        const negativePrompt = extractNegativePromptFromEntry(entry, worldName);
        if (settings.verbose && negativePrompt) {
            console.log(`[GIC-Lore] ネガティブプロンプト: ${negativePrompt.slice(0, 80)}${negativePrompt.length > 80 ? '...' : ''}`);
        }

        // ★ 生成コンテキストを保存（ファイル名リネーム用）
        _pendingGenerationContext = {
            entryKey: extractEntryKey(entry),
            uid: entry.uid,
            worldName,
            prompt,
            negativePrompt,
            triggeredAt: Date.now(),
        };
        if (settings.verbose) {
            console.log(`[GIC-Lore] 生成コンテキスト設定: entryKey="${_pendingGenerationContext.entryKey}"`);
        }

        // ★ 画像生成開始を通知（status_indicator.js が「画像生成中…」を表示）
        try {
            window.dispatchEvent(new CustomEvent('gic-image-generation-started', {
                detail: {
                    entryKey: _pendingGenerationContext.entryKey,
                    worldName,
                    prompt,
                    negativePrompt,
                },
            }));
        } catch (e) { /* ignore */ }

        try {
            await executeSd(prompt, negativePrompt);
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
                        console.log('6c) entryKey (ファイル名用):', extractEntryKey(found));
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
    getLexNegativePrompt,                  // ★ v4 追加
    extractNegativePromptFromEntry,        // ★ v4 追加
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
