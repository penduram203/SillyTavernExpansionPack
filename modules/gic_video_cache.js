// gic_video_cache.js
// ST本体の getVideoThumbnail が動画デコードで詰まる問題への対策。
// ギャラリー内の全動画を fetch + <video> で事前デコードし、
// ブラウザのHTTPキャッシュ・デコーダーキャッシュを温める。

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
// 公開: ギャラリー内の全動画をプリウォーム
//    (1) fetch(url, { cache: 'force-cache' }) でHTTPキャッシュに乗せる
//    (2) <video preload="auto"> でデコード → デコーダーキャッシュに乗せる
//    (3) IndexedDBにサムネイル(dataURL)を保存（GIC UI用）
// ============================================================
export async function prewarmVideoResources() {
    if (videoWarmupInFlight) return;
    videoWarmupInFlight = true;

    try {
        const charName = getCharacterName();
        if (!charName) return;

        const gallery = document.getElementById('gallery');
        if (!gallery) return;

        // ギャラリーのサムネイルから動画URLを抽出
        const urls = new Set();
        gallery.querySelectorAll('.nGY2GThumbnail, .nGY2GThumbnail_l1').forEach(thumb => {
            const title = (thumb.getAttribute('title') || '').trim();
            if (title && isVideoFile(title)) {
                urls.add('/user/images/' + encodeURIComponent(charName) + '/' + encodeURIComponent(title));
            }
        });

        if (urls.size === 0) return;

        const newUrls = [...urls].filter(u => !VIDEO_WARMUP_DONE.has(u));
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
// 公開: ギャラリーが開いたら自動でプリウォーム
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
        prewarmVideoResources().catch(() => {});
    }, 5000);

    console.log('[GIC-Cache] 🎬 動画ウォームアップオブザーバを設置しました');
}
