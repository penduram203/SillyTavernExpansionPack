// worldbook_auto_select.js
// キャラクター切替時に、キャラに関連付けられたロアブックを自動選択する。
// ロアブックが存在しない場合はキャラ名と同じロアブックを自動作成し、
// キャラクターとバインド（char.data.extensions.world）する。
//
// ★ v8（リロード不要方式）:
//   v7 までは新規作成後に location.reload() していたが、根本原因は
//   「サーバーファイルは正常なのに ST 内部のワールドインフォ用キャッシュ/UI が
//    古い（空）まま」だったこと。F5 が効いたのはメモリが消えるため。
//   v8 では ST 公式の関数（context / world-info.js 経由）を使って
//   キャッシュ・ワールド一覧・エディタを正規の手順で更新する。
//
//   作成フロー:
//     1. saveWorldInfo(name, data, true) でキャッシュ+サーバーを同時更新
//        （失敗時: 直接 /api/worldinfo/edit → importWorldInfo の順でフォールバック）
//     2. サーバーのファイルを検証
//     3. updateWorldInfoList() でワールド一覧を更新
//     4. reloadWorldInfoEditor() でエディタに読込
//     5. エディタ DOM が空なら、サーバー内容でキャッシュを上書きして再読込（自己修復）
//
//   ★ 削除対応:
//     /api/worldinfo/delete を検知して、そのロアブックのガード・処理済み状態をクリアする。
//     （削除済みロアブックの古いデータが再作成を邪魔しないようにする）
//
//   ★ v7 の world_info への Proxy/getter 注入と、エディタ select への
//     偽 option(value=名前) 追加は撤去（ST 内部状態との不整合の原因になるため）。
//
//   ★ 最終手段としてのリロード:
//     自己修復が全て失敗した場合のみ、設定 lastResortReload=true の時に限り
//     リロードする（既定は false）。

