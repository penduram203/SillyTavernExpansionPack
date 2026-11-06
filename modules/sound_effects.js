// sound_effects.js
(function () {
    'use strict';
    const LOG = '[SoundEffects]';

    // ★ sound_effects_data.js が先に読み込まれている前提
    const SOUND_EFFECTS = window.SOUND_EFFECTS_DATA || {
        attack: '',
        defense: '',
    };

    const _audioUrlCache = new Map();

    /**
     * Base64文字列（改行・data URLヘッダー付き可）から data URL を作る
     */
    function _toDataUrl(base64Data) {
        const clean = String(base64Data)
            .replace(/^data:audio\/[^;]+;base64,/, '')
            .replace(/\s+/g, '');
        return 'data:audio/mpeg;base64,' + clean;
    }

    /**
     * 有効な Base64 データかどうかをざっくり判定する
     *   - 空文字列
     *   - コメント文字列（//, #, /*）
     *   - 極端に短い（100文字未満）
     * を弾く
     */
    function _isValidBase64(base64Data) {
        if (!base64Data || typeof base64Data !== 'string') return false;
        const t = base64Data.trim();
        if (t.length < 100) return false;
        if (t.startsWith('//') || t.startsWith('#') || t.startsWith('/*')) return false;
        return true;
    }

    /**
     * Base64 から効果音を再生する
     * @param {string} base64Data - Base64エンコードされた音声データ
     */
    function playSound(base64Data) {
        if (!_isValidBase64(base64Data)) {
            console.warn(LOG, '無効な音声データのためスキップ (len=' +
                (typeof base64Data === 'string' ? base64Data.length : 'n/a') + ')');
            return;
        }

        try {
            let dataUrl = _audioUrlCache.get(base64Data);
            if (!dataUrl) {
                dataUrl = _toDataUrl(base64Data);
                _audioUrlCache.set(base64Data, dataUrl);
            }

            // ★ ユーザー操作（クリック）内で同期的に play() を呼ぶ
            const audio = new Audio(dataUrl);
            audio.volume = 1.0;
            const p = audio.play();
            if (p && typeof p.catch === 'function') {
                p.then(() => {
                    console.log(LOG, '🔊 再生開始');
                }).catch((e) => {
                    console.warn(LOG, 'play() 失敗:', e);
                });
            }
        } catch (error) {
            console.error(LOG, '音声の再生に失敗しました:', error);
        }
    }

    // ★ グローバルに公開（variable_manager.js から参照できるようにする）
    window.playSound = playSound;
    window.SOUND_EFFECTS = SOUND_EFFECTS;

    console.log(LOG, '✅ window.playSound / window.SOUND_EFFECTS を公開',
        {
            attackLen: SOUND_EFFECTS.attack.length,
            defenseLen: SOUND_EFFECTS.defense.length,
        });
})();
