// worldbook_auto_select.js
// キャラクター切替時に、キャラに関連付けられたロアブックを自動選択する。
// ロアブックが存在しない場合はキャラ名と同じロアブックを自動作成し、
// キャラクターとバインド（char.data.extensions.world）する。
//
// ★ 設計方針: ロアブック名 = キャラ名 / [char.name, ext.world, data.world]
//
// ★ 自動作成の第一手段は ST 本体の importWorldInfo:
//   - importWorldInfo は内部で /api/worldinfo/import を叩き、
//     成功後に getSettings() を実行して world_names を更新し、
//     UI のドロップダウンも再構築する。
//   - これが world_names を正しく更新する唯一の確実な経路。
//   - importWorldInfo が失敗した場合のみ createNewWorldInfo + edit へ
//     フォールバックする。
//
// ★ v5 修正（今回 / レース条件の根本解決）:
//   - ST の saveWorldInfo は **DOM から entries を読んで**
//     /api/worldinfo/edit に送る。DOM 構築（loadWorldInfo→displayWorldEntries）
//     が完了する前に saveWorldInfo が走ると、空エントリでサーバーファイルを
//     上書きしてしまう（「エントリが空のロアブックが自動作成される」直接原因）。
//   - これを防ぐため、/api/worldinfo/edit への fetch をインターセプトし、
//     直前に作成した world への「空エントリ保存」をブロックして
//     スナップショットで置換する。
//   - 安全判定として「#world_editor_select で現在編集中の world 名」と
//     「保存対象 world 名」を比較し、不一致の時のみブロックする。
//     （ユーザーが意図的に全エントリ削除した時は両者一致なので素通り）
//   - さらに _setActive 後に 2 秒待ってサーバーファイルを検証し、
//     空になっていたらスナップショットで復元する安全網を追加。
//   - APPLY_DELAY_MS を 200→500ms に延長して DOM 構築の完了を待つ。
//
// ★ world_info 保護（v4 から継続）:
//   - Object.defineProperty + Proxy + deepcopy でメモリ上の entries を保護
//   - インスタンス変化を検知して自動再インストール