console.log('[WBAutoSelect] 📦 v8 module loading (soft-refresh strategy, no reload)...');

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

    // 最終手段リロード用
    const RELOAD_DELAY_MS = 1000;
    const RELOAD_LOOP_WINDOW_MS = 60000;
    const RELOAD_MAX_PER_WINDOW = 3;
    const RELOAD_STATE_KEY = 'wbAutoSelect_reloadState';
    const RELOAD_SCROLL_KEY = 'wbAutoSelect_scroll';
    const RELOAD_COUNT_KEY = 'wbAutoSelect_reloadCount';

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
    };

    let settings = { ...DEFAULT_SETTINGS };
    let _generationToken = 0;
    let _scheduleTimer = null;
    let _retryTimer = null;
    let _lastProcessedChar = null;
    let _lastFailure = { char: null, at: 0 };
    const _emptySaveGuards = new Map();   // name -> { createdAt, until, entries }
    const _creating = new Map();          // name -> Promise<boolean>（多重作成防止）

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
    //   context 経由を優先し、無ければ world-info.js のエクスポートを使う。
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
    // 空保存ガード + 削除検知（fetch インターセプタ）
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

            // ---- 削除検知 ----
            if (isDelete) {
                const p = originalFetch.apply(this, arguments);
                p.then(r => { if (r && r.ok) _onWorldDeleted(name); }).catch(() => {});
                return p;
            }

            // ---- 空保存ガード ----
            const guard = _emptySaveGuards.get(name);
            if (!guard || Date.now() > guard.until) return originalFetch.apply(this, arguments);

            const incoming = body?.data?.entries;
            const incomingIsEmpty = !incoming
                || (typeof incoming === 'object' && Object.keys(incoming).length === 0);
            if (!incomingIsEmpty) {
                guard.entries = clone(incoming);
                return originalFetch.apply(this, arguments);
            }
            if (!guard.entries || Object.keys(guard.entries).length === 0) {
                return originalFetch.apply(this, arguments);
            }
            console.warn(`${LOG} 🛡️ empty save BLOCKED for "${name}" (restored from guard)`);
            const newBody = {
                ...body,
                data: { ...(body.data || {}), entries: clone(guard.entries) },
            };
            return originalFetch.call(this, input, { ...init, body: JSON.stringify(newBody) });
        };
        console.log('[WBAutoSelect] 🛡️ worldinfo fetch interceptor installed (edit guard + delete hook)');
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
            if (t === name) return opt.value;     // ST の value はインデックスなので text 優先
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
    // null = エディタ DOM 自体が無い（検証不能）
    function _countEditorEntries() {
        const list = document.querySelector('#world_popup_entries_list');
        if (!list) return null;
        return list.querySelectorAll('.world_entry').length;
    }

    // ============================================================
    // ワールド一覧の更新（公式 API → フォールバック）
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

    // ワールド一覧に name が現れるまで更新を繰り返す
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
    // ロアブック作成（リロード不要）
    //   1) 公式 saveWorldInfo（キャッシュ+サーバー同時更新）
    //   2) 直接 /api/worldinfo/edit
    //   3) importWorldInfo
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
            // ST が途中で空保存してもこの内容で上書きされるようガード
            _protectFromEmptySave(worldName, newEntries);

            const api = await _getWIApi();
            let verified = null;

            // ── 方式1: 公式 saveWorldInfo ──
            if (api.save) {
                try {
                    await api.save(worldName, { entries: clone(newEntries) }, true);
                    verified = await _waitForServerEntries(worldName);
                    if (verified) console.log(`${LOG} ✅ created via saveWorldInfo: "${worldName}"`);
                } catch (e) {
                    console.warn(`${LOG} saveWorldInfo failed:`, e?.message || e);
                }
            }

            // ── 方式2: 直接 edit ──
            if (!verified) {
                if (await _directEditWorldbook(worldName, newEntries)) {
                    verified = await _waitForServerEntries(worldName);
                    if (verified) console.log(`${LOG} ✅ created via direct edit: "${worldName}"`);
                }
            }

            // ── 方式3: importWorldInfo ──
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
        // フォールバック: ドロップダウン操作（option は ST が生成したものだけを使う）
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
                const cur = $(wi).val() || [];
                const next = Array.isArray(cur) ? cur.slice() : [cur];
                if (!next.includes(String(value))) next.push(String(value));
                // 当該キャラ用のみを選択（従来動作に合わせ単一選択）
                $(wi).val([String(value)]).trigger('change');
            } else {
                $(wi).val(value).trigger('change');
            }
            return true;
        } catch (e) { return false; }
    }

    // ============================================================
    // ★ 自己修復: エディタが空表示なら、サーバー内容でキャッシュを上書きして再読込
    // ============================================================
    async function _ensureEditorShows(name) {
        const api = await _getWIApi();

        for (let attempt = 1; attempt <= HEAL_MAX_ATTEMPTS; attempt++) {
            // 描画待ち
            for (let i = 0; i < EDITOR_RENDER_WAIT_TRIES; i++) {
                const n = _countEditorEntries();
                if (n === null) return true;     // 検証不能 → 成功扱い
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

            // キャッシュをサーバーの内容で上書き
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
    // 最終手段のリロード（既定で無効）
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

    // サーバー上に（エントリ付きで）実在するか。無ければ DOM の古い option を掃除する。
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

            // ── 存在しない → 作成（リロードなし） ──
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

                // ST のワールド一覧に反映されるまで待つ
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

            // ── エディタ + アクティブ選択 ──
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

                // ★ エディタが空表示になっていないか検証し、必要なら自己修復
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
        getCurrentCharName,
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
                version: 'v8',
                settings: { ...settings },
                currentChar: getCurrentCharName(),
                api: {
                    save: !!api.save,
                    reloadEditor: !!api.reloadEditor,
                    updateList: !!api.updateList,
                    importWI: !!api.importWI,
                },
                editorEntryCount: _countEditorEntries(),
                editorSelected: document.querySelector('#world_editor_select')
                    ?.selectedOptions?.[0]?.textContent?.trim() || null,
                emptySaveGuards: Array.from(_emptySaveGuards.keys()),
                creating: Array.from(_creating.keys()),
            };
        },
        resetProcessed: () => {
            _lastProcessedChar = null;
            _lastFailure = { char: null, at: 0 };
            if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
        },
    };

    console.log(LOG, 'window.WorldbookAutoSelect API exposed (v8)');
})();
