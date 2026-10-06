/**
 * Bifurc Companion — Background Service Worker
 * (Chrome runs it as a service worker, Firefox as an event page.)
 *
 * The extension is a proxy switch for the Bifurc desktop app:
 * 1. It finds the app's companion server (a WebSocket on loopback) and opens
 *    an RPC session with it.
 * 2. It asks the engine which port its forward proxy listens on.
 * 3. The toggle routes browser traffic to that port, or leaves it direct.
 *
 * Finding the companion server: the app binds the first free port at or above
 * a base port (9271 unless changed in the app's Settings → Ports). So the
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
const DEFAULT_BASE_PORT = 9271;
/** How many ports above the base are tried before giving up. */
const SCAN_AHEAD = 10;
/** `PROTOCOL_VERSION` in `protocol-rust/src/version.rs`. */
const PROTOCOL_VERSION = "1.0.0";
/** One of the engine's `CLIENT_NAMES`. */
const CLIENT_NAME = "bifurc-extension";

const PROBE_TIMEOUT_MS = 800;
const HELLO_TIMEOUT_MS = 3000;
const RPC_TIMEOUT_MS = 5000;
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
let forward = { running: false, port: 0, error: null };

let searching = false;      // a search is in flight
let notFound = false;       // the last search finished without finding the app
let discoverSeq = 0;        // a newer search supersedes an older one
let retryTimer = null;
let retryDelay = 1000;
let pollTimer = null;

let rpcSeq = 0;
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
    const { proxyEnabled, basePort } = await getConfig();
    const blocked = await needsPrivateAccess();
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

function buildPacScript(port) {
    return `function FindProxyForURL(url, host) { return "PROXY ${HOST}:${port}"; }`;
}

/** The `proxy.settings` value that routes HTTP and HTTPS to `port`. */
function buildProxyValue(port) {
    if (IS_FIREFOX) {
        // Firefox takes no inline PAC script; a manual proxy does the same job.
        const address = `${HOST}:${port}`;
        return { proxyType: "manual", http: address, ssl: address };
    }
    return { mode: "pac_script", pacScript: { data: buildPacScript(port) } };
}

/** Firefox has a single scope and does not take the argument. */
const PROXY_SCOPE = IS_FIREFOX ? {} : { scope: "regular" };

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
    const desiredKey = state.proxyActive ? `proxy:${state.forwardPort}` : "direct";

    // Keep the synchronous mirror in step before any early return, so the
    // webRequest listener sees the truth even on the skip path.
    proxyRouted = state.proxyActive;

    if (state.needsPrivateAccess) {
        // Firefox would reject the call, and without that access nothing of
        // ours can be in place. Apply afresh once the user grants it.
        appliedProxyKey = null;
    } else if (desiredKey !== appliedProxyKey) {
        try {
            if (state.proxyActive) {
                await chrome.proxy.settings.set({
                    value: buildProxyValue(state.forwardPort),
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
    forward = { running: false, port: 0, error: null };
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

function rpc(action, payload) {
    return new Promise((resolve, reject) => {
        if (!isConnected()) {
            reject(new Error("not connected"));
            return;
        }
        const id = `ext-${++rpcSeq}`;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`"${action}" timed out`));
        }, RPC_TIMEOUT_MS);
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
    else call.reject(new Error((frame.error && frame.error.message) || "the engine refused the request"));
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
            await setConfig({ proxyEnabled: !!message.enabled });
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
