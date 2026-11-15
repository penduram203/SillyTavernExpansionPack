// console_filter.js
// コンソールログのノイズフィルタ拡張
//
// 目的:
//   拡張パックが正常動作している状態で、ポーリング・再描画・状態同期などの
//   定常ログを抑制し、エラー・警告・ユーザー操作結果だけをコンソールに残す。
//
// 特徴:
//   - console.log / console.debug / console.info のみフィルタ
//     （console.warn / console.error は常に通す）
//   - localStorage で ON/OFF 永続化（デフォルト ON）
//   - verbose モードで「[FILTERED] xxx」として残す（デバッグ時用）
//   - ランタイムでパターン追加可能
//
// 使い方（コンソールで）:
//   ConsoleFilter.disable()            ... フィルタOFF（全ログ表示）
//   ConsoleFilter.enable()             ... フィルタON（デフォルト）
//   ConsoleFilter.setVerbose(true)     ... 抑制したログを [FILTERED] として残す
//   ConsoleFilter.addPattern(/.../)    ... パターン追加
//   ConsoleFilter.listPatterns()       ... 現在のパターン一覧
//   ConsoleFilter.mute(2000)           ... 2秒だけ全ログ表示

(function () {
    'use strict';
    if (window.__expConsoleFilterInstalled) return;
    window.__expConsoleFilterInstalled = true;

    const LOG = '[ConsoleFilter]';
    const FILTER_KEY = 'exp_console_filter_enabled';
    const VERBOSE_KEY = 'exp_console_filter_verbose';

    let enabled = localStorage.getItem(FILTER_KEY) !== 'false';
    let verbose = localStorage.getItem(VERBOSE_KEY) === 'true';
    let mutedUntil = 0;

    // ── 抑制パターン ──
    //   コンソール出力の「先頭文字列」に対してテストする。
    //   ログの message がマッチしたら出力しない。
    const SUPPRESS_PATTERNS = [
        // === GIC のループ出力 ===
        /^\[GIC\] refreshUnregisterButton/,
        /^\[GIC\] 🚫 \/api\/images\/list/,
        /^\[GIC\] 🎯 galleryMaxRows/,
        /^\[GIC\] 🎯 3列強制/,
        /^\[GIC\] 🔥 メモリキャッシュウォームアップ/,
        /^\[GIC\] ギャラリー高さ/,
        /^\[GIC\] 🚫 新規 #gallery/,
        /^\[GIC\] 🚪 付属UIを即座に非表示/,
        /^\[GIC\] ✅ warmUpGallery/,
        /^\[GIC\] ✅ nanogallery2 patch/,
        /^\[GIC\] 外部 ComfyUI URL/,
        /^\[GIC\] 永続状態を復元/,
        /^\[GIC\] モジュールロード開始/,
        /^\[GIC-Lore\] トリガー:/,
        /^\[GIC-Lore\] イベント登録完了/,
        /^\[GIC-Lore\] ✅ \/gic-sd/,
        /^\[GIC-Boot\]/,

        // === ImageDisplay のループ出力 ===
        /^\[ImageDisplay\] 💾 バッグ状態を保存/,
        /^\[ImageDisplay\] 🔄 全画像表示済み/,
        /^\[ImageDisplay\] 🎲 半ランダム選択/,
        /^\[ImageDisplay\] 画像ブランチ/,
        /^\[ImageDisplay\] img 読み込み成功/,
        /^\[ImageDisplay\] 同一URLのため再描画スキップ/,
        /^\[ImageDisplay\] 📂 バッグ状態を復元/,
        /^\[ImageDisplay\] image_display_extension を読込/,
        /^\[ImageDisplay\] CHARACTER_EDITED/,
        /^\[ImageDisplay\] 💾/,

        // === CharStore のループ出力 ===
        /^\[CharStore\] 🎯 merge に backup 注入/,
        /^\[CharStore\] ✅ .* に保存/,
        /^\[CharStore\] キャラ切替: pending/,
        /^\[CharStore\] 🎯 キャラ切替クリーンアップ/,
        /^\[CharStore\] 🎯 export_button/,
        /^\[CharStore\] 🎯 Blob/,
        /^\[CharStore\] 🎯 edit fetch/,
        /^\[CharStore\] 公開API/,

        // === VarManager のループ出力 ===
        /^\[VarManager\] 共通ルール:/,
        /^\[VarManager\] updateBattleUI:/,
        /^\[VarManager\] 🔄 キャラ変更を検知/,

        // === LBE のイベント受信 ===
        /^\[LBE\] WORLDINFO_ENTRIES_LOADED/,
        /^\[LBE\] WORLDINFO_SETTINGS_UPDATED/,
        /^\[LBE\] WORLDINFO_UPDATED/,
        /^\[LBE\] ⚠️ fetch 失敗/,

        // === STJ Editor のループ出力 ===
        /^\[STJ Editor\] 🔄 bag_state から/,
        /^\[STJ Editor\] 📂 ディスクスキャン/,
        /^\[STJ Editor\] 🔄 統合復元/,
        /^\[STJ Editor\] ✅ 同期完了/,
        /^\[STJ Editor\] syncLorebook/,
        /^\[STJ Editor\] 🗑️ ロアブックに存在しない/,
        /^\[STJ Editor\] 🆕 セル自動作成/,
        /^\[STJ Editor\] 🌐 グローバル/,
        /^\[STJ Editor\] 🎯 カスタムドロップ/,
        /^\[STJ Editor\] 📢/,

        // === WBAutoSelect のイベント毎出力 ===
        /^\[WBAutoSelect\] start:/,
        /^\[WBAutoSelect\] same char/,
        /^\[WBAutoSelect\] skip: no char/,
        /^\[WBAutoSelect\] 中断: キャラ変更/,
        /^\[WBAutoSelect\] 📋 editor/,
        /^\[WBAutoSelect\] 📋 world_info/,
        /^\[WBAutoSelect\] 🛡️/,
        /^\[WBAutoSelect\] 🩹/,
        /^\[WBAutoSelect\] 📝 comment→key synced/,

        // === RightNav のポーリング ===
        /^\[RightNavKai DEBUG\]/,

        // === Text Styling の状態変化 ===
        /^\[Text Styling\] ボタンテキスト更新/,
        /^\[Text Styling\] レイアウト:/,
        /^\[Text Styling\] 手動モードを抜ける/,
        /^\[Text Styling\] トグル:/,

        // === Chat Window On/Off の状態変化 ===
        /^\[Chat Window On\/Off\] 🔓 Tパネル非表示/,
        /^\[Chat Window On\/Off\] 🔒 Tパネル表示中/,

        // === SoundEffects のファイル読み込み ===
        /^\[SoundEffects\] 効果音を読み込みました/,
        /^\[SoundEffects\] 音声ファイルが見つかりません/,

        // === ST コア: イベントシステム ===
        /^Event emitted:/,

        // === ST コア: メッセージ描画 ===
        /^Rendered \d+ messages/,
        /^saw no avatars/,

        // === ST コア: WI スキャン（超ノイズ） ===
        /^\[WI\] --- /,
        /^\[WI\] Entry /,
        /^\[WI\] Search done/,
        /^\[WI\] Successfully activated/,
        /^\[WI\] Hypothetically adding/,
        /^\[WI\] No new entries/,
        /^\[WI\] Scan done/,
        /^\[WI\] Scan state/,
        /^\[WI\] Setting scan state/,
        /^\[WI\] Found /,
        /^\[WI\] Global world info has/,
        /^\[WI\] Character /,
        /^\[WI\] Context size/,
        /^\[WI\] No inclusion groups/,
        /^\[WI\] No probability checks/,
        /^\[WI\] WI entry/,

        // === ST コア: power-user / movingUI ===
        /^Setting context_/,
        /^skipping movingUI state load/,
        /^aborting MUI reset/,
        /^setting pin class/,
        /^Summary has no content/,

        // === ST コア: プリセット/サンプラー ===
        /^Preset samplers order:/,
        /^Registering preset manager/,
        /^returning full samplers array/,
        /^Text Completions: loading selected samplers/,
        /^poweruser\.chat_display/,
        /^applying default chat/,

        // === ST コア: 拡張アクティベート ===
        /^Activating extension /,
        /^callExtensionHook: /,

        // === ST コア: misc ===
        /^Loading locale data/,
        /^User Agent/,
        /^Google model changed/,
        /^Chat Completions: loading token cache/,
        /^Chat Completions: saving token cache/,
        /^getting sprites list/,
        /^Character context menu initialized/,
        /^setting pin class/,
        /^saw no avatars/,
        /^Window resize:/,
        /^Zoom:/,
        /^8192 script\.js/,
        /^value\? /,
        /^hiding settings\?/,
        /^Settings not ready, scheduling another save/,
        /^Using default TTS Provider settings/,
        /^SystemTTS: Settings loaded/,
        /^Streaming /,
        /^Using /,
        /^Core\/all messages:/,
        /^skipWIAN not active/,
        /^calling runGenerate/,
        /^generating prompt/,
        /^---calling setPromptString/,
        /^Generate entered/,
        /^Core\/all messages:/,

        // === ST コア: チャット/キャラ系 ===
        /^Chat .* is already open/,
        /^\[QR2\] (executing|sets|settings|calling|READY|CHAT_CHANGED|\/executing)/,
        /^getting sprites list/,

        // === GIC-Bulk ===
        /^\[GIC-Bulk\]/,

        // === ChoiceClick の初期化 ===
        /^\[ChoiceClick\] (MutationObserver|初期化完了|#q-text-color)/,
    ];

    // ── オリジナル console メソッドを保存 ──
    const orig = {
        log: console.log,
        debug: console.debug,
        info: console.info,
    };

    function shouldSuppress(args) {
        if (!enabled) return false;
        if (Date.now() < mutedUntil) return false;
        const first = args[0];
        if (typeof first !== 'string') return false;
        // 文字列が長すぎる場合は先頭128文字だけテスト（性能対策）
        const probe = first.length > 128 ? first.slice(0, 128) : first;
        for (let i = 0; i < SUPPRESS_PATTERNS.length; i++) {
            try {
                if (SUPPRESS_PATTERNS[i].test(probe)) return true;
            } catch (e) { /* ignore */ }
        }
        return false;
    }

    function makeFiltered(origFn) {
        return function (...args) {
            try {
                if (shouldSuppress(args)) {
                    if (verbose) {
                        return origFn.call(this, '[FILTERED]', ...args);
                    }
                    return;
                }
            } catch (e) { /* fall through */ }
            return origFn.apply(this, args);
        };
    }

    console.log = makeFiltered(orig.log);
    console.debug = makeFiltered(orig.debug);
    console.info = makeFiltered(orig.info);

    // ── 公開 API ──
    window.ConsoleFilter = {
        enable() {
            enabled = true;
            localStorage.setItem(FILTER_KEY, 'true');
            orig.log.call(console, LOG, '✅ filter ON');
        },
        disable() {
            enabled = false;
            localStorage.setItem(FILTER_KEY, 'false');
            orig.log.call(console, LOG, '❌ filter OFF');
        },
        isEnabled() { return enabled; },
        setVerbose(v) {
            verbose = !!v;
            localStorage.setItem(VERBOSE_KEY, String(verbose));
            orig.log.call(console, LOG, `verbose=${verbose}`);
        },
        isVerbose() { return verbose; },
        addPattern(regex) {
            if (regex instanceof RegExp) {
                SUPPRESS_PATTERNS.push(regex);
                orig.log.call(console, LOG, `pattern added: ${regex}`);
            }
        },
        listPatterns() {
            return SUPPRESS_PATTERNS.map(p => String(p));
        },
        mute(durationMs = 2000) {
            mutedUntil = Date.now() + durationMs;
            orig.log.call(console, LOG, `muted for ${durationMs}ms`);
        },
        stats() {
            return {
                enabled,
                verbose,
                patternCount: SUPPRESS_PATTERNS.length,
                mutedUntil,
            };
        },
    };

    orig.log.call(console, LOG, `installed (filter=${enabled ? 'ON' : 'OFF'}, verbose=${verbose}, patterns=${SUPPRESS_PATTERNS.length})`);
})();
