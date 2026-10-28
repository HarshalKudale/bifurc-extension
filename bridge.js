/**
 * Bifurc Companion — page bridge (content script, isolated world)
 *
 * inject.js runs in the page's own world, where it can patch fetch, XHR,
 * EventSource and WebSocket but cannot reach the extension. This script can.
 * inject.js hands it one end of a MessageChannel; every call it makes over
 * that channel is passed to the background worker on a runtime port (one per
 * frame, so a closed tab or frame cancels what it had open), and every answer
 * and state change comes back the same way.
 *
 * Only `{ n, action, payload }` calls with a known action are passed on: the
 * page could find the channel too, and the background checks every payload.
 */

(() => {
    const PORT_NAME = "bifurc-page";
    const ACTIONS = new Set(["decide", "read", "open", "message", "close", "cancel", "wsSend", "wsClose"]);

    let page = null; // the MessagePort to inject.js
    let background = null;
    let lastState = null;

    function connect() {
        try {
            background = chrome.runtime.connect({ name: PORT_NAME });
        } catch {
            // The extension was reloaded or removed: this page keeps its native behaviour.
            background = null;
            page.postMessage({ t: "state", on: false });
            return;
        }
        background.onMessage.addListener((message) => {
            if (message.t === "state") lastState = message;
            page.postMessage(message);
        });
        const openedAt = Date.now();
        background.onDisconnect.addListener(() => {
            // The worker restarted (or went away): what was in flight is lost, and the state is asked again,
            // at once after a restart, slowly if the port keeps closing as soon as it opens.
            background = null;
            page.postMessage({ t: "reset" });
            setTimeout(() => { if (!background) connect(); }, Date.now() - openedAt < 1000 ? 5000 : 0);
        });
    }

    window.addEventListener("message", (event) => {
        const data = event.data;
        if (!data || data.bifurc !== "companion-port" || !event.ports || !event.ports[0]) return;
        // inject.js hands over a new channel only when it thinks this one was missed: the latest is the live one.
        const first = !page;
        page = event.ports[0];
        page.onmessage = ({ data: call }) => {
            if (!call || typeof call.n !== "number" || !ACTIONS.has(call.action)) return;
            if (!background) connect();
            background?.postMessage({ n: call.n, action: call.action, payload: call.payload });
        };
        if (first) connect();
        else if (lastState) page.postMessage(lastState);
    });

    // inject.js may have run first and posted its port before this listener existed: ask it again.
    window.postMessage({ bifurc: "bridge-ready" }, "*");
})();
