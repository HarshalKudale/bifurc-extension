/**
 * Bifurc Companion — page patch (content script, the page's own world)
 *
 * With the proxy toggle on and the engine not intercepting HTTPS itself, the
 * browser's HTTPS traffic would pass the engine by inside a TLS tunnel. This
 * script catches a page's fetch, XMLHttpRequest, EventSource and WebSocket
 * calls before the browser encrypts them, and asks the engine what to do
 * (`browser.decide`):
 *
 *   respond   the engine answered (a mock): the page gets that answer
 *   relay     the engine is fetching it (a proxy rule): the body streams in
 *   socket    the engine opened the WebSocket (a proxy rule)
 *   continue  nothing claimed it: the browser sends it as it would have, and
 *             what comes back is reported to the engine for its capture
 *   fail      the engine dropped it (a fault): the page sees a network error
 *
 * The engine decides everything; this script only carries requests and
 * answers. Plain `http:`/`ws:` is not touched: it already goes through the
 * proxy. Synchronous XHR, keepalive and no-cors requests are left alone too.
 */

(() => {
    // ── The channel to the extension (bridge.js) ──────────────────────────────

    /** Whether to route HTTPS through the engine: `null` until the extension says. */
    let on = null;
    let onKnown = null;
    const known = new Promise((resolve) => { onKnown = resolve; });
    // An extension that never answers leaves the page native.
    setTimeout(() => { if (on === null) setOn(false); }, 300);

    function setOn(value) {
        on = !!value;
        onKnown();
    }

    let seq = 0;
    const waiting = new Map(); // n -> { resolve, reject }
    let port = null;
    let handedOver = false;

    function receive({ data }) {
        if (!data) return;
        if (data.t === "state") {
            handedOver = true;
            setOn(data.on);
        } else if (data.t === "reset") {
            on = false;
            for (const call of waiting.values()) call.reject(new TypeError("the Bifurc extension restarted"));
            waiting.clear();
        } else if (waiting.has(data.n)) {
            const call = waiting.get(data.n);
            waiting.delete(data.n);
            if (data.ok) call.resolve(data.data);
            else call.reject(new Error(data.error || "the engine refused the request"));
        }
    }

    /**
     * Give bridge.js a channel. Content scripts of one document run in manifest order, bridge.js first, but
     * if it missed the first channel it says so ("bridge-ready") and gets a new one; it keeps the latest.
     */
    function handOver() {
        if (handedOver) return;
        const channel = new MessageChannel();
        channel.port1.onmessage = receive;
        port = channel.port1;
        window.postMessage({ bifurc: "companion-port" }, "*", [channel.port2]);
    }
    window.addEventListener("message", (event) => {
        if (event.data && event.data.bifurc === "bridge-ready") handOver();
    });
    handOver();

    /** One call to the engine through the extension. */
    function call(action, payload) {
        return new Promise((resolve, reject) => {
            const n = ++seq;
            waiting.set(n, { resolve, reject });
            port.postMessage({ n, action, payload });
        });
    }

    /** Fire and forget: what is only reported to the capture. */
    function tell(action, payload) {
        call(action, payload).catch(() => { });
    }

    /** Whether a request to `url` goes through the engine, waiting briefly for the first state. */
    async function routed(url) {
        if (!/^(https|wss):/i.test(url)) return false;
        if (on === null) await known;
        return on;
    }
})();
