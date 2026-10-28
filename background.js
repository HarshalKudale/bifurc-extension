/**
 * Bifurc Companion — Background Service Worker
 * (Chrome runs it as a service worker, Firefox as an event page.)
 *
 * The extension is a proxy switch for the Bifurc desktop app:
 * 1. It finds the app's companion server (a WebSocket on loopback) and opens
 *    an RPC session with it.
 * 2. It asks the engine which port its forward proxy listens on.
 * 3. The toggle routes browser traffic to that port, or leaves it direct.
 * 4. With the toggle on and the engine not intercepting HTTPS itself, pages'
 *    HTTPS calls are routed through the engine by inject.js (see "Page
 *    traffic" below), so mocks, rules and capture work without its certificate.
 *
 * Finding the companion server: the app binds the first free port at or above
 * a base port (4747 unless changed in the app's Settings → Ports). So the
 * extension tries the base port and the next 10 above it, lowest first. If
 * none answers, the popup offers the port to the user.
 *
 * IMPORTANT — proxy activation rule:
 *   The proxy is applied ONLY when the toggle is ON, the engine is connected
 *   and its forward proxy is running. In every other case the proxy settings
 *   are cleared so the browser keeps its normal direct passthrough. Routing to
 *   a port nothing listens on would black-hole traffic.
 */

// ── Constants (kept in step with the engine) ──────────────────────────────────

const HOST = "127.0.0.1";
/** The app's default companion port (Settings → Ports). */
const DEFAULT_BASE_PORT = 4747;
/** How many ports above the base are tried before giving up. */
const SCAN_AHEAD = 10;
/** `PROTOCOL_VERSION` in `protocol-rust/src/version.rs`. */
const PROTOCOL_VERSION = "1.0.0";
/** One of the engine's `CLIENT_NAMES`. */
const CLIENT_NAME = "bifurc-extension";

const PROBE_TIMEOUT_MS = 800;
const HELLO_TIMEOUT_MS = 3000;
const RPC_TIMEOUT_MS = 5000;
/** `browser.read` waits up to 20 s for data on the engine's side. */
const READ_TIMEOUT_MS = 30000;
/** Also what keeps the service worker alive while a session is open. */
const STATUS_POLL_MS = 5000;
const MAX_RETRY_DELAY_MS = 15000;

const EVENTS = ["event.settings.changed", "event.server.error", "event.engine.stopping"];

/** Firefox shapes proxy settings and network errors differently from Chrome. */
const IS_FIREFOX = chrome.runtime.getURL("").startsWith("moz-extension:");

const DEFAULTS = {
    proxyEnabled: false,
    basePort: DEFAULT_BASE_PORT,
    // The companion port of the last session, tried first on the next search.
    lastPort: null,
};

// ── State ─────────────────────────────────────────────────────────────────────

let ws = null;              // the socket of the established session
let companionPort = null;   // the port that session is on
let engineVersion = null;
let forward = { running: false, port: 0, https: false, error: null };

let searching = false;      // a search is in flight
let notFound = false;       // the last search finished without finding the app
let discoverSeq = 0;        // a newer search supersedes an older one
let retryTimer = null;
let retryDelay = 1000;
let pollTimer = null;

let rpcSeq = 0;
// False once the engine refused the browser.* commands (one older than this extension): pages stay native.
let browserCommands = true;
const pending = new Map();  // rpc id -> { resolve, reject, timer }

// Monotonic guard so a slow/racing applyProxy() can never clobber a newer one.
let proxyApplySeq = 0;
// Identity of the proxy config currently pushed to the browser ("direct" | "proxy:<port>").
// null until the first successful apply in this service-worker lifetime.
let appliedProxyKey = null;
// Synchronous mirror of "Chrome is routing regular traffic through our proxy".
// webRequest listeners are sync, so they cannot await getState().
let proxyRouted = false;

// ── Storage helpers ───────────────────────────────────────────────────────────

function isPort(value) {
    return Number.isInteger(value) && value >= 1 && value <= 65535;
}

