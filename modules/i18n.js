// i18n.js
// 拡張パック共通の多言語対応（英語 / 日本語）
//
// - SillyTavern の power_user.user_language から言語を判定
// - window.ExpI18n.t(key, fallback, params) でキーを翻訳
// - window.ExpI18n.lang / getLanguage() で現在の言語コード ('ja' | 'en')
// - HTML の data-exp-i18n / data-exp-i18n-title / data-exp-i18n-placeholder 属性を自動翻訳
// - 言語変更を 1 秒間隔の polling で検知し、登録されたコールバックを呼ぶ
// - window.ExpI18n.extend(lang, dict) で他モジュールから辞書を追加可能

(function () {
    'use strict';
    if (window.__expI18nInstalled) return;
    window.__expI18nInstalled = true;

    const LOG = '[ExpI18n]';

    // ------------------------------------------------------------
    // 辞書
    // ------------------------------------------------------------
    const TRANSLATIONS = {
        en: {
            // === 共通 ===
            'common.yes': 'Yes',
            'common.no': 'No',
            'common.ok': 'OK',
            'common.cancel': 'Cancel',
            'common.apply': 'Apply',
            'common.delete': 'Delete',
            'common.refresh': 'Refresh',
            'common.updating': 'Updating…',

            // === GIC: ボタン ===
            'gic.button.unregister': 'Unlink',
            'gic.button.delete': 'Delete',
            'gic.button.refresh': '🔄 Refresh',
            'gic.button.refreshing': 'Updating…',
            'gic.button.bulk_select': 'Bulk Select',
            'gic.button.bulk_end': 'End Selection',
            'gic.button.bulk_end_count': 'End ({count})',

            // === GIC: ツールチップ ===
            'gic.title.unregister': 'Unregister the currently displayed image from the cell',
            'gic.title.delete': 'Delete the currently displayed image from local disk',
            'gic.title.refresh': 'Manually refresh the gallery (clear cache and reload)',
            'gic.title.bulk_toggle': 'Start / end bulk selection mode',
            'gic.title.delete_header_disabled': 'Start bulk selection mode first to use this',
            'gic.title.delete_header_ready': 'Delete the {count} selected image(s)',
            'gic.title.delete_header_select_first': 'Select images first',
            'gic.title.gallery_open': 'Open the SillyTavern official gallery',
            'gic.title.gallery_loading_click': 'Loading gallery… (click to open immediately)',
            'gic.title.floating_bulk_exit': 'End bulk selection mode',

            // === GIC: ダイアログ ===
            'gic.dialog.delete.title': 'The image will be unregistered, and the image file itself will be deleted.',
            'gic.dialog.delete.subtitle': 'Are you sure you want to delete it?',
            'gic.dialog.delete.yes': 'Yes',
            'gic.dialog.delete.no': 'No',

            // === GIC: トースト（削除 / 登録解除） ===
            'gic.toast.unregistered': 'The image has been unregistered.',
            'gic.toast.unregister_failed': 'Failed to unregister the image.',
            'gic.toast.deleted': 'The image has been deleted.',
            'gic.toast.delete_failed': 'Failed to delete the image.',

            // === GIC: トースト（コピー） ===
            'gic.toast.copy_prompt': 'Prompt copied to clipboard.',
            'gic.toast.copy_negative': 'Negative prompt copied to clipboard.',
            'gic.toast.copy_both': 'Prompt and negative prompt copied to clipboard.',
            'gic.toast.copy_failed': 'Failed to copy.',

            // === GIC: トースト（一括選択） ===
            'gic.toast.bulk_started': 'Bulk selection mode — click images to select',
            'gic.toast.bulk_ended': 'Bulk selection mode ended.',
            'gic.toast.bulk_no_selection': 'No images are selected for deletion.',
            'gic.toast.bulk_select_first': 'Please select images using the "Bulk Select" button first.',

            // === GIC: バナー（ギャラリー上部の赤枠） ===
            'gic.banner.bulk_mode': 'Bulk selection mode — click images to select',
            'gic.banner.bulk_selected': 'select {count} image(s) (🗑 to delete / drag to register together)',

            // === STJ Editor ===
            'stj.char_name_missing': 'Character name is not set.',
            'stj.save_success': 'Data saved.',

            'stj.keyword_dup_toast_title': 'Duplicate keyword',
            'stj.keyword_dup_msg': 'This keyword is already set: "{keyword}"',
            'stj.keyword_dup_title_attr': 'This keyword is already set',

            'stj.preview.placeholder': 'Preview',
            'stj.preview.default_placeholder': 'Default media preview',
            'stj.preview.thumbnail_placeholder': 'Thumbnail preview',
            'stj.preview.missing_file': 'File not found',
            'stj.preview.loading': 'Loading...',

            'stj.choices.label': 'Choices',
            'stj.choices.button': 'Choices',
            'stj.choices.button_title': 'Show choices ({count})',

            'stj.cell_modal.apply': 'Apply',
            'stj.cell_modal.cancel': 'Cancel',
            'stj.cell_modal.keyword_placeholder': 'Keyword',
            'stj.cell_modal.slot_remove_title': 'Unregister',

            'stj.drag.swap': '⇄ Swap',
            'stj.drag.insert': '⬇ Insert',

            'stj.confirm.delete_msg': 'Are you sure you want to delete?',
            'stj.confirm.bulk_delete_msg': 'Are you sure you want to delete in bulk?',
            'stj.confirm.unregister_images_msg': 'Unregister {count} image(s) from the keyword?',
            'stj.confirm.yes': 'Yes',
            'stj.confirm.no': 'No',

            'stj.bulk_delete.in_progress': 'Deleting selected cells in bulk...',

            'stj.test.empty_hint': 'Enter text to see which keywords match.',
            'stj.test.matched': 'Matched 「{keyword}」! (File: {file})',
            'stj.test.no_match': 'No keyword matched (default "{default}" will be applied).',
            'stj.test.file_unspecified': 'unspecified',
            'stj.test.result_prefix': 'Result',

            'stj.header.title': '🔍 Real-time keyword reaction test',
            'stj.header.help': 'Help',
            'stj.header.test_placeholder': 'Enter a test sentence (e.g., greets with a smile)...',

            'stj.special.default_label': 'Default display',
            'stj.special.thumbnail_label': 'Thumbnail display',

            'stj.info.click_hint': '※ Click a cell to open the edit window.',
            'stj.info.title': '📖 Operations',
            'stj.info.op_click': '<b>Click a cell</b>: opens the edit window',
            'stj.info.op_drag_gallery': '<b>Drag &amp; drop from the gallery</b>: adds an image',
            'stj.info.op_drag_cell': '<b>Drag a cell</b>: swaps cell positions',
            'stj.info.op_hover_remove': '<b>Hover in the edit window</b>: ❌ button on each slot → unregister',
            'stj.info.op_delete_btn': '<b>❌ button</b>: deletes the cell',
            'stj.info.op_bulk_delete': '<b>Bulk Delete</b>: deletes multiple cells at once',
            'stj.info.op_add_cell': '<b>Add Cell</b>: adds a new cell',

            'stj.button.close': 'Close',
            'stj.button.update': 'Update',
            'stj.button.update_title': 'Sync with lorebook entries and auto-create cells (no auto-delete)',
            'stj.button.bulk_delete': 'Bulk Delete',
            'stj.button.back': 'Back',
            'stj.button.execute_delete': 'Execute Delete',

            'stj.syntax.title': '🔧 Basic Operators',
            'stj.syntax.and': 'AND (all must match)',
            'stj.syntax.and_ex': 'Example: <code>mountain+river</code> → matches when both "mountain" and "river" are present',
            'stj.syntax.or': 'OR (any match)',
            'stj.syntax.or_ex': 'Example: <code>mountain,river</code> → matches when either "mountain" or "river" is present',
            'stj.syntax.not': 'NOT (exclude)',
            'stj.syntax.not_ex': 'Example: <code>!mountain</code> → matches only when "mountain" is not present',
            'stj.syntax.group': 'Grouping (nestable)',
            'stj.syntax.group_ex': 'Example: <code>(mountain+river),valley</code> → matches either "mountain and river" or "valley"',

            'stj.toast.sync_added': 'Synced with lorebook ({count} added)',
            'stj.toast.sync_no_add': 'No new cells to sync',
            'stj.toast.sync_failed': 'Sync failed',
            
            // === GIC: 確認 ===
            'gic.confirm.bulk_delete': 'Delete the {count} selected image(s)?\nThis operation cannot be undone.',

            // === GIC: ステータス ===
            'gic.status.gallery_loading': 'Loading gallery…',
            'gic.status.gallery_ready': 'Loaded',
            'gic.status.gallery_load_failed': 'Loading failed.',

            // === GIC: プロンプトオーバーレイ ===
            'gic.prompt.keyword': 'Keyword',
            'gic.prompt.copy_prompt': 'Copy prompt',
            'gic.prompt.copy_negative': 'Copy negative',
            'gic.prompt.copy_both': 'Copy both',

            // === Font Scale Auto ダイアログ ===
            'fsa.dialog.title': 'Select your monitor resolution',
            'fsa.dialog.desc': 'The font scale will be set automatically based on the selected resolution.\n(The scale is calculated using 1920×1080 as the base.)',
            'fsa.dialog.hint': '↓ Click the dropdown below and choose your resolution',
            'fsa.dialog.resolution_label': 'Resolution:',
            'fsa.dialog.dont_show': "Don't show this message again",
            'fsa.dialog.note': 'You can always change the font size from "Font Scale" in the user settings.',
            'fsa.dialog.cancel': 'Cancel',
            'fsa.dialog.apply': 'Apply',
        },
        ja: {
            // === 共通 ===
            'common.yes': 'はい',
            'common.no': 'いいえ',
            'common.ok': 'OK',
            'common.cancel': 'キャンセル',
            'common.apply': '適用',
            'common.delete': '削除',
            'common.refresh': '更新',
            'common.updating': '更新中…',

            // === GIC: ボタン ===
            'gic.button.unregister': '解除',
            'gic.button.delete': '削除',
            'gic.button.refresh': '🔄 更新',
            'gic.button.refreshing': '更新中…',
            'gic.button.bulk_select': '一括選択',
            'gic.button.bulk_end': '選択終了',
            'gic.button.bulk_end_count': '選択終了 ({count})',

            // === GIC: ツールチップ ===
            'gic.title.unregister': '現在表示中の画像をセルから登録解除する',
            'gic.title.delete': '現在表示中の画像をローカルディスクから削除する',
            'gic.title.refresh': 'ギャラリーを手動で更新（キャッシュをクリアして再読込）',
            'gic.title.bulk_toggle': '一括選択モードの開始／終了',
            'gic.title.delete_header_disabled': '一括選択モードを開始すると使えます',
            'gic.title.delete_header_ready': '選択中の {count} 枚を削除',
            'gic.title.delete_header_select_first': '先に画像を選択してください',
            'gic.title.gallery_open': 'SillyTavern公式ギャラリーを開く',
            'gic.title.gallery_loading_click': 'ギャラリーを読み込み中です…（クリックで即時オープン）',
            'gic.title.floating_bulk_exit': '一括選択モードを終了',

            // === GIC: ダイアログ ===
            'gic.dialog.delete.title': '画像登録が解除され画像ファイル自体も削除されます',
            'gic.dialog.delete.subtitle': '本当に削除しますか？',
            'gic.dialog.delete.yes': 'はい',
            'gic.dialog.delete.no': 'いいえ',

            // === GIC: トースト（削除 / 登録解除） ===
            'gic.toast.unregistered': '画像の登録が解除されました',
            'gic.toast.unregister_failed': '登録解除に失敗しました',
            'gic.toast.deleted': '画像が削除されました',
            'gic.toast.delete_failed': '画像の削除に失敗しました',

            // === GIC: トースト（コピー） ===
            'gic.toast.copy_prompt': 'プロンプトをコピーしました',
            'gic.toast.copy_negative': 'ネガティブプロンプトをコピーしました',
            'gic.toast.copy_both': 'プロンプトとネガティブをコピーしました',
            'gic.toast.copy_failed': 'コピーに失敗しました',

            // === GIC: トースト（一括選択） ===
            'gic.toast.bulk_started': '一括選択モード — 画像クリックで選択',
            'gic.toast.bulk_ended': '一括選択モードを終了しました',
            'gic.toast.bulk_no_selection': '削除する画像が選択されていません',
            'gic.toast.bulk_select_first': '先に「一括選択」ボタンで画像を選択してください',

            // === GIC: バナー（ギャラリー上部の赤枠） ===
            'gic.banner.bulk_mode': '一括選択モード — 画像クリックで選択',
            'gic.banner.bulk_selected': '一括選択中 — {count} 枚（🗑 で削除 / ドラッグでまとめて登録）',

            // === STJ Editor ===
            'stj.char_name_missing': 'キャラクター名が設定されていません',
            'stj.save_success': 'データを保存しました',

            'stj.keyword_dup_toast_title': 'キーワード重複',
            'stj.keyword_dup_msg': '既に同じキーワードが設定されています: 「{keyword}」',
            'stj.keyword_dup_title_attr': '既に同じキーワードが設定されています',

            'stj.preview.placeholder': 'プレビュー',
            'stj.preview.default_placeholder': 'デフォルトメディアプレビュー',
            'stj.preview.thumbnail_placeholder': 'サムネイルプレビュー',
            'stj.preview.missing_file': 'ファイルが見つかりません',
            'stj.preview.loading': '読み込み中...',

            'stj.choices.label': '選択肢',
            'stj.choices.button': '選択肢',
            'stj.choices.button_title': '選択肢を表示 ({count}件)',

            'stj.cell_modal.apply': '決定',
            'stj.cell_modal.cancel': 'キャンセル',
            'stj.cell_modal.keyword_placeholder': 'キーワード',
            'stj.cell_modal.slot_remove_title': '登録解除',

            'stj.drag.swap': '⇄ 場所交代',
            'stj.drag.insert': '⬇ 隙間挿入',

            'stj.confirm.delete_msg': '本当に削除しますか？',
            'stj.confirm.bulk_delete_msg': '本当に一括削除しますか？',
            'stj.confirm.unregister_images_msg': '{count}枚の画像をキーワードから登録解除しますか？',
            'stj.confirm.yes': 'はい',
            'stj.confirm.no': 'いいえ',

            'stj.bulk_delete.in_progress': '選択されたセルを一括削除します',

            'stj.test.empty_hint': '文章を入力するとヒットするキーワードが表示されます',
            'stj.test.matched': '「{keyword}」 にマッチしました！ (ファイル: {file})',
            'stj.test.no_match': '一致するキーワードがありません（デフォルト「{default}」が適用されます）',
            'stj.test.file_unspecified': '未指定',
            'stj.test.result_prefix': '判定結果',

            'stj.header.title': '🔍 リアルタイムキーワード反応テスト',
            'stj.header.help': 'ヘルプ',
            'stj.header.test_placeholder': '試しに文章を入力してください（例：笑顔で挨拶する）...',

            'stj.special.default_label': 'デフォルト表示',
            'stj.special.thumbnail_label': 'サムネイル表示',

            'stj.info.click_hint': '※セルをクリックすると編集ウインドウが開きます',
            'stj.info.title': '📖 操作方法',
            'stj.info.op_click': '<b>セルをクリック</b>：編集ウインドウが開きます',
            'stj.info.op_drag_gallery': '<b>ギャラリーからドラッグ&amp;ドロップ</b>：画像を追加できます',
            'stj.info.op_drag_cell': '<b>セルをドラッグ</b>：セルの位置を入れ替えられます',
            'stj.info.op_hover_remove': '<b>編集ウインドウでホバー</b>：各マスに ❌ ボタン → 登録解除',
            'stj.info.op_delete_btn': '<b>❌ボタン</b>：セルを削除します',
            'stj.info.op_bulk_delete': '<b>一括削除</b>：複数のセルをまとめて削除',
            'stj.info.op_add_cell': '<b>セル追加</b>：新しいセルを追加',

            'stj.button.close': '終了',
            'stj.button.update': '更新',
            'stj.button.update_title': 'ロアブックのエントリと同期してセルを自動作成します（自動削除はしません）',
            'stj.button.bulk_delete': '一括削除',
            'stj.button.back': '戻る',
            'stj.button.execute_delete': '削除実行',

            'stj.syntax.title': '🔧 基本演算子',
            'stj.syntax.and': 'AND（全て含む）',
            'stj.syntax.and_ex': '例：<code>山+川</code> → 「山」と「川」の両方が含まれる時にマッチ',
            'stj.syntax.or': 'OR（いずれか含む）',
            'stj.syntax.or_ex': '例：<code>山,川</code> → 「山」または「川」のどちらかが含まれる時にマッチ',
            'stj.syntax.not': 'NOT（除外）',
            'stj.syntax.not_ex': '例：<code>!山</code> → 「山」が含まれていない時にのみマッチ',
            'stj.syntax.group': 'グループ化（入れ子可能）',
            'stj.syntax.group_ex': '例：<code>(山+川),谷</code> → 「山と川」または「谷」のいずれかにマッチ',

            'stj.toast.sync_added': 'ロアブックと同期しました（{count} 件追加）',
            'stj.toast.sync_no_add': '同期する新規セルはありませんでした',
            'stj.toast.sync_failed': '同期に失敗しました',
            
            // === GIC: 確認 ===
            'gic.confirm.bulk_delete': '選択した {count} 枚の画像を削除しますか？\nこの操作は取り消せません。',

            // === GIC: ステータス ===
            'gic.status.gallery_loading': 'ギャラリーを読み込み中です…',
            'gic.status.gallery_ready': '読み込み完了',
            'gic.status.gallery_load_failed': '読み込みに失敗しました',

            // === GIC: プロンプトオーバーレイ ===
            'gic.prompt.keyword': 'キーワード',
            'gic.prompt.copy_prompt': 'プロンプトをコピー',
            'gic.prompt.copy_negative': 'ネガティブをコピー',
            'gic.prompt.copy_both': '両方コピー',

            // === Font Scale Auto ダイアログ ===
            'fsa.dialog.title': 'モニタ解像度を選択してください',
            'fsa.dialog.desc': '選択した解像度に応じて、フォントスケールを自動的に設定します。\n（1920×1080 を基準として、スケール値を計算します）',
            'fsa.dialog.hint': '↓のドロップダウンをクリックして解像度を選択して下さい',
            'fsa.dialog.resolution_label': '解像度:',
            'fsa.dialog.dont_show': 'このメッセージを再び表示しない',
            'fsa.dialog.note': 'フォントサイズは、ユーザー設定の「フォントスケール」からいつでも自由に変更できます。',
            'fsa.dialog.cancel': 'キャンセル',
            'fsa.dialog.apply': '適用',
        },
    };

    // ------------------------------------------------------------
    // 言語検出
    // ------------------------------------------------------------
    function getSTContext() {
        try {
            if (window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
                return window.SillyTavern.getContext();
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function detectLanguage() {
        // ① <html lang="..."> を最優先（ST が UI 言語に合わせて更新する）
        try {
            const htmlLang = (document.documentElement.getAttribute('lang') || '').toLowerCase().trim();
            if (htmlLang) {
                if (htmlLang.startsWith('ja')) return 'ja';
                return 'en';
            }
        } catch (e) { /* ignore */ }

        // ② power_user.user_language
        try {
            const ctx = getSTContext();
            const raw = ctx?.power_user?.user_language
                     ?? ctx?.powerUserSettings?.user_language
                     ?? window.power_user?.user_language;
            if (raw) {
                const s = String(raw).toLowerCase().trim();
                if (s.startsWith('ja')) return 'ja';
                return 'en';
            }
        } catch (e) { /* ignore */ }

        // ③ navigator.language フォールバック
        try {
            const navLang = String(navigator.language || 'en').toLowerCase();
            if (navLang.startsWith('ja')) return 'ja';
        } catch (e) { /* ignore */ }

        return 'en';
    }

    let _currentLang = detectLanguage();

    // ------------------------------------------------------------
    // 翻訳
    // ------------------------------------------------------------
    function t(key, fallback, params) {
        const dict = TRANSLATIONS[_currentLang] || TRANSLATIONS.en;
        let str = dict[key];
        if (str === undefined) str = TRANSLATIONS.en[key];
        if (str === undefined) str = (fallback !== undefined ? fallback : key);
        if (params && typeof params === 'object') {
            for (const k of Object.keys(params)) {
                str = str.split(`{${k}}`).join(String(params[k]));
            }
        }
        return str;
    }

    // ------------------------------------------------------------
    // 言語変更リスナー
    // ------------------------------------------------------------
    const _listeners = new Set();
    function onLanguageChange(cb) {
        if (typeof cb === 'function') {
            _listeners.add(cb);
            return () => _listeners.delete(cb);
        }
        return () => {};
    }
    
    function pollLanguageChange() {
        const next = detectLanguage();
        if (next !== _currentLang) {
            console.log(`${LOG} language changed: ${_currentLang} → ${next}`);
            _currentLang = next;
            for (const cb of _listeners) {
                try { cb(_currentLang); } catch (e) { console.warn(`${LOG} listener error:`, e); }
            }
            applyAllTranslations();
        }
    }
    setInterval(pollLanguageChange, 500);

    // ★ <html lang="..."> の変化を直接監視（ST の言語切替を即検知）
    (function watchHtmlLang() {
        if (!document.documentElement) return;
        const mo = new MutationObserver(() => pollLanguageChange());
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    })();

    // ------------------------------------------------------------
    // data-exp-i18n 属性による自動翻訳
    // ------------------------------------------------------------
    function applyTranslationsIn(root) {
        if (!root || !root.querySelectorAll) return;
        const scope = (root === document || root === document.body) ? document : root;
        scope.querySelectorAll('[data-exp-i18n]').forEach(el => {
            const key = el.getAttribute('data-exp-i18n');
            const fallback = el.textContent;
            el.textContent = t(key, fallback);
        });
        scope.querySelectorAll('[data-exp-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-exp-i18n-title');
            const fallback = el.getAttribute('title') || '';
            el.setAttribute('title', t(key, fallback));
        });
        scope.querySelectorAll('[data-exp-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-exp-i18n-placeholder');
            const fallback = el.getAttribute('placeholder') || '';
            el.setAttribute('placeholder', t(key, fallback));
        });
    }

    function applyAllTranslations() {
        applyTranslationsIn(document);
    }

    let pending = false;
    const mo = new MutationObserver((mutations) => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (
                        node.hasAttribute?.('data-exp-i18n') ||
                        node.hasAttribute?.('data-exp-i18n-title') ||
                        node.hasAttribute?.('data-exp-i18n-placeholder')
                    ) {
                        applyTranslationsIn(node.parentNode || document);
                        continue;
                    }
                    if (node.querySelectorAll && node.querySelector(
                        '[data-exp-i18n], [data-exp-i18n-title], [data-exp-i18n-placeholder]'
                    )) {
                        applyTranslationsIn(node);
                    }
                }
            }
        });
    });

    function startObserver() {
        if (!document.body) { setTimeout(startObserver, 100); return; }
        mo.observe(document.body, { childList: true, subtree: true });
        applyAllTranslations();
    }

    // ------------------------------------------------------------
    // 公開 API
    // ------------------------------------------------------------
    window.ExpI18n = {
        get lang() { return _currentLang; },
        getLanguage: () => _currentLang,
        isJapanese: () => _currentLang === 'ja',
        isEnglish:  () => _currentLang === 'en',
        t,
        translate: t,
        onLanguageChange,
        apply: applyTranslationsIn,
        applyAll: applyAllTranslations,
        extend: (lang, dict) => {
            if (!TRANSLATIONS[lang]) TRANSLATIONS[lang] = {};
            Object.assign(TRANSLATIONS[lang], dict);
            applyAllTranslations();
        },
    };

    // ST の APP_READY を待ってから observer 起動（初期言語は同期で判定済み）
    function bootstrap() {
        let started = false;
        const startOnce = () => {
            if (started) return;
            started = true;
            const prev = _currentLang;
            _currentLang = detectLanguage();
            startObserver();
            applyAllTranslations();
            // ★ 言語が変わっていたらリスナーにも通知する
            //   （gic.js 等のボタンラベルが英語に切り替わる）
            if (_currentLang !== prev) {
                for (const cb of _listeners) {
                    try { cb(_currentLang); } catch (e) { console.warn(`${LOG} listener error:`, e); }
                }
            }
            // ★ 診断ログ: 何を見て判定したか
            try {
                const ctx = getSTContext();
                console.log(
                    `${LOG} started (lang=${_currentLang}) ` +
                    `[html.lang="${document.documentElement.getAttribute('lang') || ''}", ` +
                    `user_language="${ctx?.power_user?.user_language ?? ''}", ` +
                    `navigator="${navigator.language}"]`
                );
            } catch (e) {
                console.log(`${LOG} started (lang=${_currentLang})`);
            }
        };

        const ctx = getSTContext();
        if (ctx?.eventSource && ctx?.eventTypes?.APP_READY) {
            ctx.eventSource.on(ctx.eventTypes.APP_READY, startOnce);
            setTimeout(startOnce, 5000);
        } else if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', startOnce);
            setTimeout(startOnce, 5000);
        } else {
            setTimeout(startOnce, 1000);
        }
    }

    bootstrap();
    console.log(`${LOG} ✅ installed (initial lang=${_currentLang})`);
})();
