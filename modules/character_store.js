// modules/character_store.js
//
// character.data.extensions.{namespace} への読み書きを一元化するヘルパー。
//
// 設計:
//   一次: ctx.characters[characterId].data.extensions[namespace]
//   永続: /api/characters/merge-attributes → character.json (PNG)
//
// レース対策:
//   - SAVE_DEBOUNCE_MS = 100 (旧 600 から短縮)
//   - キャラ編集画面を開くクリックで flushAll() を強制
//   - CHARACTER_EDITOR_OPENED 後に backup との差分を検査して復元

import { getContext } from '../../../../extensions.js';
import { getRequestHeaders } from '../../../../../script.js';

const LOG = '[CharStore]';
const SAVE_DEBOUNCE_MS = 100;
const SAVE_RETRY_DELAYS_MS = [0, 1000, 2000, 5000];

const _saveTimers = new Map();       // namespace → timer
const _pendingPayloads = new Map();  // namespace → payload
const _saveInFlight = new Map();     // namespace → promise
const _backup = {};                  // namespace → 最後の payload の deep copy

// ============================================================
// 内部ヘルパー
// ============================================================
function _getCtx() {
    try { return getContext(); } catch (e) { return null; }
}

function _getCurrentAvatarUrl() {
    const ctx = _getCtx();
    if (!ctx) return null;
    const id = ctx.characterId;
    if (id === undefined || id === null) return null;
    const char = ctx.characters?.[id];
    return char?.avatar || null;
}

function _updateMemory(namespace, payload) {
    const ctx = _getCtx();
    if (!ctx) return;
    const id = ctx.characterId;
    const char = ctx.characters?.[id];
    if (!char) return;

    // ① ctx.characters[characterId] を更新（一次情報源）
    if (!char.data) char.data = {};
    if (!char.data.extensions) char.data.extensions = {};
    char.data.extensions[namespace] = payload;

    // ② ctx.character が存在すれば同期（ST バージョン互換）
    if (ctx.character && ctx.character !== char) {
        if (!ctx.character.data) ctx.character.data = {};
        if (!ctx.character.data.extensions) ctx.character.data.extensions = {};
        ctx.character.data.extensions[namespace] = payload;
    }
}

async function _pushToServer(namespace, payload) {
    const ctx = _getCtx();
    if (!ctx) return false;

    const id = ctx.characterId;
    const char = ctx.characters?.[id];
    if (!char) {
        console.warn(`${LOG} 現在キャラ取得失敗 (id=${id})`);
        return false;
    }

    // avatar_url の正規化（"none" や拡張子なしを補正）
    let avatarUrl = char.avatar;
    if (!avatarUrl || avatarUrl === 'none') {
        avatarUrl = `${char.name}.png`;
        console.warn(`${LOG} avatar が異常値のため推定使用: ${avatarUrl}`);
    }
    if (!avatarUrl.match(/\.(png|webp|jpg)$/i) && !avatarUrl.includes('/')) {
        avatarUrl = `${avatarUrl}.png`;
    }

    const body = {
        avatar: avatarUrl,
        avatar_url: avatarUrl,
        ch_name: char.name,
        data: { extensions: { [namespace]: payload } },
    };

    try {
        const resp = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            console.warn(`${LOG} merge-attributes 失敗 (${resp.status}): ${text.slice(0, 300)}`);
            return false;
        }
        console.log(`${LOG} ✅ ${namespace} を character.json に保存 (avatar=${avatarUrl})`);
        return true;
    } catch (e) {
        console.warn(`${LOG} merge-attributes 例外:`, e);
        return false;
    }
}

async function _retrySave(namespace, payload, attempt = 0) {
    const ok = await _pushToServer(namespace, payload);
    if (ok) {
        console.log(`${LOG} ✅ ${namespace} を character.json に保存`);
        return true;
    }
    if (attempt >= SAVE_RETRY_DELAYS_MS.length - 1) {
        console.error(`${LOG} ${namespace} 保存 ${SAVE_RETRY_DELAYS_MS.length} 回失敗`);
        return false;
    }
    await new Promise(r => setTimeout(r, SAVE_RETRY_DELAYS_MS[attempt + 1]));
    return _retrySave(namespace, payload, attempt + 1);
}

