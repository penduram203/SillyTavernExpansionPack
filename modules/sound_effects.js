// sound_effects.js
// 効果音を音声ファイルから再生するユーティリティ。
//   window.SoundEffects.play('attack') のように呼び出す。
//
// ★ 拡張子の自動解決:
//   SOUND_FILES の値を拡張子なしで書いた場合、AUDIO_EXTENSIONS の優先順に
//   実ファイルを HEAD プローブし、最初に見つかった拡張子を採用する。
//   例: attack: 'attack' → attack.opus / attack.ogg / attack.mp3 / attack.wav を順に探す。
//
// ★ 明示指定:
//   拡張子込みで書けば、そのファイルをそのまま使用する。
//   例: attack: 'attack.opus'
//
// ★ ブラウザ対応チェック:
//   canPlayType() で非対応形式（Safari の Opus など）は自動的にスキップ。
//
// ファイル配置（拡張ルートからの相対パス）:
//   SillyTavernExpansionPack/audio/attack.opus   ← 置くだけで自動検出
//   SillyTavernExpansionPack/audio/attack.ogg
//   SillyTavernExpansionPack/audio/attack.mp3
//   SillyTavernExpansionPack/audio/attack.wav
//   など、いずれか1つを audio/ に置けばOK。
//
// このファイルは SillyTavernExpansionPack/modules/sound_effects.js にあり、
// ../audio/ が SillyTavernExpansionPack/audio/ に解決される。

