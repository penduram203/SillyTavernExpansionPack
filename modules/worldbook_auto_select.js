// worldbook_auto_select.js
// キャラクター切替時に、キャラに関連付けられたロアブックを自動選択する。
// ロアブックが存在しない場合はキャラ名と同じロアブックを自動作成し、
// キャラクターとバインド（char.data.extensions.world）する。
//
// ★ v8.5:
//   comment→key 自動同期を「保存層（fetch インターセプタ）」で確実に行う。
//   パネル閉時は textarea[name="key"] が DOM から消えるため、内部データ
//   更新だけでは ST 自身の debounce saveWorldInfo に負ける。
//   そこで /api/worldinfo/edit の payload を捕捉し、
//   「直近に comment が編集された uid」の key を comment から自動補完する。
//   これにより、ST がいつ saveWorldInfo を呼んでも正しい key が送られる。
//
// ★ v8.4〜v8: soft-refresh 方式（リロード不要）。

console.log('[WBAutoSelect] 📦 v8.5 module loading (comment→key via edit payload interceptor)...');

(function () {
    'use strict';
    const LOG = '[WBAutoSelect]';
    const SETTINGS_KEY = 'worldbook_auto_select';

    const DEBOUNCE_MS = 300;
    const RETRY_AFTER_FAILURE_MS = 1500;
    const FIND_RETRY_MAX = 5;
    const FIND_RETRY_DELAY_MS = 300;
    const VERIFY_RETRY_MAX = 6;
    const VERIFY_RETRY_DELAY_MS = 300;
    const APPLY_DELAY_MS = 500;
    const EMPTY_SAVE_GUARD_MS = 30000;
    const HEAL_MAX_ATTEMPTS = 3;
    const EDITOR_RENDER_WAIT_TRIES = 10;
    const EDITOR_RENDER_WAIT_MS = 250;
    const LIST_SYNC_RETRY_MAX = 5;

    const NEW_ENTRY_WATCH_MS = 8000;
    const NEW_ENTRY_POLL_MS = 150;
    const NEW_ENTRY_APPLY_RETRY_MAX = 12;
    const NEW_ENTRY_APPLY_RETRY_MS = 150;
    const NEW_ENTRY_DEPTH = 0;

    const RELOAD_DELAY_MS = 1000;
    const RELOAD_LOOP_WINDOW_MS = 60000;
    const RELOAD_MAX_PER_WINDOW = 3;
    const RELOAD_STATE_KEY = 'wbAutoSelect_reloadState';
    const RELOAD_SCROLL_KEY = 'wbAutoSelect_scroll';
    const RELOAD_COUNT_KEY = 'wbAutoSelect_reloadCount';

    const PANEL_SYNC_DELAY_MS = 200;
    const COMMENT_SYNC_SAVE_DEBOUNCE_MS = 300;
    // ★ v8.5: 直近編集された uid を保持する期間
    const RECENT_EDIT_TTL_MS = 10000;

    const COMMON_RULE_NAME = '00_共通ルール';
    const COMMON_RULE_CONTENT =
        '【絶対厳守ルール】\n' +
        '1. プレイヤーが入力した番号に対応する場面を描写する。\n' +
        '2. {{char}}の台詞を日本のラノベ風にした上で、{{char}}の台詞だけで状況や心情を説明する\n' +
        '3. 地の文を絶対に使わない\n' +
        '3. {{user}}の台詞や独白を描写しない\n' +
        '4. 描写の長さは必ず 約400文字 とすること。100文字や200文字といった短い本文は絶対禁止。\n' +
        '5. 情景・人物の動き・心情・五感・会話を丁寧に書き、短くまとめてはいけない。\n' +
        '6. 描写本文を書いたら、必ず空行を2行入れる。';

    const DEFAULT_SETTINGS = {
        lastResortReload: false,
        newEntryDefaults: true,
        commentToKeySync: true,
    };

    let settings = { ...DEFAULT_SETTINGS };
    let _generationToken = 0;
    let _scheduleTimer = null;
    let _retryTimer = null;
    let _lastProcessedChar = null;
    let _lastFailure = { char: null, at: 0 };
    const _emptySaveGuards = new Map();
    const _creating = new Map();

    let _commentSyncSaveTimer = null;

    // ★ v8.5: 直近に comment が編集された uid → { at, value } を保持
    //   fetch インターセプタで payload 補正に使う
    const _recentlyEditedUids = new Map();  // uid -> { at, commentValue }

    // ============================================================
    // 基本ヘルパー
    // ============================================================
    function getSTContext() {
        try {
            if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
                return window.SillyTavern.getContext();
            }
        } catch (e) { /* ignore */ }
        return null;
    }
    function getCurrentChar() {
        try {
            const ctx = getSTContext();
            return ctx?.characters?.[ctx?.characterId] || ctx?.character || null;
        } catch (e) { return null; }
    }
    function getCurrentCharName() {
        return getCurrentChar()?.name || null;
    }
    function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
    function getJQuery() { return window.$ || window.jQuery || null; }
    function clone(o) { return JSON.parse(JSON.stringify(o)); }

    async function getRequestHeadersSafe() {
        try {
            const mod = await import('../../../../../script.js');
            if (typeof mod.getRequestHeaders === 'function') {
                const h = mod.getRequestHeaders();
                if (h && typeof h === 'object') return h;
            }
        } catch (e) { /* ignore */ }
        try {
            const ctx = getSTContext();
            if (ctx && typeof ctx.getRequestHeaders === 'function') {
                const h = ctx.getRequestHeaders();
                if (h && typeof h === 'object') return h;
            }
        } catch (e) { /* ignore */ }
        const headers = { 'Content-Type': 'application/json' };
        try {
            const csrfMeta = document.querySelector('meta[name="csrf-token"]');
            const csrfInput = document.querySelector('#csrf_token');
            const csrf =
                csrfMeta?.getAttribute('content') ||
                csrfInput?.getAttribute('data-token') ||
                csrfInput?.value || '';
            if (csrf) headers['X-CSRF-Token'] = csrf;
        } catch (e) { /* ignore */ }
        return headers;
    }

    // ============================================================
    // 設定管理
    // ============================================================
    function _getSettings() {
        try {
            const ctx = getSTContext();
            if (ctx?.extensionSettings?.[SETTINGS_KEY]) {
                return { ...DEFAULT_SETTINGS, ...ctx.extensionSettings[SETTINGS_KEY] };
            }
        } catch (e) { /* ignore */ }
        return { ...settings };
    }
    function _saveSettings() {
        try {
            const ctx = getSTContext();
            if (!ctx?.extensionSettings) return;
            if (!ctx.extensionSettings[SETTINGS_KEY]) ctx.extensionSettings[SETTINGS_KEY] = {};
            Object.assign(ctx.extensionSettings[SETTINGS_KEY], settings);
            if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch (e) { /* ignore */ }
    }
    function loadSettings() {
        settings = _getSettings();
        console.log(`${LOG} settings loaded:`, settings);
    }

    // ============================================================
    // ST 公式 ワールドインフォ API の取得
    // ============================================================
    let _modPromise = null;
    function _loadWIModule() {
        if (!_modPromise) {
            _modPromise = import('../../../../world-info.js').catch(() => null);
        }
        return _modPromise;
    }
    async function _getWIApi() {
        const ctx = getSTContext();
        const mod = await _loadWIModule();
        const fn = (...c) => c.find(f => typeof f === 'function') || null;
        return {
            save: fn(ctx?.saveWorldInfo, mod?.saveWorldInfo),
            reloadEditor: fn(ctx?.reloadWorldInfoEditor, mod?.reloadEditor),
            updateList: fn(ctx?.updateWorldInfoList, mod?.updateWorldInfoList),
            importWI: fn(mod?.importWorldInfo),
        };
    }

    // ============================================================
    // サーバー通信
    // ============================================================
    async function fetchWorldbookFromServer(worldName) {
        if (!worldName) return null;
        try {
            const headers = await getRequestHeadersSafe();
            const resp = await fetch('/api/worldinfo/get', {
                method: 'POST', headers,
                body: JSON.stringify({ name: worldName }),
                cache: 'no-store',
            });
            if (!resp.ok) return null;
            const data = await resp.json();
            if (data?.entries && Object.keys(data.entries).length > 0) return data;
            return null;
        } catch (e) { return null; }
    }
    async function _verifyWorldbookOnServer(worldName) {
        const data = await fetchWorldbookFromServer(worldName);
        return !!(data && data.entries && Object.keys(data.entries).length > 0);
    }
    async function _waitForServerEntries(worldName, tries = VERIFY_RETRY_MAX) {
        for (let i = 0; i < tries; i++) {
            const data = await fetchWorldbookFromServer(worldName);
            if (data?.entries && Object.keys(data.entries).length > 0) return data.entries;
            await wait(VERIFY_RETRY_DELAY_MS);
        }
        return null;
    }
    async function _directEditWorldbook(name, entries) {
        try {
            const headers = await getRequestHeadersSafe();
            const resp = await fetch('/api/worldinfo/edit', {
                method: 'POST', headers,
                body: JSON.stringify({ name, data: { entries } }),
            });
            return resp.ok;
        } catch (e) { return false; }
    }

    // ============================================================
    // 空保存ガード + 削除検知 + comment→key 補正（fetch インターセプタ）
    // ============================================================
    function _protectFromEmptySave(name, entries, durationMs = EMPTY_SAVE_GUARD_MS) {
        if (!name || !entries || Object.keys(entries).length === 0) return;
        const existing = _emptySaveGuards.get(name);
        _emptySaveGuards.set(name, {
            createdAt: existing?.createdAt || Date.now(),
            until: Date.now() + durationMs,
            entries: clone(entries),
        });
    }
    function _onWorldDeleted(name) {
        if (!name) return;
        _emptySaveGuards.delete(name);
        _lastProcessedChar = null;
        _lastFailure = { char: null, at: 0 };
        console.log(`${LOG} 🗑 world deleted detected → state cleared: "${name}"`);
    }

    // ★ v8.5: 直近編集された uid の key を comment から補正
    //   ST が saveWorldInfo を debounce で呼んだ瞬間に、内部データの key が
    //   空でも、ここで payload を書き換えて正しい key を保存させる
    function _applyRecentEditsToPayload(entries) {
        if (!entries || typeof entries !== 'object') return 0;
        const now = Date.now();
        let modified = 0;

        // 期限切れエントリを削除
        for (const [uid, info] of Array.from(_recentlyEditedUids.entries())) {
            if (now - info.at > RECENT_EDIT_TTL_MS) {
                _recentlyEditedUids.delete(uid);
            }
        }

        if (_getSettings().commentToKeySync === false) return 0;
        if (_recentlyEditedUids.size === 0) return 0;

        for (const k of Object.keys(entries)) {
            const e = entries[k];
            if (!e || typeof e !== 'object') continue;
            const uidStr = String(e.uid);
            if (uidStr === 'undefined' || uidStr === 'null') continue;
            if (!_recentlyEditedUids.has(uidStr)) continue;

            const comment = String(e.comment || '');
            const newKeyArr = comment
                ? comment.split(',').map(s => s.trim()).filter(Boolean)
                : [];
            const oldKeyStr = Array.isArray(e.key) ? e.key.join(',') : '';
            const newKeyStr = newKeyArr.join(',');
            if (oldKeyStr !== newKeyStr) {
                e.key = newKeyArr;
                modified++;
                console.log(
                    `${LOG} 📝 payload補正: uid=${uidStr} key=[${newKeyStr}] (comment="${comment.slice(0, 40)}...")`
                );
            }
        }
        return modified;
    }

    (function installWorldInfoFetchInterceptor() {
        if (window.__wbAutoSelectFetchPatched) return;
        window.__wbAutoSelectFetchPatched = true;

        const originalFetch = window.fetch;
        window.__wbAutoSelectOriginalFetch = originalFetch;

        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const isEdit = url.includes('/api/worldinfo/edit');
            const isDelete = url.includes('/api/worldinfo/delete');
            if (!isEdit && !isDelete) return originalFetch.apply(this, arguments);
            if (!init || typeof init.body !== 'string') return originalFetch.apply(this, arguments);

            let body;
            try { body = JSON.parse(init.body); } catch (e) {
                return originalFetch.apply(this, arguments);
            }
            const name = body?.name;
            if (!name) return originalFetch.apply(this, arguments);

            if (isDelete) {
                const p = originalFetch.apply(this, arguments);
                p.then(r => { if (r && r.ok) _onWorldDeleted(name); }).catch(() => {});
                return p;
            }

            // ---- ★ v8.5: comment→key 補正 ----
            let payloadModified = 0;
            if (body?.data?.entries) {
                payloadModified = _applyRecentEditsToPayload(body.data.entries);
            }

            // ---- 空保存ガード ----
            const guard = _emptySaveGuards.get(name);
            let blockedByGuard = false;
            if (guard && Date.now() <= guard.until) {
                const incoming = body?.data?.entries;
                const incomingIsEmpty = !incoming
                    || (typeof incoming === 'object' && Object.keys(incoming).length === 0);
                if (incomingIsEmpty && guard.entries && Object.keys(guard.entries).length > 0) {
                    body.data = { ...(body.data || {}), entries: clone(guard.entries) };
                    blockedByGuard = true;
                    console.warn(`${LOG} 🛡️ empty save BLOCKED for "${name}" (restored from guard)`);
                } else if (!incomingIsEmpty) {
                    guard.entries = clone(incoming);
                }
            }

            // 変更があった場合のみ body を書き換えて送信
            if (payloadModified > 0 || blockedByGuard) {
                return originalFetch.call(this, input, { ...init, body: JSON.stringify(body) });
            }
            return originalFetch.apply(this, arguments);
        };
        console.log('[WBAutoSelect] 🛡️ worldinfo fetch interceptor installed (edit guard + delete hook + comment→key payload fix)');
    })();

    window.addEventListener('unhandledrejection', (e) => {
        const msg = String(e.reason?.message || e.reason?.stack || e.reason || '');
        const stBug =
            msg.includes("right-hand side of 'in' should be an object") ||
            (msg.includes("can't convert undefined to object") && msg.includes('world-info.js')) ||
            (msg.includes('getCharacterLore') && msg.includes('world-info.js')) ||
            (msg.includes('getGlobalLore') && msg.includes('world-info.js')) ||
            (msg.includes('displayWorldEntries') && msg.includes('world-info.js'));
        if (stBug) e.preventDefault();
    });

    // ============================================================
    // DOM ヘルパー
    // ============================================================
    function _findOptionValue(selectEl, name) {
        if (!selectEl || !name) return null;
        for (const opt of selectEl.options) {
            const v = (opt.value || '').trim();
            const t = (opt.textContent || '').trim();
            if (t === name) return opt.value;
            if (v === name) return opt.value;
        }
        return null;
    }
    function _hasWorldBookInDOM(name) {
        if (!name) return false;
        if (_findOptionValue(document.querySelector('#world_editor_select'), name) !== null) return true;
        if (_findOptionValue(document.querySelector('#world_info'), name) !== null) return true;
        return false;
    }
    function _removeStaleDomOption(name) {
        if (!name) return;
        for (const sel of ['#world_editor_select', '#world_info']) {
            const el = document.querySelector(sel);
            if (!el) continue;
            for (const opt of Array.from(el.options)) {
                const v = (opt.value || '').trim();
                const t = (opt.textContent || '').trim();
                if (t === name || (v === name && !/^\d+$/.test(v))) {
                    try { opt.remove(); } catch (e) { /* ignore */ }
                }
            }
        }
    }
    function _isEditorOn(name) {
        const ed = document.querySelector('#world_editor_select');
        if (!ed) return false;
        const opt = ed.options?.[ed.selectedIndex];
        if (!opt) return false;
        return (opt.textContent || '').trim() === name || (opt.value || '').trim() === name;
    }
    function _countEditorEntries() {
        const list = document.querySelector('#world_popup_entries_list');
        if (!list) return null;
        return list.querySelectorAll('.world_entry').length;
    }

    // ============================================================
    // ワールド一覧の更新
    // ============================================================
    async function refreshWorldSelects() {
        let success = false;
        try {
            const api = await _getWIApi();
            if (api.updateList) {
                await api.updateList();
                success = true;
            }
        } catch (e) { /* ignore */ }
        if (!success) {
            try {
                const ctx = getSTContext();
                if (ctx && typeof ctx.getSettings === 'function') {
                    await ctx.getSettings();
                    success = true;
                }
            } catch (e) { /* ignore */ }
        }
        return success;
    }

    async function _syncWorldListUntilVisible(name) {
        for (let i = 0; i < LIST_SYNC_RETRY_MAX; i++) {
            if (_hasWorldBookInDOM(name)) return true;
            await refreshWorldSelects();
            await wait(200);
        }
        return _hasWorldBookInDOM(name);
    }

    // ============================================================
    // エントリ生成
    // ============================================================
    function _createCommonRuleEntry(uid) {
        return {
            uid: uid, displayIndex: uid, key: [], keysecondary: [],
            comment: COMMON_RULE_NAME, content: COMMON_RULE_CONTENT,
            constant: true, vectorized: false, selective: true, selectiveLogic: 0,
            addMemo: false, order: 100, position: 4, disable: false,
            excludeRecursion: false, preventRecursion: false, delayUntilRecursion: false,
            probability: 100, useProbability: true, depth: 1, group: '',
            groupOverride: false, groupWeight: 100,
            scanDepth: null, caseSensitive: null,
            matchWholeWord: null, matchWholeWords: null, useGroupScoring: null,
            automationId: '', role: 0, sticky: 0, cooldown: 0, delay: 0,
        };
    }

    // ============================================================
    // ロアブック作成
    // ============================================================
    async function _createWorldbookIfMissing(worldName) {
        if (!worldName) return false;
        if (_creating.has(worldName)) return _creating.get(worldName);

        const promise = (async () => {
            const existing = await fetchWorldbookFromServer(worldName);
            if (existing?.entries && Object.keys(existing.entries).length > 0) {
                _protectFromEmptySave(worldName, existing.entries);
                return true;
            }

            const newEntries = { 0: _createCommonRuleEntry(0) };
            _protectFromEmptySave(worldName, newEntries);

            const api = await _getWIApi();
            let verified = null;

            if (api.save) {
                try {
                    await api.save(worldName, { entries: clone(newEntries) }, true);
                    verified = await _waitForServerEntries(worldName);
                    if (verified) console.log(`${LOG} ✅ created via saveWorldInfo: "${worldName}"`);
                } catch (e) {
                    console.warn(`${LOG} saveWorldInfo failed:`, e?.message || e);
                }
            }

            if (!verified) {
                if (await _directEditWorldbook(worldName, newEntries)) {
                    verified = await _waitForServerEntries(worldName);
                    if (verified) console.log(`${LOG} ✅ created via direct edit: "${worldName}"`);
                }
            }

            if (!verified && api.importWI) {
                try {
                    const blob = new Blob([JSON.stringify({ entries: newEntries }, null, 2)],
                        { type: 'application/json' });
                    const file = new File([blob], `${worldName}.json`, { type: 'application/json' });
                    await api.importWI(file, false);
                    verified = await _waitForServerEntries(worldName, VERIFY_RETRY_MAX + 4);
                    if (verified) console.log(`${LOG} ✅ created via importWorldInfo: "${worldName}"`);
                } catch (e) {
                    console.warn(`${LOG} importWorldInfo failed:`, e?.message || e);
                }
            }

            if (!verified) return false;

            _protectFromEmptySave(worldName, verified);
            await refreshWorldSelects();
            return true;
        })();

        _creating.set(worldName, promise);
        try { return await promise; }
        finally { _creating.delete(worldName); }
    }

    // ============================================================
    // キャラクターとのバインド
    // ============================================================
    async function _bindCharacterToWorld(char, worldName, force = false) {
        if (!char || !worldName) return false;
        if (!force && char.data?.extensions?.world === worldName) return true;
        if (!(await _verifyWorldbookOnServer(worldName))) return false;
        try {
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};
            char.data.extensions.world = worldName;
        } catch (e) { /* ignore */ }
        try {
            const avatar = char.avatar && char.avatar !== 'none' ? char.avatar : `${char.name}.png`;
            const headers = await getRequestHeadersSafe();
            const resp = await fetch('/api/characters/merge-attributes', {
                method: 'POST', headers,
                body: JSON.stringify({
                    avatar, avatar_url: avatar, ch_name: char.name,
                    data: { extensions: { world: worldName } },
                }),
            });
            return resp.ok;
        } catch (e) { return false; }
    }

    // ============================================================
    // エディタ / アクティブ選択
    // ============================================================
    async function _reloadEditor(name) {
        const api = await _getWIApi();
        if (api.reloadEditor) {
            try {
                await api.reloadEditor(name, true);
                await wait(100);
                if (_isEditorOn(name)) return true;
            } catch (e) {
                console.warn(`${LOG} reloadEditor failed:`, e?.message || e);
            }
        }
        const $ = getJQuery();
        const ed = document.querySelector('#world_editor_select');
        if (!$ || !ed) return false;
        const value = _findOptionValue(ed, name);
        if (value === null) return false;
        try {
            $(ed).val(value).trigger('change');
            return true;
        } catch (e) { return false; }
    }

    async function _setEditTarget(name) {
        if (!name) return false;
        if (!(await _verifyWorldbookOnServer(name))) return false;
        if (!_hasWorldBookInDOM(name)) await _syncWorldListUntilVisible(name);
        return _reloadEditor(name);
    }

    async function _setActive(name) {
        const $ = getJQuery();
        const wi = document.querySelector('#world_info');
        if (!$ || !wi || !name) return false;
        if (!(await _verifyWorldbookOnServer(name))) return false;
        if (_findOptionValue(wi, name) === null) await _syncWorldListUntilVisible(name);
        const value = _findOptionValue(wi, name);
        if (value === null) return false;
        try {
            if (wi.hasAttribute('multiple')) {
                $(wi).val([String(value)]).trigger('change');
            } else {
                $(wi).val(value).trigger('change');
            }
            return true;
        } catch (e) { return false; }
    }

    async function _ensureEditorShows(name) {
        const api = await _getWIApi();

        for (let attempt = 1; attempt <= HEAL_MAX_ATTEMPTS; attempt++) {
            for (let i = 0; i < EDITOR_RENDER_WAIT_TRIES; i++) {
                const n = _countEditorEntries();
                if (n === null) return true;
                if (n > 0 && _isEditorOn(name)) return true;
                await wait(EDITOR_RENDER_WAIT_MS);
            }

            console.warn(`${LOG} ⚠️ editor shows 0 entries for "${name}" → heal attempt ${attempt}/${HEAL_MAX_ATTEMPTS}`);

            const server = await fetchWorldbookFromServer(name);
            if (!server?.entries) {
                console.warn(`${LOG} heal: server has no entries for "${name}"`);
                return false;
            }
            _protectFromEmptySave(name, server.entries);

            if (api.save) {
                try {
                    await api.save(name, { entries: clone(server.entries) }, true);
                } catch (e) {
                    console.warn(`${LOG} heal: saveWorldInfo failed:`, e?.message || e);
                }
            }
            await refreshWorldSelects();
            await _reloadEditor(name);
        }

        const n = _countEditorEntries();
        return n === null || n > 0;
    }

    // ============================================================
    // 新規エントリ初期値
    // ============================================================
    let _newEntryWatch = null;
    const _appliedNewEntryUids = new Set();

    function _getEntryElements() {
        return Array.from(document.querySelectorAll('.world_entry[uid]'));
    }
    function _snapshotEntryUids() {
        const set = new Set();
        let max = -1;
        for (const el of _getEntryElements()) {
            const uid = String(el.getAttribute('uid'));
            set.add(uid);
            if (/^\d+$/.test(uid)) max = Math.max(max, Number(uid));
        }
        return { set, max };
    }

    function _triggerInput(el) {
        const $ = getJQuery();
        try {
            if ($) $(el).trigger('input');
            else el.dispatchEvent(new Event('input', { bubbles: true }));
        } catch (e) {
            try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) { /* ignore */ }
        }
    }
    function _triggerInputAndChange(el) {
        const $ = getJQuery();
        try {
            if ($) {
                $(el).trigger('input');
                $(el).trigger('change');
            } else {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (e) {
            try {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (e2) { /* ignore */ }
        }
    }

    function _applyNewEntryDefaults(entryEl) {
        if (!entryEl) return false;

        const posSel = entryEl.querySelector('select[name="position"]');
        if (!posSel) return false;

        let posIdx = -1;
        const opts = Array.from(posSel.options);
        const depthOpts = opts
            .map((o, i) => ({ o, i }))
            .filter(x => String(x.o.value) === '4');
        if (depthOpts.length > 0) {
            const sys = depthOpts.find(x => {
                const r = x.o.getAttribute('data-role');
                return r === '0' || r === 'system';
            });
            posIdx = (sys || depthOpts[0]).i;
        } else {
            const byText = opts.findIndex(o => /@D|depth/i.test(o.textContent || ''));
            if (byText >= 0) posIdx = byText;
        }
        if (posIdx < 0) return false;

        posSel.selectedIndex = posIdx;
        _triggerInput(posSel);

        const roleSel = entryEl.querySelector('select[name="role"], select[name="entryRole"]');
        if (roleSel) {
            const sysIdx = Array.from(roleSel.options).findIndex(o => String(o.value) === '0');
            if (sysIdx >= 0) {
                roleSel.selectedIndex = sysIdx;
                _triggerInput(roleSel);
            }
        }

        const depthInput = entryEl.querySelector('input[name="depth"]');
        if (depthInput) {
            depthInput.value = String(NEW_ENTRY_DEPTH);
            _triggerInput(depthInput);
        }

        const stateSel = entryEl.querySelector('select[name="entryStateSelector"]');
        if (stateSel) {
            let idx = Array.from(stateSel.options).findIndex(o => String(o.value) === 'normal');
            if (idx < 0) {
                idx = Array.from(stateSel.options).findIndex(o => /normal/i.test(o.textContent || ''));
            }
            if (idx >= 0) {
                stateSel.selectedIndex = idx;
                _triggerInput(stateSel);
            }
        } else {
            for (const nm of ['constant', 'vectorized']) {
                const cb = entryEl.querySelector(`input[name="${nm}"]`);
                if (cb && cb.checked) {
                    cb.checked = false;
                    _triggerInput(cb);
                    try { cb.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* ignore */ }
                }
            }
        }

        return true;
    }

    async function _applyNewEntryDefaultsWithRetry(uid) {
        for (let i = 0; i < NEW_ENTRY_APPLY_RETRY_MAX; i++) {
            const el = document.querySelector(`.world_entry[uid="${CSS.escape(String(uid))}"]`);
            if (el && _applyNewEntryDefaults(el)) {
                console.log(`${LOG} 🆕 new entry defaults applied: uid=${uid} (Normal / @D system / depth=${NEW_ENTRY_DEPTH})`);
                return true;
            }
            await wait(NEW_ENTRY_APPLY_RETRY_MS);
        }
        console.warn(`${LOG} new entry defaults: could not apply to uid=${uid}`);
        return false;
    }

    function _stopNewEntryWatch() {
        if (_newEntryWatch?.timer) clearInterval(_newEntryWatch.timer);
        _newEntryWatch = null;
    }

    function _startNewEntryWatch() {
        if (_getSettings().newEntryDefaults === false) return;
        if (_creating.size > 0) return;

        _stopNewEntryWatch();
        const snap = _snapshotEntryUids();
        const watch = {
            startedAt: Date.now(),
            knownUids: snap.set,
            maxKnown: snap.max,
            timer: null,
            busy: false,
        };
        _newEntryWatch = watch;

        watch.timer = setInterval(async () => {
            if (_newEntryWatch !== watch) { clearInterval(watch.timer); return; }
            if (Date.now() - watch.startedAt > NEW_ENTRY_WATCH_MS) { _stopNewEntryWatch(); return; }
            if (watch.busy) return;

            let candidate = null;
            for (const el of _getEntryElements()) {
                const uid = String(el.getAttribute('uid'));
                if (watch.knownUids.has(uid) || _appliedNewEntryUids.has(uid)) continue;
                if (/^\d+$/.test(uid)) {
                    const n = Number(uid);
                    if (n <= watch.maxKnown) continue;
                    if (!candidate || n > candidate.n) candidate = { uid, n };
                } else if (!candidate) {
                    candidate = { uid, n: -1 };
                }
            }
            if (!candidate) return;

            watch.busy = true;
            _appliedNewEntryUids.add(candidate.uid);
            try {
                await _applyNewEntryDefaultsWithRetry(candidate.uid);
            } finally {
                _stopNewEntryWatch();
            }
        }, NEW_ENTRY_POLL_MS);
    }

    function installNewEntryDefaults() {
        if (window.__wbAutoSelectNewEntryInstalled) return;
        window.__wbAutoSelectNewEntryInstalled = true;

        document.addEventListener('click', (e) => {
            const btn = e.target?.closest?.('#world_popup_new');
            if (!btn) return;
            _startNewEntryWatch();
        }, true);

        console.log(`${LOG} 🆕 new-entry defaults installed (Normal / @D system / depth=${NEW_ENTRY_DEPTH})`);
    }

    // ============================================================
    // ★ v8.5: comment→key 自動同期
    // ============================================================
    let _commentToKeyInstalled = false;

    function _getCurrentEditorWorldName() {
        const ed = document.querySelector('#world_editor_select');
        if (ed) {
            const opt = ed.options?.[ed.selectedIndex];
            if (opt) {
                const t = (opt.textContent || '').trim();
                const v = (opt.value || '').trim();
                if (t && t !== '--- Pick to Edit ---' && t !== '--- 編集するものを選択 ---') return t;
                if (v && !/^\d+$/.test(v)) return v;
            }
        }
        const wi = document.querySelector('#world_info');
        if (wi) {
            const opt = wi.options?.[wi.selectedIndex];
            if (opt) {
                const t = (opt.textContent || '').trim();
                const v = (opt.value || '').trim();
                if (t && t !== '--- Pick to Edit ---') return t;
                if (v && !/^\d+$/.test(v)) return v;
            }
        }
        const char = getCurrentChar();
        if (char?.data?.extensions?.world) return char.data.extensions.world;
        return null;
    }

    function _getSTEntry(worldName, uid) {
        const candidates = [];
        try {
            const ctx = getSTContext();
            if (ctx?.world_info) candidates.push(ctx.world_info);
        } catch (e) { /* ignore */ }
        try {
            if (window.world_info) candidates.push(window.world_info);
        } catch (e) { /* ignore */ }

        for (const wi of candidates) {
            if (!wi || typeof wi !== 'object') continue;
            const entries = wi[worldName]?.entries;
            if (!entries) continue;
            const direct = entries[uid] || entries[Number(uid)];
            if (direct) return direct;
            for (const k of Object.keys(entries)) {
                const e = entries[k];
                if (e && String(e.uid) === String(uid)) return e;
            }
        }
        return null;
    }

    function _updateCommentAndKeyInSTData(uid, rawText) {
        const worldName = _getCurrentEditorWorldName();
        if (!worldName) return false;
        const target = _getSTEntry(worldName, uid);
        if (!target) return false;

        const newKeyArr = rawText
            ? rawText.split(',').map(s => s.trim()).filter(Boolean)
            : [];
        target.key = newKeyArr;
        target.comment = rawText;
        return true;
    }

    // ★ v8.5: 直近編集の記録（fetch インターセプタの payload 補正で使う）
    function _recordRecentEdit(uid, commentValue) {
        _recentlyEditedUids.set(String(uid), {
            at: Date.now(),
            commentValue: String(commentValue || ''),
        });
    }

    // 現在のエディタ world を明示的に saveWorldInfo で保存
    async function _saveCurrentEditorWorld() {
        const worldName = _getCurrentEditorWorldName();
        if (!worldName) {
            console.warn(`${LOG} _saveCurrentEditorWorld: no world name`);
            return false;
        }
        const ctx = getSTContext();
        const worldData = ctx?.world_info?.[worldName] || window.world_info?.[worldName];
        if (!worldData?.entries) {
            console.warn(`${LOG} _saveCurrentEditorWorld: no entries for "${worldName}"`);
            return false;
        }

        // payload 補正を経由して保存
        const api = await _getWIApi();
        if (api.save) {
            try {
                await api.save(worldName, { entries: clone(worldData.entries) }, true);
                console.log(`${LOG} 💾 saveWorldInfo via API: "${worldName}"`);
                return true;
            } catch (e) {
                console.warn(`${LOG} saveWorldInfo (comment→key) failed:`, e?.message || e);
            }
        } else {
            console.warn(`${LOG} _saveCurrentEditorWorld: api.save not available, trying direct edit`);
            return await _directEditWorldbook(worldName, clone(worldData.entries));
        }
        return false;
    }

    // comment → key 同期（メイン）
    function _syncCommentToKey(entryEl, uid, newValue) {
        // ① 直近編集の記録（payload 補正のトリガー）
        _recordRecentEdit(uid, newValue);

        // ② 内部データ更新
        const dataUpdated = _updateCommentAndKeyInSTData(uid, newValue);

        // ③ DOM の key textarea があれば視覚反映（パネル開時）
        let domUpdated = false;
        if (entryEl) {
            const keyEl = entryEl.querySelector('textarea[name="key"]');
            if (keyEl && keyEl.value !== newValue) {
                keyEl.value = newValue;
                _triggerInputAndChange(keyEl);
                domUpdated = true;
            }
        }

        // ④ ST の saveWorldInfo より前に payload 補正を効かせるため、
        //    明示 save はせず ST の debounce save に任せる（payload が補正される）
        //    ただし、ST が save を発火しないケースの保険として、
        //    300ms 後に保存確認する（既に保存済みなら no-op）
        if (_commentSyncSaveTimer) clearTimeout(_commentSyncSaveTimer);
        _commentSyncSaveTimer = setTimeout(async () => {
            _commentSyncSaveTimer = null;
            // サーバー上の値を確認
            const worldName = _getCurrentEditorWorldName();
            if (!worldName) return;
            const server = await fetchWorldbookFromServer(worldName);
            if (!server?.entries) return;
            const entry = _getSTEntry(worldName, uid);
            if (!entry) return;
            const serverUid = Object.values(server.entries).find(e => String(e.uid) === String(uid));
            if (!serverUid) return;
            const serverKeyStr = Array.isArray(serverUid.key) ? serverUid.key.join(',') : '';
            const expectKeyStr = String(newValue || '');
            if (serverKeyStr !== expectKeyStr) {
                console.warn(
                    `${LOG} ⚠️ key not persisted yet for uid=${uid} ` +
                    `(server="${serverKeyStr}", expected="${expectKeyStr}") → force save`
                );
                await _saveCurrentEditorWorld();
            }
        }, COMMENT_SYNC_SAVE_DEBOUNCE_MS);

        return dataUpdated || domUpdated;
    }

    function _resyncKeyUIToComment(entryEl, uid) {
        if (!entryEl) return false;
        const keyEl = entryEl.querySelector('textarea[name="key"]');
        if (!keyEl) return false;
        const commentEl = entryEl.querySelector('textarea[name="comment"]');
        if (!commentEl) return false;
        if (keyEl.value === commentEl.value) return false;

        const worldName = _getCurrentEditorWorldName();
        if (!worldName) return false;
        const target = _getSTEntry(worldName, uid);
        if (!target) return false;
        const dataKeyStr = Array.isArray(target.key)
            ? target.key.join(',')
            : String(target.key || '');
        const dataCmt = String(target.comment || '');
        if (dataKeyStr !== dataCmt) return false;

        keyEl.value = commentEl.value;
        return true;
    }

    function installCommentToKeySync() {
        if (_commentToKeyInstalled) return;
        _commentToKeyInstalled = true;

        // input 監視
        document.addEventListener('input', (e) => {
            if (_getSettings().commentToKeySync === false) return;
            if (_creating.size > 0) return;

            const el = e.target;
            if (!el || el.tagName !== 'TEXTAREA') return;
            if (el.name !== 'comment') return;

            const entryEl = el.closest('.world_entry');
            if (!entryEl) return;
            const uid = entryEl.getAttribute('uid');
            if (!uid) return;

            _syncCommentToKey(entryEl, uid, el.value);
        }, true);

        // パネル開時
        document.addEventListener('click', (e) => {
            if (_getSettings().commentToKeySync === false) return;
            if (_creating.size > 0) return;

            const toggle = e.target?.closest?.('.inline-drawer-toggle');
            if (!toggle) return;
            const entryEl = toggle.closest('.world_entry');
            if (!entryEl) return;
            const uid = entryEl.getAttribute('uid');
            if (!uid) return;

            setTimeout(() => {
                _resyncKeyUIToComment(entryEl, uid);
            }, PANEL_SYNC_DELAY_MS);
        }, true);

        console.log(`${LOG} 📝 comment→key sync installed (payload interceptor + internal data)`);
    }

    // ============================================================
    // 最終手段のリロード
    // ============================================================
    function _checkReloadLoop() {
        try {
            const raw = sessionStorage.getItem(RELOAD_COUNT_KEY);
            const data = raw ? JSON.parse(raw) : { count: 0, firstAt: 0 };
            const now = Date.now();
            if (now - data.firstAt > RELOAD_LOOP_WINDOW_MS) { data.count = 0; data.firstAt = now; }
            data.count++;
            sessionStorage.setItem(RELOAD_COUNT_KEY, JSON.stringify(data));
            return data.count;
        } catch (e) { return 1; }
    }
    function _savePreReloadState(charName, worldName) {
        try {
            sessionStorage.setItem(RELOAD_STATE_KEY, JSON.stringify({ charName, worldName, createdAt: Date.now() }));
            const chat = document.getElementById('chat');
            if (chat && chat.scrollTop > 0) sessionStorage.setItem(RELOAD_SCROLL_KEY, String(chat.scrollTop));
        } catch (e) { /* ignore */ }
    }
    async function _scheduleReloadAndExit(charName, worldName) {
        if (!(await _verifyWorldbookOnServer(worldName))) return false;
        const count = _checkReloadLoop();
        if (count > RELOAD_MAX_PER_WINDOW) {
            console.error(`${LOG} 🛑 reload loop detected, aborting`);
            return false;
        }
        const textarea = document.getElementById('send_textarea');
        if (textarea && textarea.value.trim().length > 0) return false;
        _savePreReloadState(charName, worldName);
        try {
            window.toastr?.info?.(`ロアブック「${worldName}」の反映のためページを再読み込みします...`, '',
                { timeOut: 3000, positionClass: 'toast-top-center' });
        } catch (e) { /* ignore */ }
        setTimeout(() => { try { location.reload(); } catch (e) { /* ignore */ } }, RELOAD_DELAY_MS);
        return true;
    }
    function _consumeReloadState() {
        try {
            const raw = sessionStorage.getItem(RELOAD_STATE_KEY);
            if (!raw) return null;
            sessionStorage.removeItem(RELOAD_STATE_KEY);
            const state = JSON.parse(raw);
            if (Date.now() - state.createdAt > 60000) return null;
            return state;
        } catch (e) { return null; }
    }
    function _restoreScrollAfterReload() {
        try {
            const raw = sessionStorage.getItem(RELOAD_SCROLL_KEY);
            if (!raw) return;
            sessionStorage.removeItem(RELOAD_SCROLL_KEY);
            const target = parseInt(raw, 10);
            if (!Number.isFinite(target) || target <= 0) return;
            const tryRestore = (attempt = 0) => {
                const chat = document.getElementById('chat');
                if (chat && chat.scrollHeight > 100) { chat.scrollTop = target; return; }
                if (attempt < 20) setTimeout(() => tryRestore(attempt + 1), 200);
            };
            setTimeout(() => tryRestore(0), 1500);
        } catch (e) { /* ignore */ }
    }

    // ============================================================
    // 候補名・存在確認
    // ============================================================
    function _getCharacterWorldCandidates(char) {
        const candidates = [];
        if (!char) return candidates;
        if (char.name && typeof char.name === 'string' && char.name.trim()) {
            candidates.push(char.name.trim());
        }
        const fromExt = char.data?.extensions?.world;
        if (fromExt && typeof fromExt === 'string' && fromExt.trim()) {
            const w = fromExt.trim();
            if (!candidates.includes(w)) candidates.push(w);
        }
        const fromData = char.data?.world;
        if (fromData && typeof fromData === 'string' && fromData.trim()) {
            const w = fromData.trim();
            if (!candidates.includes(w)) candidates.push(w);
        }
        return candidates;
    }

    async function _hasWorldBookVerified(name) {
        if (!name) return false;
        if (await _verifyWorldbookOnServer(name)) return true;
        _removeStaleDomOption(name);
        _emptySaveGuards.delete(name);
        return false;
    }

    // ============================================================
    // メイン処理
    // ============================================================
    async function autoSelect(myToken, reason, options = {}) {
        const isStale = () => _generationToken !== myToken;

        const charAtStart = getCurrentChar();
        const charNameAtStart = charAtStart?.name || null;
        if (!charNameAtStart) {
            console.debug(LOG, `skip: no char (${reason})`);
            return;
        }

        const candidates = _getCharacterWorldCandidates(charAtStart);
        console.log(`${LOG} start: char="${charNameAtStart}", reason=${reason}, candidates=[${candidates.join(', ')}]`);

        try {
            let targetName = null;
            let wasCreated = false;

            for (let i = 0; i < FIND_RETRY_MAX; i++) {
                if (isStale()) return;
                for (const name of candidates) {
                    if (await _hasWorldBookVerified(name)) { targetName = name; break; }
                }
                if (targetName) break;
                await wait(FIND_RETRY_DELAY_MS);
            }

            if (!targetName) {
                const worldToCreate = charNameAtStart;
                console.log(`${LOG} 🆕 creating "${worldToCreate}"`);

                const created = await _createWorldbookIfMissing(worldToCreate);
                if (!created) {
                    console.warn(`${LOG} creation FAILED: "${worldToCreate}"`);
                    _recordFailure(charNameAtStart);
                    return;
                }
                wasCreated = true;

                if (isStale()) return;

                const bound = await _bindCharacterToWorld(charAtStart, worldToCreate, true);
                if (!bound) {
                    console.warn(`${LOG} bind FAILED: "${worldToCreate}"`);
                    _recordFailure(charNameAtStart);
                    return;
                }

                const visible = await _syncWorldListUntilVisible(worldToCreate);
                if (!visible) {
                    console.warn(`${LOG} "${worldToCreate}" not visible in ST world list`);
                    _recordFailure(charNameAtStart);
                    return;
                }
                targetName = worldToCreate;
            }

            if (isStale()) return;

            const sameChar = (_lastProcessedChar === charNameAtStart);
            if (!options.force && sameChar && reason !== 'chat-changed' && !wasCreated) {
                console.debug(LOG, `same char "${charNameAtStart}" skip`);
                return;
            }

            const editOk = await _setEditTarget(targetName);
            await wait(APPLY_DELAY_MS);
            if (isStale()) return;
            const activeOk = await _setActive(targetName);

            if (editOk || activeOk) {
                console.log(`${LOG} 🔖 selected "${targetName}" (edit=${editOk}, active=${activeOk})`);

                if (targetName === charNameAtStart) {
                    const currentExt = charAtStart.data?.extensions?.world;
                    if (currentExt !== targetName) {
                        await _bindCharacterToWorld(charAtStart, targetName, true);
                    }
                }

                if (editOk) {
                    const shown = await _ensureEditorShows(targetName);
                    if (!shown) {
                        console.error(`${LOG} ❌ editor still empty after heal: "${targetName}"`);
                        if (_getSettings().lastResortReload === true) {
                            const reloaded = await _scheduleReloadAndExit(charNameAtStart, targetName);
                            if (reloaded) return;
                        }
                        _recordFailure(charNameAtStart);
                        return;
                    }
                }

                _lastProcessedChar = charNameAtStart;
                _lastFailure = { char: null, at: 0 };
            } else {
                console.warn(`${LOG} selection failed for "${targetName}"`);
                _recordFailure(charNameAtStart);
            }
        } catch (e) {
            console.warn(LOG, 'autoSelect error:', e);
            _recordFailure(charNameAtStart);
        }
    }

    function _recordFailure(charName) {
        _lastProcessedChar = null;
        _lastFailure = { char: charName, at: Date.now() };
        _scheduleRetry(charName);
    }
    function _scheduleRetry(charName) {
        if (_retryTimer) clearTimeout(_retryTimer);
        _retryTimer = setTimeout(() => {
            _retryTimer = null;
            const currentChar = getCurrentCharName();
            if (!currentChar || currentChar !== charName) return;
            scheduleAutoSelect('retry-after-failure', { force: true });
        }, RETRY_AFTER_FAILURE_MS);
    }
    function scheduleAutoSelect(reason, options = {}) {
        const myToken = ++_generationToken;
        if (_scheduleTimer) clearTimeout(_scheduleTimer);
        if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
        _scheduleTimer = setTimeout(() => {
            _scheduleTimer = null;
            autoSelect(myToken, reason, options).catch(e => console.warn(LOG, e));
        }, DEBOUNCE_MS);
    }

    function setupEventListeners() {
        const ctx = getSTContext();
        if (!ctx?.eventSource || !ctx?.eventTypes) return false;
        const et = ctx.eventTypes;
        const es = ctx.eventSource;
        const events = [
            { name: 'CHARACTER_SELECTED', reason: 'character-selected' },
            { name: 'CHAT_CHANGED', reason: 'chat-changed' },
            { name: 'CHARACTER_PAGE_LOADED', reason: 'character-page-loaded' },
            { name: 'SETTINGS_LOADED', reason: 'settings-loaded' },
        ];
        let installed = 0;
        for (const { name, reason } of events) {
            if (et[name] && typeof es.on === 'function') {
                es.on(et[name], () => scheduleAutoSelect(reason));
                installed++;
            }
        }
        if (installed > 0) console.log(LOG, `registered ${installed} listeners`);
        return installed > 0;
    }

    async function init() {
        let waited = 0;
        while (!getSTContext() && waited < 10000) {
            await wait(200);
            waited += 200;
        }

        loadSettings();

        const reloadState = _consumeReloadState();
        if (reloadState) {
            console.log(`${LOG} ✅ resuming after reload: char="${reloadState.charName}", world="${reloadState.worldName}"`);
        }
        _restoreScrollAfterReload();

        setupEventListeners();
        installNewEntryDefaults();
        installCommentToKeySync();

        setTimeout(() => scheduleAutoSelect('initial'), reloadState ? 1000 : 1500);
        console.log(LOG, 'init complete');
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ============================================================
    // 公開 API
    // ============================================================
    window.WorldbookAutoSelect = {
        run: (reason, options) => {
            const token = ++_generationToken;
            return autoSelect(token, reason || 'manual', options || {});
        },
        runForce: () => {
            const token = ++_generationToken;
            return autoSelect(token, 'manual-force', { force: true });
        },
        forceReload: async () => {
            const charName = getCurrentCharName();
            if (!charName) return false;
            if (!(await _verifyWorldbookOnServer(charName))) {
                const created = await _createWorldbookIfMissing(charName);
                if (!created) return false;
            }
            return _scheduleReloadAndExit(charName, charName);
        },
        getSettings: () => ({ ...settings }),
        setSettings: (patch) => {
            settings = { ...settings, ...patch };
            _saveSettings();
            return settings;
        },
        setLastResortReload: (enabled) => {
            settings.lastResortReload = !!enabled;
            _saveSettings();
            return settings.lastResortReload;
        },
        setNewEntryDefaults: (enabled) => {
            settings.newEntryDefaults = !!enabled;
            _saveSettings();
            return settings.newEntryDefaults;
        },
        setCommentToKeySync: (enabled) => {
            settings.commentToKeySync = !!enabled;
            _saveSettings();
            console.log(`${LOG} commentToKeySync = ${settings.commentToKeySync}`);
            return settings.commentToKeySync;
        },
        syncCommentToKeyNow: async (uid) => {
            const els = _getEntryElements();
            if (els.length === 0) return false;
            const target = uid !== undefined && uid !== null
                ? document.querySelector(`.world_entry[uid="${CSS.escape(String(uid))}"]`)
                : els[els.length - 1];
            if (!target) return false;
            const c = target.querySelector('textarea[name="comment"]');
            if (!c) return false;
            const tid = target.getAttribute('uid');
            _syncCommentToKey(target, tid, c.value);
            // 即時 save は debounce に任せる（payload 補正が効く）
            await wait(COMMENT_SYNC_SAVE_DEBOUNCE_MS + 100);
            console.log(`${LOG} 📝 comment→key synced manually (uid=${tid})`);
            return true;
        },
        // ★ v8.5: 直近編集マップの状態（デバッグ用）
        getRecentlyEditedUids: () => {
            const out = {};
            const now = Date.now();
            for (const [uid, info] of _recentlyEditedUids.entries()) {
                out[uid] = {
                    age: now - info.at,
                    comment: String(info.commentValue || '').slice(0, 60),
                };
            }
            return out;
        },
        // ★ v8.5: 手動で payload 補正を発動（デバッグ用）
        forceCommentToKeySave: async (uid) => {
            const targetUid = uid !== undefined && uid !== null
                ? String(uid)
                : (() => {
                    const els = _getEntryElements();
                    return els.length > 0 ? els[els.length - 1].getAttribute('uid') : null;
                })();
            if (!targetUid) return false;
            const worldName = _getCurrentEditorWorldName();
            if (!worldName) return false;
            const entry = _getSTEntry(worldName, targetUid);
            if (!entry) return false;
            _recordRecentEdit(targetUid, entry.comment || '');
            const ok = await _saveCurrentEditorWorld();
            return ok;
        },
        applyNewEntryDefaults: async (uid) => {
            let target = uid;
            if (target === undefined || target === null) {
                const els = _getEntryElements();
                if (els.length === 0) return false;
                target = els[els.length - 1].getAttribute('uid');
            }
            return _applyNewEntryDefaultsWithRetry(target);
        },
        getCurrentCharName,
        getCurrentEditorWorldName: _getCurrentEditorWorldName,
        getSTEntry: (uid) => {
            const w = _getCurrentEditorWorldName();
            return w ? _getSTEntry(w, uid) : null;
        },
        hasWorldBookVerified: _hasWorldBookVerified,
        hasWorldBookInDOM: _hasWorldBookInDOM,
        getEmptySaveGuards: () => {
            const out = {};
            for (const [k, v] of _emptySaveGuards.entries()) {
                out[k] = { createdAt: v.createdAt, until: v.until, entryCount: Object.keys(v.entries || {}).length };
            }
            return out;
        },
        createWorldbook: (name) => _createWorldbookIfMissing(name || getCurrentCharName()),
        verifyWorldbookOnServer: (name) => _verifyWorldbookOnServer(name || getCurrentCharName()),
        fetchWorldbook: (name) => fetchWorldbookFromServer(name || getCurrentCharName()),
        refreshWorldSelects,
        ensureEditorShows: (name) => _ensureEditorShows(name || getCurrentCharName()),
        bindCharacter: async (worldName, force) => {
            const char = getCurrentChar();
            return _bindCharacterToWorld(char, worldName || getCurrentCharName(), !!force);
        },
        diagnose: async () => {
            const api = await _getWIApi();
            return {
                version: 'v8.5',
                settings: { ...settings },
                currentChar: getCurrentCharName(),
                editorWorld: _getCurrentEditorWorldName(),
                api: {
                    save: !!api.save,
                    reloadEditor: !!api.reloadEditor,
                    updateList: !!api.updateList,
                    importWI: !!api.importWI,
                },
                editorEntryCount: _countEditorEntries(),
                editorSelected: document.querySelector('#world_editor_select')
                    ?.selectedOptions?.[0]?.textContent?.trim() || null,
                newEntryButtonFound: !!document.querySelector('#world_popup_new'),
                newEntryWatching: !!_newEntryWatch,
                commentToKeyInstalled: _commentToKeyInstalled,
                recentlyEditedUids: Array.from(_recentlyEditedUids.keys()),
                emptySaveGuards: Array.from(_emptySaveGuards.keys()),
                creating: Array.from(_creating.keys()),
            };
        },
        resetProcessed: () => {
            _lastProcessedChar = null;
            _lastFailure = { char: null, at: 0 };
            if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
            _recentlyEditedUids.clear();
        },
    };

    console.log(LOG, 'window.WorldbookAutoSelect API exposed (v8.5)');
})();
