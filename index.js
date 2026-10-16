// ============================================================
// SillyTavern Expansion Pack
//   各拡張をモジュールとして読み込むエントリポイント
// ============================================================

// ---- Chat Window On/Off ----
import './modules/chat_window_onoff.js';
export { onInstall } from './modules/chat_window_onoff.js';

// ---- Right Nav Kai ----
import './modules/right_nav_kai.js';
// right_nav_kai.js は IIFE で完結しており、export は不要

// ---- STJ Editor ----
import './modules/stj_editor.js';
// stj_editor.js は IIFE で完結しており、export は不要

// ---- 今後追加する拡張はここに追記していく ----
// import './modules/image_display.js';
// import './modules/gic.js';
// import './modules/gic_lorebook.js';
// import './modules/text-styling.js';
// import './modules/Lorebook_Expansion.js';