// ============================================================
// 公開 API
// ============================================================
export function getCharacterExtension(namespace) {
    const ctx = _getCtx();
    if (!ctx) return null;
    const char = ctx.characters?.[ctx.characterId];
    const ext = char?.data?.extensions?.[namespace];
    return ext && typeof ext === 'object' ? ext : null;
}

export function getCharacterExtensionRaw() {
    const ctx = _getCtx();
    const char = ctx?.characters?.[ctx?.characterId];
    return char?.data?.extensions || {};
}

export function saveCharacterExtension(namespace, payload, options = {}) {
    const { immediate = false } = options;

    // ★ backup を更新（意図した最新値のスナップショット）
    try {
        _backup[namespace] = JSON.parse(JSON.stringify(payload));
    } catch (e) { /* ignore */ }

    _updateMemory(namespace, payload);

    // 既存タイマーをキャンセル
    if (_saveTimers.has(namespace)) {
        clearTimeout(_saveTimers.get(namespace));
        _saveTimers.delete(namespace);
    }
    _pendingPayloads.set(namespace, payload);

    const fire = () => {
        const p = _pendingPayloads.get(namespace);
        if (!p) return Promise.resolve(true);
        _pendingPayloads.delete(namespace);
        _saveTimers.delete(namespace);
        const promise = _retrySave(namespace, p);
        _saveInFlight.set(namespace, promise);
        promise.finally(() => {
            if (_saveInFlight.get(namespace) === promise) _saveInFlight.delete(namespace);
        });
        return promise;
    };

    if (immediate) return fire();

    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fire()), SAVE_DEBOUNCE_MS);
        _saveTimers.set(namespace, timer);
    });
}

export async function flushCharacterExtension(namespace) {
    const inflight = _saveInFlight.get(namespace);
    if (inflight) await inflight;
    const pending = _pendingPayloads.get(namespace);
    if (!pending) return;
    if (_saveTimers.has(namespace)) {
        clearTimeout(_saveTimers.get(namespace));
        _saveTimers.delete(namespace);
    }
    _pendingPayloads.delete(namespace);
    await _retrySave(namespace, pending);
}

export async function flushAll() {
    const namespaces = new Set([
        ..._saveTimers.keys(),
        ..._saveInFlight.keys(),
        ..._pendingPayloads.keys(),
    ]);
    await Promise.all([...namespaces].map(ns => flushCharacterExtension(ns)));
    return true;
}

// ============================================================
// ★ レース対策 1: キャラ編集画面を開くクリックをキャプチャして flush
// ============================================================
(function interceptCharacterEditorOpen() {
    if (window.__charStoreEditorOpenInstalled) return;
    window.__charStoreEditorOpenInstalled = true;

    function isEditButton(btn) {
        if (!btn) return false;
        const combined = [
            btn.id,
            btn.textContent,
            btn.title,
            btn.className,
            btn.getAttribute?.('data-i18n'),
            btn.getAttribute?.('aria-label'),
        ].filter(Boolean).join(' ').toLowerCase();
        if (/delete|remove|import|export|save/i.test(combined)) return false;
        return /edit|編集/.test(combined);
    }

    document.addEventListener('click', async (e) => {
        const btn = e.target?.closest?.('button, [role="button"], a');
        if (!btn) return;
        if (!isEditButton(btn)) return;
        if (window.__charStoreEditorOpenInFlight) return;

        const hasPending =
            _saveTimers.size > 0 ||
            _pendingPayloads.size > 0 ||
            _saveInFlight.size > 0;

        if (!hasPending) {
            console.log(`[CharStore] edit open 検出 (pending なし): id="${btn.id}"`);
            return;
        }

        window.__charStoreEditorOpenInFlight = true;
        e.preventDefault();
        e.stopImmediatePropagation();
        try {
            console.log(`[CharStore] キャラ編集画面 open 前に保存を待機... (id="${btn.id}")`);
            await flushAll();
            console.log(`[CharStore] 保存完了。キャラ編集画面を開きます`);
        } catch (err) {
            console.warn(`${CharStore} flush 失敗:`, err);
        }
        setTimeout(() => {
            window.__charStoreEditorOpenInFlight = false;
            btn.click();
        }, 30);
    }, true);
})();

