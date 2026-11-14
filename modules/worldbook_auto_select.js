// worldbook_auto_select.js
// キャラクター切替時に、キャラに関連付けられたロアブックを自動選択する。
// ロアブックが存在しない場合はキャラ名と同じロアブックを自動作成し、
// キャラクターとバインド（char.data.extensions.world）する。
//
// ★ v7 修正（今回 / 自動F5方式に転換）:
//   これまでの JS レベルでのレース条件対策（Layer1-3）では、
//   ST 内部の saveWorldInfo が DOM から空エントリを読み取って
//   /api/worldinfo/edit を叩くタイミングを完全に制御できず、
//   「自動作成されるがエントリが空」が50%程度の確率で発生していた。
//   唯一確実な解決策は F5（ブラウザ更新）であることが判明したため、
//   ロアブック新規作成直後に「自動F5相当のリロード」を実行する方式に変更。
//
//   フロー:
//     1. ロアブックが存在しない → importWorldInfo で作成
//     2. サーバーファイルの内容を検証（1エントリ存在を確認）
//     3. チャット・スクロール位置を sessionStorage に保存
//     4. トースト通知表示
//     5. location.reload() でページリロード
//     6. リロード後は ST がサーバーから正常にロアブックを読み込む
//     7. autoSelect が走るが、ファイルは正常なので「選択」だけ行う
//
//   ★ ループガード:
//     60秒以内に3回以上リロードが発生した場合はループと判定して中止。
//   ★ 無効化:
//     設定 `autoReloadAfterCreate: false` で旧来の JS レベル対策にフォールバック。
//   ★ 手動トリガー:
//     window.WorldbookAutoSelect.forceReload() で任意にリロード可能。

console.log('[WBAutoSelect] 📦 v7 module loading (auto-reload strategy)...');

