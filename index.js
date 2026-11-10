// index.js
// ============================================================
// SillyTavern Expansion Pack
//   各拡張をモジュールとして読み込むエントリポイント
// ============================================================

import './modules/keyconfig.js';
// ★ 効果音モジュールを最初に読み込む
//   （window.playSound / window.SOUND_EFFECTS を確定させる）
import './modules/sound_effects.js';

import './modules/character_store.js';
// ---- Image Display ----
// ★ text-styling.js が window.ImageDisplayExtension を参照するため先に読み込む
import './modules/image-display.js';

// ---- Chat Window On/Off ----
import './modules/chat_window_onoff.js';
export { onInstall } from './modules/chat_window_onoff.js';

// ---- Right Nav Kai ----
import './modules/right_nav_kai.js';

// ---- STJ Editor ----
import './modules/stj_editor.js';

// ---- Text Styling ----
import './modules/text-styling.js';

// ---- Lorebook Expansion ----
import './modules/Lorebook_Expansion.js';

// ---- Generate Image Controller ----
// ★ gic.js が gic_lorebook.js を import するため、こちらからは gic.js のみ import すれば OK
import './modules/gic.js';

import './modules/choice_click.js';

import './modules/variable_manager.js';

import './modules/worldbook_auto_select.js';

import './modules/status_indicator.js';

import './modules/user_status.js';