// ============================================================
// ★ レース対策 2: CHARACTER_EDITOR_OPENED 後の安全網
//    ST がサーバの古い値で memory を上書きした場合に、
//    backup との差分を検出して復元する
// ============================================================
(function installEditorOpenedSync() {
    if (window.__charStoreEditorOpenedSyncInstalled) return;
    window.__charStoreEditorOpenedSyncInstalled = true;

    let installed = false;
    const tryInstall = () => {
        if (installed) return;
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!ctx?.eventSource || !ctx?.eventTypes?.CHARACTER_EDITOR_OPENED) {
            setTimeout(tryInstall, 1000);
            return;
        }
        installed = true;

        ctx.eventSource.on(ctx.eventTypes.CHARACTER_EDITOR_OPENED, () => {
            // ST 側の再構築が終わるのを少し待つ
            setTimeout(async () => {
                try {
                    const ns = 'lorebook_expansion';
                    const backup = _backup[ns];
                    if (!backup) return;

                    const ctx2 = _getCtx();
                    const char = ctx2?.characters?.[ctx2?.characterId];
                    const current = char?.data?.extensions?.[ns];
                    if (!current) return;

                    const curStr = JSON.stringify(current);
                    const bakStr = JSON.stringify(backup);
                    if (curStr === bakStr) return;

                    console.log(`${LOG} editor open 後に差分検出 → backup で復元`);
                    await saveCharacterExtension(ns, backup, { immediate: true });
                } catch (e) { /* ignore */ }
            }, 300);
        });
        console.log(`${LOG} CHARACTER_EDITOR_OPENED 同期フックを設置`);
    };
    tryInstall();
})();

// ============================================================
// 外部公開
// ============================================================
window.CharStore = {
    getCharacterExtension,
    getCharacterExtensionRaw,
    saveCharacterExtension,
    flushCharacterExtension,
    flushAll,
};

// ============================================================
// ★ 最終防衛: Blob コンストラクタをパッチして、JSON export 時に
//    _backup を強制的に data.extensions へ注入する
//    ST が characters[chid] ではなく内部スナップショットから
//    export していても、最終ファイルの中身を書き換える
// ============================================================
(function patchBlobForExport() {
    if (window.__charStoreBlobPatched) return;
    window.__charStoreBlobPatched = true;

    const OrigBlob = window.Blob;

    function tryPatchJson(text) {
        try {
            const json = JSON.parse(text);
            if (!json || typeof json !== 'object') return text;

            // キャラクターカードの構造かチェック（data.extensions がある or トップレベルに name）
            const data = json.data || json;
            if (!data || typeof data !== 'object') return text;
            if (!data.extensions) data.extensions = {};

            let injected = 0;
            const injectedNamespaces = [];
            for (const [ns, payload] of Object.entries(_backup)) {
                if (!payload) continue;
                // ST が古い値を持っていても、_backup で上書き
                data.extensions[ns] = JSON.parse(JSON.stringify(payload));
                injected++;
                injectedNamespaces.push(ns);
            }

            if (injected === 0) return text;

            console.log(`[CharStore] 🎯 export Blob に backup を注入: [${injectedNamespaces.join(', ')}]`);
            for (const ns of injectedNamespaces) {
                const ip = _backup[ns]?.['003']?.img_prompt?.slice(0, 30);
                if (ip) console.log(`  ${ns}.003: ${JSON.stringify(ip)}`);
            }

            return JSON.stringify(json, null, 4);
        } catch (e) {
            return text;
        }
    }

    window.Blob = function(parts, options) {
        try {
            const type = options?.type || '';
            // JSON export のみ対象（PNG は別途）
            if (type.includes('application/json') && Array.isArray(parts)) {
                const text = parts
                    .map(p => (typeof p === 'string' ? p : ''))
                    .join('');
                if (text && text.trim().startsWith('{')) {
                    const patched = tryPatchJson(text);
                    parts = [patched];
                }
            }
        } catch (e) {
            console.warn('[CharStore] Blob patch エラー:', e);
        }
        return new OrigBlob(parts, options);
    };
    // static メソッド/プロトタイプを継承
    Object.setPrototypeOf(window.Blob, OrigBlob);
    window.Blob.prototype = OrigBlob.prototype;

    console.log('[CharStore] 🎯 Blob パッチ（JSON export 用）をインストールしました');
})();