async function getConfig() {
    const config = await chrome.storage.local.get(DEFAULTS);
    if (!isPort(config.basePort)) config.basePort = DEFAULT_BASE_PORT;
    if (!isPort(config.lastPort)) config.lastPort = null;
    return config;
}

async function setConfig(patch) {
    await chrome.storage.local.set(patch);
}

// ── Resolved state ────────────────────────────────────────────────────────────

function isConnected() {
    return !!(ws && ws.readyState === WebSocket.OPEN);
}

/**
 * Firefox only lets an extension change proxy settings once the user has
 * allowed it in private windows (about:addons). Chrome has no such rule.
 */
async function needsPrivateAccess() {
    if (!IS_FIREFOX) return false;
    try {
        return !(await chrome.extension.isAllowedIncognitoAccess());
    } catch {
        return false;
    }
}

/**
 * Resolved, UI-facing state. `proxyActive` is the single source of truth for
 * whether traffic is actually being routed through the proxy right now.
 */
async function getState() {
    const config = await getConfig();
    const { basePort } = config;
    const blocked = await needsPrivateAccess();
    // The toggle cannot be on while Firefox withholds the proxy from us: the
    // user has to grant the access first, then switch it on.
    const proxyEnabled = config.proxyEnabled && !blocked;
    const connected = isConnected();
    const forwardRunning = connected && forward.running && isPort(forward.port);
    return {
        needsPrivateAccess: blocked,
        connected,
        searching,
        notFound: !connected && notFound,
        basePort,
        scanAhead: SCAN_AHEAD,
        companionPort: connected ? companionPort : null,
        engineVersion: connected ? engineVersion : null,
        proxyEnabled: !!proxyEnabled,
        proxyActive: !!proxyEnabled && forwardRunning && !blocked,
        forwardRunning,
        forwardPort: forwardRunning ? forward.port : null,
        forwardHttps: forwardRunning && forward.https,
        forwardError: connected ? forward.error : null,
    };
}

function broadcastState(state) {
    const emit = (s) => {
        chrome.runtime
            .sendMessage({ type: "state", ...s })
            .catch(() => { /* no listeners open — fine */ });
    };
    if (state) emit(state);
    else getState().then(emit).catch(() => { });
}

// ── Proxy management ──────────────────────────────────────────────────────────

function buildPacScript(port, https) {
    // With HTTPS on, the engine's proxy port speaks TLS to the browser (and still takes plain clients).
    const scheme = https ? "HTTPS" : "PROXY";
    return `function FindProxyForURL(url, host) { return "${scheme} ${HOST}:${port}"; }`;
}

/** The `proxy.settings` value that routes HTTP and HTTPS to `port`, over an HTTPS proxy connection if `https`. */
function buildProxyValue(port, https) {
    if (IS_FIREFOX) {
        // Firefox takes no inline PAC script; a manual proxy does the same job.
        const address = `${https ? "https://" : ""}${HOST}:${port}`;
        return { proxyType: "manual", http: address, ssl: address };
    }
    return { mode: "pac_script", pacScript: { data: buildPacScript(port, https) } };
}

/** Firefox has a single scope and does not take the argument. */
const PROXY_SCOPE = IS_FIREFOX ? {} : { scope: "regular" };

/**
 * Flag the toolbar button while the extension cannot do its job, so the user
 * is sent to the popup, which says what to allow.
 */
function showAccessBadge(blocked) {
    if (!IS_FIREFOX) return;
    chrome.action.setBadgeBackgroundColor({ color: "#ca8a04" }).catch(() => { });
    chrome.action.setBadgeText({ text: blocked ? "!" : "" }).catch(() => { });
}

/**
 * Reconcile the browser's proxy settings with the current desired state.
 *
 *   toggle on && forward proxy reachable  ->  proxy pointing at its port
 *   otherwise                             ->  clear proxy settings (direct)
 */
