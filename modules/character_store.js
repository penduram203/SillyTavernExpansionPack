// character_store.js
//
// character.data.extensions.{namespace} への読み書きを一元化するヘルパー。
//
// ★ 重要な設計:
//   - saveCharacterExtension 呼出時に avatar/name をキャプチャ
//     → debounce fire 時にキャラが切り替わっていても正しいキャラへ保存
//   - _backup は avatar キーで管理（キャラ間の混入を構造的に排除）
//   - export 系は document/window の capture で全イベント種を傍受

import { getContext } from '../../../../extensions.js';
import { getRequestHeaders } from '../../../../../script.js';

const LOG = '[CharStore]';
const SAVE_DEBOUNCE_MS = 100;
const SAVE_RETRY_DELAYS_MS = [0, 1000, 2000, 5000];

const _saveTimers = new Map();
const _pendingPayloads = new Map();
const _saveInFlight = new Map();
// avatarKey -> { namespace -> payload }
const _backup = {};

function _getCtx() {
    try { return getContext(); } catch (e) { return null; }
}

function _getCurrentChar() {
    const ctx = _getCtx();
    if (!ctx) return null;
    return ctx.characters?.[ctx.characterId] || null;
}

function _charKey(char) {
    if (!char) return '';
    return char.avatar || char.name || '';
}

// ---- backup ----
function _updateBackup(char, namespace, payload) {
    const key = _charKey(char);
    if (!key) return;
    if (!_backup[key]) _backup[key] = {};
    try {
        _backup[key][namespace] = JSON.parse(JSON.stringify(payload));
    } catch (e) { _backup[key][namespace] = payload; }
}

function _getBackupsForChar(char) {
    const key = _charKey(char);
    return _backup[key] || {};
}

function _getAllBackupsForCurrentChar() {
    return _getBackupsForChar(_getCurrentChar());
}

// ---- memory ----
function _updateMemory(char, namespace, payload) {
    if (!char) return;
    if (!char.data) char.data = {};
    if (!char.data.extensions) char.data.extensions = {};
    char.data.extensions[namespace] = payload;
    const ctx = _getCtx();
    if (ctx?.character && ctx.character !== char) {
        if (!ctx.character.data) ctx.character.data = {};
        if (!ctx.character.data.extensions) ctx.character.data.extensions = {};
        ctx.character.data.extensions[namespace] = payload;
    }
}

// ---- server ----
async function _pushToServer(namespace, payload, capturedAvatar, capturedName) {
    let avatarUrl = capturedAvatar || '';
    if (!avatarUrl || avatarUrl === 'none') avatarUrl = `${capturedName}.png`;
    if (!avatarUrl.match(/\.(png|webp|jpg)$/i) && !avatarUrl.includes('/')) {
        avatarUrl = `${avatarUrl}.png`;
    }
    const body = {
        avatar: avatarUrl,
        avatar_url: avatarUrl,
        ch_name: capturedName,
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
        console.log(`${LOG} ✅ ${namespace} を ${capturedName} に保存`);
        return true;
    } catch (e) {
        console.warn(`${LOG} merge-attributes 例外:`, e);
        return false;
    }
}

async function _retrySave(namespace, payload, avatar, name, attempt = 0) {
    const ok = await _pushToServer(namespace, payload, avatar, name);
    if (ok) return true;
    if (attempt >= SAVE_RETRY_DELAYS_MS.length - 1) {
        console.error(`${LOG} ${namespace} 保存 ${SAVE_RETRY_DELAYS_MS.length} 回失敗`);
        return false;
    }
    await new Promise(r => setTimeout(r, SAVE_RETRY_DELAYS_MS[attempt + 1]));
    return _retrySave(namespace, payload, avatar, name, attempt + 1);
}

// ============================================================
// 公開 API
// ============================================================
export function getCharacterExtension(namespace) {
    const char = _getCurrentChar();
    const ext = char?.data?.extensions?.[namespace];
    return ext && typeof ext === 'object' ? ext : null;
}