// ============================================================
// ★ 最終防衛: /api/characters/edit と merge-attributes の fetch を
//   傍受し、backup を強制的に注入する
//   ST が export 前に createOrEditCharacter() でフォームから
//   data.extensions を再構築して古い値で上書きするのを防ぐ
// ============================================================
(function installEditFetchInterceptor() {
    if (window.__charStoreEditFetchInstalled) return;
    window.__charStoreEditFetchInstalled = true;

    const origFetch = window.fetch;
    window.fetch = async function(input, init) {
        try {
            const url = typeof input === 'string' ? input : (input?.url || '');
            const method = (init?.method || 'GET').toUpperCase();
            if (method !== 'POST') return origFetch.apply(this, arguments);
            if (!url.includes('/api/characters/edit') &&
                !url.includes('/api/characters/merge-attributes')) {
                return origFetch.apply(this, arguments);
            }

            // body をパース
            let body = null;
            try {
                body = init?.body ? JSON.parse(init.body) : null;
            } catch (e) { body = null; }

            if (!body || typeof body !== 'object') {
                return origFetch.apply(this, arguments);
            }

            // backup を data.extensions に強制注入
            let injected = 0;
            const injectedNamespaces = [];
            for (const [ns, payload] of Object.entries(_backup)) {
                if (!payload) continue;
                if (!body.data) body.data = {};
                if (!body.data.extensions) body.data.extensions = {};
                // ST がセットした値を上書き
                body.data.extensions[ns] = JSON.parse(JSON.stringify(payload));
                injected++;
                injectedNamespaces.push(ns);
            }

            if (injected === 0) {
                return origFetch.apply(this, arguments);
            }

            // body を書き換えた新しい init を作成
            const newInit = { ...init, body: JSON.stringify(body) };

            console.log(`[CharStore] 🎯 ${url.includes('merge') ? 'merge-attributes' : 'edit'} に backup を注入: [${injectedNamespaces.join(', ')}]`);
            for (const ns of injectedNamespaces) {
                const ip = _backup[ns]?.['003']?.img_prompt?.slice(0, 30);
                if (ip) console.log(`  ${ns}.003: ${JSON.stringify(ip)}`);
            }

            const resp = await origFetch.call(this, input, newInit);

            // 成功したら memory も同期（念のため）
            if (resp.ok) {
                const ctx = _getCtx();
                const char = ctx?.characters?.[ctx?.characterId];
                if (char) {
                    for (const ns of injectedNamespaces) {
                        if (!char.data) char.data = {};
                        if (!char.data.extensions) char.data.extensions = {};
                        char.data.extensions[ns] = JSON.parse(JSON.stringify(_backup[ns]));
                    }
                }
            }

            return resp;
        } catch (e) {
            console.warn('[CharStore] edit fetch インターセプト失敗:', e);
            return origFetch.apply(this, arguments);
        }
    };
    console.log('[CharStore] 🎯 /api/characters/edit への backup 注入フックを設置');
})();

