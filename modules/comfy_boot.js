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

// ============================================================
// ★ ComfyUI WebSocket 進捗インターセプタ（診断ログ付き）
//    ST SD 拡張が ComfyUI と通信する WS をパッチして進捗を中継する。
//    URL マッチングを広げ、全 WS 生成をログに残して原因特定を容易にする。
// ============================================================
(function installComfyWsProgressInterceptor() {
    if (window.__gicComfyWsPatched) return;
    window.__gicComfyWsPatched = true;

    try {
        const OrigWebSocket = window.WebSocket;
        if (!OrigWebSocket) return;

        function isComfyWsUrl(wsUrl) {
            try {
                const u = new URL(wsUrl, window.location.origin);
                // ① パスに /ws を含む（/ws, /ws/, /api/sd/comfy/ws など）
                if (/\/ws(\/|$)/.test(u.pathname)) return true;
                // ② ホストに comfy を含む
                if (/comfy/i.test(u.hostname + u.pathname)) return true;
                // ③ デフォルト ComfyUI ポート
                if (u.port === '8188') return true;
                // ④ localtunnel ドメイン
                if (/loca\.lt/i.test(u.hostname)) return true;
                // ⑤ localhost / 127.0.0.1 の非 ST ポート
                if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
                    u.port && u.port !== '8000') return true;
                return false;
            } catch (e) { return false; }
        }

        function dispatch(type, detail) {
            try {
                window.dispatchEvent(new CustomEvent(type, { detail }));
            } catch (e) { /* ignore */ }
        }

        function handleMessage(raw, url) {
            let data;
            try {
                if (typeof raw === 'string') {
                    data = JSON.parse(raw);
                } else if (raw && typeof raw.text === 'function') {
                    // Blob の可能性
                    raw.text().then(t => handleMessage(t, url)).catch(() => {});
                    return;
                } else {
                    return;
                }
            } catch (e) { return; }
            if (!data || typeof data !== 'object') return;

            const t = data.type;
            const d = data.data || {};

            console.log(`[GIC-Boot] WS msg from ${url}: type=${t}`, d);

            if (t === 'progress') {
                const value = Number(d.value);
                const max   = Number(d.max);
                if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
                    dispatch('comfyui-progress', { value, max, url });
                }
            } else if (t === 'execution_start') {
                dispatch('comfyui-progress-start', { url });
            } else if (t === 'execution_success' ||
                       t === 'execution_error' ||
                       t === 'execution_interrupted') {
                dispatch('comfyui-progress-end', { url, reason: t });
            } else if (t === 'executing' && (d.node === null || d.node === undefined)) {
                dispatch('comfyui-progress-end', { url, reason: 'executing-null' });
            }
        }

        function GicWebSocket(url, protocols) {
            // ★ 全ての WS 生成をログに残す（診断用）
            console.log(`[GIC-Boot] WS created: ${url}`);

            const ws = protocols !== undefined
                ? new OrigWebSocket(url, protocols)
                : new OrigWebSocket(url);

            if (isComfyWsUrl(url)) {
                console.log(`[GIC-Boot] ✅ ComfyUI WS を検出 → 進捗を監視: ${url}`);
                try {
                    ws.addEventListener('message', (e) => handleMessage(e.data, url));
                } catch (e) { /* ignore */ }
            }
            return ws;
        }

        GicWebSocket.prototype = OrigWebSocket.prototype;
        Object.setPrototypeOf(GicWebSocket, OrigWebSocket);

        // ★ static 定数は継承されるため代入しない
        //   （strict モードでは read-only への代入が TypeError になる）

        window.WebSocket = GicWebSocket;
        console.log('[GIC-Boot] ComfyUI WS 進捗インターセプタを設置');
    } catch (e) {
        console.warn('[GIC-Boot] ComfyUI WS 進捗インターセプタ設置失敗:', e);
    }
})();

