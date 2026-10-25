// modules/character_store.js
import { getContext } from '../../../../extensions.js';
import { getRequestHeaders } from '../../../../../script.js';

const LOG = '[CharStore]';
const SAVE_DEBOUNCE_MS = 600;
const SAVE_RETRY_DELAYS_MS = [0, 1000, 2000, 5000];

const _saveTimers = new Map();       // namespace → timer
const _pendingPayloads = new Map();  // namespace → payload
const _saveInFlight = new Map();     // namespace → promise

function _getCtx() {
    try { return getContext(); } catch (e) { return null; }
}

function _getCurrentAvatarUrl() {
    const ctx = _getCtx();
    if (!ctx) return null;
    const id = ctx.characterId;
    if (id === undefined || id === null) return null;
    const char = ctx.characters?.[id];
    return char?.avatar || null;   // 例: "アリス.png" または "sub/アリス.png"
}

export function getCharacterExtension(namespace) {
    const ctx = _getCtx();
    const ext = ctx?.character?.data?.extensions?.[namespace];
    return ext && typeof ext === 'object' ? ext : null;
}

export function getCharacterExtensionRaw() {
    return _getCtx()?.character?.data?.extensions || {};
}

function _updateMemory(namespace, payload) {
    const ctx = _getCtx();
    if (!ctx?.character) return;
    if (!ctx.character.data) ctx.character.data = {};
    if (!ctx.character.data.extensions) ctx.character.data.extensions = {};
    ctx.character.data.extensions[namespace] = payload;
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

    // ★ 修正点: avatar と avatar_url の両方を送る
    const body = {
        avatar: avatarUrl,           // ← これが本命（サーバーが参照）
        avatar_url: avatarUrl,       // ← 旧バージョン互換・保険
        ch_name: char.name,
        data: { extensions: { [namespace]: payload } },
    };

    console.log(`${LOG} merge-attributes 送信:`, {
        avatar: body.avatar,
        avatar_url: body.avatar_url,
        ch_name: body.ch_name,
        payloadSize: JSON.stringify(payload).length,
    });

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
        console.log(`${LOG} ✅ ${namespace} を character.json に保存 (avatar=${body.avatar})`);
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

export function saveCharacterExtension(namespace, payload, options = {}) {
    const { immediate = false } = options;

    _updateMemory(namespace, payload);

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

// 他モジュールから参照する公開 API
window.CharStore = {
    getCharacterExtension,
    getCharacterExtensionRaw,
    saveCharacterExtension,
    flushCharacterExtension,
};
console.log(`${LOG} 公開APIを window.CharStore に登録`);