async function applyProxy() {
    const seq = ++proxyApplySeq;
    const state = await getState();

    // A newer call has already started — let it win.
    if (seq !== proxyApplySeq) return state;

    // Reset to null whenever the service worker restarts, which is what we
    // want: Chrome may still hold settings from a previous lifetime, so the
    // first apply must always run.
    const desiredKey = state.proxyActive ? `proxy:${state.forwardHttps ? "https" : "http"}:${state.forwardPort}` : "direct";

    // Keep the synchronous mirror in step before any early return, so the
    // webRequest listener sees the truth even on the skip path.
    proxyRouted = state.proxyActive;
    pushPageState(state);

    showAccessBadge(state.needsPrivateAccess);

    if (state.needsPrivateAccess) {
        // Firefox would reject the call, and without that access nothing of
        // ours can be in place. Apply afresh once the user grants it.
        appliedProxyKey = null;
    } else if (desiredKey !== appliedProxyKey) {
        try {
            if (state.proxyActive) {
                await chrome.proxy.settings.set({
                    value: buildProxyValue(state.forwardPort, state.forwardHttps),
                    ...PROXY_SCOPE,
                });
            } else {
                await chrome.proxy.settings.clear(PROXY_SCOPE);
            }
            appliedProxyKey = desiredKey;
            console.log(`[Bifurc] Proxy ${state.proxyActive ? `ON -> ${HOST}:${state.forwardPort}` : "OFF (direct)"}`);
        } catch (err) {
            console.error("[Bifurc] Failed to apply proxy settings:", err);
        }
    }

    broadcastState(state);
    return state;
}

// ── Finding the companion server ──────────────────────────────────────────────

/** The ports to try, in order: the last one that worked, then upward from the base. */
function candidatePorts(basePort, lastPort) {
    const ports = [];
    if (isPort(lastPort)) ports.push(lastPort);
    for (let offset = 0; offset <= SCAN_AHEAD; offset++) {
        const port = basePort + offset;
        if (port > 65535) break;
        if (port !== lastPort) ports.push(port);
    }
    return ports;
}

/**
 * Whether `port` answers like the engine's WebSocket endpoint. A plain HTTP
 * request to it gets `426 Upgrade Required` with `upgrade: websocket`
 * (`refuse_plain_http` in the engine's `transport/ws.rs`). This is a cheap
 * filter — Chrome deliberately slows down bursts of WebSocket attempts — and
 * the handshake that follows is what confirms it.
 */
