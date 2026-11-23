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
            'gic.title.gallery_loading_click': 'Loading gallery…',
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

            'stj.special.toggle_label': 'Default & Thumbnail',
            'stj.standalone.empty': 'No standalone cells',
            
            'stj.info.click_hint': '※ Click a cell to open the edit window.',
            'stj.info.title': '📖 Operations',
            'stj.info.op_click': '<b>Click a cell</b>: opens the edit window',
            'stj.info.op_drag_gallery': '<b>Drag &amp; drop from the gallery</b>: adds an image',
            'stj.info.op_drag_cell': '<b>Drag a cell</b>: swaps cell positions',
            'stj.info.op_hover_remove': '<b>Hover in the edit window</b>: ❌ button on each slot → unregister',
            'stj.info.op_delete_btn': '<b>❌ button</b>: deletes the cell',
            'stj.info.op_bulk_delete': '<b>Bulk Delete</b>: deletes multiple cells at once',
            'stj.info.op_add_cell': '<b>Add Cell</b>: adds a new cell',

            // ボタン
            'stj.button.new': 'New',
            'stj.button.new_title': 'Add new lorebook entry',

            // トーストメッセージ
            'stj.toast.new_added': 'New entry added',
            'stj.toast.new_failed': 'Failed to add new entry',
            'stj.new_entry.default_name': 'New Entry',
            
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

            // === Text Styling ===
            'ts.panel_title': 'Text Style Settings',
            'ts.restore_title': 'Show/hide the settings panel',
            'ts.tag.p': 'Normal text',
            'ts.tag.q': 'Dialogue',

            'ts.label.enable': 'Enable this style',
            'ts.label.font_size': 'Font size',
            'ts.label.font_weight': 'Font weight',
            'ts.label.line_height': 'Line height',
            'ts.label.letter_spacing': 'Letter spacing',
            'ts.label.text_opacity': 'Opacity',
            'ts.label.text_color': 'Text color',
            'ts.label.outline_color': 'Outline color',
            'ts.label.outline_width': 'Outline width',
            'ts.label.bottom_margin': 'Bottom margin',

            'ts.chat_section': 'Chat window settings',
            'ts.chat_opacity': 'Opacity',

            'ts.layout.center': 'Center',
            'ts.layout.split': 'Split',
            'ts.layout.manual': 'Manual',
            'ts.layout.toggle.center_title': 'Click to switch to "Split"',
            'ts.layout.toggle.split_title': 'Click to switch to "Manual"',
            'ts.layout.toggle.manual_title': 'Click to switch to "Center"',

            'ts.manual_settings': 'Size Settings',
            'ts.manual_settings_title': 'Set the position and size of the background image window',
            
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

            // === Lorebook Expansion ===
            'lbe.extras_toggle': 'Advanced settings (character settings, extra matching, etc.)',

            'lbe.template.title': 'Switch the prompt template',
            'lbe.template.add': 'Add',
            'lbe.template.add_title': 'Add a new template',
            'lbe.template.del': 'Delete',
            'lbe.template.del_title': 'Delete the current template',
            'lbe.template.del_confirm': 'Delete template "{n}"?\nThis cannot be undone.',

            'lbe.random': 'Random',
            'lbe.resolution.title': 'Resolution used when generating images for this entry',
            'lbe.readonly_random': 'Cannot edit while Random is selected. Choose a specific template.',

            'lbe.img_ph': 'e.g. 5girls:1.4, school sailor uniform, miniskirt, sitting on chair, looking at viewer, school, classroom, smile, femdom',
            'lbe.neg_ph': 'e.g. bad hands, extra fingers, lowres, ugly, blurry, watermark',

            'lbe.var.number': 'Number',
            'lbe.var.string': 'String',
            'lbe.var.type_title': 'Variable type',
            'lbe.var.name_ph': 'Variable name',
            'lbe.var.del_title': 'Delete this variable',
            'lbe.var.add': '＋ Add variable',
            'lbe.var.value_ph_num': 'e.g. 594, 122224, +60, -599',
            'lbe.var.value_title_num': 'Absolute value or delta (e.g. +60 / -599)',
            'lbe.var.value_ph_str': 'e.g. text',
            'lbe.var.value_title_str': 'Any string',

            'lbe.choice.text_ph': 'Choice text (e.g. A small girl approaches)',
            'lbe.choice.del_title': 'Delete this choice',
            'lbe.choice.add': '＋ Add choice',

            // === Random Prompt Wildcard / Recommended LoRA ===
            'rpw.title': 'Random Prompt Wildcard Settings',
            'rpw.help_btn': 'Help',
            'rpw.help_btn_title': 'Show usage (help)',
            'rpw.close_title': 'Close (Escape)',
            'rpw.placeholder': '# One definition per line: name? = value1,value2,value3\n# Example: color1? = black,brown,orange,yellow,pink\n# Press the "Help" button at the top right for details',
            'rpw.help_title': 'How to use Random Prompt Wildcard',
            'rpw.select_char': 'Please select a character.',
            'rpw.btn_title': 'Configure per-character random prompt wildcards',

            'rpw.help.overview.h': 'Overview',
            'rpw.help.overview.p': 'Wildcards defined here are stored as prompt variables dedicated to this character. <strong>Variable names</strong> in the lorebook\'s <code>Img_prompt</code> or <code>Negative_prompt</code> are automatically replaced with <strong>random values</strong> when an image is generated.',
            'rpw.help.syntax.h': 'Basic syntax',
            'rpw.help.syntax.code': 'name = value1,value2,value3, ...',
            'rpw.help.syntax.li1': 'Put spaces between the "name" and <code>=</code>.',
            'rpw.help.syntax.li2': 'Separate values with commas <code>,</code>.',
            'rpw.help.syntax.li3': 'Define one variable per line.',
            'rpw.help.syntax.li4': 'Names can use any characters (e.g. <code>color1?</code>, <code>eyes</code>).',
            'rpw.help.ex1.h': 'Example 1: randomize hair color',
            'rpw.help.label.def': 'Definition',
            'rpw.help.label.lore_prompt': 'Lorebook prompt',
            'rpw.help.label.result': 'Example results',
            'rpw.help.ex2.h': 'Example 2: use the same variable in several places (important)',
            'rpw.help.ex2.p': 'Within one image generation, <strong>the same variable always gets the same value</strong>.',
            'rpw.help.label.prompt': 'Prompt',
            'rpw.help.ex2.result_label': 'Example (hair and eyes get the same color)',
            'rpw.help.ex2.note': '* To get different colors, define separate variables such as <code>color1?</code> and <code>color2?</code>.',
            'rpw.help.ex3.h': 'Example 3: values that contain commas',
            'rpw.help.ex3.p': 'Wrap them in double or single quotes.',
            'rpw.help.notes.h': 'Notes',
            'rpw.help.notes.li1': 'Lines starting with <code>#</code> are ignored as comments.',
            'rpw.help.notes.li2': 'Blank lines are ignored.',
            'rpw.help.notes.li3': 'Variables with no value (e.g. <code>foo =</code>) are ignored.',
            'rpw.help.notes.li4': 'If the same name is defined twice, the later definition wins.',
            'rpw.help.notes.li5': 'If the lorebook prompt contains no variable names, nothing changes.',
            'rpw.help.notes.li6': 'Your input is saved automatically (managed separately per character).',

            'crl.btn_label': '{name} Recommended LoRA',
            'crl.btn_label_default': 'Recommended LoRA',
            'crl.btn_title': 'Register the recommended LoRA info for this character',
            'crl.modal_title': '{name} Recommended LoRA Settings',
            'crl.modal_title_default': 'Recommended LoRA Settings',
            'crl.top_header': 'Recommended LoRA entries',
            'crl.add': '＋ Add LoRA',
            'crl.no_char': 'No character is selected.',
            'crl.empty': 'No LoRA registered yet. Press "＋ Add LoRA".',
            'crl.label.name': '① LoRA name (file name)',
            'crl.ph.name': 'e.g. myCharacterLora.safetensors',
            'crl.label.url': '② Download URL',
            'crl.ph.url': 'e.g. https://civitai.com/models/xxxxx',
            'crl.label.trigger': '③ Trigger words',
            'crl.ph.trigger': 'e.g. myStyle, characterName',
            'crl.label.desc': '④ Description',
            'crl.ph.desc': 'Description of this LoRA, recommended strength, notes, etc.',
            'crl.delete_title': 'Delete this LoRA',
            'crl.delete_confirm': 'Delete this LoRA?\nThis cannot be undone.',

            'crl.help.what.h': '📖 What is a LoRA?',
            'crl.help.what.p': 'A LoRA (Low-Rank Adaptation) is a lightweight add-on file that <strong>adds training</strong> to a base model\'s style or characters. It lets you reproduce a specific style, character or composition without changing the base model.',
            'crl.help.place.h': '📦 Where to put LoRA files',
            'crl.help.place.p': 'Place the downloaded <code>.safetensors</code> file in one of the following.',
            'crl.help.place.li1': '<strong>ComfyUI (local):</strong> <code>ComfyUI/models/loras/</code>',
            'crl.help.place.li2': '<strong>Colab + Google Drive:</strong> <code>MyDrive/ComfyUI/models/loras/</code>',
            'crl.help.place.li3': '<strong>SillyTavern SD extension:</strong> <code>data/default-user/extensions/sd/models/lora/</code>',
            'crl.help.place.warn': '⚠️ The file name must be an <strong>exact match</strong> (including case and extension).',
            'crl.help.write.h': '✍️ Writing it in the prompt',
            'crl.help.write.p1': 'Add the following tag to Img_prompt to apply the LoRA.',
            'crl.help.write.syntax_name': 'filename',
            'crl.help.write.syntax_strength': 'strength',
            'crl.help.write.example': 'Example:',
            'crl.help.write.p2': 'Set the <strong>strength</strong> between <code>0.0</code> and <code>1.0</code>. <code>0.6</code> to <code>0.8</code> is typical.',
            'crl.help.trigger.h': '🔑 Trigger words',
            'crl.help.trigger.p': 'Some LoRAs require <strong>specific keywords</strong> (trigger words) in the prompt to take effect. They are listed in the description on the LoRA\'s Civitai page.',
            'crl.help.strength.h': '💡 Strength guide',
            'crl.help.strength.li1': '<strong>0.3–0.5:</strong> Subtle. Keeps the base model\'s style.',
            'crl.help.strength.li2': '<strong>0.6–0.8:</strong> Standard. Well balanced.',
            'crl.help.strength.li3': '<strong>0.9–1.0:</strong> Strong. Emphasizes the LoRA\'s traits.',
            'crl.help.strength.li4': '<strong>Over 1.0:</strong> Can cause oversaturation and artifacts.',
            'crl.help.compat.h': '⚠️ SDXL / SD1.5 compatibility',
            'crl.help.compat.p': 'A LoRA only works with <strong>the same model family</strong> as the base model. NovaAnimeXL is <strong>SDXL</strong>-based, so use <strong>SDXL LoRAs</strong> (e.g. "SDXL 1.0", "Pony", "Illustrious" on Civitai).',
            'crl.help.compat.warn': '⚠️ SD1.5 LoRAs have almost no effect on SDXL models.',
            'crl.help.multi.h': '🔄 Using multiple LoRAs',
            'crl.help.multi.p1': 'You can write several LoRA tags in one prompt.',
            'crl.help.multi.p2': 'A total strength above <code>1.5</code> can degrade image quality, so be careful.',
            'crl.help.verify.h': '🧪 Checking that it works',
            'crl.help.verify.li1': 'If the ComfyUI server log shows <code>detected lora tag: (...)</code>, it was recognized.',
            'crl.help.verify.li2': 'If N in <code>patches attached: N</code> is greater than 0, it was applied.',
            'crl.help.verify.li3': 'Generate again without the LoRA using the same prompt and compare.',
            'crl.help.verify.li4': 'Raise the strength to <code>1.5</code> and check that the effect is emphasized.',
            
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
            'gic.title.gallery_loading_click': 'ギャラリーを読み込み中です…',
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

            'stj.special.toggle_label': 'デフォルト＆サムネイル',
            'stj.standalone.empty': '独立セルはありません',         
            
            'stj.info.click_hint': '※セルをクリックすると編集ウインドウが開きます',
            'stj.info.title': '📖 操作方法',
            'stj.info.op_click': '<b>セルをクリック</b>：編集ウインドウが開きます',
            'stj.info.op_drag_gallery': '<b>ギャラリーからドラッグ&amp;ドロップ</b>：画像を追加できます',
            'stj.info.op_drag_cell': '<b>セルをドラッグ</b>：セルの位置を入れ替えられます',
            'stj.info.op_hover_remove': '<b>編集ウインドウでホバー</b>：各マスに ❌ ボタン → 登録解除',
            'stj.info.op_delete_btn': '<b>❌ボタン</b>：セルを削除します',
            'stj.info.op_bulk_delete': '<b>一括削除</b>：複数のセルをまとめて削除',
            'stj.info.op_add_cell': '<b>セル追加</b>：新しいセルを追加',

            // ボタン
            'stj.button.new': '新規',
            'stj.button.new_title': 'ロアブックに新しいエントリーを追加',

            // トーストメッセージ
            'stj.toast.new_added': '新しいエントリーを追加しました',
            'stj.toast.new_failed': '新しいエントリーの追加に失敗しました',
            'stj.new_entry.default_name': '新しいエントリー',
            
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

                   // === Text Styling ===
            'ts.panel_title': 'テキストスタイル設定',
            'ts.restore_title': '設定パネルの表示/非表示',
            'ts.tag.p': '通常テキスト',
            'ts.tag.q': 'セリフ',

            'ts.label.enable': 'このスタイルを有効にする',
            'ts.label.font_size': '文字サイズ',
            'ts.label.font_weight': '文字の太さ',
            'ts.label.line_height': '行間',
            'ts.label.letter_spacing': '字間',
            'ts.label.text_opacity': '透過度',
            'ts.label.text_color': '文字色',
            'ts.label.outline_color': '縁取り色',
            'ts.label.outline_width': '縁取り幅',
            'ts.label.bottom_margin': '下余白',

            'ts.chat_section': 'チャットウィンドウ設定',
            'ts.chat_opacity': '透過度',

            'ts.layout.center': '中央',
            'ts.layout.split': '左右',
            'ts.layout.manual': '手動',
            'ts.layout.toggle.center_title': 'クリックで「左右」に切替',
            'ts.layout.toggle.split_title': 'クリックで「手動」に切替',
            'ts.layout.toggle.manual_title': 'クリックで「中央」に切替',

            'ts.manual_settings': 'サイズ設定',
            'ts.manual_settings_title': '背景画像ウィンドウの位置とサイズを設定',     
            
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

            // === Lorebook Expansion ===
            'lbe.extras_toggle': '詳細設定 (キャラクター設定・追加マッチング等)',

            'lbe.template.title': 'プロンプトのテンプレートを切り替える',
            'lbe.template.add': '追加',
            'lbe.template.add_title': '新しいテンプレートを追加',
            'lbe.template.del': '削除',
            'lbe.template.del_title': '現在のテンプレートを削除',
            'lbe.template.del_confirm': 'テンプレート「{n}」を削除しますか？\nこの操作は取り消せません。',

            'lbe.random': 'ランダム',
            'lbe.resolution.title': 'このエントリで画像を生成する際の解像度',
            'lbe.readonly_random': 'ランダム選択中は編集できません。具体的なテンプレートを選んでください',

            'lbe.img_ph': '例: 5girls:1.4, schoo sailor uniform, miniskirt, sitting on chair, looking at viewer, school, classroom, smile, femdom',
            'lbe.neg_ph': '例: bad hands, extra fingers, lowres, ugly, blurry, watermark',

            'lbe.var.number': '数値',
            'lbe.var.string': '文字列',
            'lbe.var.type_title': '変数の型',
            'lbe.var.name_ph': '変数名',
            'lbe.var.del_title': 'この変数を削除',
            'lbe.var.add': '＋ 変数を追加',
            'lbe.var.value_ph_num': '例: 594, 122224, +60, -599',
            'lbe.var.value_title_num': '絶対値 または 増減値（+60 / -599 など）',
            'lbe.var.value_ph_str': '例: テキスト',
            'lbe.var.value_title_str': '任意の文字列',

            'lbe.choice.text_ph': '選択肢の内容 (例: 一人の小柄な女子が近づいてきた)',
            'lbe.choice.del_title': 'この選択肢を削除',
            'lbe.choice.add': '＋ 選択肢を追加',

            // === Random Prompt Wildcard / 推奨 LoRA ===
            'rpw.title': 'Random Prompt Wildcard 設定',
            'rpw.help_btn': 'ヘルプ',
            'rpw.help_btn_title': '使い方（ヘルプ）を表示',
            'rpw.close_title': '閉じる (Escape)',
            'rpw.placeholder': '# 1行1定義: name? = value1,value2,value3\n# 例: color1? = black,brown,orange,yellow,pink\n# 詳しくは右上の「ヘルプ」ボタンを押してください',
            'rpw.help_title': 'Random Prompt Wildcard の使い方',
            'rpw.select_char': 'キャラクターを選択してください',
            'rpw.btn_title': 'キャラクター毎のランダムプロンプトワイルドカードを設定',

            'rpw.help.overview.h': '概要',
            'rpw.help.overview.p': 'ここに定義したワイルドカードは、このキャラクター専用のプロンプト変数として記録されます。ロアブックの <code>Img_prompt</code> や <code>Negative_prompt</code> に含まれる<strong>変数名</strong>が、画像生成時に自動的に<strong>ランダムな値</strong>へ置き換えられます。',
            'rpw.help.syntax.h': '基本構文',
            'rpw.help.syntax.code': '変数名 = 値1,値2,値3, ...',
            'rpw.help.syntax.li1': '「変数名」と <code>=</code> の間にスペースを入れてください。',
            'rpw.help.syntax.li2': '値はカンマ <code>,</code> で区切ってください。',
            'rpw.help.syntax.li3': '1行につき1つの変数を定義します。',
            'rpw.help.syntax.li4': '変数名には好きな文字を使えます（例: <code>color1?</code>, <code>eyes</code>）',
            'rpw.help.ex1.h': '例 1: 髪の色をランダム化',
            'rpw.help.label.def': '定義',
            'rpw.help.label.lore_prompt': 'ロアブックのプロンプト',
            'rpw.help.label.result': '生成結果の例',
            'rpw.help.ex2.h': '例 2: 同じ変数を複数箇所で使う（重要）',
            'rpw.help.ex2.p': '1回の画像生成で<strong>同じ変数は同じ値</strong>になります。',
            'rpw.help.label.prompt': 'プロンプト',
            'rpw.help.ex2.result_label': '生成例（髪と瞳が同じ色になる）',
            'rpw.help.ex2.note': '※ 別々の色にしたい場合は <code>color1?</code> <code>color2?</code> と別名の変数を定義してください。',
            'rpw.help.ex3.h': '例 3: カンマを含む値を使いたい場合',
            'rpw.help.ex3.p': 'ダブルクォートまたはシングルクォートで囲ってください。',
            'rpw.help.notes.h': '注意事項',
            'rpw.help.notes.li1': '<code>#</code> で始まる行はコメントとして無視されます。',
            'rpw.help.notes.li2': '空行も無視されます。',
            'rpw.help.notes.li3': '値が空の変数（例: <code>foo =</code>）は無視されます。',
            'rpw.help.notes.li4': '変数名が同じ場合は、後から書いた定義が優先されます。',
            'rpw.help.notes.li5': 'ロアブックに変数名が含まれていない場合は何も変化しません。',
            'rpw.help.notes.li6': '入力内容は自動的に保存されます（キャラクター毎に独立管理）。',

            'crl.btn_label': '{name} 推奨LoRA',
            'crl.btn_label_default': 'キャラ推奨LoRA',
            'crl.btn_title': 'キャラクター推奨のLoRA情報を登録する',
            'crl.modal_title': '{name} 推奨 LoRA 設定',
            'crl.modal_title_default': 'キャラ推奨 LoRA 設定',
            'crl.top_header': '推奨 LoRA 入力エリア',
            'crl.add': '＋ LoRAを追加',
            'crl.no_char': 'キャラクターが選択されていません',
            'crl.empty': 'まだ LoRA が登録されていません。「＋ LoRAを追加」を押してください。',
            'crl.label.name': '① LoRA名（ファイル名）',
            'crl.ph.name': '例: myCharacterLora.safetensors',
            'crl.label.url': '② ダウンロードURL',
            'crl.ph.url': '例: https://civitai.com/models/xxxxx',
            'crl.label.trigger': '③ トリガーワード',
            'crl.ph.trigger': '例: myStyle, characterName',
            'crl.label.desc': '④ 説明',
            'crl.ph.desc': 'このLoRAの説明、推奨強度、注意点など',
            'crl.delete_title': 'このLoRAを削除',
            'crl.delete_confirm': 'この LoRA を削除しますか？\nこの操作は取り消せません。',

            'crl.help.what.h': '📖 LoRAとは',
            'crl.help.what.p': 'LoRA（Low-Rank Adaptation）は、ベースモデルの画風やキャラクターを<strong>追加学習</strong>するための軽量な追加ファイルです。ベースモデルを変えずに、特定のスタイル・キャラクター・構図を再現できます。',
            'crl.help.place.h': '📦 LoRAファイルの配置',
            'crl.help.place.p': 'ダウンロードした <code>.safetensors</code> ファイルを以下に配置してください。',
            'crl.help.place.li1': '<strong>ComfyUI ローカル:</strong> <code>ComfyUI/models/loras/</code>',
            'crl.help.place.li2': '<strong>Colab + Google Drive:</strong> <code>MyDrive/ComfyUI/models/loras/</code>',
            'crl.help.place.li3': '<strong>SillyTavern SD拡張:</strong> <code>data/default-user/extensions/sd/models/lora/</code>',
            'crl.help.place.warn': '⚠️ ファイル名は<strong>完全一致</strong>が必要です（大文字小文字・拡張子まで）。',
            'crl.help.write.h': '✍️ プロンプトへの記述',
            'crl.help.write.p1': 'Img_prompt に以下のタグを書くと、LoRAが適用されます。',
            'crl.help.write.syntax_name': 'ファイル名',
            'crl.help.write.syntax_strength': '強度',
            'crl.help.write.example': '例:',
            'crl.help.write.p2': '<strong>強度</strong>は <code>0.0</code> 〜 <code>1.0</code> の範囲で指定します。<code>0.6</code> 〜 <code>0.8</code> が一般的です。',
            'crl.help.trigger.h': '🔑 トリガーワード',
            'crl.help.trigger.p': 'LoRAによっては、効果を発動させるために<strong>特定のキーワード</strong>（トリガーワード）をプロンプトに含める必要があります。Civitai のLoRAページの説明欄に記載されています。',
            'crl.help.strength.h': '💡 強度の目安',
            'crl.help.strength.li1': '<strong>0.3〜0.5:</strong> 控えめ。ベースモデルの画風を残す',
            'crl.help.strength.li2': '<strong>0.6〜0.8:</strong> 標準。バランスが良い',
            'crl.help.strength.li3': '<strong>0.9〜1.0:</strong> 強め。LoRAの特徴を強く出す',
            'crl.help.strength.li4': '<strong>1.0超:</strong> 過飽和・アーティファクトの原因になる',
            'crl.help.compat.h': '⚠️ SDXL / SD1.5 の互換性',
            'crl.help.compat.p': 'LoRAは<strong>ベースモデルと同じ系統</strong>でなければ動作しません。NovaAnimeXL は <strong>SDXL</strong> ベースなので、<strong>SDXL用LoRA</strong>（Civitaiで「SDXL 1.0」「Pony」「Illustrious」等）を使ってください。',
            'crl.help.compat.warn': '⚠️ SD1.5用LoRAはSDXLモデルでは効果がほとんど出ません。',
            'crl.help.multi.h': '🔄 複数LoRAの併用',
            'crl.help.multi.p1': '1つのプロンプトに複数のLoRAタグを書けます。',
            'crl.help.multi.p2': '合計強度が <code>1.5</code> を超えると画質劣化の原因になるため注意してください。',
            'crl.help.verify.h': '🧪 動作確認のポイント',
            'crl.help.verify.li1': 'ComfyUIのサーバーログに <code>detected lora tag: (...)</code> が出れば認識成功',
            'crl.help.verify.li2': '<code>patches attached: N</code> の N が 0 より大きければ適用成功',
            'crl.help.verify.li3': 'LoRAを外して同じプロンプトで生成し、見た目を比較する',
            'crl.help.verify.li4': '強度を <code>1.5</code> まで上げて変化が強調されるか確認する',
            
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
