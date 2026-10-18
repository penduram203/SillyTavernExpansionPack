// ============================================================
// SillyTavern Expansion Pack
//   各拡張をモジュールとして読み込むエントリポイント
// ============================================================

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

// ---- media controller ----
import './modules/media_controller.js';
