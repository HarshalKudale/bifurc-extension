/**
 * Generates standalone, interactive previews of the Bifurc UI.
 *
 * The real pages depend on chrome.runtime / chrome.storage, so this stitches the
 * shipped HTML + JS together with a mock chrome API:
 *
 *   popup-preview.html        - the toolbar popup, with a control bar that
 *                               simulates the companion server going up/down
 *   proxy-error-preview.html  - the proxy failure page in its "connected" state
 *
 * Run:  node build-preview.js
 */

const fs = require("fs");
const path = require("path");

const extDir = path.resolve(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(extDir, f), "utf8");
const write = (f, s) => {
    fs.writeFileSync(path.join(__dirname, f), s, "utf8");
    console.log("Wrote " + f);
};

// ── 1. Popup preview ──────────────────────────────────────────────────────────

const html = read("popup.html");
const js = read("popup.js");

// ── Mock chrome API ───────────────────────────────────────────────────────────

const mock = `
<script>
(function () {
    const state = {
        connected: true,
        proxyEnabled: false,
        proxyActive: false,
        proxyPort: 80,
        companionPort: 9271,
    };
    const listeners = [];

    function recompute() {
        state.proxyActive = state.proxyEnabled && state.connected;
    }
    function snapshot() {
        return {
            connected: state.connected,
            proxyEnabled: state.proxyEnabled,
            proxyActive: state.proxyActive,
            proxyPort: state.proxyPort,
            companionPort: state.companionPort,
        };
    }
    function broadcast() {
        const msg = Object.assign({ type: "companion:status", status: state.connected ? "connected" : "disconnected" }, snapshot());
        listeners.forEach(function (fn) { try { fn(msg); } catch (e) { } });
    }

    window.__sim = {
        state: state,
        recompute: recompute,
        broadcast: broadcast,
        setConnected: function (v) { state.connected = v; recompute(); broadcast(); },
    };

    window.chrome = {
        runtime: {
            lastError: null,
            sendMessage: function (msg, cb) {
                setTimeout(function () {
                    switch (msg.type) {
                        case "get:status":
                            cb(snapshot()); return;
                        case "proxy:toggle":
                            state.proxyEnabled = msg.enabled; recompute(); broadcast(); cb(snapshot()); return;
                        case "proxy:setPort":
                            state.proxyPort = msg.port; recompute(); broadcast(); cb(snapshot()); return;
                        case "companion:setPort":
                            state.companionPort = msg.port; recompute(); broadcast(); cb(snapshot()); return;
                        case "companion:reconnect":
                            recompute(); broadcast(); cb(snapshot()); return;
                        default:
                            cb({ ok: true });
                    }
                }, 60);
            },
            onMessage: {
                addListener: function (fn) { listeners.push(fn); },
            },
        },
    };
})();
<\/script>
`;

// ── Preview-only chrome ───────────────────────────────────────────────────────

const previewCss = `
<style>
    html {
        background: #0e0e0e;
        min-height: 100vh;
        display: flex;
        justify-content: center;
        align-items: flex-start;
        padding: 28px 0 96px;
    }

    body {
        border: 1px solid #333;
        border-radius: 14px;
        box-shadow: 0 20px 55px rgba(0, 0, 0, .65);
    }

    #simbar {
        position: fixed;
        bottom: 18px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        border-radius: 999px;
        background: #202020;
        border: 1px solid #3a3a3a;
        box-shadow: 0 10px 30px rgba(0, 0, 0, .55);
        font: 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        color: #8f8f8f;
        white-space: nowrap;
    }

    #simbar b {
        color: #e0e0e0;
        font-weight: 600;
    }

    #simbar button {
        height: 24px;
        padding: 0 11px;
        border-radius: 999px;
        border: 1px solid #3a3a3a;
        background: transparent;
        color: #c8c8c8;
        font: 11px/1 inherit;
        cursor: pointer;
        transition: .15s;
    }

    #simbar button:hover {
        border-color: #6e6e6e;
        color: #fff;
    }

    #simbar button[aria-pressed="true"] {
        border-color: rgba(74, 222, 128, .45);
        background: rgba(74, 222, 128, .13);
        color: #4ade80;
    }
</style>
`;

const simbar = `
<div id="simbar">
    <span>Preview &mdash; simulate companion server:</span>
    <button id="simUp" aria-pressed="true">Connected</button>
    <button id="simDown" aria-pressed="false">Offline</button>
</div>
<script>
    (function () {
        var up = document.getElementById("simUp");
        var down = document.getElementById("simDown");
        function set(v) {
            window.__sim.setConnected(v);
            up.setAttribute("aria-pressed", String(v));
            down.setAttribute("aria-pressed", String(!v));
        }
        up.addEventListener("click", function () { set(true); });
        down.addEventListener("click", function () { set(false); });
    })();
<\/script>
`;

// ── Stitch ────────────────────────────────────────────────────────────────────

write("popup-preview.html", html
    .replace("</head>", previewCss + "</head>")
    .replace('src="icons/icon48.png"', 'src="../../icons/icon48.png"')
    .replace(
        '<script src="popup.js"></script>',
        mock + "<script>" + js + "<\/script>" + simbar
    ));

// ── 2. Proxy error page preview ───────────────────────────────────────────────
//
// proxy-error.js reads the failed URL from location.search. A preview opened as
// a plain file has no query string, so we substitute a sample one here.

const errorHtml = read("proxy-error.html");
const errorJs = read("proxy-error.js");

const SAMPLE_QUERY = "?url=" + encodeURIComponent("https://api.example.com/v2/orders?page=3");

const errorMock = `
<script>
window.chrome = {
    runtime: {
        id: "bifurcpreview",
        lastError: null,
        getURL: function (p) { return p; },
        sendMessage: function (msg, cb) {
            setTimeout(function () {
                if (msg.type === "get:status") {
                    cb({ connected: true, proxyEnabled: true, proxyActive: true, proxyPort: 80, companionPort: 9271 });
                } else if (msg.type === "proxy:toggle") {
                    cb({ connected: true, proxyEnabled: false, proxyActive: false, proxyPort: 80, companionPort: 9271 });
                } else {
                    cb({ ok: true });
                }
            }, 60);
        },
        onMessage: { addListener: function () { } },
    },
};
<\/script>
`;

write("proxy-error-preview.html", errorHtml
    .replace(
        '<script src="proxy-error.js"></script>',
        errorMock + "<script>" + errorJs.replace("location.search", JSON.stringify(SAMPLE_QUERY)) + "<\/script>"
    ));