(function () {
    'use strict';
    const LOG = '[WBAutoSelect]';
    const DEBOUNCE_MS = 300;
    const RETRY_AFTER_FAILURE_MS = 1500;
    const FIND_RETRY_MAX = 5;
    const FIND_RETRY_DELAY_MS = 300;
    const SAVE_RETRY_MAX = 3;
    const SAVE_RETRY_DELAY_MS = 500;
    const VERIFY_RETRY_MAX = 5;
    const VERIFY_RETRY_DELAY_MS = 300;
    const APPLY_DELAY_MS = 500;              // v5: 200 → 500
    const SELF_HEAL_INTERVAL_MS = 1000;
    const EMPTY_SAVE_GUARD_MS = 30000;       // v5: 空保存防止の有効期間
    const VERIFY_AFTER_CHANGES_DELAY_MS = 2000;  // v5: change 後の検証遅延

    const COMMON_RULE_CONTENT =
        '【絶対厳守ルール】\n' +
        '1. プレイヤーが入力した番号に対応する場面を描写する。\n' +
        '2. {{char}}の台詞を日本のラノベ風にした上で、{{char}}の台詞だけで状況や心情を説明する\n' +
        '3. 地の文を絶対に使わない\n' +
        '3. {{user}}の台詞や独白を描写しない\n' +
        '4. 描写の長さは必ず 約400文字 とすること。100文字や200文字といった短い本文は絶対禁止。\n' +
        '5. 情景・人物の動き・心情・五感・会話を丁寧に書き、短くまとめてはいけない。\n' +
        '6. 描写本文を書いたら、必ず空行を2行入れる。';

    let _generationToken = 0;
    let _scheduleTimer = null;
    let _retryTimer = null;
    let _lastProcessedChar = null;
    let _lastFailure = { char: null, at: 0 };
    const _warnedMismatch = new Set();
    const _protectedWorlds = new Set();

    // ★ v4: 保護対象のスナップショット
    const _protectionTargets = new Map();  // worldName -> { entries: ... }
    let _lastWorldInfoInstance = null;

    // ★ v5: 空保存防止ガード
    //   name -> { until: timestamp, entries: {...} }
    const _emptySaveGuards = new Map();

    // ============================================================
    // ★ v5: /api/worldinfo/edit インターセプタ
    //   直前に作成した world に対する空エントリ保存をブロックし、
    //   スナップショットで置換する。
    // ============================================================
    (function installWorldInfoEditInterceptor() {
        if (window.__wbAutoSelectEditInterceptorInstalled) return;
        window.__wbAutoSelectEditInterceptorInstalled = true;

        const origFetch = window.fetch;
        window.fetch = function(input, init) {
            try {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                if (!url.includes('/api/worldinfo/edit')) {
                    return origFetch.apply(this, arguments);
                }
                if (!init || !init.body) return origFetch.apply(this, arguments);

                let body;
                try { body = JSON.parse(init.body); }
                catch (e) { return origFetch.apply(this, arguments); }

                const name = body && body.name;
                if (!name) return origFetch.apply(this, arguments);

                const guard = _emptySaveGuards.get(name);
                if (!guard) return origFetch.apply(this, arguments);

                // 期限切れガードは削除
                if (Date.now() > guard.until) {
                    _emptySaveGuards.delete(name);
                    return origFetch.apply(this, arguments);
                }

                const incomingEntries = body && body.data && body.data.entries;
                const incomingIsEmpty = !incomingEntries
                    || (typeof incomingEntries === 'object'
                        && Object.keys(incomingEntries).length === 0);

                if (!incomingIsEmpty) {
                    // 正当な保存 → ガードのスナップショットを最新化（期限は延長しない）
                    guard.entries = JSON.parse(JSON.stringify(incomingEntries));
                    return origFetch.apply(this, arguments);
                }

                // incoming が空 → ブロックすべきか判定
                if (!guard.entries || Object.keys(guard.entries).length === 0) {
                    return origFetch.apply(this, arguments);
                }

                // 現在エディタで編集中の world 名
                const editorWorld = (document.querySelector('#world_editor_select')?.value || '').trim();

                // editor === name ならユーザーが意図的にその world を編集中。
                // 全削除操作は正当として通す。
                if (editorWorld === name) {
                    // ユーザーが意図的に空にした → スナップショットもクリア
                    guard.entries = {};
                    return origFetch.apply(this, arguments);
                }

                // ★ レース条件の空保存を検出 → スナップショットで置換
                console.log(
                    `[WBAutoSelect] 🛡️ "${name}" への空エントリ保存を検出 → ` +
                    `スナップショット(${Object.keys(guard.entries).length}件)で置換 ` +
                    `(editor="${editorWorld}")`
                );
                const newBody = {
                    ...body,
                    data: {
                        ...(body.data || {}),
                        entries: JSON.parse(JSON.stringify(guard.entries)),
                    },
                };
                return origFetch.call(this, input, { ...init, body: JSON.stringify(newBody) });
            } catch (e) {
                console.warn(`${LOG} edit interceptor error:`, e);
                return origFetch.apply(this, arguments);
            }
        };
        console.log('[WBAutoSelect] 🛡️ /api/worldinfo/edit インターセプタを設置');
    })();

    // ★ v5: 空保存防止ガードをセット
    function _protectFromEmptySave(name, entries, durationMs = EMPTY_SAVE_GUARD_MS) {
        if (!name || !entries) return;
        if (Object.keys(entries).length === 0) return;
        _emptySaveGuards.set(name, {
            until: Date.now() + durationMs,
            entries: JSON.parse(JSON.stringify(entries)),
        });
        console.log(`[WBAutoSelect] 🛡️ "${name}" の空保存防止ガードを ${durationMs}ms 間有効化`);
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

    function wait(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    function getJQuery() {
        return window.$ || window.jQuery || null;
    }

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
                csrfInput?.value ||
                '';
            if (csrf) headers['X-CSRF-Token'] = csrf;
        } catch (e) { /* ignore */ }
        return headers;
    }

    // ============================================================
    // world_info インスタンス取得（jQuery / 配列を拒否）
    // インスタンス変化を検知して保護を再インストール
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
        if (!wi) return;
        if (_protectionTargets.size === 0) return;

        const targets = Array.from(_protectionTargets.entries());
        let reinstalled = 0;
        for (const [name, data] of targets) {
            if (_installProtectionOn(wi, name, data.entries)) reinstalled++;
        }
        console.log(
            `${LOG} 🔄 world_info インスタンス変化 → ${reinstalled}/${targets.length} 件の保護を再インストール`
        );
    }

    function _shouldSkipValidateKey(name) {
        if (!name) return true;
        if (/^\d+$/.test(name)) return true;
        if (name.startsWith('jQuery')) return true;
        if (name.startsWith('sizzle')) return true;
        if (name === 'length') return true;
        if (name === 'prevObject') return true;
        if (name === 'selector') return true;
        if (name === 'context') return true;
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
        if (removed > 0) console.log(`${LOG} 🧹 world_info から不正キー ${removed}件を削除`);
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
                method: 'POST',
                headers,
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

    // ★ v5: サーバーファイルが空になった場合の復元
    async function _verifyAndRestoreServerFile(name) {
        const current = await fetchWorldbookFromServer(name);
        const currentEmpty = !current || !current.entries
            || Object.keys(current.entries).length === 0;
        if (!currentEmpty) return true;

        const snapshot = _protectionTargets.get(name) || _emptySaveGuards.get(name);
        if (!snapshot || !snapshot.entries || Object.keys(snapshot.entries).length === 0) {
            return false;
        }

        console.log(
            `[WBAutoSelect] 🔧 "${name}" のサーバーファイルが空になっている → ` +
            `スナップショット(${Object.keys(snapshot.entries).length}件)で復元`
        );
        try {
            const headers = await getRequestHeadersSafe();
            const resp = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name, data: { entries: snapshot.entries } }),
            });
            return resp.ok;
        } catch (e) {
            console.warn(`${LOG} restore failed:`, e);
            return false;
        }
    }

    async function refreshWorldSelects() {
        let success = false;
        try {
            const ctx = getSTContext();
            if (ctx && typeof ctx.getSettings === 'function') {
                await ctx.getSettings();
                console.log(`${LOG} 📋 ctx.getSettings 実行成功`);
                success = true;
            }
        } catch (e) { console.warn(`${LOG} ctx.getSettings 失敗:`, e.message || e); }

        if (!success) {
            try {
                const mod = await import('../../../../world-info.js');
                if (typeof mod.loadWorldInfoList === 'function') {
                    await mod.loadWorldInfoList();
                    console.log(`${LOG} 📋 loadWorldInfoList 実行成功`);
                    success = true;
                }
            } catch (e) { console.warn(`${LOG} loadWorldInfoList 失敗:`, e.message || e); }
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
        const ed = document.querySelector('#world_editor_select');
        if (_findOptionValue(ed, name) !== null) return true;
        const wi = document.querySelector('#world_info');
        if (_findOptionValue(wi, name) !== null) return true;
        return false;
    }

    function _addOptionToSelectsIfMissing(name) {
        if (!name) return;
        const added = [];
        const ed = document.querySelector('#world_editor_select');
        if (ed && _findOptionValue(ed, name) === null) {
            const opt = document.createElement('option');
            opt.value = name; opt.textContent = name;
            ed.appendChild(opt); added.push('world_editor_select');
        }
        const wi = document.querySelector('#world_info');
        if (wi && _findOptionValue(wi, name) === null) {
            const opt = document.createElement('option');
            opt.value = name; opt.textContent = name;
            wi.appendChild(opt); added.push('world_info');
        }
        if (added.length > 0) {
            console.log(`${LOG} 📋 DOM に "${name}" option を直接注入: [${added.join(', ')}]`);
        }
    }

    function _removeStaleDomOption(name) {
        if (!name) return;
        let removed = 0;
        const ed = document.querySelector('#world_editor_select');
        if (ed) {
            for (const opt of Array.from(ed.options)) {
                const v = (opt.value || '').trim();
                const t = (opt.textContent || '').trim();
                if (v === name || t === name) {
                    try { opt.remove(); removed++; } catch (e) { /* ignore */ }
                }
            }
        }
        const wi = document.querySelector('#world_info');
        if (wi) {
            for (const opt of Array.from(wi.options)) {
                const v = (opt.value || '').trim();
                const t = (opt.textContent || '').trim();
                if (v === name || t === name) {
                    try { opt.remove(); removed++; } catch (e) { /* ignore */ }
                }
            }
        }
        if (removed > 0) console.log(`${LOG} 🧹 stale な DOM option を削除: "${name}" (${removed}件)`);
    }

    // ============================================================
    // 保護された値（Proxy + deepcopy）
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
            try {
                worldInfo[worldName] = { entries: JSON.parse(JSON.stringify(entries)) };
                return true;
            } catch (e) { return false; }
        }

        let realValue = _createProtectedValue({ entries });
        try {
            Object.defineProperty(worldInfo, worldName, {
                configurable: true,
                enumerable: true,
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
            try {
                worldInfo[worldName] = { entries: JSON.parse(JSON.stringify(entries)) };
                return true;
            } catch (e2) { return false; }
        }
    }

    function _ensureWorldInfoProtected(worldName, entries) {
        if (!worldName || !entries) return false;
        if (Object.keys(entries).length === 0) return false;

        _protectionTargets.set(worldName, { entries: JSON.parse(JSON.stringify(entries)) });

        const worldInfo = getWorldInfoInstance();
        if (!worldInfo) return false;

        const ok = _installProtectionOn(worldInfo, worldName, entries);
        if (ok) {
            _protectedWorlds.add(worldName);
            console.log(`${LOG} 🛡️ "${worldName}" の world_info 保護をインストール`);
        }
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
        const names = Object.keys(worldInfo);
        const broken = [];
        for (const name of names) {
            if (_shouldSkipValidateKey(name)) continue;
            const cur = worldInfo[name];
            const valid = cur && typeof cur === 'object'
                && cur.entries && Object.keys(cur.entries).length > 0;
            if (!valid) broken.push(name);
        }
        if (broken.length === 0) return;
        console.warn(`${LOG} ⚠️ 無効な world_info エントリを検出: [${broken.join(', ')}]`);
        for (const name of broken) {
            const fromServer = await fetchWorldbookFromServer(name);
            if (fromServer?.entries && Object.keys(fromServer.entries).length > 0) {
                _ensureWorldInfoProtected(name, fromServer.entries);
                console.log(`${LOG} 🩹 "${name}" をサーバーから復元`);
            } else {
                try {
                    delete worldInfo[name];
                    _protectedWorlds.delete(name);
                    _protectionTargets.delete(name);
                    console.log(`${LOG} 🧹 "${name}" を world_info から削除`);
                } catch (e) { /* ignore */ }
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
            _ensureWorldInfoProtected(worldName, existing.entries);
            _protectFromEmptySave(worldName, existing.entries);
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
                console.log(`${LOG} 📥 importWorldInfo で "${worldName}" を作成`);

                await wait(500);

                let verified = null;
                for (let i = 0; i < VERIFY_RETRY_MAX; i++) {
                    const fetched = await fetchWorldbookFromServer(worldName);
                    if (fetched && fetched.entries && Object.keys(fetched.entries).length > 0) {
                        const firstEntry = Object.values(fetched.entries)[0];
                        if (firstEntry && firstEntry.comment === '00_共通ルール') {
                            verified = fetched.entries;
                            break;
                        }
                    }
                    await wait(VERIFY_RETRY_DELAY_MS);
                }

                if (verified) {
                    // ★ v5: まず空保存防止ガードをセット（重要）
                    _protectFromEmptySave(worldName, verified);
                    _ensureWorldInfoProtected(worldName, verified);
                    await refreshWorldSelects();
                    _addOptionToSelectsIfMissing(worldName);
                    _ensureWorldInfoProtected(worldName, verified);
                    _protectFromEmptySave(worldName, verified);
                    console.log(
                        `${LOG} 🆕 ロアブック "${worldName}" を importWorldInfo 経由で作成完了 ` +
                        `(entries ${Object.keys(verified).length}件)`
                    );
                    return true;
                }
                console.warn(`${LOG} importWorldInfo 後のサーバー検証に失敗`);
            }
        } catch (e) {
            console.warn(`${LOG} importWorldInfo 失敗:`, e?.message || e);
        }

        // パターン B: createNewWorldInfo + /api/worldinfo/edit
        try {
            const mod = await import('../../../../world-info.js');
            if (typeof mod.createNewWorldInfo === 'function') {
                await mod.createNewWorldInfo(worldName);
                console.log(`${LOG} 📥 createNewWorldInfo で空の "${worldName}" を作成`);
                await wait(300);

                let editOk = false;
                for (let attempt = 1; attempt <= SAVE_RETRY_MAX; attempt++) {
                    try {
                        const headers = await getRequestHeadersSafe();
                        const resp = await fetch('/api/worldinfo/edit', {
                            method: 'POST', headers,
                            body: JSON.stringify({ name: worldName, data: { entries: newEntries } }),
                        });
                        if (resp.ok) { editOk = true; break; }
                    } catch (e) { /* ignore */ }
                    if (attempt < SAVE_RETRY_MAX) await wait(SAVE_RETRY_DELAY_MS);
                }

                if (editOk) {
                    let verified = null;
                    for (let i = 0; i < VERIFY_RETRY_MAX; i++) {
                        const fetched = await fetchWorldbookFromServer(worldName);
                        if (fetched && fetched.entries && Object.keys(fetched.entries).length > 0) {
                            const firstEntry = Object.values(fetched.entries)[0];
                            if (firstEntry && firstEntry.comment === '00_共通ルール') {
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
                        console.log(
                            `${LOG} 🆕 ロアブック "${worldName}" を createNewWorldInfo + edit で作成完了 ` +
                            `(entries ${Object.keys(verified).length}件)`
                        );
                        return true;
                    }
                }
            }
        } catch (e) { console.warn(`${LOG} createNewWorldInfo フォールバック失敗:`, e?.message || e); }

        // パターン C: 最終手段
        console.warn(`${LOG} importWorldInfo / createNewWorldInfo 共に失敗 → /api/worldinfo/edit のみで試行`);
        for (let attempt = 1; attempt <= SAVE_RETRY_MAX; attempt++) {
            try {
                const headers = await getRequestHeadersSafe();
                const resp = await fetch('/api/worldinfo/edit', {
                    method: 'POST', headers,
                    body: JSON.stringify({ name: worldName, data: { entries: newEntries } }),
                });
                if (resp.ok) {
                    const fetched = await fetchWorldbookFromServer(worldName);
                    if (fetched && fetched.entries && Object.keys(fetched.entries).length > 0) {
                        _protectFromEmptySave(worldName, fetched.entries);
                        _ensureWorldInfoProtected(worldName, fetched.entries);
                        await refreshWorldSelects();
                        _addOptionToSelectsIfMissing(worldName);
                        _ensureWorldInfoProtected(worldName, fetched.entries);
                        _protectFromEmptySave(worldName, fetched.entries);
                        console.log(`${LOG} 🆕 ロアブック "${worldName}" を edit のみで作成完了`);
                        return true;
                    }
                }
            } catch (e) { /* ignore */ }
            if (attempt < SAVE_RETRY_MAX) await wait(SAVE_RETRY_DELAY_MS);
        }

        console.warn(`${LOG} ロアブック "${worldName}" の作成に失敗しました`);
        return false;
    }

    async function _bindCharacterToWorld(char, worldName, force = false) {
        if (!char || !worldName) return false;
        if (!force && char.data?.extensions?.world === worldName) return true;

        const ok = await _ensureSpecificWorldReady(worldName);
        if (!ok) {
            console.warn(`${LOG} world_info["${worldName}"] が有効な entries を持たないため、バインドを中止`);
            return false;
        }

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
            if (resp.ok) {
                console.log(`${LOG} 🔗 キャラ "${char.name}" をロアブック "${worldName}" にバインド`);
                return true;
            }
            console.warn(`${LOG} merge-attributes HTTP ${resp.status}`);
            return false;
        } catch (e) { console.warn(LOG, '_bindCharacterToWorld error:', e); return false; }
    }

    async function _setEditTarget(name) {
        const $ = getJQuery();
        const ed = document.querySelector('#world_editor_select');
        if (!$ || !ed) return false;

        const ready = await _ensureSpecificWorldReady(name);
        if (!ready) {
            console.warn(`${LOG} _setEditTarget: "${name}" の entries を準備できません`);
            return false;
        }

        if (_findOptionValue(ed, name) === null) _addOptionToSelectsIfMissing(name);
        const value = _findOptionValue(ed, name);
        if (value === null) {
            console.debug(`${LOG} _setEditTarget: "${name}" の option が無い`);
            return false;
        }

        try {
            $(ed).val(value).trigger('change');
            console.log(`${LOG} 📋 world_editor_select を "${name}" に設定 (change 付き)`);
        } catch (e) { console.warn(LOG, '_setEditTarget change error:', e); return false; }

        const restore = () => {
            const wi = getWorldInfoInstance();
            if (!wi) return;
            const cur = wi[name];
            const valid = cur && typeof cur === 'object'
                && cur.entries && Object.keys(cur.entries).length > 0;
            if (!valid && _protectedWorlds.has(name)) {
                fetchWorldbookFromServer(name).then(d => {
                    if (d?.entries) _ensureWorldInfoProtected(name, d.entries);
                }).catch(() => {});
            }
        };
        setTimeout(restore, 300);
        setTimeout(restore, 1000);
        return true;
    }

    async function _setActive(name) {
        const $ = getJQuery();
        const wi = document.querySelector('#world_info');
        if (!$ || !wi) return false;

        const ok = await _ensureSpecificWorldReady(name);
        if (!ok) {
            console.warn(`${LOG} _setActive: "${name}" を準備できません`);
            return false;
        }

        if (_findOptionValue(wi, name) === null) _addOptionToSelectsIfMissing(name);
        const value = _findOptionValue(wi, name);
        if (value === null) {
            console.debug(`${LOG} _setActive: "${name}" の option が無い`);
            return false;
        }

        try {
            if (wi.hasAttribute('multiple')) $(wi).val([value]).trigger('change');
            else $(wi).val(value).trigger('change');
            console.log(`${LOG} 📋 world_info を "${name}" に設定 (change 付き)`);
        } catch (e) { console.warn(LOG, '_setActive error:', e); return false; }

        setTimeout(() => {
            try {
                const sel = Array.from(wi.selectedOptions || [])
                    .map(o => (o.value || '').trim()).filter(Boolean);
                if (!sel.includes(value)) {
                    console.warn(`${LOG} ⚠️ #world_info の選択が反映されていません: [${sel.join(', ')}]`);
                }
            } catch (e) { /* ignore */ }
        }, 500);
        return true;
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
                    if (fromServer?.entries) {
                        _ensureWorldInfoProtected(name, fromServer.entries);
                        console.log(
                            `${LOG} 🩹 self-heal: world_info["${name}"] を復元 ` +
                            `(${Object.keys(fromServer.entries).length}件)`
                        );
                    }
                } else if (!_protectedWorlds.has(name)) {
                    _ensureWorldInfoProtected(name, cur.entries);
                }
                break;
            }
        } catch (e) { /* ignore */ }
    }

    let _selfHealTimer = null;
    function startSelfHeal() {
        if (_selfHealTimer) return;
        _selfHealTimer = setInterval(() => {
            _repairCurrentCharWorld().catch(() => {});
            getWorldInfoInstance();
        }, SELF_HEAL_INTERVAL_MS);
        console.log(`${LOG} 🩹 定期自己修復を開始 (interval=${SELF_HEAL_INTERVAL_MS}ms)`);
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
            console.warn(`${LOG} 🛡️ ST 内部エラーを抑止 + 修復予約:`, msg.slice(0, 150));
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
                    const memoryValid = cur && typeof cur === 'object'
                        && cur.entries && Object.keys(cur.entries).length > 0;
                    if (!memoryValid) {
                        _ensureWorldInfoProtected(name, fromServer.entries);
                    }
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

    async function autoSelect(myToken, reason, options = {}) {
        const isStale = () => _generationToken !== myToken;

        const charAtStart = getCurrentChar();
        const charNameAtStart = charAtStart?.name || null;
        if (!charNameAtStart) {
            console.debug(LOG, `スキップ: キャラ未選択 (${reason})`);
            return;
        }

        const candidates = _getCharacterWorldCandidates(charAtStart);
        console.log(`${LOG} 開始: char="${charNameAtStart}", reason=${reason}, 候補=[${candidates.join(', ')}]`);

        try {
            let targetName = null;
            let wasCreated = false;

            for (let i = 0; i < FIND_RETRY_MAX; i++) {
                if (isStale()) {
                    console.debug(LOG, `中断: キャラ変更検出 (${charNameAtStart} → ${getCurrentCharName()})`);
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
                console.log(`${LOG} 🆕 ロアブック "${worldToCreate}" が存在しないため自動作成します`);
                const created = await _createWorldbookIfMissing(worldToCreate);
                if (!created) {
                    console.warn(`${LOG} ロアブック "${worldToCreate}" の作成に失敗しました`);
                    _recordFailure(charNameAtStart);
                    return;
                }
                wasCreated = true;

                const bound = await _bindCharacterToWorld(charAtStart, worldToCreate);
                if (!bound) {
                    console.warn(`${LOG} ロアブック "${worldToCreate}" へのバインドに失敗しました`);
                    _recordFailure(charNameAtStart);
                    return;
                }

                await wait(300);
                for (let i = 0; i < FIND_RETRY_MAX; i++) {
                    if (_hasWorldBookInDOM(worldToCreate)) {
                        targetName = worldToCreate;
                        break;
                    }
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
                        console.warn(`${LOG} ロアブック "${worldToCreate}" が見つかりません`);
                        _recordFailure(charNameAtStart);
                        return;
                    }
                }
            }

            if (isStale()) {
                console.log(`${LOG} キャラ切替検出のため UI 反映スキップ`);
                return;
            }

            const sameChar = (_lastProcessedChar === charNameAtStart);
            if (!options.force && sameChar && reason !== 'chat-changed' && !wasCreated) {
                console.debug(LOG, `同一キャラ "${charNameAtStart}" のためスキップ`);
                return;
            }

            const editOk = await _setEditTarget(targetName);
            await wait(APPLY_DELAY_MS);
            if (isStale()) return;
            const activeOk = await _setActive(targetName);

            if (isStale()) return;

            // ★ v5: change 後の安全網 - サーバーファイルが空になっていないか検証
            setTimeout(() => {
                _verifyAndRestoreServerFile(targetName).catch(() => {});
            }, VERIFY_AFTER_CHANGES_DELAY_MS);

            if (editOk || activeOk) {
                console.log(
                    `${LOG} 🔖 ロアブック "${targetName}" を自動選択 ` +
                    `(編集=${editOk}, アクティブ=${activeOk}, reason=${reason})`
                );
                if (targetName === charNameAtStart) {
                    const currentExt = charAtStart.data?.extensions?.world;
                    if (currentExt !== targetName) {
                        console.log(`${LOG} 🔄 char.extensions.world を "${targetName}" に同期`);
                        await _bindCharacterToWorld(charAtStart, targetName, true);
                    }
                }
                _lastProcessedChar = charNameAtStart;
                _lastFailure = { char: null, at: 0 };
            } else {
                console.warn(`${LOG} ロアブック "${targetName}" の選択に失敗 → 再作成を試行`);
                const recreated = await _createWorldbookIfMissing(targetName);
                if (recreated) {
                    await wait(300);
                    const editOk2 = await _setEditTarget(targetName);
                    await wait(APPLY_DELAY_MS);
                    if (isStale()) return;
                    const activeOk2 = await _setActive(targetName);
                    if (isStale()) return;
                    setTimeout(() => {
                        _verifyAndRestoreServerFile(targetName).catch(() => {});
                    }, VERIFY_AFTER_CHANGES_DELAY_MS);

                    if (editOk2 || activeOk2) {
                        if (targetName === charNameAtStart) {
                            const currentExt = charAtStart.data?.extensions?.world;
                            if (currentExt !== targetName) {
                                await _bindCharacterToWorld(charAtStart, targetName, true);
                            }
                        }
                        _lastProcessedChar = charNameAtStart;
                        _lastFailure = { char: null, at: 0 };
                        console.log(
                            `${LOG} 🔖 (再作成後) ロアブック "${targetName}" を自動選択 ` +
                            `(編集=${editOk2}, アクティブ=${activeOk2})`
                        );
                        return;
                    }
                }
                console.warn(`${LOG} ロアブック "${targetName}" の選択・作成に失敗しました`);
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
            if (!currentChar) return;
            if (currentChar === charName) {
                console.log(`${LOG} 🔄 失敗リトライ: char="${currentChar}"`);
                scheduleAutoSelect('retry-after-failure', { force: true });
            }
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
        if (installed > 0) console.log(LOG, `イベントリスナーを ${installed} 件登録`);
        return installed > 0;
    }

    async function init() {
        let waited = 0;
        while (!getSTContext() && waited < 10000) {
            await wait(200);
            waited += 200;
        }
        setupEventListeners();
        startSelfHeal();
        setTimeout(() => scheduleAutoSelect('initial'), 1500);
        console.log(LOG, '初期化完了');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // ============================================================
    // デバッグ用 API
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
        getProtectionTargets: () => Array.from(_protectionTargets.keys()),
        getEmptySaveGuards: () => {
            const out = {};
            for (const [k, v] of _emptySaveGuards.entries()) {
                out[k] = { until: v.until, entryCount: Object.keys(v.entries || {}).length };
            }
            return out;
        },
        protectFromEmptySave: (name, entries) => _protectFromEmptySave(name, entries),
        verifyAndRestoreServerFile: (name) => _verifyAndRestoreServerFile(name || getCurrentCharName()),
        getCharacterWorldCandidates: () => _getCharacterWorldCandidates(getCurrentChar()),
        createWorldbook: (name) => _createWorldbookIfMissing(name || getCurrentCharName()),
        verifyWorldbookOnServer: (name) => _verifyWorldbookOnServer(name || getCurrentCharName()),
        fetchWorldbook: (name) => fetchWorldbookFromServer(name || getCurrentCharName()),
        refreshWorldSelects,
        validateAllWorldInfoEntries: _validateAllWorldInfoEntries,
        sanitizeWorldInfo: _sanitizeWorldInfoObject,
        bindCharacter: async (worldName, force) => {
            const char = getCurrentChar();
            return _bindCharacterToWorld(char, worldName || getCurrentCharName(), !!force);
        },
        repairCurrentCharWorld: () => _repairCurrentCharWorld(),
        removeStaleDomOption: (name) => _removeStaleDomOption(name || getCurrentCharName()),
        checkInstanceChange: () => {
            getWorldInfoInstance();
            return {
                instance: _lastWorldInfoInstance,
                protectionTargets: Array.from(_protectionTargets.keys()),
            };
        },
        inspectWorldbook: async (worldName) => {
            const name = worldName || getCurrentCharName();
            if (!name) return { error: 'no worldName' };
            const fromServer = await fetchWorldbookFromServer(name);
            const worldInfo = getWorldInfoInstance();
            const fromMemory = worldInfo?.[name];
            let ctxWorldNames = null, modWorldNames = null;
            try {
                const ctx = getSTContext();
                ctxWorldNames = Array.isArray(ctx?.world_names) ? ctx.world_names.slice() : null;
            } catch (e) { /* ignore */ }
            try {
                const mod = await import('../../../../world-info.js');
                modWorldNames = Array.isArray(mod.world_names) ? mod.world_names.slice() : null;
            } catch (e) { /* ignore */ }
            return {
                worldName: name,
                protected: _protectedWorlds.has(name),
                protectionTargetExists: _protectionTargets.has(name),
                emptySaveGuardExists: _emptySaveGuards.has(name),
                serverFileExists: !!fromServer,
                serverEntryCount: fromServer ? Object.keys(fromServer.entries || {}).length : 0,
                memoryExists: !!fromMemory,
                memoryEntryCount: fromMemory?.entries ? Object.keys(fromMemory.entries).length : 0,
                domHasEditorOption: _findOptionValue(document.querySelector('#world_editor_select'), name) !== null,
                domHasActiveOption: _findOptionValue(document.querySelector('#world_info'), name) !== null,
                inCtxWorldNames: ctxWorldNames?.includes(name) ?? null,
                inModWorldNames: modWorldNames?.includes(name) ?? null,
            };
        },
        repairEmptyWorldbook: async (worldName) => {
            const name = worldName || getCurrentCharName();
            if (!name) return { error: 'no worldName' };
            const created = await _createWorldbookIfMissing(name);
            return { worldName: name, created };
        },
        fixCorruptedBindings: async () => {
            const ctx = getSTContext();
            const chars = ctx?.characters || [];
            const results = [];
            for (const char of chars) {
                const extW = char.data?.extensions?.world;
                if (extW && extW !== char.name) {
                    const hasNameWorld = await _verifyWorldbookOnServer(char.name);
                    if (hasNameWorld) {
                        const ok = await _bindCharacterToWorld(char, char.name, true);
                        results.push({ char: char.name, oldWorld: extW, newWorld: char.name, ok });
                    } else {
                        results.push({
                            char: char.name, oldWorld: extW, newWorld: char.name,
                            ok: false, reason: 'char.name のロアブックが存在しません',
                        });
                    }
                }
            }
            console.log(`${LOG} 🧹 汚染修復結果:`, results);
            return results;
        },
        cleanupStaleMemory: async () => {
            const worldInfo = getWorldInfoInstance();
            if (!worldInfo) return { cleaned: 0 };
            const names = Object.keys(worldInfo);
            let cleaned = 0;
            for (const name of names) {
                if (_shouldSkipValidateKey(name)) continue;
                const serverHas = await _verifyWorldbookOnServer(name);
                if (!serverHas) {
                    console.warn(`${LOG} 🧹 stale メモリを削除: "${name}"`);
                    try {
                        delete worldInfo[name];
                        _protectedWorlds.delete(name);
                        _protectionTargets.delete(name);
                        _emptySaveGuards.delete(name);
                        cleaned++;
                    } catch (e) { /* ignore */ }
                }
            }
            return { cleaned, total: names.length };
        },
        diagnose: async () => {
            const ctx = getSTContext();
            const worldInfoCtx = ctx?.world_info;
            const worldInfoWin = window.world_info;
            const headers = await getRequestHeadersSafe();
            const worldInfo = worldInfoCtx || worldInfoWin;
            return {
                hasCtxWorldInfo: !!worldInfoCtx,
                hasWinWorldInfo: !!worldInfoWin,
                ctxIsJQuery: !!(worldInfoCtx && worldInfoCtx.jquery),
                winIsJQuery: !!(worldInfoWin && worldInfoWin.jquery),
                sameInstance: worldInfoCtx === worldInfoWin,
                lastInstanceMatch: _lastWorldInfoInstance === worldInfo,
                worldInfoKeys: worldInfo ? Object.keys(worldInfo).slice(0, 30) : [],
                protectionTargets: Array.from(_protectionTargets.keys()),
                protectedWorlds: Array.from(_protectedWorlds),
                emptySaveGuards: Array.from(_emptySaveGuards.keys()),
                hasCsrfToken: !!(headers['X-CSRF-Token']),
                currentToken: _generationToken,
                lastProcessedChar: _lastProcessedChar,
                lastFailure: _lastFailure,
                warnedMismatch: Array.from(_warnedMismatch),
            };
        },
        resetProcessed: () => {
            _lastProcessedChar = null;
            _lastFailure = { char: null, at: 0 };
            _warnedMismatch.clear();
            if (_retryTimer) { clearTimeout(_retryTimer); _retryTimer = null; }
        },
    };
})();
