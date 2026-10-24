// comfy_boot.js
// ★ このファイルは gic.js の最初の import として読み込まれ、
//    ESMの評価順序により gic.js 本体より先に実行される。
//
//   役割:
//     1. ComfyUI 未検出キャッシュ（localStorage）を読み、
//        /api/sd/comfy/* への fetch を早期にインターセプトする
//     2. 次回ロード時に ST本体の SD 拡張が ComfyUI へリクエストするのを防ぐ
//     3. キャッシュ済みなら sd.source を "none" に同期設定する
//     4. /api/images/list をインターセプトし、動画を _thum.png に置換する
//        （ST本体の getVideoThumbnail をスキップして高速化）

(function installComfyBoot() {
    if (window.__gicComfyBootInstalled) return;
    window.__gicComfyBootInstalled = true;

    const COMFY_CACHE_KEY = 'gic_comfyUnavailable';
    const COMFY_PROBE_URLS = ['http://127.0.0.1:8188', 'http://localhost:8188'];
    const COMFY_PROBE_TIMEOUT_MS = 3000;

    // ============================================================
    // 1. /api/sd/comfy/* への fetch をインターセプト
    //    キャッシュが "true" のときはネットワークに出さず、
    //    空の成功レスポンスを返す（Firefox のネットワークログにも残らない）
    // ============================================================
    const originalFetch = window.fetch;
    window.__gicOriginalFetch = originalFetch;

    window.fetch = function(input, init) {
        try {
            const url = typeof input === 'string'
                ? input
                : (input && input.url ? input.url : '');

            if (url && url.indexOf('/api/sd/comfy/') !== -1) {
                const cached = localStorage.getItem(COMFY_CACHE_KEY);
                if (cached === 'true') {
                    console.debug('[GIC-Boot] /api/sd/comfy/* をブロック（ComfyUI未検出キャッシュ）:', url);
                    return Promise.resolve(new Response('{}', {
                        status: 200,
                        statusText: 'OK',
                        headers: { 'Content-Type': 'application/json' },
                    }));
                }
            }
        } catch (e) { /* fall through to original */ }

        return originalFetch.apply(this, arguments);
    };

    // ============================================================
    // 2. XMLHttpRequest も念のためインターセプト（古い ST 用）
    // ============================================================
    try {
        const OriginalXHR = window.XMLHttpRequest;
        if (OriginalXHR && !OriginalXHR.__gicPatched) {
            const originalOpen = OriginalXHR.prototype.open;
            const originalSend = OriginalXHR.prototype.send;

            OriginalXHR.prototype.open = function(method, url, ...rest) {
                this.__gic_intercepted_url = url;
                return originalOpen.apply(this, [method, url, ...rest]);
            };

            OriginalXHR.prototype.send = function(body) {
                const url = this.__gic_intercepted_url;
                if (url && url.indexOf('/api/sd/comfy/') !== -1) {
                    if (localStorage.getItem(COMFY_CACHE_KEY) === 'true') {
                        console.debug('[GIC-Boot] XHR /api/sd/comfy/* をブロック:', url);
                        const self = this;
                        setTimeout(() => {
                            try {
                                Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
                                Object.defineProperty(self, 'status', { value: 200, configurable: true });
                                Object.defineProperty(self, 'responseText', { value: '{}', configurable: true });
                                Object.defineProperty(self, 'response', { value: '{}', configurable: true });
                            } catch (e) { /* ignore */ }
                            try {
                                if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
                                if (typeof self.onload === 'function') self.onload();
                                if (typeof self.onloadend === 'function') self.onloadend();
                            } catch (e) { /* ignore */ }
                        }, 0);
                        return;
                    }
                }
                return originalSend.apply(this, arguments);
            };

            OriginalXHR.__gicPatched = true;
        }
    } catch (e) {
        console.debug('[GIC-Boot] XHR インターセプトをスキップ:', e);
    }

    // ============================================================
    // 3. キャッシュがあれば sd.source を "none" に同期設定
    // ============================================================
    try {
        const cached = localStorage.getItem(COMFY_CACHE_KEY);
        if (cached === 'true' && window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
            const ctx = window.SillyTavern.getContext();
            if (ctx && ctx.extensionSettings && ctx.extensionSettings.sd) {
                if (ctx.extensionSettings.sd.source === 'comfy') {
                    ctx.extensionSettings.sd.source = 'none';
                    console.info('[GIC-Boot] キャッシュに基づき sd.source を "none" に設定');
                    if (typeof ctx.saveSettingsDebounced === 'function') {
                        ctx.saveSettingsDebounced();
                    }
                }
            }
        }
    } catch (e) {
        console.debug('[GIC-Boot] sd.source 事前設定をスキップ:', e);
    }

    // ============================================================
    // 4. ComfyUI のバックグラウンド probe（結果をキャッシュに反映）
    // ============================================================
    (async function probeComfyUI() {
        const waitStart = Date.now();
        while (!window.SillyTavern && Date.now() - waitStart < 10000) {
            await new Promise(r => setTimeout(r, 100));
        }

        let available = false;
        for (const baseUrl of COMFY_PROBE_URLS) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), COMFY_PROBE_TIMEOUT_MS);
                const resp = await originalFetch.call(window, baseUrl + '/system_stats', {
                    method: 'GET',
                    signal: controller.signal,
                    mode: 'cors',
                    cache: 'no-store',
                });
                clearTimeout(timer);
                if (resp.ok) {
                    available = true;
                    break;
                }
            } catch (e) { /* next */ }
        }

        const prevCache = localStorage.getItem(COMFY_CACHE_KEY);
        const newCache = available ? 'false' : 'true';
        if (prevCache !== newCache) {
            localStorage.setItem(COMFY_CACHE_KEY, newCache);
            console.info(`[GIC-Boot] ComfyUI 可用性キャッシュ更新: ${newCache} (available=${available})`);
        }
    })();

    console.info('[GIC-Boot] ComfyUI fetch インターセプタをインストールしました');
})();