async function looksLikeEngine(port) {
    try {
        const response = await fetch(`http://${HOST}:${port}/`, {
            cache: "no-store",
            credentials: "omit",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return response.status === 426 &&
            (response.headers.get("upgrade") || "").toLowerCase() === "websocket";
    } catch {
        return false;
    }
}

/**
 * What the engine is told about this browser, for the app's Settings to list: which browser and version,
 * on which operating system, and which installed extension this is. Every member is optional.
 */
async function describeClient() {
    const info = {
        extensionId: chrome.runtime.id,
        userAgent: navigator.userAgent,
        language: navigator.language,
    };

    // Chromium names its brands (Chrome, Edge, Brave, …); the user agent only says "Chrome".
    const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
    const brand = brands.find((b) => !/not.?a.?brand|chromium/i.test(b.brand)) || brands.find((b) => /chromium/i.test(b.brand));
    if (brand) {
        info.browser = brand.brand;
        info.browserVersion = brand.version;
    } else {
        const match = navigator.userAgent.match(/(Firefox|Edg|OPR|Chrome|Safari)\/([\d.]+)/);
        if (match) {
            info.browser = { Edg: "Edge", OPR: "Opera" }[match[1]] || match[1];
            info.browserVersion = match[2];
        }
    }
    if (IS_FIREFOX) info.browser = "Firefox";

    try {
        const platform = await chrome.runtime.getPlatformInfo();
        info.os = { win: "Windows", mac: "macOS", linux: "Linux", android: "Android", cros: "ChromeOS" }[platform.os] || platform.os;
        info.arch = platform.arch;
    } catch { /* the platform stays unnamed */ }
    return info;
}

/**
 * Open a session on `port`: connect, then `hello`. Resolves true once the
 * engine has accepted the handshake and this socket is the live session.
 */
function openSession(port, token) {
    return new Promise((resolve) => {
        let socket;
        try {
            socket = new WebSocket(`ws://${HOST}:${port}`);
        } catch {
            resolve(false);
            return;
        }

        let settled = false;
        const helloId = `hello-${++rpcSeq}`;
        const fail = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.close(); } catch { /* already closed */ }
            resolve(false);
        };
        const timer = setTimeout(fail, HELLO_TIMEOUT_MS);

        socket.onopen = async () => {
            const clientInfo = await describeClient();
            if (socket.readyState !== WebSocket.OPEN) return;
            socket.send(JSON.stringify({
                id: helloId,
                action: "hello",
                payload: {
                    protocolVersion: PROTOCOL_VERSION,
                    clientName: CLIENT_NAME,
                    clientVersion: chrome.runtime.getManifest().version,
                    clientInfo,
                },
            }));
        };

        socket.onmessage = (event) => {
            let frame;
            try { frame = JSON.parse(event.data); } catch { return; }

            if (settled) {
                if (ws === socket) handleFrame(frame);
                return;
            }
            if (frame.id !== helloId) return;
            if (!frame.ok || token !== discoverSeq || isConnected()) {
                if (!frame.ok) console.warn(`[Bifurc] Port ${port} refused the handshake:`, frame.error);
                fail();
                return;
            }

            settled = true;
            clearTimeout(timer);
            ws = socket;
            companionPort = port;
            engineVersion = (frame.data && frame.data.engineVersion) || null;
            console.log(`[Bifurc] Connected to the desktop app on port ${port}`);
            resolve(true);
        };

        socket.onerror = () => { /* onclose always follows */ };

        socket.onclose = () => {
            if (!settled) {
                fail();
                return;
            }
            if (ws === socket) sessionEnded();
        };
    });
}

async function sessionStarted(port) {
    notFound = false;
    browserCommands = true;
    retryDelay = 1000;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    await setConfig({ lastPort: port });

    rpc("subscribe", { events: EVENTS }).catch(() => { /* status is polled anyway */ });
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshForward, STATUS_POLL_MS);
    await refreshForward();
}

function sessionEnded() {
    ws = null;
    companionPort = null;
    engineVersion = null;
    forward = { running: false, port: 0, https: false, error: null };
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    for (const [id, call] of pending) {
        clearTimeout(call.timer);
        call.reject(new Error("the connection closed"));
        pending.delete(id);
    }
    console.log("[Bifurc] Disconnected from the desktop app");
    // Fall back to direct passthrough at once, even if the toggle is still on.
    applyProxy();
    scheduleRetry();
}

/** Look for the desktop app on the candidate ports and connect to it. */
async function discover() {
    if (isConnected()) return;
    const token = ++discoverSeq;
    searching = true;
    broadcastState();

    const { basePort, lastPort } = await getConfig();
    const ports = candidatePorts(basePort, lastPort);
    let found = null;

    const answers = await Promise.all(ports.map(looksLikeEngine));
    if (token !== discoverSeq) return;
    for (let i = 0; i < ports.length && found === null; i++) {
        if (!answers[i]) continue;
        if (await openSession(ports[i], token)) found = ports[i];
        if (token !== discoverSeq) return;
    }

    searching = false;
    if (found === null) {
        notFound = true;
        scheduleRetry();
        await applyProxy();
        return;
    }
    await sessionStarted(found);
}

function scheduleRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!isConnected() && !searching) discover();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
}

/** Drop the session (if any) and search again. */
function searchAgain() {
    retryDelay = 1000;
    if (ws) {
        const socket = ws;
        sessionEnded();
        try { socket.close(); } catch { /* already closed */ }
    }
    return discover();
}

// ── RPC over the session ──────────────────────────────────────────────────────

