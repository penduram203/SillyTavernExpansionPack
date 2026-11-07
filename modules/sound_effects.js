// sound_effects.js
// 効果音を MP3 ファイルから再生するユーティリティ。
//   window.SoundEffects.play('attack') のように呼び出す。
//
// ファイル配置（拡張ルートからの相対パス）:
//   SillyTavernExpansionPack/audio/attack.mp3
//   SillyTavernExpansionPack/audio/defense.mp3
//   SillyTavernExpansionPack/audio/item.mp3
//   SillyTavernExpansionPack/audio/escape.mp3
//
// このファイルは SillyTavernExpansionPack/modules/sound_effects.js にあり、
// ../audio/ が SillyTavernExpansionPack/audio/ に解決される。

(function () {
    'use strict';

    const LOG = '[SoundEffects]';

    // 拡張ルートからの相対パス
    const AUDIO_BASE = new URL('../audio/', import.meta.url);

    // 効果音名 → ファイル名
    const SOUND_FILES = {
        attack: 'attack.mp3',
        defense: 'defense.mp3',
        item: 'item.mp3',
        escape: 'escape.mp3',
    };

    // Audio 要素キャッシュ（連打時のロード待ち・メモリリーク防止）
    const _audioCache = new Map();

    function resolveSrc(name) {
        const fileName = SOUND_FILES[name];
        if (!fileName) return null;
        return new URL(fileName, AUDIO_BASE).href;
    }

    function getAudio(name) {
        if (_audioCache.has(name)) return _audioCache.get(name);
        const src = resolveSrc(name);
        if (!src) return null;

        const audio = new Audio();
        audio.preload = 'auto';
        audio.src = src;
        // 404 等を無音で受け流す
        audio.addEventListener('error', () => { /* ignore */ }, { once: true });

        _audioCache.set(name, audio);
        return audio;
    }

    function play(name) {
        const audio = getAudio(name);
        if (!audio) {
            console.warn(`${LOG} 未知の効果音:`, name);
            return;
        }
        try {
            // 連打時は先頭に巻き戻して再生
            audio.currentTime = 0;
            const p = audio.play();
            if (p && typeof p.catch === 'function') {
                // ユーザー操作外での自動再生制限などでブロックされた場合の保険
                p.catch(err => {
                    console.debug(`${LOG} 再生できませんでした:`, name, err);
                });
            }
        } catch (e) {
            console.debug(`${LOG} 再生例外:`, name, e);
        }
    }

    function preload() {
        for (const name of Object.keys(SOUND_FILES)) {
            try { getAudio(name); } catch (e) { /* ignore */ }
        }
    }

    preload();

    window.SoundEffects = {
        play,
        preload,
        SOUND_FILES,
    };

    console.log(`${LOG} 初期化完了 (audio base: ${AUDIO_BASE.href})`);
})();