// ============================================================
// ★ ギャラリー動画サムネイル・インターセプタ
//    /api/images/list のレスポンスを書き換え、動画ファイルを
//    _thum.png（GIC が生成・ディスク保存）に置換する。
//    これにより ST 本体の getVideoThumbnail が呼ばれなくなり、
//    ギャラリー表示が大幅に高速化される。
//
//    ★ 重複防止:
//    ディスクに既に _thum.png が存在する場合、/api/images/list の
//    生レスポンスにもそれが含まれる。インターセプタは既存分を
//    existingThumbs として把握し、二重追加を防ぐ。
// ============================================================
(function installGalleryListInterceptor() {
    if (window.__gicGalleryListInterceptorInstalled) return;
    window.__gicGalleryListInterceptorInstalled = true;

    const originalFetch = window.fetch;

    window.fetch = async function(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (!url.includes('/api/images/list')) {
            return originalFetch.apply(this, arguments);
        }

        // リクエストボディから charName(=folder) を抽出
        let charName = null;
        try {
            const reqBody = init?.body ? JSON.parse(init.body) : null;
            charName = reqBody?.folder || null;
        } catch (e) { /* ignore */ }

        const resp = await originalFetch.apply(this, arguments);
        if (!resp.ok) return resp;

        try {
            const data = await resp.clone().json();
            if (!Array.isArray(data)) return resp;

            const images = [];
            const videos = [];
            const existingThumbs = new Set();
            for (const f of data) {
                if (/\.(mp4|webm)$/i.test(f)) {
                    videos.push(f);
                } else {
                    images.push(f);
                    if (/_thum\.png$/i.test(f)) existingThumbs.add(f);
                }
            }

            if (videos.length === 0) return resp;
            if (!charName) {
                console.debug('[GIC-Boot] charName 未取得のため置換をスキップ');
                return resp;
            }

            // ★ GIC API が利用可能になるまで少し待つ（通常は既にロード済み）
            for (let i = 0; i < 50 && !window.GicApi?.ensureThumbnailForVideo; i++) {
                await new Promise(r => setTimeout(r, 100));
            }

            if (!window.GicApi?.ensureThumbnailForVideo) {
                console.warn('[GIC-Boot] GicApi.ensureThumbnailForVideo が利用不可。置換をスキップ');
                return resp;
            }

            // ★ サムネイル生成を待つ（IndexedDB へウォームアップ）
            console.info(`[GIC-Boot] 🎬 ${videos.length}本の動画サムネイルを準備中...`);
            const genStart = Date.now();
            const tasks = videos.map(v =>
                window.GicApi.ensureThumbnailForVideo(v, charName).catch(e => {
                    console.warn('[GIC-Boot] thumb gen failed:', v, e);
                    return null;
                })
            );
            await Promise.race([
                Promise.all(tasks),
                new Promise(r => setTimeout(r, 20000)),
            ]);
            console.info(`[GIC-Boot] 🎬 サムネイル準備完了 (${Date.now() - genStart}ms)`);

            // ★ 常に _thum.png をリストに追加（ディスク非依存）
            //   ディスク存在チェックは行わない。ギャラリー側のインターセプタが
            //   IndexedDB の blob URL に差し替える。
            const modified = [...images];
            let added = 0;
            for (const v of videos) {
                const m = v.match(/^(.+)\.(mp4|webm)$/i);
                if (!m) continue;
                const thumbName = `${m[1]}_${m[2].toLowerCase()}_thum.png`;
                if (existingThumbs.has(thumbName)) continue;   // 念のため
                modified.push(thumbName);
                added++;
            }

            console.debug(`[GIC-Boot] /api/images/list 書換: 動画 ${videos.length}件 → 追加 ${added}件`);
            return new Response(JSON.stringify(modified), {
                status: resp.status,
                statusText: resp.statusText,
                headers: resp.headers,
            });
        } catch (e) {
            console.warn('[GIC-Boot] /api/images/list 書換失敗:', e);
            return resp;
        }
    };

    console.info('[GIC-Boot] 🖼️ ギャラリー動画サムネイル・インターセプタを設置しました');
})();
