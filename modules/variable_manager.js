// variable_manager.js
// 画面左上にロアブックの「現在のエントリ」の変数の値を表示する。
//   - 現在のエントリ = 最後のユーザーメッセージの番号に対応するロアブックエントリ
//   - 変数値のみを文字列として表示（ヘッダー・折りたたみ・枠なし）
//   - 「場所」は常に表示、敵キャラの名前/HPはバトル開始後のみ表示
//   - 「バトル開始」変数が 1 の時、AIメッセージ末尾に「バトル開始」ボタンを表示
//   - バトル中は画面左下・高さ中央に「攻撃/防御/道具/逃走」ボタンを配置
//   - 攻撃/防御/逃走の動作を実装（道具は未実装）
//
// ★ 変数の役割分担:
//   - バトル開始 : 選択肢末尾の「バトル開始」ボタンを表示するかどうか（常に1で維持）
//   - バトルモード : 実際のバトル進行状態（1=バトル中, 0=非バトル）
//
// ★ バトルモード遷移:
//   バトル開始ボタン押下 → バトルモード=1
//   敵HP≤0 / 逃走      → バトルモード=0 → 敵HPを最大値に全回復
//
// ★ 敵の自動攻撃:
//   プレイヤーの行動（攻撃/防御）で enemy_turn=1 になると、
//   600ms後に敵キャラが自動攻撃する。
//   敵ダメージ = max(1, enemy_attack - player_defense)
//   プレイヤーHP≤0 → バトルモード=0, バトル終了, エントリ999を自動送信