(function () {
    'use strict';

    const LOG = '[SoundEffects]';

    // 拡張ルートからの相対パス
    const AUDIO_BASE = new URL('../audio/', import.meta.url);

    // 拡張子解決の優先順（先頭ほど優先）
    // ブラウザが非対応の形式は canPlayType() で自動スキップされる
    const AUDIO_EXTENSIONS = ['opus', 'ogg', 'mp3', 'wav'];

    // 拡張子 → canPlayType() 用 MIME
    const MIME_BY_EXT = {
        opus: 'audio/ogg; codecs="opus"',
        ogg:  'audio/ogg',
        oga:  'audio/ogg',
        mp3:  'audio/mpeg',
        wav:  'audio/wav',
        m4a:  'audio/mp4',
        aac:  'audio/aac',
        webm: 'audio/webm',
    };

    // 効果音名 → ファイル名（拡張子なし / もしくは拡張子込み）
    const SOUND_FILES = {
        attack:  'attack',
        defense: 'defense',
        item:    'item',
        escape:  'escape',
    };

    // name -> HTMLAudioElement
    const _audioCache = new Map();
    // name -> Promise<string|null>（解決中のみ存在）
    const _resolvePromise = new Map();

    // ============================================================
    // ブラウザ対応チェック
    // ============================================================
    let _supportProbeEl = null;
    function isFormatSupported(ext) {
        const mime = MIME_BY_EXT[ext];
        if (!mime) {
            // 未知の拡張子は「対応しているか不明」→ 試す価値ありとみなす
            return true;
        }
        try {
            if (!_supportProbeEl) _supportProbeEl = document.createElement('audio');
            const r = _supportProbeEl.canPlayType(mime);
            return r === 'probably' || r === 'maybe';
        } catch (e) {
            return true;
        }
    }

    // ============================================================
    // 拡張子判別 & HEAD プローブ
    // ============================================================
    function hasExtension(fileName) {
        return /\.[a-z0-9]+$/i.test(fileName);
    }

    async function probeUrl(url) {
        try {
            const resp = await fetch(url, { method: 'HEAD', cache: 'no-store' });
            if (!resp.ok) return false;
            const ct = (resp.headers.get('content-type') || '').toLowerCase();
            // 404 HTML ページ等を誤検出しないよう text/html を除外
            if (ct.includes('text/html')) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    // ============================================================
    // src 解決
    //   戻り値: 完全な URL 文字列 or null
    // ============================================================
    async function resolveSrc(name) {
        const fileName = SOUND_FILES[name];
        if (!fileName) return null;

        // ① 明示指定（拡張子込み）: そのまま採用
        if (hasExtension(fileName)) {
            return new URL(fileName, AUDIO_BASE).href;
        }

        // ② 自動解決: AUDIO_EXTENSIONS を優先順に試す
        for (const ext of AUDIO_EXTENSIONS) {
            if (!isFormatSupported(ext)) continue;
            const url = new URL(`${fileName}.${ext}`, AUDIO_BASE).href;
            if (await probeUrl(url)) {
                return url;
            }
        }
        return null;
    }

    // ============================================================
    // Audio 要素の取得（非同期）
    // ============================================================
    async function getAudioAsync(name) {
        if (_audioCache.has(name)) return _audioCache.get(name);

        // 解決中の場合は同じ Promise を待つ（多重プローブ防止）
        if (_resolvePromise.has(name)) {
            await _resolvePromise.get(name);
            return _audioCache.get(name) || null;
        }

        const promise = resolveSrc(name);
        _resolvePromise.set(name, promise);

        try {
            const src = await promise;
            if (!src) {
                console.warn(
                    `${LOG} 音声ファイルが見つかりません: name="${name}", base="${SOUND_FILES[name]}", ` +
                    `試行拡張子=[${AUDIO_EXTENSIONS.join(', ')}], baseDir=${AUDIO_BASE.href}`
                );
                return null;
            }

            // 既に他経路でキャッシュ済みなら二重生成しない
            if (_audioCache.has(name)) return _audioCache.get(name);

            const audio = new Audio();
            audio.preload = 'auto';
            audio.src = src;
            // 404 等のエラーは無音で受け流す
            audio.addEventListener('error', () => { /* ignore */ }, { once: true });

            _audioCache.set(name, audio);
            console.log(`${LOG} 効果音を読み込みました: ${name} → ${src}`);
            return audio;
        } finally {
            _resolvePromise.delete(name);
        }
    }

    // ============================================================
    // 再生
    // ============================================================
    function playAudioElement(audio) {
        try {
            // 連打時は先頭に巻き戻して再生
            audio.currentTime = 0;
            const p = audio.play();
            if (p && typeof p.catch === 'function') {
                // ユーザー操作外での自動再生制限などでブロックされた場合の保険
                p.catch(err => {
                    console.debug(`${LOG} 再生できませんでした:`, err);
                });
            }
        } catch (e) {
            console.debug(`${LOG} 再生例外:`, e);
        }
    }

    function play(name) {
        // ① キャッシュ済み → 即座に同期再生
        const cached = _audioCache.get(name);
        if (cached) {
            playAudioElement(cached);
            return;
        }

        // ② 未解決 → 非同期で解決してから再生
        //    初回だけ微小な遅延が入るが、preload() により通常は起きない
        getAudioAsync(name)
            .then(audio => {
                if (audio) playAudioElement(audio);
            })
            .catch(err => {
                console.debug(`${LOG} 効果音の解決に失敗:`, name, err);
            });
    }

    // ============================================================
    // プリロード（初回再生遅延の防止）
    // ============================================================
    async function preload() {
        const names = Object.keys(SOUND_FILES);
        for (const name of names) {
            try { await getAudioAsync(name); } catch (e) { /* ignore */ }
        }
    }

    // 起動時に非同期プリロード
    preload().catch(err => {
        console.debug(`${LOG} プリロード中のエラー:`, err);
    });

    // ============================================================
    // 公開 API
    // ============================================================
    window.SoundEffects = {
        play,
        preload,
        // 参照用（デバッグ）
        SOUND_FILES,
        AUDIO_EXTENSIONS,
        // 現時点で解決済みの src 一覧を返す（デバッグ用）
        getResolvedSrcs: () => {
            const out = {};
            for (const [name, audio] of _audioCache.entries()) {
                out[name] = audio.src;
            }
            return out;
        },
    };

    console.log(`${LOG} 初期化完了 (audio base: ${AUDIO_BASE.href})`);
})();
