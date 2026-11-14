// worldbook_auto_select.js
// キャラクター切替時に、キャラに関連付けられたロアブックを自動選択する。
// ロアブックが存在しない場合はキャラ名と同じロアブックを自動作成し、
// キャラクターとバインド（char.data.extensions.world）する。
//
// ★ 設計方針: ロアブック名 = キャラ名
//   候補の順序は [char.name, extensions.world, data.world]。
//
// ★ 競合状態対策:
//   - 世代トークンで古い処理を無効化（UI 選択のみ）
//   - 自動作成・バインドは捕捉済みの charAtStart に対して完遂する
//   - バインドは merge-attributes に avatar / ch_name を明示
//
// ★ 自己修復:
//   - UI 選択後、targetName == char.name なら extensions.world を強制同期
//
// ★ 成功判定の階層:
//   1) サーバーに存在（entries 付き）
//   2) メモリに存在（world_info[name].entries 付き）
//   3) DOM に存在（#world_editor_select / #world_info の option）
//   上記 1) or 2) が満たされれば「作成成功」とみなす。
//
// ★ 自動作成は importWorldInfo を第一手段とする:
//   - world_names 配列が更新され、ST の削除処理も通る
//   - importWorldInfo 後に saveWorldInfo を明示呼び出し、保存を確定させる
//
// ★ change 発火による world_info 消失対策:
//   - _guardWorldInfoEntries / _restoreWorldInfoEntries で事前・事後ガード
//   - merge-attributes 後の ST 再構築にも対抗

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

    const COMMON_RULE_CONTENT =
        '【絶対厳守ルール】\n' +
        '1. プレイヤーが入力した番号に対応する場面を描写する。\n' +
        '2. {{char}}の台詞を日本のラノベ風にした上で、{{char}}の台詞だけで状況や心情を説明する\n' +
        '3. 地の文を絶対に使わない\n' +
        '3. {{user}}の台詞や独白を描写しない\n' +
        '4. 描写の長さは必ず 約400文字 とすること。100文字や200文字といった短い本文は絶対禁止。\n' +
        '5. 情景・人物の動き・心情・五感・会話を丁寧に書き、短くまとめてはいけない。\n' +
        '6. 描写本文を書いたら、必ず空行を2行入れる。';

    // ============================================================
    // ★ 世代トークン（古い処理を無効化するための番号）
    // ============================================================
    let _generationToken = 0;
    let _scheduleTimer = null;
    let _retryTimer = null;
    let _lastProcessedChar = null;
    let _lastFailure = { char: null, at: 0 };
    const _warnedMismatch = new Set();

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

    // ============================================================
    // ★ 確実な getRequestHeaders（CSRF トークン付き）
    // ============================================================
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
    // ST 本体と同じ world_info インスタンスを取得
    // ============================================================
    function getWorldInfoInstance() {
        try {
            const ctx = getSTContext();
            if (ctx && ctx.world_info && typeof ctx.world_info === 'object') {
                return ctx.world_info;
            }
        } catch (e) { /* ignore */ }

        if (window.world_info && typeof window.world_info === 'object') {
            return window.world_info;
        }
        return null;
    }

    // ============================================================
    // ★ DOM セレクトを更新（複数経路を順に試す）
    // ============================================================
    async function refreshWorldSelects() {
        let success = false;

        // ① ctx.getSettings（最優先）
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

        // ② loadWorldInfoList（フォールバック）
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

        // ③ mod.getSettings（最終フォールバック）
        if (!success) {
            try {
                const mod = await import('../../../../world-info.js');
                if (typeof mod.getSettings === 'function') {
                    await mod.getSettings();
                    console.log(`${LOG} 📋 mod.getSettings 実行成功`);
                    success = true;
                }
            } catch (e) {
                console.warn(`${LOG} mod.getSettings 失敗:`, e.message || e);
            }
        }

        return success;
    }

    // ============================================================
    // サーバーからロアブックを取得
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
            if (data?.entries && Object.keys(data.entries).length > 0) {
                return data;
            }
            return null;
        } catch (e) {
            return null;
        }
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

    // ============================================================
    // ★ DOM のみの同期チェック（高速パス）
    // ============================================================
    function _hasWorldBookInDOM(name) {
        if (!name) return false;
        const ed = document.querySelector('#world_editor_select');
        if (_findOptionValue(ed, name) !== null) return true;
        const wi = document.querySelector('#world_info');
        if (_findOptionValue(wi, name) !== null) return true;
        return false;
    }

    // ============================================================
    // ★ 存在確認（DOM + 検証済みメモリ）
    //   DOM に無くメモリだけある場合はサーバー検証し、
    //   サーバーにも無ければ stale としてメモリから削除する。
    // ============================================================
    async function _hasWorldBookVerified(name) {
        if (!name) return false;

        // ① DOM チェック（最速・信頼できる）
        if (_hasWorldBookInDOM(name)) {
            const worldInfo = getWorldInfoInstance();
            if (worldInfo && worldInfo[name]?.entries) {
                const count = Object.keys(worldInfo[name].entries).length;
                if (count > 0) return true;
                console.debug(LOG, `"${name}" は DOM にあるがメモリ entries が空 → サーバー検証`);
                delete worldInfo[name];
            } else {
                return true;
            }
        }

        // ② メモリにあればサーバー検証（entries の中身も）
        const worldInfo = getWorldInfoInstance();
        if (worldInfo && worldInfo[name]) {
            console.debug(LOG, `"${name}" は DOM に無いがメモリにあるため、サーバー検証`);
            const serverHas = await _verifyWorldbookOnServer(name);
            if (serverHas) {
                console.debug(LOG, `"${name}" はサーバーに entries あり（DOM 反映遅延のみ）`);
                const fromServer = await fetchWorldbookFromServer(name);
                if (fromServer) {
                    worldInfo[name] = { entries: fromServer.entries };
                }
                return true;
            }
            console.warn(
                `${LOG} ⚠️ メモリの "${name}" はサーバーに有効な entries がないため削除`
            );
            delete worldInfo[name];
            return false;
        }

        return false;
    }

    // 後方互換（debug 用）: DOM + メモリを同期判定（検証なし）
    function _hasWorldBook(name) {
        if (!name) return false;
        if (_hasWorldBookInDOM(name)) return true;
        const worldInfo = getWorldInfoInstance();
        return !!(worldInfo && worldInfo[name]);
    }

    // ============================================================
    // ★ サーバー実在検証（entries が 1件以上あることを要求）
    // ============================================================
    async function _verifyWorldbookOnServer(worldName) {
        if (!worldName) return false;
        const data = await fetchWorldbookFromServer(worldName);
        if (!data || !data.entries) return false;
        const count = Object.keys(data.entries).length;
        return count > 0;
    }

    // ============================================================
    // ★ 候補の順序: char.name を最優先
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

    // ============================================================
    // 自動作成するエントリのテンプレート
    //   displayIndex は ST が必須とするフィールド
    // ============================================================
    function _createCommonRuleEntry(uid) {
        return {
            uid: uid,
            displayIndex: uid,
            key: [],
            keysecondary: [],
            comment: '00_共通ルール',
            content: COMMON_RULE_CONTENT,
            constant: true,
            vectorized: false,
            selective: true,
            selectiveLogic: 0,
            addMemo: false,
            order: 100,
            position: 4,
            disable: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: 1,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWord: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: 0,
            sticky: 0,
            cooldown: 0,
            delay: 0,
        };
    }

    // ============================================================
    // ★ ロアブックの自動作成
    //   1) サーバーに entries 付きで存在 → メモリに復元して成功
    //   2) importWorldInfo で作成（world_names も更新）
    //   3) importWorldInfo 後に saveWorldInfo を明示呼び出し
    //   4) importWorldInfo 失敗時は /api/worldinfo/edit でフォールバック
    //   5) サーバー検証（entries の中身まで）
    // ============================================================
    async function _createWorldbookIfMissing(worldName) {
        if (!worldName) return false;

        // 1. 既存チェック（entries の中身まで）
        const existing = await fetchWorldbookFromServer(worldName);
        if (existing && existing.entries && Object.keys(existing.entries).length > 0) {
            const worldInfo = getWorldInfoInstance();
            if (worldInfo && (
                !worldInfo[worldName]?.entries ||
                Object.keys(worldInfo[worldName].entries).length === 0
            )) {
                worldInfo[worldName] = { entries: existing.entries };
            }
            return true;
        }

        // 2. 新規データ
        const newWorldData = { entries: { 0: _createCommonRuleEntry(0) } };

        // 3. importWorldInfo 経由（推奨）
        let created = false;
        try {
            const mod = await import('../../../../world-info.js');
            if (typeof mod.importWorldInfo === 'function') {
                const jsonContent = JSON.stringify(newWorldData, null, 2);
                const blob = new Blob([jsonContent], { type: 'application/json' });
                const file = new File([blob], `${worldName}.json`, { type: 'application/json' });
                await mod.importWorldInfo(file, false);
                created = true;
                console.log(`${LOG} 📥 importWorldInfo で "${worldName}" を作成`);

                // ★ importWorldInfo の内部 saveWorldInfo を確定させる
                try {
                    const ctx = getSTContext();
                    let saveFn = null;
                    if (ctx && typeof ctx.saveWorldInfo === 'function') {
                        saveFn = ctx.saveWorldInfo.bind(ctx);
                    } else if (typeof mod.saveWorldInfo === 'function') {
                        saveFn = mod.saveWorldInfo;
                    }
                    if (saveFn) {
                        await saveFn(worldName, true, true);
                        console.log(`${LOG} 💾 importWorldInfo 後に saveWorldInfo を明示実行`);
                    }
                } catch (e) {
                    console.warn(`${LOG} 明示 saveWorldInfo 失敗:`, e?.message || e);
                }
            }
        } catch (e) {
            console.warn(`${LOG} importWorldInfo 失敗:`, e?.message || e);
        }

        // 4. importWorldInfo が使えない/失敗した場合のフォールバック
        if (!created) {
            let saveSucceeded = false;
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
                        saveSucceeded = true;
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
            if (!saveSucceeded) return false;

            // メモリに書き込み
            const worldInfo = getWorldInfoInstance();
            if (worldInfo) {
                worldInfo[worldName] = { entries: newWorldData.entries };
            }

            // world_names 更新を試みる
            try {
                const mod = await import('../../../../world-info.js');
                if (typeof mod.loadWorldInfoList === 'function') {
                    await mod.loadWorldInfoList();
                }
            } catch (e) { /* ignore */ }
        }

        // 5. サーバー検証（entries の中身まで）
        for (let i = 0; i < VERIFY_RETRY_MAX; i++) {
            const fetched = await fetchWorldbookFromServer(worldName);
            if (fetched && fetched.entries && Object.keys(fetched.entries).length > 0) {
                const firstEntry = Object.values(fetched.entries)[0];
                if (firstEntry && firstEntry.comment === '00_共通ルール') {
                    console.log(
                        `${LOG} 🆕 ロアブック "${worldName}" を自動作成しました ` +
                        `(entries ${Object.keys(fetched.entries).length}件, 検証済み, ` +
                        `via ${created ? 'importWorldInfo' : 'api/edit'})`
                    );
                    const worldInfo = getWorldInfoInstance();
                    if (worldInfo) {
                        worldInfo[worldName] = { entries: fetched.entries };
                    }
                    return true;
                }
            }
            await wait(VERIFY_RETRY_DELAY_MS);
        }

        console.warn(
            `${LOG} ロアブック "${worldName}" はファイルとして存在しますが、` +
            `entries が正しく保存されていないため作成失敗とみなします`
        );
        return false;
    }

    // ============================================================
    // ★ キャラクターへのバインド
    //   - バインド前に world_info[name] の有効性を確認
    //   - merge-attributes の前後で entries を退避/復元
    // ============================================================
    async function _bindCharacterToWorld(char, worldName, force = false) {
        if (!char || !worldName) return false;

        if (!force && char.data?.extensions?.world === worldName) {
            return true;
        }

        // world_info[name] の「entries 付き」存在確認 + 退避
        let worldInfo = getWorldInfoInstance();
        let savedEntries = null;
        const hasValidEntries = worldInfo
            && worldInfo[worldName]?.entries
            && Object.keys(worldInfo[worldName].entries).length > 0;

        if (!hasValidEntries) {
            console.log(`${LOG} ⚠️ world_info["${worldName}"] が無効 → サーバーから復元を試行`);
            const fromServer = await fetchWorldbookFromServer(worldName);
            if (fromServer && fromServer.entries && Object.keys(fromServer.entries).length > 0) {
                if (!worldInfo) {
                    worldInfo = getWorldInfoInstance();
                }
                if (worldInfo) {
                    worldInfo[worldName] = { entries: fromServer.entries };
                    console.log(`${LOG} ✅ world_info["${worldName}"] をメモリに復元`);
                }
            }
        }

        // 退避（merge-attributes 後の ST 再構築に対抗）
        worldInfo = getWorldInfoInstance();
        if (worldInfo && worldInfo[worldName]?.entries) {
            savedEntries = worldInfo[worldName].entries;
        }

        // 再チェック
        const stillValid = savedEntries && Object.keys(savedEntries).length > 0;
        if (!stillValid) {
            console.warn(
                `${LOG} world_info["${worldName}"] がどの階層にも有効な entries を持たないため、` +
                `バインドを中止します（TypeError 防止）`
            );
            return false;
        }

        // メモリは同期的に更新
        try {
            if (!char.data) char.data = {};
            if (!char.data.extensions) char.data.extensions = {};
            char.data.extensions.world = worldName;
        } catch (e) { /* ignore */ }

        // サーバー保存: avatar / ch_name を明示
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

            // ★ merge-attributes 直後に world_info[name] を復元
            const worldInfoAfter = getWorldInfoInstance();
            if (worldInfoAfter && savedEntries) {
                const current = worldInfoAfter[worldName];
                if (!current?.entries || Object.keys(current.entries).length === 0) {
                    worldInfoAfter[worldName] = { entries: savedEntries };
                    console.log(
                        `${LOG} 🔄 merge-attributes 後の world_info["${worldName}"] を復元 ` +
                        `(${Object.keys(savedEntries).length}件)`
                    );
                }
            }

            if (resp.ok) {
                console.log(`${LOG} 🔗 キャラ "${char.name}" をロアブック "${worldName}" にバインド`);
                return true;
            }
            console.warn(`${LOG} merge-attributes HTTP ${resp.status}`);
            return false;
        } catch (e) {
            // 例外時も復元を試みる
            try {
                const worldInfoAfter = getWorldInfoInstance();
                if (worldInfoAfter && savedEntries) {
                    worldInfoAfter[worldName] = { entries: savedEntries };
                }
            } catch (e2) { /* ignore */ }
            console.warn(LOG, '_bindCharacterToWorld error:', e);
            return false;
        }
    }

    // ============================================================
    // ★ world_info[name] の entries を退避（無ければサーバーから取得）
    // ============================================================
    async function _guardWorldInfoEntries(name) {
        if (!name) return null;

        const worldInfo = getWorldInfoInstance();
        if (worldInfo && worldInfo[name]?.entries) {
            const keys = Object.keys(worldInfo[name].entries);
            if (keys.length > 0) {
                return worldInfo[name].entries;
            }
        }

        // メモリが空 → サーバーから取得
        const fromServer = await fetchWorldbookFromServer(name);
        if (fromServer && fromServer.entries && Object.keys(fromServer.entries).length > 0) {
            if (worldInfo) {
                worldInfo[name] = { entries: fromServer.entries };
            }
            return fromServer.entries;
        }
        return null;
    }

    // ============================================================
    // ★ world_info[name] の entries を復元（change 発火後）
    // ============================================================
    async function _restoreWorldInfoEntries(name, savedEntries) {
        if (!name || !savedEntries) return;
        if (Object.keys(savedEntries).length === 0) return;

        const worldInfo = getWorldInfoInstance();
        if (!worldInfo) return;

        const current = worldInfo[name];
        const currentCount = current?.entries ? Object.keys(current.entries).length : 0;
        if (currentCount === 0) {
            worldInfo[name] = { entries: savedEntries };
            console.log(
                `${LOG} 🔄 change 発火後の world_info["${name}"] を復元 ` +
                `(${Object.keys(savedEntries).length}件)`
            );
        }
    }

    // ============================================================
    // ★ DOM セレクトに option を直接注入（保険）
    //   loadWorldInfoList が効かない環境でも option を出現させる
    // ============================================================
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
    // ★ 編集対象ドロップダウンへの反映（事前・事後ガード付き）
    // ============================================================
    async function _setEditTarget(name) {
        const $ = getJQuery();
        const ed = document.querySelector('#world_editor_select');
        if (!$ || !ed) return false;
        const value = _findOptionValue(ed, name);
        if (value === null) {
            console.debug(LOG, `_setEditTarget: "${name}" は DOM に無いがメモリには存在するためソフト成功`);
            return true;
        }

        // ★ 事前ガード
        const savedEntries = await _guardWorldInfoEntries(name);

        try {
            $(ed).val(value).trigger('change');
        } catch (e) {
            console.warn(LOG, '_setEditTarget error:', e);
            return false;
        }

        // ★ 事後ガード
        await _restoreWorldInfoEntries(name, savedEntries);
        return true;
    }

    // ============================================================
    // ★ アクティブな世界情報への反映（事前・事後ガード付き）
    // ============================================================
    async function _setActive(name) {
        const $ = getJQuery();
        const wi = document.querySelector('#world_info');
        if (!$ || !wi) return false;
        const value = _findOptionValue(wi, name);
        if (value === null) {
            console.debug(LOG, `_setActive: "${name}" は DOM に無いがメモリには存在するためソフト成功`);
            return true;
        }

        // ★ 事前ガード
        const savedEntries = await _guardWorldInfoEntries(name);

        try {
            if (wi.hasAttribute('multiple')) {
                $(wi).val([value]).trigger('change');
            } else {
                $(wi).val(value).trigger('change');
            }
        } catch (e) {
            console.warn(LOG, '_setActive error:', e);
            return false;
        }

        // ★ 事後ガード
        await _restoreWorldInfoEntries(name, savedEntries);
        return true;
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
                    `${LOG} ⚠️ char="${charNameAtStart}" に異なる world="${extW}" が設定されています。` +
                    `UI 選択後に自動同期されます。`
                );
            }
        }

        const candidates = _getCharacterWorldCandidates(charAtStart);
        console.log(`${LOG} 開始: char="${charNameAtStart}", reason=${reason}, 候補=[${candidates.join(', ')}]`);

        try {
            // ── 1. 既存ロアブックを探す ──
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

            // ── 2. 無ければ自動作成 + バインド ──
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

                // ── DOM 反映 ──
                await refreshWorldSelects();

                // getSettings が world_info[name] を空にしていたら復元
                const worldInfoAfterRefresh = getWorldInfoInstance();
                if (worldInfoAfterRefresh && (
                    !worldInfoAfterRefresh[worldToCreate]?.entries ||
                    Object.keys(worldInfoAfterRefresh[worldToCreate].entries).length === 0
                )) {
                    const fromServer = await fetchWorldbookFromServer(worldToCreate);
                    if (fromServer && fromServer.entries) {
                        worldInfoAfterRefresh[worldToCreate] = { entries: fromServer.entries };
                        console.log(`${LOG} 🔄 world_info["${worldToCreate}"] をサーバーから再設定`);
                    }
                }

                _addOptionToSelectsIfMissing(worldToCreate);
                await wait(300);

                for (let i = 0; i < FIND_RETRY_MAX; i++) {
                    if (_hasWorldBookInDOM(worldToCreate)) {
                        targetName = worldToCreate;
                        break;
                    }
                    if (i === 1) {
                        await refreshWorldSelects();
                        // 再注入
                        const wi2 = getWorldInfoInstance();
                        if (wi2 && (!wi2[worldToCreate]?.entries || Object.keys(wi2[worldToCreate].entries).length === 0)) {
                            const srv = await fetchWorldbookFromServer(worldToCreate);
                            if (srv && srv.entries) {
                                wi2[worldToCreate] = { entries: srv.entries };
                            }
                        }
                        _addOptionToSelectsIfMissing(worldToCreate);
                    }
                    await wait(FIND_RETRY_DELAY_MS);
                }

                if (!targetName) {
                    const serverHas = await _verifyWorldbookOnServer(worldToCreate);
                    if (serverHas) {
                        console.log(
                            `${LOG} ロアブック "${worldToCreate}" はサーバーに存在 ` +
                            `（DOM 反映遅延のため成功扱い）`
                        );
                        const worldInfo = getWorldInfoInstance();
                        if (worldInfo && (!worldInfo[worldToCreate]?.entries || Object.keys(worldInfo[worldToCreate].entries).length === 0)) {
                            const fromServer = await fetchWorldbookFromServer(worldToCreate);
                            if (fromServer) {
                                worldInfo[worldToCreate] = { entries: fromServer.entries };
                            }
                        }
                        _addOptionToSelectsIfMissing(worldToCreate);
                        targetName = worldToCreate;
                    } else {
                        console.warn(`${LOG} ロアブック "${worldToCreate}" がどの階層にも見つかりませんでした`);
                        _recordFailure(charNameAtStart);
                        return;
                    }
                }
            }

            // ── 3. UI 選択 ──
            if (isStale()) {
                console.log(`${LOG} キャラ切替検出のため UI 反映スキップ (選択予定="${targetName}")`);
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
                    `(編集=${editOk}, アクティブ=${activeOk}, reason=${reason}, force=${!!options.force})`
                );

                // 自己修復: targetName == char.name なら extensions.world を同期
                if (targetName === charNameAtStart) {
                    const currentExt = charAtStart.data?.extensions?.world;
                    if (currentExt !== targetName) {
                        console.log(`${LOG} 🔄 char.extensions.world を "${targetName}" に同期 (旧: "${currentExt || 'none'}")`);
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
        if (_retryTimer) {
            clearTimeout(_retryTimer);
            _retryTimer = null;
        }

        _scheduleTimer = setTimeout(() => {
            _scheduleTimer = null;
            autoSelect(myToken, reason, options).catch(e => console.warn(LOG, e));
        }, DEBOUNCE_MS);
    }

    // ============================================================
    // イベント登録
    // ============================================================
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

    // ============================================================
    // 初期化
    // ============================================================
    async function init() {
        let waited = 0;
        while (!getSTContext() && waited < 10000) {
            await wait(200);
            waited += 200;
        }

        setupEventListeners();
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
        getCharacterWorldCandidates: () => _getCharacterWorldCandidates(getCurrentChar()),
        createWorldbook: (name) => _createWorldbookIfMissing(name || getCurrentCharName()),
        verifyWorldbookOnServer: (name) => _verifyWorldbookOnServer(name || getCurrentCharName()),
        fetchWorldbook: (name) => fetchWorldbookFromServer(name || getCurrentCharName()),
        refreshWorldSelects,
        bindCharacter: async (worldName, force) => {
            const char = getCurrentChar();
            return _bindCharacterToWorld(char, worldName || getCurrentCharName(), !!force);
        },
        // ★ ロアブックの entries を検査
        inspectWorldbook: async (worldName) => {
            const name = worldName || getCurrentCharName();
            if (!name) return { error: 'no worldName' };

            const fromServer = await fetchWorldbookFromServer(name);
            const worldInfo = getWorldInfoInstance();
            const fromMemory = worldInfo?.[name];

            return {
                worldName: name,
                serverExists: !!fromServer,
                serverEntryCount: fromServer ? Object.keys(fromServer.entries || {}).length : 0,
                serverEntryKeys: fromServer ? Object.keys(fromServer.entries || {}) : [],
                serverFirstEntry: fromServer?.entries
                    ? Object.values(fromServer.entries)[0]
                    : null,
                memoryExists: !!fromMemory,
                memoryEntryCount: fromMemory?.entries
                    ? Object.keys(fromMemory.entries).length
                    : 0,
                domHasEditorOption: _findOptionValue(
                    document.querySelector('#world_editor_select'), name
                ) !== null,
                domHasActiveOption: _findOptionValue(
                    document.querySelector('#world_info'), name
                ) !== null,
            };
        },
        // ★ entries が空のロアブックを修復
        repairEmptyWorldbook: async (worldName) => {
            const name = worldName || getCurrentCharName();
            if (!name) return { error: 'no worldName' };
            const created = await _createWorldbookIfMissing(name);
            return { worldName: name, created };
        },
        // ★ 汚染された extensions.world を全キャラ一括修復
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
        // ★ メモリ上の stale な world_info エントリを一括掃除
        cleanupStaleMemory: async () => {
            const worldInfo = getWorldInfoInstance();
            if (!worldInfo) return { cleaned: 0 };
            const names = Object.keys(worldInfo);
            let cleaned = 0;
            for (const name of names) {
                const serverHas = await _verifyWorldbookOnServer(name);
                if (!serverHas) {
                    console.warn(`${LOG} 🧹 stale メモリを削除: "${name}"`);
                    delete worldInfo[name];
                    cleaned++;
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
                sameInstance: worldInfoCtx === worldInfoWin,
                worldInfoKeys: worldInfo ? Object.keys(worldInfo) : [],
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
            if (_retryTimer) {
                clearTimeout(_retryTimer);
                _retryTimer = null;
            }
        },
    };
})();