(function () {
    'use strict';
    const LOG = '[VarManager]';
    const PANEL_ID = 'variable-manager-panel';
    const STYLE_ID = 'variable-manager-style';
    const POLL_INTERVAL_MS = 1500;

    const UI_SETTINGS_CLASS = 'variable-manager-ui-settings';
    const VISIBLE_CHECKBOX_ID = 'variable-manager-visible-checkbox';
    const START_CHECKBOX_ID = 'variable-manager-start-checkbox';
    const EXT_SETTINGS_KEY = 'variable_manager';
    const EVENT_START_CHANGED = 'variable-manager-start-changed';
    const BATTLE_START_BTN_CLASS = 'variable-battle-start-btn';
    const BATTLE_COMMANDS_ID = 'variable-battle-commands';

    const ENEMY_ATTACK_DELAY_MS = 600;
    const ENTRY_999_DELAY_MS = 800;

    const BATTLE_DEFAULTS = {
        active: false,
        player_turn: 0,
        enemy_turn: 0,
        player_attack: 60,
        player_defense: 20,
        enemy_attack: 70,
        enemy_defense: 20,
    };

    let _lastRenderKey = '';
    let _renderInFlight = false;
    let _initialized = false;
    let _uiObsPending = false;

    // ★ バトル状態
    let _battleActive = false;
    let _battlePrevChatHidden = null;
    let _lastBattleMode = false;
    let _startBattleInProgress = false;
    let _enemyAttackInProgress = false;

    (function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const link = document.createElement('link');
        link.id = STYLE_ID;
        link.rel = 'stylesheet';
        try {
            link.href = new URL('../styles/variable_manager.css', import.meta.url).href;
        } catch (e) {
            link.href = 'styles/variable_manager.css';
        }
        document.head.appendChild(link);
    })();

    function waitForLBE(maxWaitMs = 10000) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                if (window.LorebookExpansion?.getDataFor &&
                    window.LorebookExpansion?.loadWorldInfoEntriesByName) {
                    resolve(true);
                } else if (Date.now() - start > maxWaitMs) {
                    resolve(false);
                } else {
                    setTimeout(check, 200);
                }
            };
            check();
        });
    }

    function getSTContext() {
        try {
            if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
                return window.SillyTavern.getContext();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function getWorldName() {
        if (window.LorebookExpansion?.getCurrentWorldName) {
            try {
                const n = window.LorebookExpansion.getCurrentWorldName();
                if (n) return n;
            } catch (e) { /* ignore */ }
        }
        try {
            const ctx = getSTContext();
            const char = ctx?.characters?.[ctx?.characterId];
            return char?.data?.extensions?.world || char?.data?.world || null;
        } catch (e) { return null; }
    }

    function getLastChoiceNumber() {
        const ctx = getSTContext();
        if (!ctx?.chat) return null;

        for (let i = ctx.chat.length - 1; i >= 0; i--) {
            const m = ctx.chat[i];
            if (m.is_system) continue;
            if (!m.is_user) continue;

            const text = m.mes || '';
            let num = null;
            if (window.LorebookExpansion?.extractChoiceNumber) {
                try { num = window.LorebookExpansion.extractChoiceNumber(text); } catch (e) { /* ignore */ }
            }
            if (!num) {
                const match = text.match(/(\d{3,4})/);
                if (match) num = match[1].padStart(3, '0');
            }
            if (num) return num;
        }
        return null;
    }

    async function getCurrentVariables() {
        const worldName = getWorldName();
        if (!worldName) return { ok: false, reason: 'no-world' };

        const choiceNum = getLastChoiceNumber();
        if (!choiceNum) return { ok: false, reason: 'no-choice' };

        let entries = null;
        try {
            entries = await window.LorebookExpansion.loadWorldInfoEntriesByName(worldName);
        } catch (e) { return { ok: false, reason: 'load-error' }; }
        if (!entries) return { ok: false, reason: 'no-entries' };

        let entry = null;
        try { entry = window.LorebookExpansion.findEntryByChoice?.(entries, choiceNum); } catch (e) { /* ignore */ }
        if (!entry) return { ok: false, reason: 'no-entry', choiceNum, worldName };

        const uid = entry.uid ?? null;
        if (uid === null) return { ok: false, reason: 'no-uid' };

        let data = null;
        try {
            data = window.LorebookExpansion.getDataFor(worldName, uid, entry);
        } catch (e) { return { ok: false, reason: 'data-error' }; }

        return {
            ok: true,
            variables: Array.isArray(data?.variables) ? data.variables : [],
            worldName,
            entry,
            uid,
        };
    }

    // ============================================================
    // ★ バトルステート
    // ============================================================
    function getBattleState() {
        const s = _ensureExtSettings();
        if (!s) return { ...BATTLE_DEFAULTS };
        if (!s.battleState || typeof s.battleState !== 'object') {
            s.battleState = { ...BATTLE_DEFAULTS };
        }
        return s.battleState;
    }

    function saveBattleState() {
        try {
            const ctx = getSTContext();
            if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch (e) { /* ignore */ }
    }

    // ============================================================
    // ★ ロアブック変数の更新ヘルパー
    // ============================================================
    async function setBattleModeVar(value) {
        try {
            const result = await getCurrentVariables();
            if (!result.ok || !result.uid) {
                console.warn(LOG, `setBattleModeVar: 変数取得失敗 (${result.reason})`);
                return false;
            }
            const vars = result.variables.map(v => ({ ...v }));
            const varMap = {};
            for (const v of vars) if (v && v.name) varMap[v.name] = v;

            const bmVar = varMap['バトルモード'];
            if (bmVar) {
                bmVar.value = String(value);
            } else {
                vars.push({ type: 'number', name: 'バトルモード', value: String(value) });
            }

            const data = window.LorebookExpansion.getDataFor(result.worldName, result.uid, result.entry);
            data.variables = vars;
            window.LorebookExpansion.setDataFor(result.worldName, result.uid, result.entry, data);
            console.log(LOG, `バトルモード変数を ${value} に更新`);
            return true;
        } catch (e) {
            console.warn(LOG, 'setBattleModeVar error:', e);
            return false;
        }
    }

    // ★ プレイヤーHPを最大値に全回復
    function restorePlayerHPFull() {
        try {
            if (!window.UserStatus?.fullHeal) {
                console.warn(LOG, 'restorePlayerHPFull: UserStatus.fullHeal が見つかりません');
                return false;
            }
            window.UserStatus.fullHeal();
            console.log(LOG, '💚 プレイヤーHPを最大値に全回復');
            return true;
        } catch (e) {
            console.warn(LOG, 'restorePlayerHPFull error:', e);
            return false;
        }
    }    
    
    async function restoreEnemyHPFull() {
        try {
            const result = await getCurrentVariables();
            if (!result.ok || !result.uid) {
                console.warn(LOG, `restoreEnemyHPFull: 変数取得失敗 (${result.reason})`);
                return false;
            }
            const vars = result.variables.map(v => ({ ...v }));
            const varMap = {};
            for (const v of vars) if (v && v.name) varMap[v.name] = v;

            const curHPVar = varMap['敵キャラの現在HP'];
            const maxHPVar = varMap['敵キャラの最大HP'];
            if (!curHPVar || !maxHPVar) {
                console.warn(LOG, 'restoreEnemyHPFull: 敵HP変数が見つかりません');
                return false;
            }

            const maxHP = parseFloat(maxHPVar.value);
            if (!isFinite(maxHP) || maxHP <= 0) {
                console.warn(LOG, 'restoreEnemyHPFull: 最大HPが無効です', maxHPVar.value);
                return false;
            }

            curHPVar.value = String(maxHP);

            const data = window.LorebookExpansion.getDataFor(result.worldName, result.uid, result.entry);
            data.variables = vars;
            window.LorebookExpansion.setDataFor(result.worldName, result.uid, result.entry, data);
            console.log(LOG, `💚 敵HPを最大値(${maxHP})に全回復`);
            return true;
        } catch (e) {
            console.warn(LOG, 'restoreEnemyHPFull error:', e);
            return false;
        }
    }

    // ============================================================
    // UI設定
    // ============================================================
    function getCurrentCharName() {
        try {
            const ctx = getSTContext();
            const char = ctx?.characters?.[ctx?.characterId];
            return char?.name || null;
        } catch (e) { return null; }
    }

    function _ensureExtSettings() {
        try {
            const ctx = getSTContext();
            if (!ctx?.extensionSettings) return null;
            if (!ctx.extensionSettings[EXT_SETTINGS_KEY]) {
                ctx.extensionSettings[EXT_SETTINGS_KEY] = {};
            }
            return ctx.extensionSettings[EXT_SETTINGS_KEY];
        } catch (e) { return null; }
    }

    function getVisibleByCharMap() {
        const s = _ensureExtSettings();
        if (!s) return {};
        if (!s.visibleByChar || typeof s.visibleByChar !== 'object') s.visibleByChar = {};
        return s.visibleByChar;
    }

    function saveVisibleByCharMap(map) {
        const s = _ensureExtSettings();
        if (!s) return;
        s.visibleByChar = map;
        try {
            const ctx = getSTContext();
            if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch (e) { /* ignore */ }
    }

    function getStartButtonMap() {
        const s = _ensureExtSettings();
        if (!s) return {};
        if (!s.startButtonByChar || typeof s.startButtonByChar !== 'object') s.startButtonByChar = {};
        return s.startButtonByChar;
    }

    function saveStartButtonMap(map) {
        const s = _ensureExtSettings();
        if (!s) return;
        s.startButtonByChar = map;
        try {
            const ctx = getSTContext();
            if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch (e) { /* ignore */ }
    }

    function isVisibleForChar(charName) {
        if (!charName) return false;
        return getVisibleByCharMap()[charName] === true;
    }

    function isStartButtonEnabledForChar(charName) {
        if (!charName) return false;
        return getStartButtonMap()[charName] === true;
    }

    function applyPanelVisibility() {
        const panel = document.getElementById(PANEL_ID);
        const charName = getCurrentCharName();
        const visible = isVisibleForChar(charName);
        const startEnabled = isStartButtonEnabledForChar(charName);

        if (panel) {
            panel.classList.toggle('variable-manager-disabled', !visible);
        }
        const visCb = document.getElementById(VISIBLE_CHECKBOX_ID);
        if (visCb) {
            visCb.checked = visible;
            visCb.disabled = !charName;
        }
        const startCb = document.getElementById(START_CHECKBOX_ID);
        if (startCb) {
            startCb.checked = startEnabled;
            startCb.disabled = !charName;
        }
    }

    function createUISettings() {
        if (document.getElementById(VISIBLE_CHECKBOX_ID)) return;

        const select = document.getElementById('char-management-dropdown');
        if (!select) return;

        const label = select.closest('label') || select.parentElement;
        if (!label) return;

        const container = document.createElement('div');
        container.className = UI_SETTINGS_CLASS;

        const uiLabel = document.createElement('span');
        uiLabel.className = 'variable-manager-ui-label';
        uiLabel.textContent = 'UI設定';
        container.appendChild(uiLabel);

        const startWrap = document.createElement('label');
        startWrap.className = 'variable-manager-checkbox-wrap';
        startWrap.title = 'ゲーム開始ボタンを表示（キャラ毎に保存）';
        const startCb = document.createElement('input');
        startCb.type = 'checkbox';
        startCb.id = START_CHECKBOX_ID;
        startCb.className = 'variable-manager-visible-checkbox';
        startWrap.appendChild(startCb);
        const startText = document.createElement('span');
        startText.className = 'variable-manager-checkbox-text';
        startText.textContent = '開始ボタン';
        startWrap.appendChild(startText);
        startCb.addEventListener('change', () => {
            const charName = getCurrentCharName();
            if (!charName) return;
            const map = getStartButtonMap();
            map[charName] = startCb.checked === true;
            saveStartButtonMap(map);
            try {
                window.dispatchEvent(new CustomEvent(EVENT_START_CHANGED, {
                    detail: { charName, enabled: startCb.checked === true }
                }));
            } catch (e) { /* ignore */ }
        });
        container.appendChild(startWrap);

        const placeWrap = document.createElement('label');
        placeWrap.className = 'variable-manager-checkbox-wrap';
        placeWrap.title = '変数ウインドウを表示（キャラ毎に保存）';
        const visCb = document.createElement('input');
        visCb.type = 'checkbox';
        visCb.id = VISIBLE_CHECKBOX_ID;
        visCb.className = 'variable-manager-visible-checkbox';
        placeWrap.appendChild(visCb);
        const placeText = document.createElement('span');
        placeText.className = 'variable-manager-checkbox-text';
        placeText.textContent = '場所';
        placeWrap.appendChild(placeText);
        visCb.addEventListener('change', () => {
            const charName = getCurrentCharName();
            if (!charName) return;
            const map = getVisibleByCharMap();
            map[charName] = visCb.checked === true;
            saveVisibleByCharMap(map);
            applyPanelVisibility();
            render();
        });
        container.appendChild(placeWrap);

        select.insertAdjacentElement('afterend', container);

        label.style.setProperty('display', 'flex', 'important');
        label.style.setProperty('align-items', 'center', 'important');
        label.style.setProperty('gap', '6px', 'important');
        label.style.setProperty('flex-wrap', 'nowrap', 'important');
        label.style.setProperty('min-width', '0', 'important');
    }

    function ensureUISettings() {
        const select = document.getElementById('char-management-dropdown');
        if (select) {
            const next = select.nextElementSibling;
            const isProper = next && next.classList && next.classList.contains(UI_SETTINGS_CLASS);
            if (!isProper) {
                document.querySelectorAll('.' + UI_SETTINGS_CLASS).forEach(el => el.remove());
                createUISettings();
            }
        }
        applyPanelVisibility();
    }

    function setupUISettingsObserver() {
        const obs = new MutationObserver(() => {
            if (_uiObsPending) return;
            _uiObsPending = true;
            requestAnimationFrame(() => {
                _uiObsPending = false;
                ensureUISettings();
            });
        });
        obs.observe(document.body, { childList: true, subtree: true });
    }

    function ensurePanel() {
        let panel = document.getElementById(PANEL_ID);
        if (panel) return panel;

        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'variable-manager-panel variable-manager-disabled';
        document.body.appendChild(panel);
        return panel;
    }

    // ============================================================
    // ★ バトルモード制御
    // ============================================================
    function getLastAiMessageIndex() {
        const ctx = getSTContext();
        if (!ctx?.chat || ctx.chat.length === 0) return -1;
        for (let i = ctx.chat.length - 1; i >= 0; i--) {
            const m = ctx.chat[i];
            if (m.is_system) continue;
            if (!m.is_user) return i;
        }
        return -1;
    }

    function getLastAiMessageIndex() {
        const ctx = getSTContext();
        if (!ctx?.chat || ctx.chat.length === 0) return -1;
        for (let i = ctx.chat.length - 1; i >= 0; i--) {
            const m = ctx.chat[i];
            if (m.is_system) continue;
            if (!m.is_user) return i;
        }
        return -1;
    }

    // ★ 最後の非システムメッセージが AI かどうか
    //   （ユーザー送信直後〜AI生成完了までは false を返す）
    function isLastMessageAi() {
        const ctx = getSTContext();
        if (!ctx?.chat || ctx.chat.length === 0) return false;
        for (let i = ctx.chat.length - 1; i >= 0; i--) {
            const m = ctx.chat[i];
            if (m.is_system) continue;
            return !m.is_user;
        }
        return false;
    }
    
    function removeBattleStartButton() {
        document.querySelectorAll('.' + BATTLE_START_BTN_CLASS).forEach(el => el.remove());
    }

    function addBattleStartButton() {
        // ★ 最後のメッセージがAIでない場合はボタンを表示しない
        //    （ユーザー送信直後〜AI生成完了までは、直前のAIメッセージに
        //      ボタンが残ったままになるのを防ぐ）
        if (!isLastMessageAi()) {
            removeBattleStartButton();
            return;
        }

        const lastAiIdx = getLastAiMessageIndex();
        if (lastAiIdx < 0) {
            removeBattleStartButton();
            return;
        }

        const mesEl = document.querySelector(`.mes[mesid="${lastAiIdx}"]`);
        if (!mesEl) {
            removeBattleStartButton();
            return;
        }

        const mesTextEl = mesEl.querySelector('.mes_text');
        if (!mesTextEl) {
            removeBattleStartButton();
            return;
        }

        if (mesTextEl.querySelector(':scope > .' + BATTLE_START_BTN_CLASS)) return;

        document.querySelectorAll('.' + BATTLE_START_BTN_CLASS).forEach(el => el.remove());

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = BATTLE_START_BTN_CLASS;
        btn.textContent = 'バトル開始';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            Promise.resolve(startBattle()).catch(err => console.warn(LOG, err));
        });

        mesTextEl.appendChild(btn);
    }

    async function startBattle() {
        if (_battleActive || _startBattleInProgress) return;
        _startBattleInProgress = true;
        _battleActive = true;

        try {
            await setBattleModeVar(1);
        } catch (e) {
            console.warn(LOG, 'startBattle: setBattleModeVar error', e);
        }

        const s = _ensureExtSettings();
        if (s) {
            s.battleState = {
                active: true,
                player_turn: 1,
                enemy_turn: 0,
                player_attack: BATTLE_DEFAULTS.player_attack,
                player_defense: BATTLE_DEFAULTS.player_defense,
                enemy_attack: BATTLE_DEFAULTS.enemy_attack,
                enemy_defense: BATTLE_DEFAULTS.enemy_defense,
            };
            saveBattleState();
        }

        _battlePrevChatHidden = document.body.classList.contains('variable-battle-active');
        document.body.classList.add('variable-battle-active');
        removeBattleStartButton();
        _lastRenderKey = '';
        console.log(LOG, '⚔️ バトル開始', getBattleState());
        applyBattleCommandsVisibility();
        _startBattleInProgress = false;
        render();
    }

    function endBattle() {
        if (!_battleActive) return;
        _battleActive = false;

        const s = _ensureExtSettings();
        if (s && s.battleState) {
            s.battleState.active = false;
            saveBattleState();
        }

        if (!_battlePrevChatHidden) {
            document.body.classList.remove('variable-battle-active');
        }
        _battlePrevChatHidden = null;
        removeBattleStartButton();
        _lastRenderKey = '';
        console.log(LOG, '⚔️ バトル終了');
        applyBattleCommandsVisibility();
    }

    function updateBattleUI(result) {
        const varMap = {};
        if (result.ok && Array.isArray(result.variables)) {
            for (const v of result.variables) {
                if (v && typeof v.name === 'string' && v.name) {
                    varMap[v.name] = v;
                }
            }
        }

        if (!result.ok) {
            console.debug(LOG, `updateBattleUI: result not ok (${result.reason}) → 前回状態を維持`);
            if (_lastBattleMode && !_battleActive) {
                addBattleStartButton();
            }
            return;
        }

        const battleStartRaw = varMap['バトル開始']?.value;
        const battleStart = String(battleStartRaw ?? '').trim() === '1';
        _lastBattleMode = battleStart;

        const battleModeRaw = varMap['バトルモード']?.value;
        const battleMode = String(battleModeRaw ?? '').trim() === '1';

        if (battleMode && !_battleActive && !_startBattleInProgress) {
            console.log(LOG, 'バトルモード変数=1 を検出 → バトル中に復元');
            _battleActive = true;
            document.body.classList.add('variable-battle-active');
            _lastRenderKey = '';
            applyBattleCommandsVisibility();
        } else if (!battleMode && _battleActive && !_startBattleInProgress) {
            console.log(LOG, 'バトルモード変数=0 を検出 → バトル終了');
            endBattle();
        }

        if (!battleStart) {
            removeBattleStartButton();
        } else if (!_battleActive) {
            addBattleStartButton();
        } else {
            removeBattleStartButton();
        }
    }

    // ============================================================
    // ★ 敵の自動攻撃
    // ============================================================
    async function enemyAutoAttack() {
        if (_enemyAttackInProgress) return;
        if (!_battleActive) return;

        const bs = getBattleState();
        if (bs.enemy_turn !== 1) return;

        _enemyAttackInProgress = true;

        try {
            // UI更新を待つ（プレイヤー行動の結果をユーザーが認識できるように）
            await new Promise(r => setTimeout(r, ENEMY_ATTACK_DELAY_MS));

            if (!_battleActive) return;
            const bsNow = getBattleState();
            if (bsNow.enemy_turn !== 1) return;

            const enemyAtk = Number(bsNow.enemy_attack) || 70;
            const playerDef = Number(bsNow.player_defense) || 20;
            const damage = Math.max(1, enemyAtk - playerDef);

            const status = window.UserStatus?.getStatus?.();
            if (!status) {
                console.warn(LOG, 'enemyAutoAttack: UserStatus 未取得');
                return;
            }

            const curHP = status.curHP;
            const newHP = Math.max(0, curHP - damage);

            window.UserStatus.setStatus({ curHP: newHP });

            console.log(
                LOG,
                `👹 敵の攻撃: プレイヤーHP ${curHP} → ${newHP} ` +
                `(ダメージ ${damage} = ${enemyAtk} - ${playerDef})`
            );

            const isPlayerDefeated = newHP <= 0;

            if (isPlayerDefeated) {
                console.log(LOG, '💀 プレイヤーHPが0以下 → バトル終了 + エントリ999ロード');

                // ── ① バトルモード=0 ──
                await setBattleModeVar(0);

                // ── ② バトル終了（HP表示を非表示化） ──
                endBattle();

                // ── ③ 描画してHP非表示を確定 ──
                forceRender();

                // ── ④ HP非表示後にプレイヤーHPを最大値に全回復 ──
                restorePlayerHPFull();

                // ── ⑤ ターンリセット（プレイヤーへ戻す） ──
                bsNow.enemy_turn = 0;
                bsNow.player_turn = 1;
                saveBattleState();

                // ── ⑥ エントリ999を自動送信 ──
                setTimeout(() => {
                    try {
                        loadEntry999();
                    } catch (e) {
                        console.warn(LOG, 'エントリ999ロードエラー:', e);
                    }
                }, ENTRY_999_DELAY_MS);
            } else {
                // 生存：ターン切替（プレイヤーへ戻す）
                bsNow.enemy_turn = 0;
                bsNow.player_turn = 1;
                saveBattleState();
                forceRender();
            }
        } catch (e) {
            console.warn(LOG, 'enemyAutoAttack error:', e);
        } finally {
            _enemyAttackInProgress = false;
        }
    }

    // ★ エントリ999を自動送信
    function loadEntry999() {
        const textarea = document.getElementById('send_textarea');
        if (!textarea) {
            console.warn(LOG, 'loadEntry999: send_textarea が見つかりません');
            return;
        }

        textarea.value = '999';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));

        const sendBtn = document.getElementById('send_but');
        if (sendBtn) {
            sendBtn.click();
            console.log(LOG, '📨 エントリ999を自動送信しました');
        } else {
            const ev = new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true,
            });
            textarea.dispatchEvent(ev);
            console.log(LOG, '📨 エントリ999を自動送信しました（Enterキー）');
        }
    }

    // ============================================================
    // ★ バトルコマンド処理
    // ============================================================
    function forceRender() {
        _lastRenderKey = '';
        const tryRender = async () => {
            let attempts = 0;
            while (_renderInFlight && attempts < 60) {
                await new Promise(r => setTimeout(r, 50));
                attempts++;
            }
            await render();
        };
        tryRender().catch(e => console.warn(LOG, e));
    }

    async function handleAttack() {
        if (!_battleActive) return;
        const bs = getBattleState();

        if (bs.player_turn !== 1) {
            console.log(LOG, `攻撃スキップ: プレイヤーターンではありません (player_turn=${bs.player_turn})`);
            return;
        }

        const result = await getCurrentVariables();
        if (!result.ok || !result.uid) {
            console.warn(LOG, 'バトル: 変数を取得できませんでした');
            return;
        }

        const vars = result.variables.map(v => ({ ...v }));
        const varMap = {};
        for (const v of vars) if (v && v.name) varMap[v.name] = v;

        const curHPVar = varMap['敵キャラの現在HP'];
        if (!curHPVar) {
            console.warn(LOG, 'バトル: 敵キャラの現在HP 変数が見つかりません');
            return;
        }

        const curHP = parseFloat(curHPVar.value) || 0;
        const playerAtk = Number(bs.player_attack) || 60;
        const enemyDef = Number(bs.enemy_defense) || 20;

        const damage = Math.max(1, playerAtk - enemyDef);
        const newHP = Math.max(0, curHP - damage);
        curHPVar.value = String(newHP);

        const isEnemyDefeated = newHP <= 0;
        if (isEnemyDefeated) {
            const bmVar = varMap['バトルモード'];
            if (bmVar) {
                bmVar.value = '0';
            } else {
                vars.push({ type: 'number', name: 'バトルモード', value: '0' });
            }
        }

        try {
            const data = window.LorebookExpansion.getDataFor(result.worldName, result.uid, result.entry);
            data.variables = vars;
            window.LorebookExpansion.setDataFor(result.worldName, result.uid, result.entry, data);
        } catch (e) {
            console.warn(LOG, 'バトル: 変数の保存に失敗', e);
            return;
        }

        bs.player_turn = 0;
        bs.enemy_turn = 1;
        saveBattleState();

        console.log(
            LOG,
            `⚔️ 攻撃: 敵HP ${curHP} → ${newHP} (ダメージ ${damage} = ${playerAtk} - ${enemyDef}) / ` +
            `player_turn=0, enemy_turn=1`
        );

        if (isEnemyDefeated) {
            console.log(LOG, '⚔️ 敵HPが0 → バトル終了（バトルモード=0）');
            endBattle();
            await restoreEnemyHPFull();
            forceRender();
        } else {
            // ★ 敵の自動攻撃をトリガー
            await enemyAutoAttack();
        }
    }

    async function handleDefense() {
        if (!_battleActive) return;
        const bs = getBattleState();

        if (bs.player_turn !== 1) {
            console.log(LOG, `防御スキップ: プレイヤーターンではありません (player_turn=${bs.player_turn})`);
            return;
        }

        const before = Number(bs.player_defense) || 20;
        bs.player_defense = before * 2;
        bs.player_turn = 0;
        bs.enemy_turn = 1;
        saveBattleState();

        console.log(
            LOG,
            `🛡️ 防御: player_defense ${before} → ${bs.player_defense} / ` +
            `player_turn=0, enemy_turn=1`
        );

        // ★ 敵の自動攻撃をトリガー
        await enemyAutoAttack();
    }

    async function handleEscape() {
        if (!_battleActive) return;

        await setBattleModeVar(0);
        endBattle();
        await restoreEnemyHPFull();

        console.log(LOG, '🏃 逃走: バトルモードを終了し、敵HPを全回復しました');
        forceRender();
    }

    // ============================================================
    // ★ バトルコマンドUI
    // ============================================================
    function ensureBattleCommands() {
        let container = document.getElementById(BATTLE_COMMANDS_ID);
        if (container) return container;

        container = document.createElement('div');
        container.id = BATTLE_COMMANDS_ID;
        container.className = 'variable-battle-commands';
        container.style.display = 'none';

        const buttons = [
            { label: '攻撃', color: 'attack', handler: handleAttack },
            { label: '防御', color: 'defense', handler: handleDefense },
            { label: '道具', color: 'item', handler: null },
            { label: '逃走', color: 'escape', handler: handleEscape },
        ];
        for (const b of buttons) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `variable-command-btn variable-command-${b.color}`;
            btn.textContent = b.label;
            // ★ クリック時に効果音を再生
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                // 効果音（window経由 + 失敗しても後続を止めない）
                try {
                    if (b.color === 'attack') {
                        window.playSound?.(window.SOUND_EFFECTS?.attack);
                    } else if (b.color === 'defense') {
                        window.playSound?.(window.SOUND_EFFECTS?.defense);
                    } else if (b.color === 'escape') {
                        // window.playSound?.(window.SOUND_EFFECTS?.escape);
                    }
                } catch (err) {
                    console.warn(LOG, '効果音エラー:', err);
                }

                // 既存の処理
                if (typeof b.handler === 'function') {
                    Promise.resolve(b.handler()).catch(err => console.warn(LOG, err));
                }
            });
            container.appendChild(btn);
        }

        document.body.appendChild(container);
        return container;
    }

    function applyBattleCommandsVisibility() {
        const container = document.getElementById(BATTLE_COMMANDS_ID);
        if (!container) return;
        const charName = getCurrentCharName();
        const shouldShow = isVisibleForChar(charName) && _battleActive;
        container.style.display = shouldShow ? '' : 'none';
    }

    // ============================================================
    // レンダリング
    // ============================================================
    function renderPanel(panel, result) {
        if (!panel) return;

        const varMap = {};
        if (result.ok && Array.isArray(result.variables)) {
            for (const v of result.variables) {
                if (v && typeof v.name === 'string' && v.name) {
                    varMap[v.name] = v;
                }
            }
        }

        const locVal = varMap['場所']?.value;
        const locationText = (locVal !== undefined && locVal !== null && String(locVal).trim())
            ? String(locVal)
            : '場所';

        let enemyName = null;
        let hp = null;
        if (_battleActive) {
            const enemyNameVal = varMap['敵キャラの名前']?.value;
            if (enemyNameVal !== undefined && enemyNameVal !== null && String(enemyNameVal).trim()) {
                enemyName = String(enemyNameVal);
            }

            const curHP = parseFloat(varMap['敵キャラの現在HP']?.value);
            const maxHP = parseFloat(varMap['敵キャラの最大HP']?.value);
            if (isFinite(curHP) && isFinite(maxHP) && maxHP > 0) {
                hp = {
                    cur: curHP,
                    max: maxHP,
                    ratio: Math.max(0, Math.min(1, curHP / maxHP)),
                };
            }
        }

        const signature = JSON.stringify({ locationText, enemyName, hp });
        if (signature === _lastRenderKey) return;
        _lastRenderKey = signature;

        panel.innerHTML = '';

        const locEl = document.createElement('div');
        locEl.className = 'variable-manager-value-text variable-location';
        locEl.textContent = locationText;
        panel.appendChild(locEl);

        if (enemyName) {
            const nameEl = document.createElement('div');
            nameEl.className = 'variable-manager-value-text variable-enemy-name';
            nameEl.textContent = enemyName;
            panel.appendChild(nameEl);
        }

        if (hp) {
            const wrap = document.createElement('div');
            wrap.className = 'variable-hp-bar-wrap';

            const bar = document.createElement('div');
            bar.className = 'variable-hp-bar';
            bar.style.width = `${hp.ratio * 100}%`;
            wrap.appendChild(bar);
            panel.appendChild(wrap);

            const hpText = document.createElement('div');
            hpText.className = 'variable-hp-text';
            hpText.textContent = String(Math.round(hp.cur));
            panel.appendChild(hpText);
        }
    }

    async function render() {
        ensureUISettings();
        ensureBattleCommands();
        applyBattleCommandsVisibility();

        const charName = getCurrentCharName();
        if (!isVisibleForChar(charName)) {
            console.debug(LOG, `render: 場所未チェックのためスキップ (char="${charName}")`);
            if (_battleActive) endBattle();
            removeBattleStartButton();
            _lastRenderKey = '';
            return;
        }

        if (_renderInFlight) return;
        _renderInFlight = true;
        try {
            const panel = ensurePanel();
            applyPanelVisibility();
            const result = await getCurrentVariables();
            updateBattleUI(result);
            renderPanel(panel, result);
        } catch (e) {
            console.warn(LOG, 'render error:', e);
        } finally {
            _renderInFlight = false;
        }
    }

    function scheduleRender() { setTimeout(render, 150); }

    function setupEventListeners() {
        try {
            const ctx = getSTContext();
            if (ctx?.eventSource && ctx?.eventTypes) {
                const et = ctx.eventTypes;
                const es = ctx.eventSource;

                const resetOnChange = () => {
                    if (_battleActive) endBattle();
                    scheduleRender();
                };

                const events = [
                    'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED',
                    'MESSAGE_EDITED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED',
                    'CHAT_LOADED', 'GENERATION_ENDED',
                ];
                for (const name of events) {
                    if (et[name] && typeof es.on === 'function') es.on(et[name], scheduleRender);
                }

                if (et['MESSAGE_SENT'] && typeof es.on === 'function') {
                    es.on(et['MESSAGE_SENT'], () => {
                        setTimeout(render, 100);
                    });
                }

                const resetEvents = ['CHAT_CHANGED', 'CHARACTER_SELECTED', 'CHARACTER_PAGE_LOADED'];
                for (const name of resetEvents) {
                    if (et[name] && typeof es.on === 'function') es.on(et[name], resetOnChange);
                }
            }
        } catch (e) { /* ignore */ }
    }

    async function init() {
        if (_initialized) return;
        _initialized = true;

        const ready = await waitForLBE();
        if (!ready) { _initialized = false; setTimeout(init, 1000); return; }

        ensurePanel();
        ensureBattleCommands();
        ensureUISettings();
        setupEventListeners();
        setupUISettingsObserver();
        await render();

        setInterval(render, POLL_INTERVAL_MS);
        console.log(LOG, '初期化完了');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.VariableManager = {
        refresh: render,
        getCurrentVariables,
        isVisibleForChar,
        isStartButtonEnabledForChar,
        isBattleActive: () => _battleActive,
        isEnemyAttackInProgress: () => _enemyAttackInProgress,
        startBattle,
        endBattle,
        getBattleState,
        setBattleState: (patch) => {
            const s = _ensureExtSettings();
            if (!s) return;
            if (!s.battleState) s.battleState = { ...BATTLE_DEFAULTS };
            Object.assign(s.battleState, patch || {});
            saveBattleState();
            forceRender();
        },
        handleAttack,
        handleDefense,
        handleEscape,
        enemyAutoAttack,
        setBattleModeVar,
        restoreEnemyHPFull,
        loadEntry999,
        setVisibleForChar: (charName, visible) => {
            if (!charName) return false;
            const map = getVisibleByCharMap();
            map[charName] = !!visible;
            saveVisibleByCharMap(map);
            applyPanelVisibility();
            render();
            return true;
        },
        setStartButtonForChar: (charName, enabled) => {
            if (!charName) return false;
            const map = getStartButtonMap();
            map[charName] = !!enabled;
            saveStartButtonMap(map);
            applyPanelVisibility();
            try {
                window.dispatchEvent(new CustomEvent(EVENT_START_CHANGED, {
                    detail: { charName, enabled: !!enabled }
                }));
            } catch (e) { /* ignore */ }
            return true;
        },
        _debug: () => ({
            worldName: getWorldName(),
            choiceNum: getLastChoiceNumber(),
            currentChar: getCurrentCharName(),
            visibleMap: getVisibleByCharMap(),
            startButtonMap: getStartButtonMap(),
            battleActive: _battleActive,
            battleState: getBattleState(),
            lastBattleMode: _lastBattleMode,
            startBattleInProgress: _startBattleInProgress,
            enemyAttackInProgress: _enemyAttackInProgress,
        }),
        debugBattleButton: async () => {
            const charName = getCurrentCharName();
            const visible = isVisibleForChar(charName);
            const result = await getCurrentVariables();
            const varMap = {};
            if (result.ok) {
                for (const v of result.variables) {
                    if (v && v.name) varMap[v.name] = v;
                }
            }
            const lastAiIdx = getLastAiMessageIndex();
            const hasBtn = !!document.querySelector('.' + BATTLE_START_BTN_CLASS);
            const userStatus = window.UserStatus?.getStatus?.();
            const info = {
                charName,
                場所チェック: visible,
                result_ok: result.ok,
                reason: result.reason,
                選択肢番号: result.choiceNum,
                バトル開始: varMap['バトル開始']?.value,
                バトルモード: varMap['バトルモード']?.value,
                敵現在HP: varMap['敵キャラの現在HP']?.value,
                敵最大HP: varMap['敵キャラの最大HP']?.value,
                プレイヤーHP: userStatus ? `${userStatus.curHP}/${userStatus.maxHP}` : null,
                _lastBattleMode,
                _battleActive,
                _startBattleInProgress,
                _enemyAttackInProgress,
                battleState: getBattleState(),
                最後のAIメッセージ_idx: lastAiIdx,
                ボタン存在: hasBtn,
            };
            console.log(LOG, 'debugBattleButton:', info);
            return info;
        },
    };
})();
