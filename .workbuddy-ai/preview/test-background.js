/**
 * Behavioural tests for the Bifurc background service worker.
 *
 * Loads background.js in a VM with stubbed chrome.* / WebSocket and drives the
 * two rules that matter:
 *
 *   1. proxy engaged  <=>  toggle ON  AND  companion server connected
 *   2. a proxied main-frame failure shows the help page, but only when we were
 *      actually routing through the proxy
 *
 * Run:  node test-background.js
 */

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const code = fs.readFileSync(path.resolve(__dirname, "..", "..", "background.js"), "utf8");

// ── Stubs ─────────────────────────────────────────────────────────────────────

const proxyCalls = [];        // ordered log of every proxy mutation
const redirects = [];         // ordered log of every tab redirect
const messageListeners = [];
const errorListeners = [];

let stored = { proxyEnabled: true, proxyPort: 80, companionPort: 9271 };

// Controllable clock so the redirect cooldown can be exercised.
let now = 1_700_000_000_000;
const FakeDate = { now: () => now };

// Controllable timers so the reconnect backoff can be forced to fire.
let pendingTimers = [];
const fakeSetTimeout = (fn, ms) => { const t = { fn, ms, cancelled: false }; pendingTimers.push(t); return t; };
const fakeClearTimeout = (t) => { if (t) t.cancelled = true; };
function runTimers() {
    const due = pendingTimers.filter((t) => !t.cancelled);
    pendingTimers = pendingTimers.filter((t) => !t.cancelled);
    due.forEach((t) => t.fn());
}

const chrome = {
    storage: {
        local: {
            get: async (defaults) => Object.assign({}, defaults, stored),
            set: async (patch) => { Object.assign(stored, patch); },
        },
    },
    proxy: {
        settings: {
            set: async (arg) => {
                proxyCalls.push({ op: "set", port: arg.value.pacScript.data.match(/:(\d+)/)[1] });
            },
            clear: async () => { proxyCalls.push({ op: "clear" }); },
        },
    },
    tabs: {
        update: async (tabId, props) => { redirects.push({ tabId, url: props.url }); return {}; },
    },
    runtime: {
        id: "bifurctestextensionid",
        getURL: (p) => "chrome-extension://bifurctestextensionid/" + p,
        onMessage: { addListener: (fn) => messageListeners.push(fn) },
        onInstalled: { addListener: () => { } },
        sendMessage: () => Promise.resolve(),
    },
    webRequest: {
        onErrorOccurred: { addListener: (fn) => errorListeners.push(fn) },
    },
    contextMenus: { removeAll: () => { }, create: () => { }, onClicked: { addListener: () => { } } },
    alarms: { create: () => { }, onAlarm: { addListener: () => { } } },
};

let liveSocket = null;

class FakeWebSocket {
    constructor(url) {
        this.url = url;
        this.readyState = 0; // CONNECTING
        liveSocket = this;
    }
    send() { }
    close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        setTimeout(() => this.onclose && this.onclose({}), 0); // real timer
    }
}
FakeWebSocket.CONNECTING = 0;
FakeWebSocket.OPEN = 1;
FakeWebSocket.CLOSING = 2;
FakeWebSocket.CLOSED = 3;

// ── Load ──────────────────────────────────────────────────────────────────────

vm.runInNewContext(code, {
    chrome,
    WebSocket: FakeWebSocket,
    console: { log: () => { }, warn: () => { }, error: () => { } },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    Date: FakeDate,
    Math, JSON, URL,
});

const tick = () => new Promise((r) => setTimeout(r, 5)); // real timer
const send = (msg) => new Promise((res) => messageListeners[0](msg, null, res));

async function serverUp() {
    if (!liveSocket || liveSocket.readyState === 3) {
        runTimers();
        await tick();
    }
    liveSocket.readyState = 1;
    liveSocket.onopen({});
    await tick();
}

async function serverDown() {
    liveSocket.readyState = 3;
    liveSocket.onclose({});
    await tick();
}

/** Fire a webRequest.onErrorOccurred event. */
function requestFailed(overrides) {
    errorListeners[0](Object.assign({
        type: "main_frame",
        url: "https://example.com/page",
        error: "net::ERR_PROXY_CONNECTION_FAILED",
        tabId: 1,
        frameId: 0,
    }, overrides));
}

// ── Assertions ────────────────────────────────────────────────────────────────

let failures = 0;
function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(name) { console.log(`\n── ${name} ──`); }

/** Effective proxy state = the last mutation Chrome received. */
const effective = () => (proxyCalls.length ? proxyCalls[proxyCalls.length - 1].op : "unset");

// ── Part 1: proxy gating ──────────────────────────────────────────────────────

