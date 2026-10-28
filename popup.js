/**
 * Bifurc Companion — Popup Script
 *
 * A thin view over the background worker's resolved state. `proxyActive`
 * (toggle on, desktop app connected, its forward proxy running) is the only
 * value that means traffic is really being routed; everything else is direct.
 *
 * The companion port is only offered while the desktop app has not been found:
 * once connected there is nothing to configure, and the forward proxy's port
 * always comes from the engine.
 */

const els = {
    connDot: document.getElementById("connDot"),
    connText: document.getElementById("connText"),
    proxyToggle: document.getElementById("proxyToggle"),
    proxyText: document.getElementById("proxyText"),
    access: document.getElementById("access"),
    find: document.getElementById("find"),
    findText: document.getElementById("findText"),
    findForm: document.getElementById("findForm"),
    basePort: document.getElementById("basePort"),
    portDown: document.getElementById("portDown"),
    portUp: document.getElementById("portUp"),
    retryBtn: document.getElementById("retryBtn"),
};

// Mirrors background state so render() can stay synchronous.
let state = {
    connected: false,
    searching: true,
    notFound: false,
    basePort: 4747,
    scanAhead: 10,
    proxyEnabled: false,
    proxyActive: false,
    forwardRunning: false,
    forwardPort: null,
    needsPrivateAccess: false,
};

// The base port last written into the field, so a re-render does not undo an
// edit the user has not submitted yet.
let shownBasePort = null;

// ── Messaging ─────────────────────────────────────────────────────────────────

function send(message, callback) {
    try {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) return;
            if (callback) callback(response);
        });
    } catch {
        /* extension context invalidated — nothing useful to do */
    }
}

function applyState(next) {
    if (!next || typeof next.connected !== "boolean") return;
    state = { ...state, ...next };
    render();
}

function refresh() {
    send({ type: "get:status" }, applyState);
}

// ── Render ────────────────────────────────────────────────────────────────────

function proxyDescription() {
    if (state.needsPrivateAccess) return "Unavailable. Browser traffic goes direct.";
    if (state.proxyActive) return `Browser traffic goes through 127.0.0.1:${state.forwardPort}.`;
    if (!state.proxyEnabled) return "Browser traffic goes direct.";
    if (!state.connected) return "Waiting for Bifurc. Traffic goes direct until it connects.";
    return "The forward proxy is stopped in Bifurc. Traffic goes direct until it starts.";
}

function render() {
    els.connDot.className = "dot" + (state.connected ? " success" : "");
    els.connText.textContent = state.connected
        ? "Connected"
        : state.notFound ? "Not connected" : "Searching…";

    // The toggle reflects the stored choice; the text says what it results in.
    // It cannot be switched on until Firefox lets the extension set the proxy.
    els.proxyToggle.checked = state.proxyEnabled && !state.needsPrivateAccess;
    els.proxyToggle.disabled = state.needsPrivateAccess;
    els.proxyText.textContent = proxyDescription();
    els.access.hidden = !state.needsPrivateAccess;

    // The port is only a way out when the search has failed.
    els.find.hidden = state.connected || !state.notFound;
    const last = Math.min(state.basePort + state.scanAhead, 65535);
    els.findText.textContent =
        `Nothing answered on ports ${state.basePort}–${last}. Open Bifurc, or enter the ` +
        "companion port from its Settings → Ports.";
    if (state.basePort !== shownBasePort) {
        els.basePort.value = state.basePort;
        shownBasePort = state.basePort;
    }
    els.retryBtn.disabled = state.searching;
    els.retryBtn.textContent = state.searching ? "Searching…" : "Search again";
}

// ── Event handlers ────────────────────────────────────────────────────────────

els.proxyToggle.addEventListener("change", () => {
    if (state.needsPrivateAccess) {
        render();
        return;
    }
    state.proxyEnabled = els.proxyToggle.checked;
    state.proxyActive = state.proxyEnabled && state.forwardRunning && !state.needsPrivateAccess;
    render(); // optimistic — avoids a visible lag on the switch
    send({ type: "proxy:toggle", enabled: state.proxyEnabled }, applyState);
});

function stepPort(delta) {
    const current = parseInt(els.basePort.value, 10);
    const port = Number.isInteger(current) ? current + delta : state.basePort;
    els.basePort.value = Math.min(Math.max(port, 1), 65535);
}

els.portDown.addEventListener("click", () => stepPort(-1));
els.portUp.addEventListener("click", () => stepPort(1));

els.findForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const port = parseInt(els.basePort.value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    state.searching = true;
    render();
    els.basePort.blur();
    send(
        port === state.basePort
            ? { type: "companion:retry" }
            : { type: "companion:setBasePort", port },
        applyState,
    );
});

// ── Live updates ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "state") applyState(message);
});

// Light poll so the popup stays correct if the service worker restarted while
// the popup was open and missed a broadcast.
const pollTimer = setInterval(refresh, 3000);
window.addEventListener("unload", () => clearInterval(pollTimer));

// ── Review ────────────────────────────────────────────────────────────────────

// Each store's own review page; Firefox is told apart by its extension URL scheme.
const isFirefox = chrome.runtime.getURL("").startsWith("moz-extension:");
document.getElementById("reviewLink").href = isFirefox
    ? "https://addons.mozilla.org/en-US/firefox/addon/bifurc-companion/reviews/"
    : "https://chromewebstore.google.com/detail/bifurc-companion/dcifgipphabedoiemccjpocgiganpjhi/reviews";

// ── Init ──────────────────────────────────────────────────────────────────────

render();
refresh();