(function () {
    'use strict';
    const LOG = '[WBAutoSelect]';
    const SETTINGS_KEY = 'worldbook_auto_select';

    const DEBOUNCE_MS = 300;
    const RETRY_AFTER_FAILURE_MS = 1500;
    const FIND_RETRY_MAX = 5;
    const FIND_RETRY_DELAY_MS = 300;
    const VERIFY_RETRY_MAX = 5;
    const VERIFY_RETRY_DELAY_MS = 300;
    const APPLY_DELAY_MS = 500;
    const SELF_HEAL_INTERVAL_MS = 1000;
    const EMPTY_SAVE_GUARD_MS = 30000;
    const RELOAD_DELAY_MS = 1000;
    const RELOAD_LOOP_WINDOW_MS = 60000;
    const RELOAD_MAX_PER_WINDOW = 3;

    const RELOAD_STATE_KEY = 'wbAutoSelect_reloadState';
    const RELOAD_SCROLL_KEY = 'wbAutoSelect_scroll';
    const RELOAD_COUNT_KEY = 'wbAutoSelect_reloadCount';

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
        autoReloadAfterCreate: true,
    };

    let settings = { ...DEFAULT_SETTINGS };
    let _generationToken = 0;
    let _scheduleTimer = null;
    let _retryTimer = null;
    let _lastProcessedChar = null;
    let _lastFailure = { char: null, at: 0 };
    const _warnedMismatch = new Set();
    const _protectedWorlds = new Set();
    const _protectionTargets = new Map();
    let _lastWorldInfoInstance = null;
    const _emptySaveGuards = new Map();

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
            if (!ctx.extensionSettings[SETTINGS_KEY]) {
                ctx.extensionSettings[SETTINGS_KEY] = {};
            }
            Object.assign(ctx.extensionSettings[SETTINGS_KEY], settings);
            if (typeof ctx.saveSettingsDebounced === 'function') {
                ctx.saveSettingsDebounced();
            }
        } catch (e) { /* ignore */ }
    }

    function loadSettings() {
        settings = _getSettings();
        console.log(`${LOG} settings loaded:`, settings);
    }

    // ============================================================
    // ★ v7: 自動リロード機構
    // ============================================================
    function _checkReloadLoop() {
        try {
            const raw = sessionStorage.getItem(RELOAD_COUNT_KEY);
            const data = raw ? JSON.parse(raw) : { count: 0, firstAt: 0 };
            const now = Date.now();
            if (now - data.firstAt > RELOAD_LOOP_WINDOW_MS) {
                data.count = 0;
                data.firstAt = now;
            }
            data.count++;
            sessionStorage.setItem(RELOAD_COUNT_KEY, JSON.stringify(data));
            return data.count;
        } catch (e) {
            return 1;
        }
    }

    function _savePreReloadState(charName, worldName) {
        try {
            sessionStorage.setItem(RELOAD_STATE_KEY, JSON.stringify({
                charName, worldName, createdAt: Date.now(),
            }));
            const chat = document.getElementById('chat');
            if (chat && chat.scrollTop > 0) {
                sessionStorage.setItem(RELOAD_SCROLL_KEY, String(chat.scrollTop));
            }
        } catch (e) { /* ignore */ }
    }

    function _showReloadToast(worldName, deferred = false) {
        try {
            if (typeof window.toastr === 'undefined') return;
            if (deferred) {
                window.toastr.warning(
                    `ロアブック「${worldName}」を作成しました。反映にはページを手動で再読み込みしてください。`,
                    '', { timeOut: 10000, positionClass: 'toast-top-center' }
                );
            } else {
                window.toastr.info(
                    `ロアブック「${worldName}」を作成しました。ページを再読み込みします...`,
                    '', { timeOut: 3000, positionClass: 'toast-top-center' }
                );
            }
        } catch (e) { /* ignore */ }
    }

    async function _scheduleReloadAndExit(charName, worldName) {
        // 最終検証: サーバーにファイルが存在することを確認
        let verified = await _verifyWorldbookOnServer(worldName);
        if (!verified) {
            // ガードのスナップショットで復元を試みる
            const guard = _emptySaveGuards.get(worldName);
            if (guard?.entries && Object.keys(guard.entries).length > 0) {
                console.log(`${LOG} 🔧 final restore before reload: "${worldName}"`);
                await _directEditWorldbook(worldName, guard.entries);
                verified = await _verifyWorldbookOnServer(worldName);
            }
        }
        if (!verified) {
            console.error(`${LOG} ❌ cannot reload - server file still empty for "${worldName}"`);
            return false;
        }

        // ループガード
        const count = _checkReloadLoop();
        if (count > RELOAD_MAX_PER_WINDOW) {
            console.error(
                `${LOG} 🛑 reload loop detected (${count}/${RELOAD_MAX_PER_WINDOW} in window), aborting`
            );
            _showReloadToast(worldName, true);
            return false;
        }

        // ユーザーが入力中なら延期
        const textarea = document.getElementById('send_textarea');
        if (textarea && textarea.value.trim().length > 0) {
            console.log(`${LOG} ⏸ user has pending input, deferring reload`);
            _showReloadToast(worldName, true);
            return false;
        }

        // 状態を保存
        _savePreReloadState(charName, worldName);

        // トースト通知
        _showReloadToast(worldName, false);

        console.log(
            `${LOG} 🔃 scheduling reload in ${RELOAD_DELAY_MS}ms ` +
            `(char="${charName}", world="${worldName}", count=${count})`
        );

        setTimeout(() => {
            try {
                location.reload();
            } catch (e) {
                console.error(`${LOG} location.reload() failed:`, e);
            }
        }, RELOAD_DELAY_MS);

        return true;
    }

    function _consumeReloadState() {
        try {
            const raw = sessionStorage.getItem(RELOAD_STATE_KEY);
            if (!raw) return null;
            sessionStorage.removeItem(RELOAD_STATE_KEY);
            const state = JSON.parse(raw);
            if (Date.now() - state.createdAt > 60000) {
                console.log(`${LOG} stale reload state ignored`);
                return null;
            }
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
            // チャット描画完了後にスクロール復元
            const tryRestore = (attempt = 0) => {
                const chat = document.getElementById('chat');
                if (chat && chat.scrollHeight > 100) {
                    chat.scrollTop = target;
                    console.log(`${LOG} 📜 scroll restored to ${target}px`);
                    return;
                }
                if (attempt < 20) {
                    setTimeout(() => tryRestore(attempt + 1), 200);
                }
            };
            setTimeout(() => tryRestore(0), 1500);
        } catch (e) { /* ignore */ }
    }

    // ============================================================
    // /api/worldinfo/edit インターセプタ（フォールバック用）
    // ============================================================
    (function installWorldInfoEditInterceptor() {
        if (window.__wbAutoSelectFetchPatched) return;
        window.__wbAutoSelectFetchPatched = true;

        const originalFetch = window.fetch;
        window.__wbAutoSelectOriginalFetch = originalFetch;

        window.fetch = function(input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (!url.includes('/api/worldinfo/edit')) {
                return originalFetch.apply(this, arguments);
            }
            if (!init || typeof init.body !== 'string') {
                return originalFetch.apply(this, arguments);
            }
            let body;
            try { body = JSON.parse(init.body); } catch (e) {
                return originalFetch.apply(this, arguments);
            }
            const name = body?.name;
            if (!name) return originalFetch.apply(this, arguments);
            const guard = _emptySaveGuards.get(name);
            if (!guard || Date.now() > guard.until) return originalFetch.apply(this, arguments);

            const incomingEntries = body?.data?.entries;
            const incomingIsEmpty = !incomingEntries
                || (typeof incomingEntries === 'object'
                    && Object.keys(incomingEntries).length === 0);
            if (!incomingIsEmpty) {
                guard.entries = JSON.parse(JSON.stringify(incomingEntries));
                return originalFetch.apply(this, arguments);
            }
            if (!guard.entries || Object.keys(guard.entries).length === 0) {
                return originalFetch.apply(this, arguments);
            }
            console.warn(`${LOG} 🛡️ empty save BLOCKED for "${name}"`);
            const newBody = {
                ...body,
                data: { ...(body.data || {}), entries: JSON.parse(JSON.stringify(guard.entries)) },
            };
            return originalFetch.call(this, input, { ...init, body: JSON.stringify(newBody) });
        };
        console.log('[WBAutoSelect] 🛡️ edit interceptor installed');
    })();

    function _protectFromEmptySave(name, entries, durationMs = EMPTY_SAVE_GUARD_MS) {
        if (!name || !entries) return;
        if (Object.keys(entries).length === 0) return;
        const existing = _emptySaveGuards.get(name);
        _emptySaveGuards.set(name, {
            createdAt: existing?.createdAt || Date.now(),
            until: Date.now() + durationMs,
            entries: JSON.parse(JSON.stringify(entries)),
        });
    }

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
        const char = getCurrentChar();
        return char?.name || null;
    }
    function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
    function getJQuery() { return window.$ || window.jQuery || null; }

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
    // world_info インスタンス管理
    // ============================================================
    function isPlainWorldInfoObject(x) {
        if (!x || typeof x !== 'object') return false;
        if (x.jquery) return false;
        if (Array.isArray(x)) return false;
        return true;
    }
    function getWorldInfoInstance() {
        const ctx = getSTContext();
        let obj = null;
        if (isPlainWorldInfoObject(ctx?.world_info)) obj = ctx.world_info;
        else if (isPlainWorldInfoObject(window.world_info)) obj = window.world_info;
        if (obj && obj !== _lastWorldInfoInstance) {
            _lastWorldInfoInstance = obj;
            _reinstallAllProtections();
        }
        return obj;
    }
    function _reinstallAllProtections() {
        const wi = _lastWorldInfoInstance;
        if (!wi || _protectionTargets.size === 0) return;
        let reinstalled = 0;
        for (const [name, data] of _protectionTargets.entries()) {
            if (_installProtectionOn(wi, name, data.entries)) reinstalled++;
        }
        if (reinstalled > 0) console.log(`${LOG} 🔄 reinstalled ${reinstalled} protections`);
    }
    function _shouldSkipValidateKey(name) {
        if (!name) return true;
        if (/^\d+$/.test(name)) return true;
        if (name.startsWith('jQuery')) return true;
        if (name.startsWith('sizzle')) return true;
        if (name === 'length' || name === 'prevObject' || name === 'selector' || name === 'context') return true;
        return false;
    }
    function _sanitizeWorldInfoObject() {
        const worldInfo = getWorldInfoInstance();
        if (!worldInfo) return 0;
        let removed = 0;
        for (const key of Object.keys(worldInfo)) {
            if (_shouldSkipValidateKey(key)) {
                try { delete worldInfo[key]; removed++; } catch (e) { /* ignore */ }
            }
        }
        return removed;
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
        if (!worldName) return false;
        const data = await fetchWorldbookFromServer(worldName);
        if (!data || !data.entries) return false;
        return Object.keys(data.entries).length > 0;
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
    async function refreshWorldSelects() {
        let success = false;
        try {
            const ctx = getSTContext();
            if (ctx && typeof ctx.getSettings === 'function') {
                await ctx.getSettings();
                success = true;
            }
        } catch (e) { /* ignore */ }
        if (!success) {
            try {
                const mod = await import('../../../../world-info.js');
                if (typeof mod.loadWorldInfoList === 'function') {
                    await mod.loadWorldInfoList();
                    success = true;
                }
            } catch (e) { /* ignore */ }
        }
        getWorldInfoInstance();
        return success;
    }

    // ============================================================
    // DOM ヘルパー
    // ============================================================
    function _findOptionValue(selectEl, name) {
        if (!selectEl || !name) return null;
        for (const opt of selectEl.options) {
            const v = (opt.value || '').trim();
            const t = (opt.textContent || '').trim();
            if (v === name) return opt.value;
            if (t === name) return opt.value;
        }
        return null;
    }
    function _hasWorldBookInDOM(name) {
        if (!name) return false;
        if (_findOptionValue(document.querySelector('#world_editor_select'), name) !== null) return true;
        if (_findOptionValue(document.querySelector('#world_info'), name) !== null) return true;
        return false;
    }
    function _addOptionToSelectsIfMissing(name) {
        if (!name) return;
        const ed = document.querySelector('#world_editor_select');
        if (ed && _findOptionValue(ed, name) === null) {
            const opt = document.createElement('option');
            opt.value = name; opt.textContent = name;
            ed.appendChild(opt);
        }
        const wi = document.querySelector('#world_info');
        if (wi && _findOptionValue(wi, name) === null) {
            const opt = document.createElement('option');
            opt.value = name; opt.textContent = name;
            wi.appendChild(opt);
        }
    }
    function _removeStaleDomOption(name) {
        if (!name) return;
        for (const sel of ['#world_editor_select', '#world_info']) {
            const el = document.querySelector(sel);
            if (!el) continue;
            for (const opt of Array.from(el.options)) {
                const v = (opt.value || '').trim();
                const t = (opt.textContent || '').trim();
                if (v === name || t === name) {
                    try { opt.remove(); } catch (e) { /* ignore */ }
                }
            }
        }
    }

    // ============================================================
    // メモリ保護
    // ============================================================
    function _createProtectedValue(data) {
        if (!data || typeof data !== 'object') return data;
        const copy = JSON.parse(JSON.stringify(data));
        try {
            if (typeof Proxy === 'function') {
                return new Proxy(copy, {
                    set(target, prop, value) {
                        if (prop === 'entries') {
                            if (!value || typeof value !== 'object') return true;
                            if (Object.keys(value).length === 0) return true;
                        }
                        return Reflect.set(target, prop, value);
                    },
                });
            }
        } catch (e) { /* fallback */ }
        return copy;
    }
    function _installProtectionOn(worldInfo, worldName, entries) {
        if (!worldInfo || !worldName || !entries) return false;
        if (Object.keys(entries).length === 0) return false;
        const desc = Object.getOwnPropertyDescriptor(worldInfo, worldName);
        if (desc && typeof desc.get === 'function' && typeof desc.set === 'function') {
            try { worldInfo[worldName] = { entries: JSON.parse(JSON.stringify(entries)) }; return true; }
            catch (e) { return false; }
        }
        let realValue = _createProtectedValue({ entries });
        try {
            Object.defineProperty(worldInfo, worldName, {
                configurable: true, enumerable: true,
                get() { return realValue; },
                set(v) {
                    if (v === null || v === undefined) return;
                    if (v && typeof v === 'object' && v.entries
                        && Object.keys(v.entries).length > 0) {
                        realValue = _createProtectedValue(v);
                        return;
                    }
                },
            });
            return true;
        } catch (e) {
            try { worldInfo[worldName] = { entries: JSON.parse(JSON.stringify(entries)) }; return true; }
            catch (e2) { return false; }
        }
    }
    function _ensureWorldInfoProtected(worldName, entries) {
        if (!worldName || !entries) return false;
        if (Object.keys(entries).length === 0) return false;
        _protectionTargets.set(worldName, { entries: JSON.parse(JSON.stringify(entries)) });
        const worldInfo = getWorldInfoInstance();
        if (!worldInfo) return false;
        const ok = _installProtectionOn(worldInfo, worldName, entries);
        if (ok) _protectedWorlds.add(worldName);
        return ok;
    }
    async function _ensureSpecificWorldReady(name) {
        if (!name) return false;
        const worldInfo = getWorldInfoInstance();
        if (!worldInfo) return false;
        const cur = worldInfo[name];
        const valid = cur && typeof cur === 'object'
            && cur.entries && Object.keys(cur.entries).length > 0;
        if (valid) return true;
        const fromServer = await fetchWorldbookFromServer(name);
        if (fromServer?.entries && Object.keys(fromServer.entries).length > 0) {
            _ensureWorldInfoProtected(name, fromServer.entries);
            return true;
        }
        return false;
    }
    async function _validateAllWorldInfoEntries() {
        const worldInfo = getWorldInfoInstance();
        if (!worldInfo) return;
        _sanitizeWorldInfoObject();
        const broken = [];
        for (const name of Object.keys(worldInfo)) {
            if (_shouldSkipValidateKey(name)) continue;
            const cur = worldInfo[name];
            const valid = cur && typeof cur === 'object'
                && cur.entries && Object.keys(cur.entries).length > 0;
            if (!valid) broken.push(name);
        }
        if (broken.length === 0) return;
        for (const name of broken) {
            const fromServer = await fetchWorldbookFromServer(name);
            if (fromServer?.entries && Object.keys(fromServer.entries).length > 0) {
                _ensureWorldInfoProtected(name, fromServer.entries);
            } else {
                try { delete worldInfo[name]; _protectedWorlds.delete(name); _protectionTargets.delete(name); } catch (e) { /* ignore */ }
            }
        }
    }

    function _createCommonRuleEntry(uid) {
        return {
            uid: uid, displayIndex: uid, key: [], keysecondary: [],
            comment: '00_共通ルール', content: COMMON_RULE_CONTENT,
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

    async function _createWorldbookIfMissing(worldName) {
        if (!worldName) return false;
        const existing = await fetchWorldbookFromServer(worldName);
        if (existing && existing.entries && Object.keys(existing.entries).length > 0) {
            _protectFromEmptySave(worldName, existing.entries);
            _ensureWorldInfoProtected(worldName, existing.entries);
            return true;
        }
        const newEntries = { 0: _createCommonRuleEntry(0) };

        // パターン A: importWorldInfo
        try {
            const mod = await import('../../../../world-info.js');
            if (typeof mod.importWorldInfo === 'function') {
                const jsonContent = JSON.stringify({ entries: newEntries }, null, 2);
                const blob = new Blob([jsonContent], { type: 'application/json' });
                const file = new File([blob], `${worldName}.json`, { type: 'application/json' });
                await mod.importWorldInfo(file, false);
                console.log(`${LOG} 📥 importWorldInfo created "${worldName}"`);
                await wait(500);

                let verified = null;
                for (let i = 0; i < VERIFY_RETRY_MAX; i++) {
                    const fetched = await fetchWorldbookFromServer(worldName);
                    if (fetched?.entries && Object.keys(fetched.entries).length > 0) {
                        const first = Object.values(fetched.entries)[0];
                        if (first?.comment === '00_共通ルール') {
                            verified = fetched.entries;
                            break;
                        }
                    }
                    await wait(VERIFY_RETRY_DELAY_MS);
                }
                if (verified) {
                    _protectFromEmptySave(worldName, verified);
                    _ensureWorldInfoProtected(worldName, verified);
                    await refreshWorldSelects();
                    _addOptionToSelectsIfMissing(worldName);
                    _ensureWorldInfoProtected(worldName, verified);
                    _protectFromEmptySave(worldName, verified);
                    return true;
                }
            }
        } catch (e) { console.warn(`${LOG} importWorldInfo failed:`, e?.message || e); }

        // パターン B: direct edit のみ
        const ok = await _directEditWorldbook(worldName, newEntries);
        if (ok) {
            const fetched = await fetchWorldbookFromServer(worldName);
            if (fetched?.entries && Object.keys(fetched.entries).length > 0) {
                _protectFromEmptySave(worldName, fetched.entries);
                _ensureWorldInfoProtected(worldName, fetched.entries);
                await refreshWorldSelects();
                _addOptionToSelectsIfMissing(worldName);
                _ensureWorldInfoProtected(worldName, fetched.entries);
                _protectFromEmptySave(worldName, fetched.entries);
                return true;
            }
        }
        return false;
    }

    async function _bindCharacterToWorld(char, worldName, force = false) {
        if (!char || !worldName) return false;
        if (!force && char.data?.extensions?.world === worldName) return true;
        const ok = await _ensureSpecificWorldReady(worldName);
        if (!ok) return false;
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

    async function _setEditTarget(name) {
        const $ = getJQuery();
        const ed = document.querySelector('#world_editor_select');
        if (!$ || !ed) return false;
        if (!(await _ensureSpecificWorldReady(name))) return false;
        if (_findOptionValue(ed, name) === null) _addOptionToSelectsIfMissing(name);
        const value = _findOptionValue(ed, name);
        if (value === null) return false;
        try {
            $(ed).val(value).trigger('change');
            return true;
        } catch (e) { return false; }
    }

    async function _setActive(name) {
        const $ = getJQuery();
        const wi = document.querySelector('#world_info');
        if (!$ || !wi) return false;
        if (!(await _ensureSpecificWorldReady(name))) return false;
        if (_findOptionValue(wi, name) === null) _addOptionToSelectsIfMissing(name);
        const value = _findOptionValue(wi, name);
        if (value === null) return false;
        try {
            if (wi.hasAttribute('multiple')) $(wi).val([value]).trigger('change');
            else $(wi).val(value).trigger('change');
            return true;
        } catch (e) { return false; }
    }

    async function _repairCurrentCharWorld() {
        try {
            const char = getCurrentChar();
            if (!char) return;
            const candidates = _getCharacterWorldCandidates(char);
            const worldInfo = getWorldInfoInstance();
            if (!worldInfo) return;
            for (const name of candidates) {
                if (!name) continue;
                if (!_hasWorldBookInDOM(name)) continue;
                const cur = worldInfo[name];
                const valid = cur && typeof cur === 'object'
                    && cur.entries && Object.keys(cur.entries).length > 0;
                if (!valid) {
                    const fromServer = await fetchWorldbookFromServer(name);
                    if (fromServer?.entries) _ensureWorldInfoProtected(name, fromServer.entries);
                } else if (!_protectedWorlds.has(name)) {
                    _ensureWorldInfoProtected(name, cur.entries);
                }
                break;
            }
        } catch (e) { /* ignore */ }
    }

    function _pollGuardedWorldsMemory() {
        const worldInfo = getWorldInfoInstance();
        if (!worldInfo) return;
        for (const [name, guard] of _emptySaveGuards.entries()) {
            if (Date.now() > guard.until) continue;
            if (!guard.entries || Object.keys(guard.entries).length === 0) continue;
            const cur = worldInfo[name];
            const isEmpty = !cur || !cur.entries || Object.keys(cur.entries).length === 0;
            if (isEmpty) _ensureWorldInfoProtected(name, guard.entries);
        }
    }

    let _selfHealTimer = null;
    function startSelfHeal() {
        if (_selfHealTimer) return;
        _selfHealTimer = setInterval(() => {
            _repairCurrentCharWorld().catch(() => {});
            _pollGuardedWorldsMemory();
            getWorldInfoInstance();
        }, SELF_HEAL_INTERVAL_MS);
    }

    window.addEventListener('unhandledrejection', (e) => {
        const msg = String(e.reason?.message || e.reason?.stack || e.reason || '');
        const stBug =
            msg.includes("right-hand side of 'in' should be an object") ||
            (msg.includes("can't convert undefined to object") && msg.includes('world-info.js')) ||
            (msg.includes('getCharacterLore') && msg.includes('world-info.js')) ||
            (msg.includes('getGlobalLore') && msg.includes('world-info.js')) ||
            (msg.includes('displayWorldEntries') && msg.includes('world-info.js'));
        if (stBug) {
            e.preventDefault();
            setTimeout(() => {
                _validateAllWorldInfoEntries().catch(() => {});
                _repairCurrentCharWorld().catch(() => {});
            }, 100);
        }
    });

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
        const serverHas = await _verifyWorldbookOnServer(name);
        if (serverHas) {
            const fromServer = await fetchWorldbookFromServer(name);
            if (fromServer?.entries && Object.keys(fromServer.entries).length > 0) {
                const worldInfo = getWorldInfoInstance();
                if (worldInfo) {
                    const cur = worldInfo[name];
                    const valid = cur && typeof cur === 'object'
                        && cur.entries && Object.keys(cur.entries).length > 0;
                    if (!valid) _ensureWorldInfoProtected(name, fromServer.entries);
                }
                return true;
            }
        }
        const worldInfo = getWorldInfoInstance();
        if (worldInfo) {
            try { delete worldInfo[name]; } catch (e) { /* ignore */ }
            _protectedWorlds.delete(name);
            _protectionTargets.delete(name);
        }
        _removeStaleDomOption(name);
        return false;
    }

    function _hasWorldBook(name) {
        if (!name) return false;
        const worldInfo = getWorldInfoInstance();
        if (worldInfo && worldInfo[name]?.entries) {
            return Object.keys(worldInfo[name].entries).length > 0;
        }
        return _hasWorldBookInDOM(name);
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
                if (isStale()) {
                    console.debug(LOG, `stale: char changed (${charNameAtStart} → ${getCurrentCharName()})`);
                    return;
                }
                for (const name of candidates) {
                    if (await _hasWorldBookVerified(name)) {
                        targetName = name;
                        break;
                    }
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

                const bound = await _bindCharacterToWorld(charAtStart, worldToCreate);
                if (!bound) {
                    console.warn(`${LOG} bind FAILED: "${worldToCreate}"`);
                    _recordFailure(charNameAtStart);
                    return;
                }

                // ★ v7: 新規作成直後に自動リロード
                if (_getSettings().autoReloadAfterCreate !== false) {
                    const reloaded = await _scheduleReloadAndExit(charNameAtStart, worldToCreate);
                    if (reloaded) {
                        // リロードがスケジュールされた → ここで処理終了
                        return;
                    }
                    // リロードできなかった場合（入力中/ループ検出/検証失敗）は
                    // 通常フローにフォールバック
                    console.log(`${LOG} reload skipped → falling back to normal flow`);
                }

                await wait(300);
                for (let i = 0; i < FIND_RETRY_MAX; i++) {
                    if (_hasWorldBookInDOM(worldToCreate)) { targetName = worldToCreate; break; }
                    if (i === 1) {
                        await refreshWorldSelects();
                        _addOptionToSelectsIfMissing(worldToCreate);
                    }
                    await wait(FIND_RETRY_DELAY_MS);
                }
                if (!targetName) {
                    const serverHas = await _verifyWorldbookOnServer(worldToCreate);
                    if (serverHas) {
                        _addOptionToSelectsIfMissing(worldToCreate);
                        targetName = worldToCreate;
                    } else {
                        _recordFailure(charNameAtStart);
                        return;
                    }
                }
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
                _lastProcessedChar = charNameAtStart;
                _lastFailure = { char: null, at: 0 };
            } else {
                console.warn(`${LOG} selection failed for "${targetName}" → retry create`);
                const recreated = await _createWorldbookIfMissing(targetName);
                if (recreated) {
                    await wait(300);
                    const editOk2 = await _setEditTarget(targetName);
                    await wait(APPLY_DELAY_MS);
                    const activeOk2 = await _setActive(targetName);
                    if (editOk2 || activeOk2) {
                        _lastProcessedChar = charNameAtStart;
                        _lastFailure = { char: null, at: 0 };
                        return;
                    }
                }
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

        // ★ v7: リロード直後か判定
        const reloadState = _consumeReloadState();
        if (reloadState) {
            console.log(
                `${LOG} ✅ resuming after auto-reload: char="${reloadState.charName}", ` +
                `world="${reloadState.worldName}"`
            );
        }

        // ★ v7: スクロール位置復元
        _restoreScrollAfterReload();

        setupEventListeners();
        startSelfHeal();

        // リロード直後は少し早めに autoSelect を走らせる
        const delay = reloadState ? 1000 : 1500;
        setTimeout(() => scheduleAutoSelect('initial'), delay);

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
        // ★ v7: 手動リロード API
        forceReload: async () => {
            const charName = getCurrentCharName();
            if (!charName) {
                console.warn(`${LOG} forceReload: no current char`);
                return false;
            }
            const verified = await _verifyWorldbookOnServer(charName);
            if (!verified) {
                console.warn(`${LOG} forceReload: "${charName}" not on server, creating first`);
                const created = await _createWorldbookIfMissing(charName);
                if (!created) return false;
            }
            return _scheduleReloadAndExit(charName, charName);
        },
        getSettings: () => ({ ...settings }),
        setSettings: (patch) => {
            settings = { ...settings, ...patch };
            _saveSettings();
            console.log(`${LOG} settings updated:`, settings);
            return settings;
        },
        setAutoReload: (enabled) => {
            settings.autoReloadAfterCreate = !!enabled;
            _saveSettings();
            console.log(`${LOG} autoReloadAfterCreate = ${settings.autoReloadAfterCreate}`);
            return settings.autoReloadAfterCreate;
        },
        getCurrentCharName,
        hasWorldBook: _hasWorldBook,
        hasWorldBookVerified: _hasWorldBookVerified,
        hasWorldBookInDOM: _hasWorldBookInDOM,
        hasWorldBookInMemory: (name) => {
            const worldInfo = getWorldInfoInstance();
            return !!(worldInfo && worldInfo[name]?.entries
                && Object.keys(worldInfo[name].entries).length > 0);
        },
        isProtected: (name) => _protectedWorlds.has(name),
        getProtectedWorlds: () => Array.from(_protectedWorlds),
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
        validateAllWorldInfoEntries: _validateAllWorldInfoEntries,
        bindCharacter: async (worldName, force) => {
            const char = getCurrentChar();
            return _bindCharacterToWorld(char, worldName || getCurrentCharName(), !!force);
        },
        diagnose: async () => {
            const ctx = getSTContext();
            const worldInfoCtx = ctx?.world_info;
            const worldInfoWin = window.world_info;
            const worldInfo = worldInfoCtx || worldInfoWin;
            return {
                settings: { ...settings },
                hasCtxWorldInfo: !!worldInfoCtx,
                hasWinWorldInfo: !!worldInfoWin,
                sameInstance: worldInfoCtx === worldInfoWin,
                worldInfoKeys: worldInfo ? Object.keys(worldInfo).slice(0, 30) : [],
                protectedWorlds: Array.from(_protectedWorlds),
                emptySaveGuards: Array.from(_emptySaveGuards.keys()),
                currentChar: getCurrentCharName(),
                reloadState: (() => {
                    try {
                        const raw = sessionStorage.getItem(RELOAD_STATE_KEY);
                        return raw ? JSON.parse(raw) : null;
                    } catch (e) { return null; }
                })(),
            };
        },
        resetProcessed: () => {
            _lastProcessedChar = null;
            _lastFailure = { char: null, at: 0 };
            _warnedMismatch.clear();
            if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
        },
    };

    console.log(LOG, 'window.WorldbookAutoSelect API exposed (v7)');
})();
