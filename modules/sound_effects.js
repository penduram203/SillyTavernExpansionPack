// sound_effects.js
const SOUND_EFFECTS = {
    // 攻撃ボタン用の効果音 (Base64文字列)
    // ※ 実際のBase64データは sound_effects_data.js に移動することを推奨
    attack: '', // ← ここにBase64を貼り付けるか、外部ファイルから読み込む

    // 防御ボタン用の効果音 (Base64文字列)
    defense: '', // ← 同上
};

const audioContext = new (window.AudioContext || window.webkitAudioContext)();
const audioBufferCache = {}; // デコード済みの音声データをキャッシュ

/**
 * Base64文字列から音声を再生する
 * @param {string} base64Data - Base64エンコードされた音声データ
 */
async function playSound(base64Data) {
    if (!base64Data) return;

    try {
        // キャッシュになければデコード
        if (!audioBufferCache[base64Data]) {
            // Base64ヘッダー（data:audio/mpeg;base64,）を除去
            const base64WithoutHeader = base64Data.replace(/^data:audio\/\w+;base64,/, '');

            // Base64 → Uint8Array (ArrayBuffer)
            const binaryString = atob(base64WithoutHeader);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // ArrayBuffer → AudioBufferにデコード
            audioBufferCache[base64Data] = await audioContext.decodeAudioData(bytes.buffer);
        }

        // 再生
        const source = audioContext.createBufferSource();
        source.buffer = audioBufferCache[base64Data];
        source.connect(audioContext.destination);
        source.start(0);
    } catch (error) {
        console.error('[SoundEffects] 音声の再生に失敗しました:', error);
    }
}

// ★ グローバルに公開（variable_manager.js から参照できるようにする）
window.playSound = playSound;
window.SOUND_EFFECTS = SOUND_EFFECTS;
