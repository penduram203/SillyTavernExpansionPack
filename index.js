// ============================================================
// SillyTavern Expansion Pack
//   各拡張をモジュールとして読み込むエントリポイント
// ============================================================

// ---- Image Display ----
// ★ 読み込み順序に注意: image-display.js は window.ImageDisplayExtension を
//    公開する。text-styling.js が同 API を参照するため、
//    image-display.js を先に読み込むことを推奨。
import './modules/image-display.js';
// image-display.js は IIFE で完結しており、export は不要

// ---- Chat Window On/Off ----
import './modules/chat_window_onoff.js';
export { onInstall } from './modules/chat_window_onoff.js';

// ---- Right Nav Kai ----
import './modules/right_nav_kai.js';
// right_nav_kai.js は IIFE で完結しており、export は不要

// ---- STJ Editor ----
import './modules/stj_editor.js';
// stj_editor.js は IIFE で完結しており、export は不要

// ---- Text Styling ----
import './modules/text-styling.js';
// text-styling.js は initTextStyling() を自動実行する形式のため、export は不要

// ---- 今後追加する拡張はここに追記していく ----
// import './modules/gic.js';
// import './modules/gic_lorebook.js';
// import './modules/Lorebook_Expansion.js';
