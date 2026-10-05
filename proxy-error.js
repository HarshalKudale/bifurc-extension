/**
 * Bifurc Companion — proxy failure help page.
 *
 * Opened by the background worker when a proxied main-frame request fails
 * (see handleRequestError in background.js). Explains the likely cause and
 * offers two ways out: retry, or switch the proxy off.
 *
 * `chrome.*` is absent when this page is opened outside the extension, so every
 * lookup degrades to a static render instead of throwing.
 */

const els = {
    lead: document.getElementById("lead"),
    proxyAddr: document.getElementById("proxyAddr"),
    failedUrl: document.getElementById("failedUrl"),
    connDot: document.getElementById("connDot"),
    connText: document.getElementById("connText"),
    retryBtn: document.getElementById("retryBtn"),
    disableBtn: document.getElementById("disableBtn"),
    status: document.getElementById("status"),
};

const hasChrome = typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;

const failedUrl = (() => {
    try {
        return new URLSearchParams(location.search).get("url") || "";
    } catch {
        return "";
    }
})();

function send(message, callback) {
    if (!hasChrome) return;
    try {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) return;
            if (callback) callback(response);
        });
    } catch {
        /* extension context invalidated */
    }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderState(state) {
    const connected = !!(state && state.connected);

    els.connDot.className = "dot" + (connected ? " success" : "");
    els.connText.textContent = connected ? "Connected" : "Not connected";

    // By the time this page asks, the background worker has usually noticed the
    // dead proxy and already fallen back to direct.
    if (state && state.forwardPort) {
        els.proxyAddr.textContent = `127.0.0.1:${state.forwardPort}`;
    } else {
        els.proxyAddr.textContent = connected ? "Stopped" : "Unknown";
    }

    if (!connected) {
        els.lead.textContent =
            "Bifurc is not running, so its forward proxy is gone. Traffic goes direct until " +
            "Bifurc is open again.";
    } else if (state.proxyActive) {
        els.lead.textContent =
            "The Proxy switch is on, but nothing answered at the forward proxy's port.";
    } else {
        els.lead.textContent =
            "The forward proxy is stopped in Bifurc. Traffic goes direct until it starts.";
    }
}

function setBusy(busy) {
    els.retryBtn.disabled = busy;
    els.disableBtn.disabled = busy;
}

// ── Actions ───────────────────────────────────────────────────────────────────

function goBackToTarget() {
    if (failedUrl) location.replace(failedUrl);
    else history.back();
}

els.retryBtn.addEventListener("click", () => {
    setBusy(true);
    els.status.textContent = "Retrying…";
    goBackToTarget();
});

els.disableBtn.addEventListener("click", () => {
    setBusy(true);
    els.status.textContent = "Turning off the proxy…";

    send({ type: "proxy:toggle", enabled: false }, (state) => {
        if (!state || state.proxyActive) {
            setBusy(false);
            els.status.textContent =
                "Couldn't turn off the proxy. Turn it off from the Bifurc toolbar icon.";
            return;
        }
        els.status.textContent = "Proxy is off. Loading directly…";
        goBackToTarget();
    });
});

// ── Init ──────────────────────────────────────────────────────────────────────

els.failedUrl.textContent = failedUrl || "Unknown";
setBusy(false);

send({ type: "get:status" }, renderState);
