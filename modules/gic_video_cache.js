// gic_video_cache.js
// ST本体の getVideoThumbnail が動画デコードで詰まる問題への対策。
// ギャラリー内の全動画を fetch + <video> で事前デコードし、
// ブラウザのHTTPキャッシュ・デコーダーキャッシュを温める。
//
// ★ v2 変更:
//   - prewarmVideoResources(urls) にシグネチャ変更（URL配列を引数に取る）
//   - collectVideoUrlsFromDOM() をエクスポート（ギャラリーDOMから抽出）
//   - fetchVideoUrlsForCharacter() をエクスポート（API経由で一覧取得）
//     → ギャラリーを開かずにキャラ選択時にバックグラウンドでプリウォーム可能

const GIC_CACHE_DB = 'gic_video_cache';
const GIC_CACHE_STORE = 'thumbnails';
const GIC_CACHE_VERSION = 1;

const VIDEO_WARMUP_DONE = new Set();
let videoWarmupInFlight = false;

function isVideoFile(url) {
    if (!url || typeof url !== 'string') return false;
    return /\.(mp4|webm)(\?|#|$)/i.test(url);
}

function getCharacterName() {
    try {
        if (typeof SillyTavern === 'undefined') return null;
        const ctx = SillyTavern.getContext();
        if (ctx?.character?.name) return ctx.character.name;
        if (ctx?.characters && ctx?.characterId != null) {
            const c = ctx.characters[ctx.characterId];
            if (c?.name) return c.name;
        }
    } catch (e) { /* ignore */ }
    return null;
}

function getRequestHeaders() {
    try {
        if (typeof SillyTavern !== 'undefined') {
            const ctx = SillyTavern.getContext();
            if (ctx && typeof ctx.getRequestHeaders === 'function') {
                return ctx.getRequestHeaders();
            }
        }
    } catch (e) { /* ignore */ }
    return { 'Content-Type': 'application/json' };
}

// ============================================================
// IndexedDB
// ============================================================
async function openCacheDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(GIC_CACHE_DB, GIC_CACHE_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(GIC_CACHE_STORE)) {
                db.createObjectStore(GIC_CACHE_STORE);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function getThumbFromCache(url) {
    try {
        const db = await openCacheDB();
        return new Promise((resolve) => {
            const tx = db.transaction(GIC_CACHE_STORE, 'readonly');
            const req = tx.objectStore(GIC_CACHE_STORE).get(url);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch (e) { return null; }
}

async function saveThumbToCache(url, dataURL) {
    try {
        const db = await openCacheDB();
        return new Promise((resolve) => {
            const tx = db.transaction(GIC_CACHE_STORE, 'readwrite');
            tx.objectStore(GIC_CACHE_STORE).put(dataURL, url);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
        });
    } catch (e) { return false; }
}

// ============================================================
// サムネイル生成（キャッシュ用）
// ============================================================
async function generateThumbnail(url) {
    return new Promise((resolve) => {
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.crossOrigin = 'anonymous';

        const timeout = setTimeout(() => {
            try { video.remove(); } catch (e) {}
            resolve(null);
        }, 5000);

        video.onloadeddata = () => {
            clearTimeout(timeout);
            try {
                const canvas = document.createElement('canvas');
                const size = 320;
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                const vw = video.videoWidth || size;
                const vh = video.videoHeight || size;
                const scale = Math.min(size / vw, size / vh);
                const dw = vw * scale;
                const dh = vh * scale;
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, size, size);
                ctx.drawImage(video, (size - dw) / 2, (size - dh) / 2, dw, dh);
                const dataURL = canvas.toDataURL('image/jpeg', 0.7);
                video.remove();
                resolve(dataURL);
            } catch (e) {
                video.remove();
                resolve(null);
            }
        };
        video.onerror = () => {
            clearTimeout(timeout);
            video.remove();
            resolve(null);
        };
        video.src = url;
    });
}

// ============================================================
// 公開: ギャラリーDOMから動画URLを抽出
// ============================================================
export function collectVideoUrlsFromDOM() {
    const urls = new Set();
    const charName = getCharacterName();
    if (!charName) return [];

    const gallery = document.getElementById('gallery');
    if (!gallery) return [];

    gallery.querySelectorAll('.nGY2GThumbnail, .nGY2GThumbnail_l1').forEach(thumb => {
        const title = (thumb.getAttribute('title') || '').trim();
        if (title && isVideoFile(title)) {
            urls.add('/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(title));
        }
    });
    return [...urls];
}

// ============================================================
// 公開: API経由でキャラフォルダの動画URL一覧を取得
//   ギャラリーを開かずに呼べる
// ============================================================
export async function fetchVideoUrlsForCharacter(charName) {
    if (!charName) return [];
    try {
        const resp = await fetch('/api/images/list', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ folder: charName }),
        });
        if (!resp.ok) {
            // 一部STバージョンは GET + query 形式
            const resp2 = await fetch(
                '/api/images/list?folder=' + encodeURIComponent(charName),
                { method: 'GET', headers: getRequestHeaders() }
            );
            if (!resp2.ok) return [];
            const data2 = await resp2.json();
            const files2 = Array.isArray(data2?.files) ? data2.files
                         : Array.isArray(data2) ? data2 : [];
            return files2
                .filter(f => isVideoFile(f))
                .map(f => '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(f));
        }
        const data = await resp.json();
        const files = Array.isArray(data?.files) ? data.files
                    : Array.isArray(data) ? data : [];
        return files
            .filter(f => isVideoFile(f))
            .map(f => '/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(f));
    } catch (e) {
        return [];
    }
}

// ============================================================
// 公開: 指定URLの動画をプリウォーム（fetch + decode + IndexedDBサムネイル）
// ============================================================
export async function prewarmVideoResources(urls) {
    if (videoWarmupInFlight) return;
    if (!Array.isArray(urls) || urls.length === 0) return;
    videoWarmupInFlight = true;

    try {
        const newUrls = urls.filter(u => u && !VIDEO_WARMUP_DONE.has(u));
        if (newUrls.length === 0) return;

        console.log(`[GIC-Cache] 🎬 ${newUrls.length}本の動画をプリウォーム開始`);

        for (const url of newUrls) {
            VIDEO_WARMUP_DONE.add(url);

            try {
                // (1) fetch でブラウザ HTTP キャッシュに乗せる
                const resp = await fetch(url, { cache: 'force-cache' });
                if (!resp.ok) continue;
                const blob = await resp.blob();
                const blobURL = URL.createObjectURL(blob);

                // (2) <video> でデコード → デコーダーキャッシュ
                const decodeDone = new Promise(resolve => {
                    const v = document.createElement('video');
                    v.preload = 'auto';
                    v.muted = true;
                    v.playsInline = true;
                    const done = () => {
                        try { v.remove(); } catch (e) {}
                        try { URL.revokeObjectURL(blobURL); } catch (e) {}
                        resolve();
                    };
                    v.onloadeddata = done;
                    v.onerror = done;
                    setTimeout(done, 3000);
                    v.src = blobURL;
                    v.load();
                });
                await decodeDone;

                // (3) IndexedDB にサムネイル dataURL を保存
                const cached = await getThumbFromCache(url);
                if (!cached) {
                    const thumb = await generateThumbnail(url);
                    if (thumb) await saveThumbToCache(url, thumb);
                }
            } catch (e) {
                // 1本失敗しても他は続行
            }
        }

        console.log(`[GIC-Cache] 🎬 動画プリウォーム完了`);
    } finally {
        videoWarmupInFlight = false;
    }
}

// ============================================================
// 公開: キャッシュ済みサムネイルを取得
// ============================================================
export async function getCachedThumbnail(url) {
    return await getThumbFromCache(url);
}

// ============================================================
// 公開: ギャラリーが開いたら自動でプリウォーム（保険）
// ============================================================
export function setupVideoWarmupObserver() {
    if (window.__gicVideoWarmupInstalled) return;
    window.__gicVideoWarmupInstalled = true;

    let lastRunAt = 0;
    setInterval(() => {
        const gallery = document.getElementById('gallery');
        if (!gallery) return;
        const s = window.getComputedStyle(gallery);
        if (s.display === 'none' || s.visibility === 'hidden') return;
        if (Date.now() - lastRunAt < 15000) return;
        lastRunAt = Date.now();
        const urls = collectVideoUrlsFromDOM();
        if (urls.length > 0) {
            prewarmVideoResources(urls).catch(() => {});
        }
    }, 5000);

    console.log('[GIC-Cache] 🎬 動画ウォームアップオブザーバを設置しました');
}
