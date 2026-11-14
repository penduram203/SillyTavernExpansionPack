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
//
// ★ v6 修正（3層防御でレース条件を完全に封じる）:
//   Layer 1: /api/worldinfo/edit インターセプタ
//     - 直近に作成した world への「空エントリ保存」を無条件でブロック
//     - 直近 = guard.createdAt から RECENT_WINDOW_MS (5秒) 以内
//     - それ以降は editorWorld === name の時のみ素通し（ユーザー明示削除を尊重）
//   Layer 2: 作成リトライ + direct edit フォールバック
//     - _createWorldbookIfMissing は最大3回リトライ
//     - 2回目以降は importWorldInfo をスキップし、
//       /api/worldinfo/edit を直接叩いて ST の change サイクルを回避
//     - 各試行後 1〜2 秒待ってサーバーファイルを検証
//   Layer 3: 定期ポーリング復元（自己修復ループ内）
//     - 有効なガードがある world について、サーバーファイルとメモリを毎秒チェック
//     - 空になっていたらガードのスナップショットで復元
//
// ★ v4 から継続:
//   - Object.defineProperty + Proxy + deepcopy でメモリ上の entries を保護
//   - インスタンス変化を検知して自動再インストール

console.log('[WBAutoSelect] 📦 v6 module loading...');

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
    const APPLY_DELAY_MS = 500;
    const SELF_HEAL_INTERVAL_MS = 1000;
    const EMPTY_SAVE_GUARD_MS = 30000;
    const RECENT_SAVE_WINDOW_MS = 5000;   // v6: 直近作成から5秒間は無条件ブロック
    const VERIFY_AFTER_CHANGES_DELAY_MS = 2000;
    const CREATION_MAX_ATTEMPTS = 3;      // v6: リトライ回数
    const MEMORY_POLL_INTERVAL_MS = 1000; // v6: メモリ復元チェック間隔
    const SERVER_POLL_INTERVAL_MS = 3000; // v6: サーバー復元チェック間隔

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

    const _protectionTargets = new Map();
    let _lastWorldInfoInstance = null;

    // v6: guard に createdAt / lastServerCheckAt / lastMemoryCheckAt を持たせる
    const _emptySaveGuards = new Map();

    // ★ v6: インターセプタのログ出力用に、fetch を差し替え済みか記録
    let _interceptorInstalled = false;
    let _lastInterceptorHit = 0;

    // ============================================================
    // ★ v6 Layer 1: /api/worldinfo/edit インターセプタ（強化版）
    // ============================================================
    (function installWorldInfoEditInterceptor() {
        if (window.__wbAutoSelectFetchPatched) {
            console.log('[WBAutoSelect] 🛡️ interceptor already installed (skip)');
            return;
        }
        window.__wbAutoSelectFetchPatched = true;

        const originalFetch = window.fetch;
        window.__wbAutoSelectOriginalFetch = originalFetch;

        window.fetch = function(input, init) {
            // ★ URL 判定
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (!url.includes('/api/worldinfo/edit')) {
                return originalFetch.apply(this, arguments);
            }

            // ★ body 判定（文字列以外はそのまま通す）
            if (!init || typeof init.body !== 'string') {
                return originalFetch.apply(this, arguments);
            }

            let body;
            try {
                body = JSON.parse(init.body);
            } catch (e) {
                return originalFetch.apply(this, arguments);
            }

            const name = body?.name;
            if (!name) return originalFetch.apply(this, arguments);

            const guard = _emptySaveGuards.get(name);
            if (!guard) {
                // ガードなし → 素通し（ただしログだけ）
                const incomingEmpty = !body?.data?.entries
                    || Object.keys(body.data.entries || {}).length === 0;
                if (incomingEmpty) {
                    console.log(
                        `[WBAutoSelect] (no guard) empty save detected for "${name}" (allowed)`
                    );
                }
                return originalFetch.apply(this, arguments);
            }

            if (Date.now() > guard.until) {
                _emptySaveGuards.delete(name);
                return originalFetch.apply(this, arguments);
            }

            const incomingEntries = body?.data?.entries;
            const incomingIsEmpty = !incomingEntries
                || (typeof incomingEntries === 'object'
                    && Object.keys(incomingEntries).length === 0);

            if (!incomingIsEmpty) {
                // 正当な非空保存 → スナップショットを更新
                guard.entries = JSON.parse(JSON.stringify(incomingEntries));
                return originalFetch.apply(this, arguments);
            }

            // incoming が空 → ブロック判定
            if (!guard.entries || Object.keys(guard.entries).length === 0) {
                // ガードのスナップショットも空 → 通す（既に空を許容している）
                return originalFetch.apply(this, arguments);
            }

            const guardAge = Date.now() - (guard.createdAt || 0);
            const editorWorld = (document.querySelector('#world_editor_select')?.value || '').trim();

            // ★ Layer 1 の肝: 直近 5 秒以内の作成なら editor 状態に関係なくブロック
            if (guardAge < RECENT_SAVE_WINDOW_MS) {
                console.warn(
                    `[WBAutoSelect] 🛡️ empty save BLOCKED for "${name}" ` +
                    `(guard age=${guardAge}ms, editor="${editorWorld}", ` +
                    `snapshot=${Object.keys(guard.entries).length} entries)`
                );
                _lastInterceptorHit = Date.now();
                const newBody = {
                    ...body,
                    data: {
                        ...(body.data || {}),
                        entries: JSON.parse(JSON.stringify(guard.entries)),
                    },
                };
                return originalFetch.call(this, input, { ...init, body: JSON.stringify(newBody) });
            }

            // 一定時間経過後は editorWorld === name なら素通し（ユーザー明示削除）
            if (editorWorld === name) {
                console.log(
                    `[WBAutoSelect] (user explicit) empty save allowed for "${name}" ` +
                    `(editor matches, guard age=${guardAge}ms)`
                );
                guard.entries = {};
                return originalFetch.apply(this, arguments);
            }

            // editor が別の world を指している → ST 内部のレースとみなしてブロック
            console.warn(
                `[WBAutoSelect] 🛡️ empty save BLOCKED for "${name}" ` +
                `(editor="${editorWorld}", guard age=${guardAge}ms)`
            );
            _lastInterceptorHit = Date.now();
            const newBody = {
                ...body,
                data: {
                    ...(body.data || {}),
                    entries: JSON.parse(JSON.stringify(guard.entries)),
                },
            };
            return originalFetch.call(this, input, { ...init, body: JSON.stringify(newBody) });
        };

        _interceptorInstalled = true;
        console.log('[WBAutoSelect] 🛡️ Layer1: /api/worldinfo/edit interceptor INSTALLED');
    })();

    // ============================================================
    // v6: ガード設定（createdAt 付き）
    // ============================================================
    function _protectFromEmptySave(name, entries, durationMs = EMPTY_SAVE_GUARD_MS) {
        if (!name || !entries) return;
        if (Object.keys(entries).length === 0) return;
        const existing = _emptySaveGuards.get(name);
        const createdAt = existing?.createdAt || Date.now();
        _emptySaveGuards.set(name, {
            createdAt,
            until: Date.now() + durationMs,
            entries: JSON.parse(JSON.stringify(entries)),
            lastServerCheckAt: 0,
            lastMemoryCheckAt: 0,
        });
        console.log(`[WBAutoSelect] 🛡️ guard for "${name}" activated (${durationMs}ms)`);
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
        if (!wi) return;
        if (_protectionTargets.size === 0) return;
        const targets = Array.from(_protectionTargets.entries());
        let reinstalled = 0;
        for (const [name, data] of targets) {
            if (_installProtectionOn(wi, name, data.entries)) reinstalled++;
        }
        console.log(
            `${LOG} 🔄 world_info instance changed → ${reinstalled}/${targets.length} protections reinstalled`
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
        if (removed > 0) console.log(`${LOG} 🧹 removed ${removed} invalid keys`);
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
                console.log(`${LOG} 📋 ctx.getSettings OK`);
                success = true;
            }
        } catch (e) { console.warn(`${LOG} getSettings failed:`, e.message || e); }
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
            ed.appendChild(opt); added.push('editor');
        }
        const wi = document.querySelector('#world_info');
        if (wi && _findOptionValue(wi, name) === null) {
            const opt = document.createElement('option');
            opt.value = name; opt.textContent = name;
            wi.appendChild(opt); added.push('info');
        }
        if (added.length > 0) console.log(`${LOG} 📋 injected option "${name}" to [${added.join(', ')}]`);
    }
    function _removeStaleDomOption(name) {
        if (!name) return;
        let removed = 0;
        for (const sel of ['#world_editor_select', '#world_info']) {
            const el = document.querySelector(sel);
            if (!el) continue;
            for (const opt of Array.from(el.options)) {
                const v = (opt.value || '').trim();
                const t = (opt.textContent || '').trim();
                if (v === name || t === name) {
                    try { opt.remove(); removed++; } catch (e) { /* ignore */ }
                }
            }
        }
        if (removed > 0) console.log(`${LOG} 🧹 removed ${removed} stale options for "${name}"`);
    }

    // ============================================================
    // メモリ保護（Proxy + deepcopy）
    // ============================================================
    function _createProtectedValue(data) {
        if (!data || typeof data !== 'object') return data;
        const copy = JSON.parse(JSON.stringify(data));
        try {
            if (typeof Proxy === 'function') {
                return new Proxy(copy, {
                    set(target, prop, value) {
                        if (prop === 'entries') {
                            if (!value || typeof value !== 'object') {
                                console.warn(`[WBAutoSelect] 🛡️ blocked invalid entries write`);
                                return true;
                            }
                            if (Object.keys(value).length === 0) {
                                console.warn(`[WBAutoSelect] 🛡️ blocked empty entries write`);
                                return true;
                            }
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
                configurable: true, enumerable: true,
                get() { return realValue; },
                set(v) {
                    if (v === null || v === undefined) return;
                    if (v && typeof v === 'object' && v.entries
                        && Object.keys(v.entries).length > 0) {
                        realValue = _createProtectedValue(v);
                        return;
                    }
                    console.warn(`[WBAutoSelect] 🛡️ blocked invalid world_info assignment for "${worldName}"`);
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
        console.warn(`${LOG} ⚠️ invalid entries detected: [${broken.join(', ')}]`);
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

    // ============================================================
    // ★ v6 Layer 2: 1回分の作成試行
    //   useDirectEdit=true なら importWorldInfo をスキップして
    //   /api/worldinfo/edit を直接叩く（ST の change サイクルを回避）
    // ============================================================
    async function _createWorldbookAttempt(worldName, options = {}) {
        const { useDirectEdit = false } = options;
        const newEntries = { 0: _createCommonRuleEntry(0) };

        // ★ direct edit モード: ST を介さずに直接ファイル書き込み
        if (useDirectEdit) {
            console.log(`${LOG} 📥 direct edit for "${worldName}" (bypass ST)`);
            const ok = await _directEditWorldbook(worldName, newEntries);
            if (!ok) return false;
            _protectFromEmptySave(worldName, newEntries);
            _ensureWorldInfoProtected(worldName, newEntries);
            return true;
        }

        // ★ 通常モード: importWorldInfo 経由
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
                    if (fetched && fetched.entries && Object.keys(fetched.entries).length > 0) {
                        const first = Object.values(fetched.entries)[0];
                        if (first && first.comment === '00_共通ルール') {
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
                console.warn(`${LOG} importWorldInfo verification failed`);
            }
        } catch (e) {
            console.warn(`${LOG} importWorldInfo failed:`, e?.message || e);
        }

        // フォールバック A: createNewWorldInfo + edit
        try {
            const mod = await import('../../../../world-info.js');
            if (typeof mod.createNewWorldInfo === 'function') {
                await mod.createNewWorldInfo(worldName);
                await wait(300);
                const ok = await _directEditWorldbook(worldName, newEntries);
                if (ok) {
                    let verified = null;
                    for (let i = 0; i < VERIFY_RETRY_MAX; i++) {
                        const fetched = await fetchWorldbookFromServer(worldName);
                        if (fetched && fetched.entries && Object.keys(fetched.entries).length > 0) {
                            verified = fetched.entries;
                            break;
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
            }
        } catch (e) { console.warn(`${LOG} createNewWorldInfo fallback failed:`, e?.message || e); }

        // フォールバック B: direct edit のみ
        const ok = await _directEditWorldbook(worldName, newEntries);
        if (ok) {
            const verified = await fetchWorldbookFromServer(worldName);
            if (verified?.entries && Object.keys(verified.entries).length > 0) {
                _protectFromEmptySave(worldName, verified.entries);
                _ensureWorldInfoProtected(worldName, verified.entries);
                await refreshWorldSelects();
                _addOptionToSelectsIfMissing(worldName);
                _ensureWorldInfoProtected(worldName, verified.entries);
                _protectFromEmptySave(worldName, verified.entries);
                return true;
            }
        }

        return false;
    }

    // ============================================================
    // ★ v6 Layer 2: 作成リトライ
    //   各試行後 1〜2 秒待ってサーバーファイルを検証。
    //   空になっていたら次の試行へ。
    // ============================================================
    async function _createWorldbookIfMissing(worldName) {
        if (!worldName) return false;

        // 既存チェック
        const existing = await fetchWorldbookFromServer(worldName);
        if (existing && existing.entries && Object.keys(existing.entries).length > 0) {
            _protectFromEmptySave(worldName, existing.entries);
            _ensureWorldInfoProtected(worldName, existing.entries);
            return true;
        }

        for (let attempt = 1; attempt <= CREATION_MAX_ATTEMPTS; attempt++) {
            const useDirectEdit = attempt > 1;
            console.log(
                `${LOG} 🆕 creation attempt ${attempt}/${CREATION_MAX_ATTEMPTS} for "${worldName}" ` +
                `(directEdit=${useDirectEdit})`
            );

            const created = await _createWorldbookAttempt(worldName, { useDirectEdit });
            if (!created) {
                console.warn(`${LOG} attempt ${attempt} failed to create`);
                continue;
            }

            // ★ ST の change サイクルが空保存を起こす可能性があるので待つ
            await wait(1000 + (attempt - 1) * 500);

            const verified = await _verifyWorldbookOnServer(worldName);
            if (verified) {
                console.log(`${LOG} ✅ "${worldName}" attempt ${attempt} SUCCEEDED`);
                return true;
            }

            console.warn(
                `${LOG} ⚠️ "${worldName}" attempt ${attempt} resulted in EMPTY file, retrying...`
            );
        }

        console.error(`${LOG} ❌ "${worldName}" creation FAILED after ${CREATION_MAX_ATTEMPTS} attempts`);
        return false;
    }

    async function _bindCharacterToWorld(char, worldName, force = false) {
        if (!char || !worldName) return false;
        if (!force && char.data?.extensions?.world === worldName) return true;
        const ok = await _ensureSpecificWorldReady(worldName);
        if (!ok) {
            console.warn(`${LOG} bind aborted: "${worldName}" not ready`);
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
                console.log(`${LOG} 🔗 bound "${char.name}" → "${worldName}"`);
                return true;
            }
            return false;
        } catch (e) { return false; }
    }

    async function _setEditTarget(name) {
        const $ = getJQuery();
        const ed = document.querySelector('#world_editor_select');
        if (!$ || !ed) return false;
        const ready = await _ensureSpecificWorldReady(name);
        if (!ready) { console.warn(`${LOG} _setEditTarget: "${name}" not ready`); return false; }
        if (_findOptionValue(ed, name) === null) _addOptionToSelectsIfMissing(name);
        const value = _findOptionValue(ed, name);
        if (value === null) return false;
        try {
            $(ed).val(value).trigger('change');
            console.log(`${LOG} 📋 editor → "${name}"`);
        } catch (e) { return false; }
        setTimeout(() => {
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
        }, 300);
        setTimeout(() => {
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
        }, 1000);
        return true;
    }

    async function _setActive(name) {
        const $ = getJQuery();
        const wi = document.querySelector('#world_info');
        if (!$ || !wi) return false;
        const ok = await _ensureSpecificWorldReady(name);
        if (!ok) return false;
        if (_findOptionValue(wi, name) === null) _addOptionToSelectsIfMissing(name);
        const value = _findOptionValue(wi, name);
        if (value === null) return false;
        try {
            if (wi.hasAttribute('multiple')) $(wi).val([value]).trigger('change');
            else $(wi).val(value).trigger('change');
            console.log(`${LOG} 📋 active → "${name}"`);
        } catch (e) { return false; }
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
                        console.log(`${LOG} 🩹 self-heal: "${name}" restored`);
                    }
                } else if (!_protectedWorlds.has(name)) {
                    _ensureWorldInfoProtected(name, cur.entries);
                }
                break;
            }
        } catch (e) { /* ignore */ }
    }

    // ============================================================
    // ★ v6 Layer 3: ガード付き world のポーリング復元
    //   メモリとサーバーの両方をチェック
    // ============================================================
    function _pollGuardedWorldsMemory() {
        const worldInfo = getWorldInfoInstance();
        if (!worldInfo) return;
        const now = Date.now();
        for (const [name, guard] of _emptySaveGuards.entries()) {
            if (now > guard.until) continue;
            if (!guard.entries || Object.keys(guard.entries).length === 0) continue;
            if (guard.lastMemoryCheckAt && now - guard.lastMemoryCheckAt < MEMORY_POLL_INTERVAL_MS) continue;
            guard.lastMemoryCheckAt = now;
            const cur = worldInfo[name];
            const isEmpty = !cur || !cur.entries || Object.keys(cur.entries).length === 0;
            if (isEmpty) {
                console.warn(`${LOG} 🩹 memory poll: "${name}" empty → restoring from guard`);
                _ensureWorldInfoProtected(name, guard.entries);
            }
        }
    }

    async function _pollGuardedWorldsServer() {
        const now = Date.now();
        for (const [name, guard] of Array.from(_emptySaveGuards.entries())) {
            if (now > guard.until) {
                _emptySaveGuards.delete(name);
                continue;
            }
            if (!guard.entries || Object.keys(guard.entries).length === 0) continue;
            if (guard.lastServerCheckAt && now - guard.lastServerCheckAt < SERVER_POLL_INTERVAL_MS) continue;
            guard.lastServerCheckAt = now;

            const verified = await _verifyWorldbookOnServer(name);
            if (verified) continue;

            console.warn(`${LOG} 🩹 server poll: "${name}" empty → restoring from guard`);
            const ok = await _directEditWorldbook(name, guard.entries);
            if (ok) {
                _ensureWorldInfoProtected(name, guard.entries);
                console.log(`${LOG} 🩹 server poll: "${name}" restored successfully`);
            } else {
                console.warn(`${LOG} 🩹 server poll: "${name}" restore FAILED`);
            }
        }
    }

    let _selfHealTimer = null;
    function startSelfHeal() {
        if (_selfHealTimer) return;
        _selfHealTimer = setInterval(() => {
            _repairCurrentCharWorld().catch(() => {});
            _pollGuardedWorldsMemory();
            _pollGuardedWorldsServer().catch(() => {});
            getWorldInfoInstance();
        }, SELF_HEAL_INTERVAL_MS);
        console.log(`${LOG} 🩹 self-heal loop started (interval=${SELF_HEAL_INTERVAL_MS}ms)`);
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
            console.warn(`${LOG} 🛡️ ST internal error suppressed:`, msg.slice(0, 150));
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

            if (isStale()) return;

            // ★ v6: change 後の安全網を複数タイミングで実行
            [1000, 3000, 6000].forEach((delay) => {
                setTimeout(() => {
                    _pollGuardedWorldsServer().catch(() => {});
                }, delay);
            });

            if (editOk || activeOk) {
                console.log(
                    `${LOG} 🔖 selected "${targetName}" (edit=${editOk}, active=${activeOk})`
                );
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
                    if (isStale()) return;
                    const activeOk2 = await _setActive(targetName);
                    if (editOk2 || activeOk2) {
                        if (targetName === charNameAtStart) {
                            const currentExt = charAtStart.data?.extensions?.world;
                            if (currentExt !== targetName) {
                                await _bindCharacterToWorld(charAtStart, targetName, true);
                            }
                        }
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
            if (!currentChar) return;
            if (currentChar === charName) {
                console.log(`${LOG} 🔄 retry: char="${currentChar}"`);
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
        if (installed > 0) console.log(LOG, `registered ${installed} event listeners`);
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
        console.log(LOG, 'init complete');
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
                out[k] = {
                    createdAt: v.createdAt,
                    until: v.until,
                    age: Date.now() - v.createdAt,
                    entryCount: Object.keys(v.entries || {}).length,
                };
            }
            return out;
        },
        isInterceptorInstalled: () => _interceptorInstalled,
        getLastInterceptorHit: () => _lastInterceptorHit,
        protectFromEmptySave: (name, entries) => _protectFromEmptySave(name, entries),
        verifyAndRestoreServerFile: (name) => _pollGuardedWorldsServer(),
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
            };
        },
        repairEmptyWorldbook: async (worldName) => {
            const name = worldName || getCurrentCharName();
            if (!name) return { error: 'no worldName' };
            const created = await _createWorldbookIfMissing(name);
            return { worldName: name, created };
        },
        diagnose: async () => {
            const ctx = getSTContext();
            const worldInfoCtx = ctx?.world_info;
            const worldInfoWin = window.world_info;
            const headers = await getRequestHeadersSafe();
            const worldInfo = worldInfoCtx || worldInfoWin;
            return {
                interceptorInstalled: _interceptorInstalled,
                lastInterceptorHit: _lastInterceptorHit,
                fetchPatched: !!window.__wbAutoSelectFetchPatched,
                hasCtxWorldInfo: !!worldInfoCtx,
                hasWinWorldInfo: !!worldInfoWin,
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
