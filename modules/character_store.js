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
    const avatarUrl = _getCurrentAvatarUrl();
    if (!avatarUrl) {
        console.warn(`${LOG} avatar_url 取得失敗 (${namespace})`);
        return false;
    }
    try {
        const resp = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                avatar_url: avatarUrl,
                data: { extensions: { [namespace]: payload } },
            }),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            console.warn(`${LOG} merge-attributes 失敗 (${resp.status}): ${text.slice(0, 200)}`);
            return false;
        }
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