(async () => {
    section("proxy gating");

    await tick();
    check("startup, toggle on + offline -> direct passthrough", effective(), "clear");

    await serverUp();
    check("toggle on + connected -> proxy engaged on stored port",
        proxyCalls[proxyCalls.length - 1], { op: "set", port: "80" });

    await serverDown();
    check("toggle on + server drops -> direct passthrough", effective(), "clear");

    let before = proxyCalls.length;
    const off = await send({ type: "proxy:toggle", enabled: false });
    check("toggle off while offline -> still direct", effective(), "clear");
    check("toggle off while offline -> no redundant API call", proxyCalls.length, before);
    check("toggle off -> state reports inactive", [off.proxyEnabled, off.proxyActive], [false, false]);

    before = proxyCalls.length;
    const onOffline = await send({ type: "proxy:toggle", enabled: true });
    check("toggle on while offline -> proxy stays bypassed", effective(), "clear");
    check("toggle on while offline -> no API call", proxyCalls.length, before);
    check("toggle on while offline -> state reports inactive",
        [onOffline.proxyEnabled, onOffline.proxyActive], [true, false]);

    await serverUp();
    check("reconnect with toggle on -> proxy engages",
        proxyCalls[proxyCalls.length - 1], { op: "set", port: "80" });

    await send({ type: "proxy:setPort", port: 8080 });
    check("port change while active -> re-applies with new port",
        proxyCalls[proxyCalls.length - 1], { op: "set", port: "8080" });

    await serverDown();
    before = proxyCalls.length;
    await send({ type: "proxy:setPort", port: 9090 });
    check("port change while offline -> no proxy mutation", proxyCalls.length, before);
    check("port change while offline -> still direct", effective(), "clear");

    const st = await send({ type: "get:status" });
    check("get:status is self-consistent",
        [st.proxyEnabled, st.connected, st.proxyActive], [true, false, false]);
    check("get:status reflects the new port", st.proxyPort, 9090);

    await serverUp();
    const staleSocket = liveSocket;
    await send({ type: "companion:setPort", port: 9272 });
    await tick();
    check("port change replaces the socket", liveSocket !== staleSocket, true);
    check("new socket targets the new port", liveSocket.url, "ws://127.0.0.1:9272");
    staleSocket.readyState = 3;
    staleSocket.onclose({});
    await tick();
    check("stale socket close does not fall back to direct", effective(), "set");

    // ── Part 2: proxy failure handling ────────────────────────────────────────

    section("proxy failure handling (proxy ACTIVE, connected)");

    await serverUp();
    redirects.length = 0;

    requestFailed({ tabId: 5, url: "https://example.com/a?b=1&c=2" });
    check("proxied main-frame failure -> one redirect", redirects.length, 1);
    check("redirect targets the help page for the failed URL",
        redirects[0],
        {
            tabId: 5,
            url: "chrome-extension://bifurctestextensionid/proxy-error.html?url=" +
                encodeURIComponent("https://example.com/a?b=1&c=2"),
        });

    requestFailed({ tabId: 5 });
    check("same tab again immediately -> suppressed by cooldown", redirects.length, 1);

    requestFailed({ tabId: 6 });
    check("different tab -> redirected (cooldown is per-tab)", redirects.length, 2);

    now += 2000;
    requestFailed({ tabId: 5 });
    check("same tab after cooldown -> redirected again", redirects.length, 3);

    requestFailed({ tabId: 7, type: "xmlhttprequest" });
    check("sub-resource failure -> no redirect", redirects.length, 3);

    requestFailed({ tabId: 8, error: "net::ERR_NAME_NOT_RESOLVED" });
    check("non-proxy error -> no redirect", redirects.length, 3);

    requestFailed({ tabId: 9, error: "net::ERR_TUNNEL_CONNECTION_FAILED" });
    check("tunnel failure -> redirected", redirects.length, 4);

    requestFailed({ tabId: 10, url: "chrome-extension://abc/other.html" });
    check("chrome-extension:// failure -> no redirect", redirects.length, 4);

    requestFailed({ tabId: -1 });
    check("no-tab request (background fetch) -> no redirect", redirects.length, 4);

    section("proxy failure handling (proxy OFF)");

    redirects.length = 0;
    await send({ type: "proxy:toggle", enabled: false });
    requestFailed({ tabId: 12 });
    check("proxy off -> failure is left alone", redirects.length, 0);

    // Disconnected but toggle back on: still not routed, so still no redirect.
    await send({ type: "proxy:toggle", enabled: true });
    await serverDown();
    requestFailed({ tabId: 13 });
    check("toggle on but disconnected -> failure is left alone", redirects.length, 0);

    // Reconnected -> routing resumes and failures are explained again.
    await serverUp();
    requestFailed({ tabId: 14 });
    check("routing restored -> failure explained again", redirects.length, 1);

    console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}`);
    process.exit(failures === 0 ? 0 : 1);
})();