// ============================================================
// ★ ComfyUI /prompt 傍受 + WebSocket 進捗取得（診断強化版）
//
//    ST SD 拡張の実際のリクエスト URL を特定するため、
//    /api/sd/comfy/* 系の fetch / XHR をすべてログ出力する。
//    その上で prompt_id を返すエンドポイントを捕捉して WS 接続する。
// ============================================================
(function installComfyPromptWatcher() {
    if (window.__gicComfyPromptWatcherInstalled) return;
    window.__gicComfyPromptWatcherInstalled = true;

    // -- State --
    let _ws = null;
    let _wsClientId = null;
    let _wsUrl = null;
    let _wsConnecting = false;
    let _wsTimeoutTimer = null;
    let _currentPromptId = null;
    let _capturedClientId = null;

    // -- Helpers --
    function getComfyBaseUrl() {
        try {
            const ctx = window.SillyTavern?.getContext?.();
            const sd = ctx?.extensionSettings?.sd;
            const url = sd?.comfy_url || sd?.comfyui_url || sd?.url || sd?.server_url || '';
            if (url && /^https?:\/\//i.test(url)) {
                return url.trim().replace(/\/+$/, '');
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function buildWsUrl(clientId) {
        const baseUrl = getComfyBaseUrl();
        if (baseUrl) {
            return baseUrl.replace(/^http/i, 'ws')
                + '/ws?clientId=' + encodeURIComponent(clientId);
        }
        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const host = window.location.hostname || '127.0.0.1';
        return `${proto}://${host}:8188/ws?clientId=${encodeURIComponent(clientId)}`;
    }

    function generateClientId() {
        try {
            if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
        } catch (e) { /* ignore */ }
        return Array.from({ length: 32 }, () =>
            Math.floor(Math.random() * 16).toString(16)
        ).join('');
    }

    function dispatch(type, detail) {
        try {
            window.dispatchEvent(new CustomEvent(type, { detail }));
        } catch (e) { /* ignore */ }
    }

    function closeWs(reason) {
        if (_wsTimeoutTimer) { clearTimeout(_wsTimeoutTimer); _wsTimeoutTimer = null; }
        if (_ws) {
            try { _ws.close(1000, reason); } catch (e) { /* ignore */ }
            _ws = null;
        }
        _wsConnecting = false;
    }

    function resetWsTimeout() {
        if (_wsTimeoutTimer) clearTimeout(_wsTimeoutTimer);
        _wsTimeoutTimer = setTimeout(() => {
            console.warn('[GIC-Boot] ComfyUI WS タイムアウト (180秒) → 閉じます');
            closeWs('timeout');
            _currentPromptId = null;
        }, 180000);
    }

    function handleWsMessage(ev) {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (!msg || typeof msg !== 'object') return;

        const t = msg.type;
        const d = msg.data || {};

        if (_currentPromptId && d.prompt_id && d.prompt_id !== _currentPromptId) {
            if (t !== 'status' && t !== 'queue_remaining') return;
        }

        switch (t) {
            case 'progress': {
                const value = Number(d.value);
                const max = Number(d.max);
                if (Number.isFinite(value) && Number.isFinite(max) && max > 0) {
                    console.log(`[GIC-Boot] 📊 progress: ${value}/${max} (prompt=${d.prompt_id})`);
                    dispatch('comfyui-progress', { value, max, promptId: d.prompt_id });
                }
                break;
            }
            case 'execution_start':
                console.log(`[GIC-Boot] 🚀 execution_start: ${d.prompt_id}`);
                dispatch('comfyui-progress-start', { promptId: d.prompt_id });
                break;
            case 'execution_success':
            case 'execution_error':
            case 'execution_interrupted':
                console.log(`[GIC-Boot] 🏁 ${t}: ${d.prompt_id}`);
                dispatch('comfyui-progress-end', { promptId: d.prompt_id, reason: t });
                _currentPromptId = null;
                break;
            case 'executing':
                if (d.node === null || d.node === undefined) {
                    console.log(`[GIC-Boot] ✅ executing/node=null: ${d.prompt_id}`);
                    dispatch('comfyui-progress-end', { promptId: d.prompt_id, reason: 'executing-null' });
                    _currentPromptId = null;
                }
                break;
        }
    }

    function openWs(clientId) {
        if (_ws && _ws.readyState === WebSocket.OPEN) {
            console.log(`[GIC-Boot] 既存 WS を再利用 (clientId=${_wsClientId})`);
            resetWsTimeout();
            return;
        }
        if (_wsConnecting) return;

        _wsClientId = clientId || generateClientId();
        _wsUrl = buildWsUrl(_wsClientId);
        console.log(`[GIC-Boot] ComfyUI WS に接続: ${_wsUrl}`);

        _wsConnecting = true;
        try {
            _ws = new WebSocket(_wsUrl);

            _ws.addEventListener('open', () => {
                _wsConnecting = false;
                console.log(`[GIC-Boot] ✅ ComfyUI WS 接続成功 (clientId=${_wsClientId})`);
                resetWsTimeout();
            });

            _ws.addEventListener('message', handleWsMessage);

            _ws.addEventListener('error', () => {
                _wsConnecting = false;
                console.warn(
                    '[GIC-Boot] ❌ ComfyUI WS エラー（CORS / mixed content / ' +
                    'localtunnel 制限の可能性）。スピナー表示で継続します。'
                );
            });

            _ws.addEventListener('close', (e) => {
                console.log(`[GIC-Boot] ComfyUI WS 切断 (code=${e.code}, reason="${e.reason || ''}")`);
                _ws = null;
                _wsConnecting = false;
                if (_wsTimeoutTimer) { clearTimeout(_wsTimeoutTimer); _wsTimeoutTimer = null; }
            });

            resetWsTimeout();
        } catch (e) {
            _wsConnecting = false;
            console.warn('[GIC-Boot] ComfyUI WS 接続例外:', e);
        }
    }

    // ============================================================
    // ★ prompt_id と client_id をレスポンス/リクエストから抽出
    // ============================================================
    function tryExtractClientId(body) {
        try {
            if (!body) return;
            let obj = null;
            if (typeof body === 'string' && body.length > 0 && body[0] === '{') {
                obj = JSON.parse(body);
            } else if (body instanceof URLSearchParams) {
                const cid = body.get('client_id');
                if (cid) { _capturedClientId = cid; console.log(`[GIC-Boot] 🔑 client_id を抽出 (form): ${cid}`); }
                return;
            } else if (body instanceof FormData) {
                const cid = body.get('client_id');
                if (cid) { _capturedClientId = cid; console.log(`[GIC-Boot] 🔑 client_id を抽出 (formdata): ${cid}`); }
                return;
            }
            if (obj) {
                const cid = obj.client_id || obj.clientId;
                if (cid && typeof cid === 'string' && cid.length >= 8) {
                    _capturedClientId = cid;
                    console.log(`[GIC-Boot] 🔑 client_id を抽出 (json): ${cid}`);
                }
            }
        } catch (e) { /* ignore */ }
    }

    function tryExtractPromptId(data) {
        if (!data || typeof data !== 'object') return false;
        // ComfyUI のレスポンスは {prompt_id} / {id} / {promptId} など
        const promptId = data.prompt_id || data.id || data.promptId;
        if (promptId && typeof promptId === 'string' && promptId.length >= 8) {
            console.log(`[GIC-Boot] ✅ prompt_id 取得: ${promptId}`);
            _currentPromptId = promptId;
            openWs(_capturedClientId || generateClientId());
            return true;
        }
        return false;
    }

    // ============================================================
    // ★ fetch インターセプタ（全 /api/sd/ 系をログ出力）
    // ============================================================
    const origFetch = window.fetch;
    if (origFetch && !origFetch.__gicPromptWatcherPatched) {
        const wrapped = function(input, init) {
            const url = typeof input === 'string'
                ? input
                : (input && typeof input.url === 'string' ? input.url : '');
            const method = (init?.method || 'GET').toUpperCase();

            // 診断: /api/sd/ 系の全リクエストをログ（画像関連ノイズは除外）
            const isSdApi = url.includes('/api/sd/');
            if (isSdApi) {
                console.log(`[GIC-Boot] 📡 SD API: ${method} ${url}`);
            }

            // 対象: /api/sd/comfy/ 以下の POST すべて
            const isTargetCall = method === 'POST' && (
                url.includes('/api/sd/comfy/prompt') ||
                url.includes('/api/sd/comfy/generate') ||
                url.includes('/api/sd/comfy/queue') ||
                /\/prompt(\?|$)/.test(url) ||
                /\/generate(\?|$)/.test(url)
            );

            if (!isTargetCall) {
                return origFetch.apply(this, arguments);
            }

            console.log(`[GIC-Boot] 🎯 対象 POST 検出: ${url}`);

            tryExtractClientId(init?.body);

            return origFetch.apply(this, arguments).then(async (resp) => {
                try {
                    if (resp.ok) {
                        const cloned = resp.clone();
                        const ct = (cloned.headers.get('content-type') || '').toLowerCase();
                        if (ct.includes('json')) {
                            const data = await cloned.json();
                            console.log(`[GIC-Boot] 📥 ${url} レスポンス:`, data);
                            if (!tryExtractPromptId(data)) {
                                // レスポンス内に client_id が含まれる場合もある
                                if (data?.client_id) {
                                    _capturedClientId = data.client_id;
                                    console.log(`[GIC-Boot] 🔑 レスポンスから client_id: ${data.client_id}`);
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.debug('[GIC-Boot] レスポンス解析スキップ:', e);
                }
                return resp;
            });
        };
        wrapped.__gicPromptWatcherPatched = true;
        window.fetch = wrapped;
    }

    // ============================================================
    // ★ XHR インターセプタ（fetch を使っていない場合の保険）
    // ============================================================
    try {
        const OrigXHR = window.XMLHttpRequest;
        if (OrigXHR && !OrigXHR.__gicPromptWatcherPatched) {
            const origOpen = OrigXHR.prototype.open;
            const origSend = OrigXHR.prototype.send;

            OrigXHR.prototype.open = function(method, url, ...rest) {
                this.__gic_url = url;
                this.__gic_method = (method || 'GET').toUpperCase();
                return origOpen.apply(this, [method, url, ...rest]);
            };

            OrigXHR.prototype.send = function(body) {
                const url = this.__gic_url || '';
                const method = this.__gic_method || 'GET';

                if (method === 'POST' && url.includes('/api/sd/')) {
                    console.log(`[GIC-Boot] 📡 SD XHR: ${method} ${url}`);
                    tryExtractClientId(body);

                    const isTarget = url.includes('/api/sd/comfy/prompt') ||
                                     url.includes('/api/sd/comfy/generate') ||
                                     /\/prompt(\?|$)/.test(url) ||
                                     /\/generate(\?|$)/.test(url);

                    if (isTarget) {
                        console.log(`[GIC-Boot] 🎯 対象 XHR POST: ${url}`);
                        this.addEventListener('load', () => {
                            try {
                                if (this.status >= 200 && this.status < 300) {
                                    const data = JSON.parse(this.responseText);
                                    console.log(`[GIC-Boot] 📥 XHR レスポンス:`, data);
                                    tryExtractPromptId(data);
                                }
                            } catch (e) { /* ignore */ }
                        });
                    }
                }

                return origSend.apply(this, [body]);
            };

            OrigXHR.__gicPromptWatcherPatched = true;
        }
    } catch (e) {
        console.warn('[GIC-Boot] XHR インターセプト失敗:', e);
    }

    // -- 完了後 5 秒で WS 掃除 --
    window.addEventListener('comfyui-progress-end', () => {
        setTimeout(() => {
            if (!_currentPromptId) closeWs('progress-end');
        }, 5000);
    });

    // -- デバッグ API --
    window.GicComfyWs = {
        status: () => ({
            connected: !!_ws && _ws.readyState === WebSocket.OPEN,
            connecting: _wsConnecting,
            url: _wsUrl,
            clientId: _wsClientId,
            currentPromptId: _currentPromptId,
            lastCapturedClientId: _capturedClientId,
        }),
        testConnect: () => openWs(generateClientId()),
        close: (r) => closeWs(r || 'manual'),
        buildWsUrl,
        getComfyBaseUrl,
    };

    console.log('[GIC-Boot] /prompt 監視 + WebSocket 進捗取得を有効化（診断強化版）');
})();
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
                    // ★ SD設定に外部URL（localtunnel等）が設定されている場合は
                    //   ブロックしない（Colab + localtunnel 環境対策）
                    let hasExternalUrl = false;
                    try {
                        const ctx = window.SillyTavern?.getContext?.();
                        const sd = ctx?.extensionSettings?.sd;
                        const sdUrl = sd?.comfy_url || sd?.comfyui_url || sd?.url || '';
                        if (/^https?:\/\//i.test(sdUrl) &&
                            !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(sdUrl)) {
                            hasExternalUrl = true;
                        }
                    } catch (e) { /* ignore */ }
                    if (!hasExternalUrl) {
                        console.debug('[GIC-Boot] /api/sd/comfy/* をブロック（ComfyUI未検出キャッシュ）:', url);
                        return Promise.resolve(new Response('{}', {
                            status: 200,
                            statusText: 'OK',
                            headers: { 'Content-Type': 'application/json' },
                        }));
                    } else {
                        console.debug('[GIC-Boot] 外部URL設定のためブロックをスキップ:', url);
                    }
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

            // ★ 常に _thum.png をリストに追加（ディスク存在チェックなし）
            const modified = [...images];
            let added = 0;
            for (const v of videos) {
                const m = v.match(/^(.+)\.(mp4|webm)$/i);
                if (!m) continue;
                const thumbName = `${m[1]}_${m[2].toLowerCase()}_thum.png`;
                if (existingThumbs.has(thumbName)) continue;
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