(function installCharacterEditedSync() {
    if (window.__charStoreEditedSyncInstalled) return;
    window.__charStoreEditedSyncInstalled = true;

    const tryInstall = () => {
        const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
        if (!ctx?.eventSource || !ctx?.eventTypes?.CHARACTER_EDITED) {
            setTimeout(tryInstall, 1000);
            return;
        }
        ctx.eventSource.on(ctx.eventTypes.CHARACTER_EDITED, () => {
            // 同期実行: export が characters[chid] を読む前に間に合わせる
            const char = ctx.characters?.[ctx.characterId];
            if (!char) return;
            let restored = 0;
            for (const [ns, payload] of Object.entries(_backup)) {
                if (!payload) continue;
                if (!char.data) char.data = {};
                if (!char.data.extensions) char.data.extensions = {};
                char.data.extensions[ns] = JSON.parse(JSON.stringify(payload));
                restored++;
            }
            if (restored > 0) {
                console.log(`[CharStore] 🎯 CHARACTER_EDITED 直後に memory を backup で復元 (${restored})`);
            }
        });
        console.log('[CharStore] 🎯 CHARACTER_EDITED 同期フックを設置');
    };
    tryInstall();
})();

// ============================================================
// ★ 最終防衛: export/ダウンロード系ボタン押下時に backup を強制注入
// ============================================================
(function installExportGuard() {
    if (window.__charStoreExportGuardInstalled) return;
    window.__charStoreExportGuardInstalled = true;

    // キャラクター JSON / PNG の export ボタン判定（ID/テキスト/title/class/data-i18n）
    function isExportButton(btn) {
        if (!btn) return false;
        const combined = [
            btn.id,
            btn.textContent,
            btn.title,
            btn.className,
            btn.getAttribute?.('data-i18n'),
            btn.getAttribute?.('aria-label'),
        ].filter(Boolean).join(' ').toLowerCase();

        // STJ Editor は除外（別物）
        if (/stj|_ext/.test(combined)) return false;
        if (/import|cancel|close/.test(combined)) return false;

        return /export|download|ダウンロード|エクスポート|json|\.png/.test(combined);
    }

    function restoreBackupToMemory() {
        const ctx = _getCtx();
        const char = ctx?.characters?.[ctx?.characterId];
        if (!char) return 0;
        let restored = 0;
        for (const [ns, payload] of Object.entries(_backup)) {
            if (!payload) continue;
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};
            char.data.extensions[ns] = JSON.parse(JSON.stringify(payload));
            restored++;
        }
        if (restored > 0) {
            console.log(`[CharStore] 🎯 export 直前に backup から ${restored} namespace を復元`);
            for (const ns of Object.keys(_backup)) {
                const ip = _backup[ns]?.['003']?.img_prompt?.slice(0, 30);
                if (ip) console.log(`  ${ns}.003: ${JSON.stringify(ip)}`);
            }
        }
        return restored;
    }

    // capture phase で実行（ST のハンドラより先）
    document.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('button, [role="button"], a');
        if (!btn) return;
        if (!isExportButton(btn)) return;
        console.log(`[CharStore] 🎯 export ボタン検出: id="${btn.id}" text="${(btn.textContent || '').trim().slice(0, 20)}"`);
        restoreBackupToMemory();
    }, true);

    // pointerdown/mousedown でも発火（click より早いタイミング）
    ['pointerdown', 'mousedown'].forEach(evt => {
        document.addEventListener(evt, (e) => {
            const btn = e.target?.closest?.('button, [role="button"], a');
            if (!btn) return;
            if (!isExportButton(btn)) return;
            restoreBackupToMemory();
        }, true);
    });

    console.log('[CharStore] 🎯 export 直前ガードをインストールしました');
})();

console.log(`${LOG} 公開APIを window.CharStore に登録`);
