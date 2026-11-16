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

            /* #sheld 内のテキストを scale 倍 */
            #sheld {
                font-size: calc(var(--exp-original-mainFontSize) * var(--exp-scale, 1)) !important;
                --mainFontSize: calc(var(--exp-original-mainFontSize) * var(--exp-scale, 1));
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