function rpc(action, payload, timeoutMs = RPC_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        if (!isConnected()) {
            reject(new Error("not connected"));
            return;
        }
        const id = `ext-${++rpcSeq}`;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`"${action}" timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, action, payload: payload || {} }));
    });
}

function handleFrame(frame) {
    if (typeof frame.event === "string") {
        // Settings, a listener failure, a restart: all can move the forward proxy.
        refreshForward();
        return;
    }
    const call = pending.get(frame.id);
    if (!call) return;
    pending.delete(frame.id);
    clearTimeout(call.timer);
    if (frame.ok) call.resolve(frame.data);
    else {
        const error = new Error((frame.error && frame.error.message) || "the engine refused the request");
        error.code = frame.error && frame.error.code;
        call.reject(error);
    }
}

/** Ask the engine where its forward proxy listens, and whether it is up. */
async function refreshForward() {
    if (!isConnected()) return;
    const socket = ws;
    try {
        const status = await rpc("server.status", {});
        if (ws !== socket) return;
        forward = {
            running: !!status.running,
            port: Number(status.port) || 0,
            https: !!status.https,
            error: typeof status.error === "string" ? status.error : null,
        };
    } catch (err) {
        if (ws !== socket) return;
        // An engine that stopped answering is as good as gone.
        console.warn("[Bifurc] Lost the desktop app:", err.message);
        sessionEnded();
        try { socket.close(); } catch { /* already closed */ }
        return;
    }
    await applyProxy();
}

// ── Message handler (popup and the proxy help page) ───────────────────────────

async function handleMessage(message) {
    switch (message.type) {
        case "get:status":
            return await getState();

        case "proxy:toggle":
            // Never store "on" while Firefox would ignore it: that reads as a
            // working proxy while traffic goes direct.
            await setConfig({ proxyEnabled: !!message.enabled && !(await needsPrivateAccess()) });
            return await applyProxy();

        case "companion:setBasePort":
            if (!isPort(message.port)) return await getState();
            await setConfig({ basePort: message.port, lastPort: null });
            searchAgain();
            return await getState();

        case "companion:retry":
            searchAgain();
            return await getState();
    }
    return undefined;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type === "state") return false;
    handleMessage(message)
        .then((response) => sendResponse(response ?? { ok: false }))
        .catch((err) => {
            console.error("[Bifurc] Message handler error:", err);
            sendResponse({ ok: false, error: String(err) });
        });
    return true; // keep the channel open for the async response
});

// ── Page traffic ──────────────────────────────────────────────────────────────
//
// bridge.js opens a port per frame and passes on inject.js's calls. They are
// checked here and sent to the engine as `browser.*` commands; a port can only
// touch the streams it opened, and what it had open is cancelled when it
// closes (the tab or frame went away).

const PAGE_PORT = "bifurc-page";
const pagePorts = new Set();
let pageOn = false;

/** Whether pages route HTTPS through the engine: proxying, and the engine not decrypting HTTPS itself. */
function pageRouting(state) {
    return state.proxyActive && !state.forwardHttps && browserCommands;
}

function pushPageState(state) {
    const next = pageRouting(state);
    if (next === pageOn) return;
    pageOn = next;
    for (const port of pagePorts) post(port, { t: "state", on: pageOn });
}

/** A port can close between a call and its answer. */
function post(port, message) {
    try {
        port.postMessage(message);
    } catch { /* the frame is gone */ }
}

const text = (value) => (typeof value === "string" ? value : "");

/** An object of strings, whatever the page sent. */
function stringMap(value) {
    const out = {};
    if (value && typeof value === "object") {
        for (const [name, v] of Object.entries(value)) if (typeof v === "string") out[name] = v;
    }
    return out;
}

// ── Cookies for page traffic ──
//
// A page's own request object never shows the cookies the browser would add,
// and a Response built in the page cannot set any. So the engine is given the
// browser's cookies with each request, and what an answer it gave sets is
// stored here.

/** The cookie store of the tab a port belongs to (a private window or a Firefox container has its own). */
function storeOf(sender) {
    const tab = sender && sender.tab;
    if (!tab) return undefined;
    if (tab.cookieStoreId) return tab.cookieStoreId;
    return tab.incognito ? "1" : undefined;
}

/** `wss:` cookies are the `https:` ones. */
function cookieUrl(url) {
    return url.replace(/^ws/i, "http");
}

/** The `Cookie` header the browser would send with this request, if any. */
async function cookieHeader(url, credentials, pageOrigin, storeId) {
    if (credentials === "omit") return null;
    const target = cookieUrl(url);
    if (credentials !== "include" && new URL(target).origin !== pageOrigin) return null;
    const cookies = await chrome.cookies.getAll({ url: target, ...(storeId ? { storeId } : {}) });
    // Longer paths first, as a browser orders them.
    cookies.sort((a, b) => b.path.length - a.path.length);
    return cookies.length ? cookies.map((c) => `${c.name}=${c.value}`).join("; ") : null;
}

/** Where a cookie without a Path attribute applies: the request path up to its last slash. */
function defaultPath(url) {
    const path = new URL(url).pathname;
    const slash = path.lastIndexOf("/");
    return slash > 0 ? path.slice(0, slash) : "/";
}

/** Store one `Set-Cookie` line for `url`. */
function setCookie(line, url, storeId) {
    const [pair, ...attributes] = line.split(";");
    const eq = pair.indexOf("=");
    const target = cookieUrl(url);
    const details = {
        url: target,
        name: eq < 0 ? "" : pair.slice(0, eq).trim(),
        value: (eq < 0 ? pair : pair.slice(eq + 1)).trim(),
        path: defaultPath(target),
        ...(storeId ? { storeId } : {}),
    };
    let maxAge = null;
    for (const attribute of attributes) {
        const at = attribute.indexOf("=");
        const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
        const value = at < 0 ? "" : attribute.slice(at + 1).trim();
        if (key === "domain" && value) details.domain = value;
        else if (key === "path" && value.startsWith("/")) details.path = value;
        else if (key === "expires" && !Number.isNaN(Date.parse(value))) details.expirationDate = Date.parse(value) / 1000;
        else if (key === "max-age" && /^-?\d+$/.test(value)) maxAge = Number(value);
        else if (key === "secure") details.secure = true;
        else if (key === "httponly") details.httpOnly = true;
        else if (key === "samesite") {
            const sameSite = { strict: "strict", lax: "lax", none: "no_restriction" }[value.toLowerCase()];
            if (sameSite) details.sameSite = sameSite;
        }
        // shortcut: a Partitioned (CHIPS) cookie is stored unpartitioned; pass a partitionKey once a rule's
        // target is seen relying on one.
    }
    if (maxAge !== null) details.expirationDate = Date.now() / 1000 + maxAge;
    if (details.expirationDate !== undefined && details.expirationDate <= Date.now() / 1000) {
        return chrome.cookies.remove({ url: target, name: details.name, ...(storeId ? { storeId } : {}) });
    }
    return chrome.cookies.set(details);
}

/** Store what an answer sets, and take `Set-Cookie` out of the headers the page gets (it never sees them). */
async function applySetCookies(decision, url, storeId) {
    if (!Array.isArray(decision.headers)) return;
    const kept = [];
    for (const [name, value] of decision.headers) {
        if (name !== "set-cookie") kept.push([name, value]);
        else await Promise.resolve(setCookie(value, url, storeId)).catch((err) => console.warn("[Bifurc] Cookie not stored:", err));
    }
    decision.headers = kept;
}

// ── Response headers for requests the browser sends itself ──
//
// A page reading a cross-origin answer sees only the CORS-safelisted headers,
// so what the capture shows of an answer comes from here: the browser reports
// every request's response headers, and each report is kept briefly for the
// page's own report of the same request.

const HEADERS_KEPT_MS = 30000;
const answered = new Map(); // "tab method url" -> [{ at, headers }]

chrome.webRequest.onResponseStarted.addListener((details) => {
    if (!pageOn || details.tabId < 0) return;
    const key = `${details.tabId} ${details.method} ${details.url}`;
    const list = answered.get(key) || [];
    list.push({ at: Date.now(), headers: details.responseHeaders || [] });
    answered.set(key, list);
    if (answered.size > 500) {
        const old = Date.now() - HEADERS_KEPT_MS;
        for (const [k, l] of answered) if (l.every((r) => r.at < old)) answered.delete(k);
    }
}, { urls: ["https://*/*"], types: ["xmlhttprequest"] }, IS_FIREFOX ? ["responseHeaders"] : ["responseHeaders", "extraHeaders"]);

/**
 * The browser's own record of an answer's headers, as the engine logs them (set-cookie lines joined with
 * newlines, repeats with commas), waiting briefly in case its report has not arrived yet. `null` when it never
 * comes (an answer from a service worker or a cache the browser does not report).
 */
async function answerHeaders(tabId, method, url) {
    const key = `${tabId} ${method} ${url}`;
    for (let waited = 0; waited <= 300; waited += 25) {
        const list = answered.get(key);
        if (list && list.length) {
            const { headers } = list.shift();
            if (!list.length) answered.delete(key);
            const out = {};
            for (const { name, value } of headers) {
                const lower = name.toLowerCase();
                const v = value ?? "";
                out[lower] = lower in out ? `${out[lower]}${lower === "set-cookie" ? "\n" : ", "}${v}` : v;
            }
            return out;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
}

/** The streams a decision opens: the id the page reads, reports or cancels against. */
function streamOf(decision) {
    return decision && ["relay", "socket", "continue"].includes(decision.action) ? decision.id : null;
}

/** One call from a page, as the engine command it becomes. Throws on a payload that is not one. */
async function pageCall(action, payload, streams, sender) {
    payload = payload && typeof payload === "object" ? payload : {};
    if (action === "decide") {
        const url = text(payload.url);
        if (!/^(https|wss):/i.test(url)) throw new Error("not routed");
        const request = {
            method: text(payload.method) || "GET",
            url,
            headers: stringMap(payload.headers),
            body: text(payload.body),
        };
        const storeId = storeOf(sender);
        const pageOrigin = sender.origin || (sender.url ? new URL(sender.url).origin : "");
        const cookie = await cookieHeader(url, text(payload.credentials), pageOrigin, storeId).catch(() => null);
        if (cookie) request.headers.cookie = cookie;
        const decision = await rpc("browser.decide", request);
        await applySetCookies(decision, url, storeId);
        const id = streamOf(decision);
        if (id) streams.add(id);
        return decision;
    }
    const id = text(payload.id);
    if (!streams.has(id)) throw new Error("no such stream");
    switch (action) {
        case "read": {
            const read = await rpc("browser.read", { id }, READ_TIMEOUT_MS);
            if (read.done) streams.delete(id);
            return read;
        }
        case "open": {
            const open = { id, status: Number.isInteger(payload.status) ? payload.status : 0, headers: stringMap(payload.headers) };
            const tabId = sender.tab && sender.tab.id;
            if (tabId !== undefined && typeof payload.url === "string" && typeof payload.method === "string") {
                open.headers = (await answerHeaders(tabId, payload.method, payload.url)) || open.headers;
            }
            if (payload.kind === "sse" || payload.kind === "ws") open.kind = payload.kind;
            return rpc("browser.open", open);
        }
        case "message": {
            const m = payload.message || {};
            const message = { direction: m.direction === "sent" ? "sent" : "received", data: text(m.data) };
            for (const key of ["event", "eventId"]) if (typeof m[key] === "string") message[key] = m[key];
            if (typeof m.binary === "boolean") message.binary = m.binary;
            if (Number.isInteger(m.close)) message.close = m.close;
            return rpc("browser.message", { id, message });
        }
        case "close":
            streams.delete(id);
            return rpc("browser.close", { id, body: text(payload.body) });
        case "cancel":
            streams.delete(id);
            return rpc("browser.cancel", { id });
        case "wsSend":
            return rpc("browser.wsSend", { id, data: text(payload.data), binary: payload.binary === true });
        case "wsClose": {
            const close = { id, reason: text(payload.reason) };
            if (Number.isInteger(payload.code) && payload.code >= 1000 && payload.code <= 4999) close.code = payload.code;
            return rpc("browser.wsClose", close);
        }
    }
    throw new Error("unknown call");
}

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PAGE_PORT) return;
    const streams = new Set();
    pagePorts.add(port);
    post(port, { t: "state", on: pageOn });
    port.onMessage.addListener((message) => {
        if (!message || typeof message.n !== "number") return;
        pageCall(message.action, message.payload, streams, port.sender || {}).then(
            (data) => post(port, { n: message.n, ok: true, data }),
            (err) => {
                // An engine older than this extension refuses these commands: stop routing pages through it.
                if (err.code === "FORBIDDEN" && message.action === "decide") {
                    browserCommands = false;
                    getState().then(pushPageState);
                }
                post(port, { n: message.n, ok: false, error: String(err.message || err) });
            },
        );
    });
    port.onDisconnect.addListener(() => {
        pagePorts.delete(port);
        for (const id of streams) rpc("browser.cancel", { id }).catch(() => { });
    });
});

// ── Proxy failure handling ────────────────────────────────────────────────────
//
// The forward proxy can die between two status polls. Until the next poll
// notices and falls back to direct, a proxied navigation fails with a bare
// Chrome error page. We catch that here and send the tab to a help page.
//
// Only main_frame navigations can be replaced with HTML — a failed sub-resource
// (XHR, image, script) has nowhere to render a document.

// Chrome documents the `error` string as not stable across releases, so match on
// the distinctive fragments rather than the full "net::" prefix. Firefox reports
// its own `NS_ERROR_PROXY_*` names.
const PROXY_FAILURE_RE =
    /PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|MANDATORY_PROXY_CONFIGURATION_FAILED|NS_ERROR_PROXY_|NS_ERROR_UNKNOWN_PROXY_HOST/i;

// Per-tab cooldown so a burst of failures cannot spam redirects.
const REDIRECT_COOLDOWN_MS = 1500;
const recentRedirects = new Map(); // tabId -> timestamp

const NON_HTTP_SCHEME_RE = /^(chrome|chrome-extension|moz-extension|edge|about|devtools|view-source|data|blob):/i;

function handleRequestError(details) {
    if (details.type !== "main_frame") return;
    // A failure with the proxy switched off is just a normal network error —
    // we must not claim the proxy caused it.
    if (!proxyRouted) return;
    if (!PROXY_FAILURE_RE.test(details.error || "")) return;
    if (details.tabId == null || details.tabId < 0) return;
    if (NON_HTTP_SCHEME_RE.test(details.url || "")) return;

    const now = Date.now();
    // Opportunistic cleanup so the map cannot grow without bound.
    for (const [tabId, at] of recentRedirects) {
        if (now - at > 60000) recentRedirects.delete(tabId);
    }
    if (now - (recentRedirects.get(details.tabId) || 0) < REDIRECT_COOLDOWN_MS) return;
    recentRedirects.set(details.tabId, now);

    // The proxy may be gone for good: find out now rather than at the next poll.
    refreshForward();

    const target = chrome.runtime.getURL(
        "proxy-error.html?url=" + encodeURIComponent(details.url || "")
    );
    chrome.tabs.update(details.tabId, { url: target }).catch((err) => {
        console.error("[Bifurc] Could not open the proxy help page:", err);
    });
}

chrome.webRequest.onErrorOccurred.addListener(handleRequestError, {
    urls: ["<all_urls>"],
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// A toggle switched on before the private-window access was required to do so
// is dropped, so granting the access later does not start routing unasked.
needsPrivateAccess().then((blocked) => {
    if (blocked) setConfig({ proxyEnabled: false });
});

// Nothing is connected yet, so this resolves to "direct"; the proxy is applied
// once the session is up and the engine has reported its forward proxy.
applyProxy();

// Every wake of the service worker looks for the desktop app.
discover();

// Service workers can be killed while idle: the alarm brings one back to look
// for the desktop app again.
chrome.alarms?.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === "keepalive" && !isConnected() && !searching) discover();
});
