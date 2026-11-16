// resolution_scale.js
// 全拡張パックの解像度スケーリング（CSS変数モード）
//
// 1920×962 基準で設計された UI を、他の解像度でも比例スケーリングする。
// 既存の JS はそのまま動く。CSS 側だけ段階的に calc(var(--exp-scale) * Npx)
// に書き換えていく。
//
// 使い方:
//   1. comfy_boot.js の先頭で import
//   2. CSS で width: calc(var(--exp-scale, 1) * 50px) のように参照
//   3. JS で window.S(50) のように参照（必要な箇所のみ）

(function () {
    'use strict';
    if (window.__expResolutionScaleInstalled) return;
    window.__expResolutionScaleInstalled = true;

    const BASE_W = 1920;
    const BASE_H = 962;
    const LOG = '[ExpScale]';

    function computeScale() {
        return Math.min(window.innerWidth / BASE_W, window.innerHeight / BASE_H);
    }

    function apply() {
        const scale = computeScale();
        const root = document.documentElement;

        root.style.setProperty('--exp-scale', String(scale));
        root.style.setProperty('--exp-scale-w', String(window.innerWidth  / BASE_W));
        root.style.setProperty('--exp-scale-h', String(window.innerHeight / BASE_H));
        window.__expScale = scale;
    }

    // JS ヘルパー: window.S(50) → scale倍した整数px
    window.S = (px) => Math.round(px * (window.__expScale || 1));

    window.ExpScale = {
        get scale() { return window.__expScale || 1; },
        S: (px) => Math.round(px * (window.__expScale || 1)),
        refresh: () => apply(),
        info: () => ({
            physW: window.innerWidth,
            physH: window.innerHeight,
            scale: window.__expScale,
        }),
    };

    apply();

    // リサイズ時に再計算（rAF で間引き）
    let _raf = null;
    window.addEventListener('resize', () => {
        if (_raf) return;
        _raf = requestAnimationFrame(() => { _raf = null; apply(); });
    });

    // ============================================================
    // ★ チャット内容の解像度スケーリング
    //   #sheld 内の font-size を --exp-scale 倍する。
    //   - --mainFontSize を #sheld スコープでのみ上書き（外部 UI に影響しない）
    //   - #sheld 自身の font-size も直接設定（子孫の継承を保証）
    //   - フォントスケール（--exp-original-mainFontSize）とは掛け合わせない。
    //     基準を固定 15px にすることで、解像度スケーリングのみが #sheld 内で
    //     作用する（フォントスケールによる二重拡大の防止）。
    // ============================================================
    (function injectChatContentScaling() {
        if (document.getElementById('exp-chat-scaling-css')) return;
        const style = document.createElement('style');
        style.id = 'exp-chat-scaling-css';
        style.textContent = `
            /* 元の --mainFontSize を保持（#sheld 内での上書き基準） */
            html {
                --exp-original-mainFontSize: var(--mainFontSize, 15px);
            }

            /* #sheld 内のテキストは解像度係数のみでスケーリング（フォントスケール非適用） */
            #sheld {
                font-size: calc(15px * var(--exp-scale, 1)) !important;
                --mainFontSize: calc(15px * var(--exp-scale, 1));
            }

            /* キャラクター一覧のキャラクター名を解像度に応じてスケーリング（2倍）
               フォントスケール（--exp-original-mainFontSize）とは掛け合わせず、
               解像度係数 --exp-scale のみで拡大する（二重拡大の防止） */
            #rm_print_characters_block .character_select .character_name_block .ch_name,
            #rm_print_characters_block .character_select .ch_name,
            #rm_print_characters_block .character_name_block .ch_name,
            #rm_print_characters_block .ch_name,
            .character_select .character_name_block .ch_name,
            .character_select .ch_name {
                font-size: calc(15px * var(--exp-scale, 1) * 2) !important;
            }

            /* ロアブック編集画面の上部ボタン（Random_Prompt_Wildcard / キャラ推奨LoRA） */
            #rpw-button-container {
                display: flex;
                flex-wrap: wrap;
                gap: calc(8px * var(--exp-scale, 1));
                margin: calc(8px * var(--exp-scale, 1)) 0;
            }
            #rpw-button-container > button,
            #rpw-open-button,
            #crl-open-button {
                font-size: calc(14px * var(--exp-scale, 1)) !important;
                padding: calc(6px * var(--exp-scale, 1)) calc(12px * var(--exp-scale, 1)) !important;
                line-height: 1.4 !important;
                height: auto !important;
                min-height: 0 !important;
            }

            /* ロアブック編集画面のワールド選択（select2）
               テキスト欄の高さ・フォントサイズ・矢印サイズを解像度に追従させる */
            .select2-container:has(#select2-world_editor_select-container) .select2-selection--single {
                height: calc(32px * var(--exp-scale, 1)) !important;
                min-height: calc(32px * var(--exp-scale, 1)) !important;
                padding: 0 !important;
            }
            .select2-container:has(#select2-world_editor_select-container) .select2-selection--single .select2-selection__rendered {
                font-size: calc(14px * var(--exp-scale, 1)) !important;
                line-height: calc(32px * var(--exp-scale, 1)) !important;
                padding-left: calc(8px * var(--exp-scale, 1)) !important;
                padding-right: calc(20px * var(--exp-scale, 1)) !important;
            }
            .select2-container:has(#select2-world_editor_select-container) .select2-selection--single .select2-selection__arrow {
                height: calc(30px * var(--exp-scale, 1)) !important;
                right: calc(3px * var(--exp-scale, 1)) !important;
                width: calc(20px * var(--exp-scale, 1)) !important;
            }
            .select2-container:has(#select2-world_editor_select-container) .select2-selection--single .select2-selection__arrow b {
                margin-top: calc(-2px * var(--exp-scale, 1)) !important;
            }

            /* 画像削除確認ダイアログ（gic.js が生成する #gic-delete-confirm-dialog）
               インラインスタイルを !important で上書きし、解像度に追従させる */
            #gic-delete-confirm-dialog {
                padding: calc(20px * var(--exp-scale, 1)) !important;
            }
            #gic-delete-confirm-dialog > div {
                border-width: calc(3px * var(--exp-scale, 1)) !important;
                border-radius: calc(12px * var(--exp-scale, 1)) !important;
                padding: calc(32px * var(--exp-scale, 1)) calc(40px * var(--exp-scale, 1)) !important;
                max-width: calc(600px * var(--exp-scale, 1)) !important;
                min-width: calc(420px * var(--exp-scale, 1)) !important;
            }
            /* 警告文 */
            #gic-delete-confirm-dialog > div > div:nth-child(1) {
                font-size: calc(20px * var(--exp-scale, 1)) !important;
                margin-bottom: calc(16px * var(--exp-scale, 1)) !important;
            }
            /* 見出し「本当に削除しますか？」 */
            #gic-delete-confirm-dialog > div > div:nth-child(2) {
                font-size: calc(26px * var(--exp-scale, 1)) !important;
                margin-bottom: calc(20px * var(--exp-scale, 1)) !important;
            }
            /* ファイル名表示欄 */
            #gic-delete-confirm-dialog > div > div:nth-child(3) {
                font-size: calc(13px * var(--exp-scale, 1)) !important;
                padding: calc(8px * var(--exp-scale, 1)) calc(12px * var(--exp-scale, 1)) !important;
                border-radius: calc(4px * var(--exp-scale, 1)) !important;
                margin-bottom: calc(24px * var(--exp-scale, 1)) !important;
            }
            /* ボタン行 */
            #gic-delete-confirm-dialog > div > div:nth-child(4) {
                gap: calc(16px * var(--exp-scale, 1)) !important;
            }
            /* はい / いいえ ボタン */
            #gic-delete-confirm-dialog > div > div:nth-child(4) > button {
                padding: calc(14px * var(--exp-scale, 1)) calc(40px * var(--exp-scale, 1)) !important;
                font-size: calc(18px * var(--exp-scale, 1)) !important;
                border-width: calc(2px * var(--exp-scale, 1)) !important;
                border-radius: calc(6px * var(--exp-scale, 1)) !important;
                min-width: calc(120px * var(--exp-scale, 1)) !important;
            }
        `;
        document.head.appendChild(style);
        console.log(`${LOG} chat content scaling CSS injected`);
    })();
    
    console.log(`${LOG} installed`, {
        physW: window.innerWidth,
        physH: window.innerHeight,
        scale: window.__expScale,
    });
})();