export function getCharacterExtensionRaw() {
    return _getCurrentChar()?.data?.extensions || {};
}

export function saveCharacterExtension(namespace, payload, options = {}) {
    const { immediate = false } = options;
    const char = _getCurrentChar();
    if (!char) {
        console.warn(`${LOG} saveCharacterExtension: 現在キャラなし`);
        return Promise.resolve(false);
    }

    // ★ 呼出時の char をキャプチャ（debounce fire 時のズレ防止）
    const capturedAvatar = char.avatar || '';
    const capturedName = char.name || '';

    _updateBackup(char, namespace, payload);
    _updateMemory(char, namespace, payload);

    if (_saveTimers.has(namespace)) {
        clearTimeout(_saveTimers.get(namespace));
        _saveTimers.delete(namespace);
    }
    _pendingPayloads.set(namespace, { payload, avatar: capturedAvatar, name: capturedName });

    const fire = () => {
        const entry = _pendingPayloads.get(namespace);
        if (!entry) return Promise.resolve(true);
        _pendingPayloads.delete(namespace);
        _saveTimers.delete(namespace);
        const promise = _retrySave(namespace, entry.payload, entry.avatar, entry.name);
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
    await _retrySave(namespace, pending.payload, pending.avatar, pending.name);
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
// キャラ切替時: _backup は avatar キーで分離済みなので保持不要
// pending のみクリア（旧キャラ宛の保留保存が新キャラに紛れないように）
// ============================================================
(function setupCharSwitchCleanup() {
    if (window.__charStoreSwitchCleanupInstalled) return;
    window.__charStoreSwitchCleanupInstalled = true;
    const tryInstall = () => {
        const ctx = _getCtx();
        if (!ctx?.eventSource || !ctx?.eventTypes) { setTimeout(tryInstall, 1000); return; }

        const clearPending = () => {
            for (const k of _pendingPayloads.keys()) _pendingPayloads.delete(k);
            for (const [k, t] of _saveTimers.entries()) { clearTimeout(t); _saveTimers.delete(k); }
            console.log('[CharStore] キャラ切替: pending をクリア');
        };

        const es = ctx.eventSource;
        const et = ctx.eventTypes;
        let installed = 0;
        if (et.CHARACTER_SELECTED && typeof es.on === 'function') {
            es.on(et.CHARACTER_SELECTED, clearPending);
            installed++;
        }
        if (et.CHAT_CHANGED && typeof es.on === 'function') {
            es.on(et.CHAT_CHANGED, () => setTimeout(clearPending, 200));
            installed++;
        }
        if (installed === 0) {
            console.warn('[CharStore] 利用可能な切替イベントが見つかりません（スキップ）');
        } else {
            console.log(`[CharStore] 🎯 キャラ切替クリーンアップフックを設置 (${installed} events)`);
        }
    };
    tryInstall();
})();

// ============================================================
// export 前ガード（memory 復元）
// ============================================================
(function installExportGuard() {
    if (window.__charStoreExportGuardInstalled) return;
    window.__charStoreExportGuardInstalled = true;

    function isExportButton(btn) {
        if (!btn) return false;
        const combined = [btn.id, btn.textContent, btn.title, btn.className,
                          btn.getAttribute?.('data-i18n')].filter(Boolean).join(' ').toLowerCase();
        if (/stj|_ext/.test(combined)) return false;
        if (/import|cancel|close/.test(combined)) return false;
        return /export|download|ダウンロード|エクスポート|json|\.png/.test(combined);
    }

    function restoreBackup() {
        const char = _getCurrentChar();
        if (!char) return 0;
        const backups = _getBackupsForChar(char);
        let restored = 0;
        for (const [ns, payload] of Object.entries(backups)) {
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};
            char.data.extensions[ns] = JSON.parse(JSON.stringify(payload));
            restored++;
        }
        if (restored > 0) console.log(`${LOG} 🎯 export 直前に ${restored} ns を復元`);
        return restored;
    }

    const trigger = (e) => {
        const btn = e.target?.closest?.('button, [role="button"], a, div[id*="export"]');
        if (!btn) return;
        if (!isExportButton(btn)) return;
        restoreBackup();
    };
    ['click', 'pointerdown', 'mousedown'].forEach(evt =>
        document.addEventListener(evt, trigger, true));
})();

// ============================================================
// ★ export_button 完全乗っ取り
//    - 全イベント種 (click/pointerdown/pointerup/mousedown/mouseup) を capture で傍受
//    - MutationObserver で button 再生成を検知
//    - window にもキャプチャを張る（ST が window capture で bind する場合対策）
// ============================================================
(function installExportButtonHijack() {
    if (window.__charStoreExportHijackInstalled) return;
    window.__charStoreExportHijackInstalled = true;

    // ---- 共通ロジック ----
    function isExportBtn(el) {
        if (!el) return false;
        return el.id === 'export_button';
    }

    // ---- JSON export ----
    function doJsonExport() {
        try {
            const char = _getCurrentChar();
            if (!char) return false;
            const backups = _getBackupsForChar(char);
            for (const [ns, payload] of Object.entries(backups)) {
                if (!char.data) char.data = {};
                if (!char.data.extensions) char.data.extensions = {};
                char.data.extensions[ns] = JSON.parse(JSON.stringify(payload));
            }
            const exportData = JSON.parse(JSON.stringify(char));
            exportData.create_date = exportData.create_date || new Date().toISOString();
            exportData.avatar_url = char.avatar || '';
            exportData.ch_name = char.name || '';
            const jsonStr = JSON.stringify(exportData, null, 4);
            const filename = `${char.name || 'character'}.json`;
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.style.display = 'none';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 2000);
            console.log(`${LOG} 🎯 自前 JSON export 完了: ${filename} (${jsonStr.length} bytes)`);
            return true;
        } catch (e) {
            console.error(`${LOG} JSON export エラー:`, e);
            return false;
        }
    }

    // ---- PNG export (chara/ccv3 チャンクパッチ) ----
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[i] = c;
        }
        return t;
    })();
    function crc32(bytes) {
        let crc = -1;
        for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
        return (crc ^ -1) >>> 0;
    }
    function makeChunk(type, data) {
        const tb = new TextEncoder().encode(type);
        const lb = new ArrayBuffer(4); new DataView(lb).setUint32(0, data.length, false);
        const ci = new Uint8Array(4 + data.length);
        ci.set(tb, 0); ci.set(data, 4);
        const cb = new ArrayBuffer(4); new DataView(cb).setUint32(0, crc32(ci), false);
        const out = new Uint8Array(12 + data.length);
        out.set(new Uint8Array(lb), 0); out.set(tb, 4); out.set(data, 8);
        out.set(new Uint8Array(cb), 8 + data.length);
        return out;
    }
    function u2b(s) { return btoa(unescape(encodeURIComponent(s))); }
    function b2u(b) { return decodeURIComponent(escape(atob(b))); }

    async function fetchAvatarPngBytes() {
        const char = _getCurrentChar();
        if (!char) return null;
        const t = Date.now();
        const c = [];
        if (char.avatar && char.avatar !== 'none') {
            c.push(`/characters/${encodeURIComponent(char.avatar)}?t=${t}`);
            c.push(`/user/characters/${encodeURIComponent(char.avatar)}?t=${t}`);
            c.push(`/user/avatars/${encodeURIComponent(char.avatar)}?t=${t}`);
        }
        if (char.name) {
            const n = `${char.name}.png`;
            c.push(`/characters/${encodeURIComponent(n)}?t=${t}`);
            c.push(`/user/characters/${encodeURIComponent(n)}?t=${t}`);
            c.push(`/user/avatars/${encodeURIComponent(n)}?t=${t}`);
        }
        for (const url of c) {
            try {
                const r = await fetch(url, { cache: 'no-store' });
                if (!r.ok) continue;
                const b = new Uint8Array(await r.arrayBuffer());
                if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) {
                    console.log(`${LOG} avatar PNG 取得: ${url}`);
                    return b;
                }
            } catch (e) {}
        }
        return null;
    }

    function patchPng(bytes) {
        const char = _getCurrentChar();
        const backups = _getBackupsForChar(char);
        if (Object.keys(backups).length === 0) {
            console.log(`${LOG} PNG: 現在キャラの backup なし → パッチスキップ`);
            return bytes;
        }
        const chunks = []; let pos = 8; const patchIdx = [];
        const KEYS = new Set(['chara', 'ccv3']);
        while (pos + 12 <= bytes.length) {
            const len = (bytes[pos] << 24) | (bytes[pos+1] << 16) | (bytes[pos+2] << 8) | bytes[pos+3];
            const type = String.fromCharCode(bytes[pos+4], bytes[pos+5], bytes[pos+6], bytes[pos+7]);
            const ds = pos + 8, de = ds + len, ce = de + 4;
            if (ce > bytes.length || len < 0) break;
            chunks.push({ type, ds, de, raw: bytes.slice(pos, ce) });
            if (type === 'tEXt') {
                const td = bytes.slice(ds, de);
                const ni = td.indexOf(0);
                if (ni > 0 && ni < 8) {
                    const k = String.fromCharCode(...td.slice(0, ni));
                    if (KEYS.has(k)) patchIdx.push({ i: chunks.length - 1, k });
                }
            }
            if (type === 'IEND') break;
            pos = ce;
        }
        if (patchIdx.length === 0) return bytes;
        const out = [...chunks];
        for (const { i, k } of patchIdx) {
            const cd = chunks[i];
            const td = bytes.slice(cd.ds, cd.de);
            const ni = td.indexOf(0);
            const b64 = String.fromCharCode(...td.slice(ni + 1));
            let json; try { json = JSON.parse(b2u(b64)); } catch (e) { continue; }
            const data = json.data || json;
            if (!data.extensions) data.extensions = {};
            let inj = 0;
            for (const [ns, p] of Object.entries(backups)) {
                data.extensions[ns] = JSON.parse(JSON.stringify(p));
                inj++;
            }
            if (inj === 0) continue;
            const nt = new TextEncoder().encode(k + '\0' + u2b(JSON.stringify(json)));
            out[i] = { type: 'tEXt', raw: makeChunk('tEXt', nt) };
            console.log(`${LOG} 🎯 PNG ${k} パッチ (${inj} ns)`);
        }
        const total = 8 + out.reduce((s, c) => s + c.raw.length, 0);
        const res = new Uint8Array(total);
        res.set(bytes.slice(0, 8), 0);
        let off = 8;
        for (const c of out) { res.set(c.raw, off); off += c.raw.length; }
        return res;
    }

    async function doPngExport() {
        const char = _getCurrentChar();
        if (!char) return false;
        console.log(`${LOG} 🎯 自前 PNG export 開始`);
        const bytes = await fetchAvatarPngBytes();
        if (!bytes) { console.warn(`${LOG} PNG: avatar 取得失敗`); return false; }
        const patched = patchPng(bytes);
        const blob = new Blob([patched], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${char.name || 'character'}.png`; a.style.display = 'none';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 5000);
        console.log(`${LOG} 🎯 PNG export 完了: ${patched.length} bytes`);
        return true;
    }

    // ---- ハンドラ: click のみ実行、他の種は事前阻止 ----
    function handler(e) {
        const target = e.target?.closest?.('#export_button, button, [role="button"]');
        if (!target || !isExportBtn(target)) return;

        if (e.type === 'click') {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.shiftKey) {
                doJsonExport();
            } else {
                doPngExport().then(ok => {
                    if (!ok) {
                        console.log(`${LOG} PNG 不可 → JSON にフォールバック`);
                        doJsonExport();
                    }
                });
            }
            return;
        }
        // pointerdown/up, mousedown/up は ST のハンドラ発火を阻止するだけ
        e.stopImmediatePropagation();
    }

    ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup'].forEach(t => {
        document.addEventListener(t, handler, true);
        try { window.addEventListener(t, handler, true); } catch (e) {}
    });

    console.log(`${LOG} 🎯 export_button 完全乗っ取り完了 (click=PNG / Shift+click=JSON)`);
})();

// ============================================================
// Blob パッチ（ST 内部の JSON 生成対策・保険）
// ============================================================
(function patchBlobForExport() {
    if (window.__charStoreBlobPatched) return;
    window.__charStoreBlobPatched = true;
    const OrigBlob = window.Blob;
    function tryPatch(text) {
        try {
            const json = JSON.parse(text);
            if (!json || typeof json !== 'object') return text;
            const data = json.data || json;
            if (!data) return text;
            if (!data.extensions) data.extensions = {};
            const backups = _getAllBackupsForCurrentChar();
            let inj = 0;
            for (const [ns, p] of Object.entries(backups)) {
                data.extensions[ns] = JSON.parse(JSON.stringify(p));
                inj++;
            }
            if (inj === 0) return text;
            return JSON.stringify(json, null, 4);
        } catch (e) { return text; }
    }
    window.Blob = function(parts, options) {
        try {
            const type = options?.type || '';
            if (type.includes('application/json') && Array.isArray(parts)) {
                const text = parts.map(p => (typeof p === 'string' ? p : '')).join('');
                if (text && text.trim().startsWith('{')) parts = [tryPatch(text)];
            }
        } catch (e) {}
        return new OrigBlob(parts, options);
    };
    Object.setPrototypeOf(window.Blob, OrigBlob);
    window.Blob.prototype = OrigBlob.prototype;
    console.log(`${LOG} 🎯 Blob パッチをインストール`);
})();

// ============================================================
// /api/characters/edit への注入（キャプチャ済み avatar で送信）
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
            if (!url.includes('/api/characters/edit') && !url.includes('/api/characters/merge-attributes')) {
                return origFetch.apply(this, arguments);
            }
            let body = null;
            try { body = init?.body ? JSON.parse(init.body) : null; } catch (e) { body = null; }
            if (!body || typeof body !== 'object') return origFetch.apply(this, arguments);

            // ★ body が要求する avatar/name と一致する backup のみ注入
            const bodyAvatar = body.avatar_url || body.avatar || '';
            const bodyName = body.ch_name || '';
            const matchKey = (bodyAvatar && bodyAvatar !== 'none') ? bodyAvatar : `${bodyName}.png`;
            const backups = _backup[matchKey] || {};
            let inj = 0;
            for (const [ns, p] of Object.entries(backups)) {
                if (!body.data) body.data = {};
                if (!body.data.extensions) body.data.extensions = {};
                body.data.extensions[ns] = JSON.parse(JSON.stringify(p));
                inj++;
            }
            if (inj === 0) return origFetch.apply(this, arguments);
            console.log(`${LOG} 🎯 ${url.includes('merge') ? 'merge' : 'edit'} に backup 注入 (${inj} ns, key=${matchKey})`);
            return await origFetch.call(this, input, { ...init, body: JSON.stringify(body) });
        } catch (e) {
            return origFetch.apply(this, arguments);
        }
    };
    console.log(`${LOG} 🎯 edit fetch インターセプタを設置`);
})();

// ============================================================
// CHARACTER_EDITED 同期は撤去（キャラ切替との競合で誤注入の原因になるため）
// memory 同期は export ガード + fetch interceptor で十分カバーされる
// ============================================================

// ============================================================
// 外部公開
// ============================================================
window.CharStore = {
    getCharacterExtension,
    getCharacterExtensionRaw,
    saveCharacterExtension,
    flushCharacterExtension,
    flushAll,
    _dumpBackup: () => {
        const out = {};
        for (const [key, ns] of Object.entries(_backup)) {
            out[key] = Object.fromEntries(Object.entries(ns).map(([k, v]) => [k, `[${Object.keys(v || {}).length} keys]`]));
        }
        return out;
    },
};
console.log(`${LOG} 公開APIを window.CharStore に登録`);
