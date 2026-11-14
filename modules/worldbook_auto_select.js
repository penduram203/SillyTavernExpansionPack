// worldbook_auto_select.js
// キャラクター切替時に、キャラに関連付けられたロアブックを自動選択する。
// ロアブックが存在しない場合はキャラ名と同じロアブックを自動作成し、
// キャラクターとバインド（char.data.extensions.world）する。
//
// ★ world_info 保護:
//   - Object.defineProperty で setter を上書きし、boolean/null/空オブジェクト
//     の書き込みを拒否する。
//   - jQuery オブジェクト / 配列は world_info として扱わない。
//
// ★ _validateAllWorldInfoEntries:
//   - 数値キー ("0", "1") と jQuery/sizzle expando キーはスキップ
//   - 呼び出しは unhandledrejection ハンドラのみ（critical path から外す）
//
// ★ _setActive / _setEditTarget:
//   - 一括検証は呼ばない。特定ワールドのみ検証してから change を発火
//   - ST の onWorldInfoChange / onWorldEditorSelectChange が正常動作する

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
    const APPLY_DELAY_MS = 200;
    const SELF_HEAL_INTERVAL_MS = 2000;

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
    // ★ world_info インスタンス取得（jQuery / 配列を拒否）
    // ============================================================
    function isPlainWorldInfoObject(x) {
        if (!x || typeof x !== 'object') return false;
        if (x.jquery) return false;        // jQuery オブジェクト
        if (Array.isArray(x)) return false; // 配列
        return true;
    }

    function getWorldInfoInstance() {
        try {
            const ctx = getSTContext();
            if (isPlainWorldInfoObject(ctx?.world_info)) {
                return ctx.world_info;
            }
        } catch (e) { /* ignore */ }

        if (isPlainWorldInfoObject(window.world_info)) {
            return window.world_info;
        }
        return null;
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
        } catch (e) {
            console.warn(`${LOG} ctx.getSettings 失敗:`, e.message || e);
        }

        if (!success) {
            try {
                const mod = await import('../../../../world-info.js');
                if (typeof mod.loadWorldInfoList === 'function') {
                    await mod.loadWorldInfoList();
                    console.log(`${LOG} 📋 loadWorldInfoList 実行成功`);
                    success = true;
                }
            } catch (e) {
                console.warn(`${LOG} loadWorldInfoList 失敗:`, e.message || e);
            }
        }

        return success;
    }

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
            if (data?.entries && Object.keys(data.entries).length > 0) {
                return data;
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    async function _verifyWorldbookOnServer(worldName) {
        if (!worldName) return false;
        const data = await fetchWorldbookFromServer(worldName);
        if (!data || !data.entries) return false;
        return Object.keys(data.entries).length > 0;
    }

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

    function _ensureWorldInfoProtected(worldName, entries) {
        if (!worldName || !entries) return false;
        if (Object.keys(entries).length === 0) return false;

        const worldInfo = getWorldInfoInstance();
        if (!worldInfo) return false;

        const desc = Object.getOwnPropertyDescriptor(worldInfo, worldName);
        if (desc && typeof desc.get === 'function' && typeof desc.set === 'function') {
            try {
                worldInfo[worldName] = { entries: JSON.parse(JSON.stringify(entries)) };
                _protectedWorlds.add(worldName);
                return true;
            } catch (e) {
                return false;
            }
        }

        let realValue = { entries: JSON.parse(JSON.stringify(entries)) };

        try {
            Object.defineProperty(worldInfo, worldName, {
                configurable: true,
                enumerable: true,
                get() { return realValue; },
                set(v) {
                    if (v && typeof v === 'object' && v.entries && Object.keys(v.entries).length > 0) {
                        realValue = v;
                    } else if (v === null || v === undefined) {
                        // ignore
                    } else if (typeof v === 'boolean') {
                        // ignore
                    } else if (typeof v === 'object' && (!v.entries || Object.keys(v.entries || {}).length === 0)) {
                        // ignore
                    } else {
                        realValue = v;
                    }
                },
            });
            _protectedWorlds.add(worldName);
            console.log(`${LOG} 🛡️ "${worldName}" の world_info 保護をインストール`);
            return true;
        } catch (e) {
            try { worldInfo[worldName] = realValue; return true; }
            catch (e2) { return false; }
        }
    }

    // ============================================================
    // ★ 特定ワールドの有効性のみ確認（他には触らない）
    // ============================================================
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

    // ============================================================
    // ★ world_names に確実に登録
    // ============================================================
    async function _ensureWorldInSTWorldNames(worldName) {
        if (!worldName) return false;

        // 既に登録済み？
        try {
            const ctx = getSTContext();
            if (Array.isArray(ctx?.world_names) && ctx.world_names.includes(worldName)) {
                return true;
            }
        } catch (e) { /* ignore */ }

        try {
            const mod = await import('../../../../world-info.js');
            if (Array.isArray(mod.world_names) && mod.world_names.includes(worldName)) {
                // mod には入っているが ctx はダメかもしれない → ctx に追加を試みる
                try {
                    const ctx = getSTContext();
                    if (Array.isArray(ctx?.world_names) && !ctx.world_names.includes(worldName)) {
                        ctx.world_names.push(worldName);
                    }
                } catch (e) { /* ignore */ }
                return true;
            }
        } catch (e) { /* ignore */ }

        // ST に再読み込みさせる
        await refreshWorldSelects();
        await wait(200);

        try {
            const ctx = getSTContext();
            if (Array.isArray(ctx?.world_names) && ctx.world_names.includes(worldName)) {
                console.log(`${LOG} ✅ world_names に "${worldName}" が反映されました`);
                return true;
            }
        } catch (e) { /* ignore */ }

        try {
            const mod = await import('../../../../world-info.js');
            if (Array.isArray(mod.world_names) && mod.world_names.includes(worldName)) {
                console.log(`${LOG} ✅ mod.world_names に "${worldName}" が反映されました`);
                return true;
            }
        } catch (e) { /* ignore */ }

        // 手動 push
        let pushed = false;
        try {
            const mod = await import('../../../../world-info.js');
            if (Array.isArray(mod.world_names) && !mod.world_names.includes(worldName)) {
                mod.world_names.push(worldName);
                console.log(`${LOG} 📋 mod.world_names に "${worldName}" を手動追加`);
                pushed = true;
            }
        } catch (e) { /* ignore */ }
        try {
            const ctx = getSTContext();
            if (Array.isArray(ctx?.world_names) && !ctx.world_names.includes(worldName)) {
                ctx.world_names.push(worldName);
                console.log(`${LOG} 📋 ctx.world_names に "${worldName}" を手動追加`);
                pushed = true;
            }
        } catch (e) { /* ignore */ }
        return pushed;
    }

    // ============================================================
    // ★ 一括検証（unhandledrejection ハンドラ専用）
    //   数値キー・jQuery/sizzle キーはスキップ
    // ============================================================
    function _shouldSkipValidateKey(name) {
        if (!name) return true;
        if (/^\d+$/.test(name)) return true;
        if (name.startsWith('jQuery')) return true;
        if (name.startsWith('sizzle')) return true;
        if (name === 'length') return true;
        if (name === 'prevObject') return true;
        return false;
    }

    async function _validateAllWorldInfoEntries() {
        const worldInfo = getWorldInfoInstance();
        if (!worldInfo) {
            console.debug(`${LOG} _validateAllWorldInfoEntries: world_info が無効 (jQuery/配列) のためスキップ`);
            return;
        }

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
                    console.log(`${LOG} 🧹 "${name}" を world_info から削除（サーバーにも無し）`);
                } catch (e) { /* ignore */ }
            }
        }
    }

    // ============================================================
    // 自動作成エントリのテンプレート
    // ============================================================
    function _createCommonRuleEntry(uid) {
        return {
            uid: uid, displayIndex: uid,
            key: [], keysecondary: [],
            comment: '00_共通ルール', content: COMMON_RULE_CONTENT,
            constant: true, vectorized: false, selective: true, selectiveLogic: 0,
            addMemo: false, order: 100, position: 4, disable: false,
            excludeRecursion: false, preventRecursion: false, delayUntilRecursion: false,
            probability: 100, useProbability: true, depth: 1,
            group: '', groupOverride: false, groupWeight: 100,
            scanDepth: null, caseSensitive: null, matchWholeWord: null, matchWholeWords: null,
            useGroupScoring: null, automationId: '', role: 0,
            sticky: 0, cooldown: 0, delay: 0,
        };
    }

    // ============================================================
    // 自動作成
    // ============================================================
    async function _createWorldbookIfMissing(worldName) {
        if (!worldName) return false;

        const existing = await fetchWorldbookFromServer(worldName);
        if (existing && existing.entries && Object.keys(existing.entries).length > 0) {
            _ensureWorldInfoProtected(worldName, existing.entries);
            await _ensureWorldInSTWorldNames(worldName);
            return true;
        }

        const newWorldData = { entries: { 0: _createCommonRuleEntry(0) } };
        let saved = false;

        for (let attempt = 1; attempt <= SAVE_RETRY_MAX; attempt++) {
            try {
                const headers = await getRequestHeadersSafe();
                const resp = await fetch('/api/worldinfo/edit', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ name: worldName, data: newWorldData }),
                });
                if (resp.ok) {
                    console.log(`${LOG} 💾 /api/worldinfo/edit 成功 (attempt ${attempt})`);
                    saved = true;
                    break;
                }
                let errText = '';
                try { errText = await resp.text(); } catch (e) { /* ignore */ }
                console.warn(
                    `${LOG} /api/worldinfo/edit HTTP ${resp.status} (attempt ${attempt}) ` +
                    `body="${errText.slice(0, 200)}"`
                );
            } catch (e) {
                console.warn(`${LOG} /api/worldinfo/edit 例外 (attempt ${attempt}):`, e);
            }
            if (attempt < SAVE_RETRY_MAX) await wait(SAVE_RETRY_DELAY_MS);
        }

        if (!saved) return false;

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

        if (!verified) {
            console.warn(`${LOG} ロアブック "${worldName}" のサーバー保存を確認できませんでした`);
            return false;
        }

        _ensureWorldInfoProtected(worldName, verified);

        // ★ refreshWorldSelects を先に呼んでから world_names を確認
        await refreshWorldSelects();
        await _ensureWorldInSTWorldNames(worldName);
        _addOptionToSelectsIfMissing(worldName);

        console.log(
            `${LOG} 🆕 ロアブック "${worldName}" を自動作成しました ` +
            `(entries ${Object.keys(verified).length}件, 保護済み, 検証済み)`
        );
        return true;
    }

    async function _bindCharacterToWorld(char, worldName, force = false) {
        if (!char || !worldName) return false;

        if (!force && char.data?.extensions?.world === worldName) {
            return true;
        }

        // 対象ワールドのみ確保
        const ok = await _ensureSpecificWorldReady(worldName);
        if (!ok) {
            console.warn(
                `${LOG} world_info["${worldName}"] が有効な entries を持たないため、バインドを中止`
            );
            return false;
        }

        try {
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};
            char.data.extensions.world = worldName;
        } catch (e) { /* ignore */ }

        try {
            const avatar = char.avatar && char.avatar !== 'none'
                ? char.avatar
                : `${char.name}.png`;
            const headers = await getRequestHeadersSafe();
            const resp = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    avatar: avatar,
                    avatar_url: avatar,
                    ch_name: char.name,
                    data: { extensions: { world: worldName } },
                }),
            });
            if (resp.ok) {
                console.log(`${LOG} 🔗 キャラ "${char.name}" をロアブック "${worldName}" にバインド`);
                return true;
            }
            console.warn(`${LOG} merge-attributes HTTP ${resp.status}`);
            return false;
        } catch (e) {
            console.warn(LOG, '_bindCharacterToWorld error:', e);
            return false;
        }
    }

    // ============================================================
    // ★ _setEditTarget: 特定ワールドのみ検証 → change 発火
    // ============================================================
    async function _setEditTarget(name) {
        const $ = getJQuery();
        const ed = document.querySelector('#world_editor_select');
        if (!$ || !ed) return false;

        if (_findOptionValue(ed, name) === null) {
            _addOptionToSelectsIfMissing(name);
        }
        const value = _findOptionValue(ed, name);
        if (value === null) {
            console.debug(`${LOG} _setEditTarget: "${name}" の option が無いためソフト成功`);
            return true;
        }

        // ★ 特定ワールドのみ準備（一括検証しない）
        await _ensureSpecificWorldReady(name);

        try {
            $(ed).val(value).trigger('change');
            console.log(`${LOG} 📋 world_editor_select を "${name}" に設定 (change 付き)`);
        } catch (e) {
            console.warn(LOG, '_setEditTarget change error:', e);
            return false;
        }

        // 事後復元（change 中の上書き対策）
        const restore = () => {
            if (!_protectedWorlds.has(name)) return;
            const wi = getWorldInfoInstance();
            if (!wi) return;
            const cur = wi[name];
            const valid = cur && typeof cur === 'object'
                && cur.entries && Object.keys(cur.entries).length > 0;
            if (!valid) {
                // 保護済みなら setter が拒否するだけなので実害なし
                console.debug(`${LOG} 事後復元: "${name}" が無効になっていたが保護済み`);
            }
        };
        setTimeout(restore, 300);
        setTimeout(restore, 1000);

        return true;
    }

    // ============================================================
    // ★ _setActive: 特定ワールドのみ検証 → change 発火
    // ============================================================
    async function _setActive(name) {
        const $ = getJQuery();
        const wi = document.querySelector('#world_info');
        if (!$ || !wi) return false;

        if (_findOptionValue(wi, name) === null) {
            _addOptionToSelectsIfMissing(name);
        }
        const value = _findOptionValue(wi, name);
        if (value === null) {
            console.debug(`${LOG} _setActive: "${name}" の option が無いためソフト成功`);
            return true;
        }

        // ★ 特定ワールドのみ準備（一括検証しない）
        const ok = await _ensureSpecificWorldReady(name);
        if (!ok) {
            console.warn(`${LOG} _setActive: "${name}" を準備できません`);
            return false;
        }

        try {
            if (wi.hasAttribute('multiple')) {
                $(wi).val([value]).trigger('change');
            } else {
                $(wi).val(value).trigger('change');
            }
            console.log(`${LOG} 📋 world_info を "${name}" に設定 (change 付き)`);
        } catch (e) {
            console.warn(LOG, '_setActive error:', e);
        }

        // 選択状態の確認（ログ出力のみ）
        setTimeout(() => {
            try {
                const sel = Array.from(wi.selectedOptions || [])
                    .map(o => (o.value || '').trim())
                    .filter(Boolean);
                if (!sel.includes(value)) {
                    console.warn(`${LOG} ⚠️ #world_info の選択が反映されていません: [${sel.join(', ')}]`);
                }
            } catch (e) { /* ignore */ }
        }, 500);

        return true;
    }

    function _addOptionToSelectsIfMissing(name) {
        if (!name) return;
        const added = [];

        const ed = document.querySelector('#world_editor_select');
        if (ed && _findOptionValue(ed, name) === null) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            ed.appendChild(opt);
            added.push('world_editor_select');
        }

        const wi = document.querySelector('#world_info');
        if (wi && _findOptionValue(wi, name) === null) {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            wi.appendChild(opt);
            added.push('world_info');
        }

        if (added.length > 0) {
            console.log(`${LOG} 📋 DOM に "${name}" option を直接注入: [${added.join(', ')}]`);
        }
    }

    // ============================================================
    // ★ 自己修復（特定ワールドのみ、一括検証しない）
    // ============================================================
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
        }, SELF_HEAL_INTERVAL_MS);
        console.log(`${LOG} 🩹 定期自己修復を開始 (interval=${SELF_HEAL_INTERVAL_MS}ms)`);
    }

    // ============================================================
    // unhandledrejection: ST 内部エラー抑止 + 修復
    // ============================================================
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

        if (_hasWorldBookInDOM(name)) {
            const worldInfo = getWorldInfoInstance();
            if (worldInfo && worldInfo[name]?.entries) {
                const count = Object.keys(worldInfo[name].entries).length;
                if (count > 0) return true;
                try { delete worldInfo[name]; } catch (e) { /* ignore */ }
                _protectedWorlds.delete(name);
            } else {
                return true;
            }
        }

        const worldInfo = getWorldInfoInstance();
        if (worldInfo && worldInfo[name]) {
            const serverHas = await _verifyWorldbookOnServer(name);
            if (serverHas) {
                const fromServer = await fetchWorldbookFromServer(name);
                if (fromServer) {
                    _ensureWorldInfoProtected(name, fromServer.entries);
                }
                return true;
            }
            try { delete worldInfo[name]; } catch (e) { /* ignore */ }
            _protectedWorlds.delete(name);
            return false;
        }

        return false;
    }

    function _hasWorldBook(name) {
        if (!name) return false;
        if (_hasWorldBookInDOM(name)) return true;
        const worldInfo = getWorldInfoInstance();
        return !!(worldInfo && worldInfo[name]);
    }

    // ============================================================
    // メイン処理
    // ============================================================
    async function autoSelect(myToken, reason, options = {}) {
        const isStale = () => _generationToken !== myToken;

        const charAtStart = getCurrentChar();
        const charNameAtStart = charAtStart?.name || null;
        if (!charNameAtStart) {
            console.debug(LOG, `スキップ: キャラ未選択 (${reason})`);
            return;
        }

        const extW = charAtStart.data?.extensions?.world;
        if (extW && extW !== charNameAtStart) {
            const key = `${charNameAtStart}::${extW}`;
            if (!_warnedMismatch.has(key)) {
                _warnedMismatch.add(key);
                console.warn(
                    `${LOG} ⚠️ char="${charNameAtStart}" に異なる world="${extW}" が設定されています。`
                );
            }
        }

        const candidates = _getCharacterWorldCandidates(charAtStart);
        console.log(`${LOG} 開始: char="${charNameAtStart}", reason=${reason}, 候補=[${candidates.join(', ')}]`);

        try {
            let targetName = null;
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
            if (!options.force && sameChar && reason !== 'chat-changed') {
                console.debug(LOG, `同一キャラ "${charNameAtStart}" のためスキップ`);
                return;
            }

            const editOk = await _setEditTarget(targetName);
            await wait(APPLY_DELAY_MS);
            if (isStale()) return;
            const activeOk = await _setActive(targetName);

            if (isStale()) return;

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
                console.warn(`${LOG} ロアブック "${targetName}" の選択に失敗しました`);
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

        if (installed > 0) {
            console.log(LOG, `イベントリスナーを ${installed} 件登録`);
        }
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
        getCharacterWorldCandidates: () => _getCharacterWorldCandidates(getCurrentChar()),
        createWorldbook: (name) => _createWorldbookIfMissing(name || getCurrentCharName()),
        verifyWorldbookOnServer: (name) => _verifyWorldbookOnServer(name || getCurrentCharName()),
        fetchWorldbook: (name) => fetchWorldbookFromServer(name || getCurrentCharName()),
        refreshWorldSelects,
        ensureWorldInSTWorldNames: (name) => _ensureWorldInSTWorldNames(name || getCurrentCharName()),
        validateAllWorldInfoEntries: _validateAllWorldInfoEntries,
        bindCharacter: async (worldName, force) => {
            const char = getCurrentChar();
            return _bindCharacterToWorld(char, worldName || getCurrentCharName(), !!force);
        },
        repairCurrentCharWorld: () => _repairCurrentCharWorld(),
        inspectWorldbook: async (worldName) => {
            const name = worldName || getCurrentCharName();
            if (!name) return { error: 'no worldName' };

            const fromServer = await fetchWorldbookFromServer(name);
            const worldInfo = getWorldInfoInstance();
            const fromMemory = worldInfo?.[name];

            // world_names の状態も報告
            let ctxWorldNames = null;
            let modWorldNames = null;
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
                serverExists: !!fromServer,
                serverEntryCount: fromServer ? Object.keys(fromServer.entries || {}).length : 0,
                memoryExists: !!fromMemory,
                memoryEntryCount: fromMemory?.entries
                    ? Object.keys(fromMemory.entries).length
                    : 0,
                memoryType: typeof fromMemory,
                domHasEditorOption: _findOptionValue(
                    document.querySelector('#world_editor_select'), name
                ) !== null,
                domHasActiveOption: _findOptionValue(
                    document.querySelector('#world_info'), name
                ) !== null,
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
                worldInfoKeys: worldInfo ? Object.keys(worldInfo).slice(0, 20) : [],
                hasCsrfToken: !!(headers['X-CSRF-Token']),
                currentToken: _generationToken,
                lastProcessedChar: _lastProcessedChar,
                lastFailure: _lastFailure,
                warnedMismatch: Array.from(_warnedMismatch),
                protectedWorlds: Array.from(_protectedWorlds),
            };
        },
        resetProcessed: () => {
            _lastProcessedChar = null;
            _lastFailure = { char: null, at: 0 };
            _warnedMismatch.clear();
            if (_retryTimer) {
                clearTimeout(_retryTimer);
                _retryTimer = null;
            }
        },
    };
})();
