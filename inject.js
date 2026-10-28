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

    /**
     * Fire and forget: what is only reported to the capture. The engine runs calls side by side, so one
     * stream's reports go one after another (an open overtaken by its close would log a failed request).
     */
    const reports = new Map(); // stream id -> its last report
    function tell(action, payload) {
        const id = payload.id;
        const report = (reports.get(id) || Promise.resolve()).then(() => call(action, payload)).catch(() => { });
        reports.set(id, report);
        if (action === "close" || action === "cancel") {
            report.then(() => { if (reports.get(id) === report) reports.delete(id); });
        }
    }

    /** Whether a request to `url` goes through the engine, waiting briefly for the first state. */
    async function routed(url) {
        if (!/^(https|wss):/i.test(url)) return false;
        if (on === null) await known;
        return on;
    }

    // ── Bodies, headers and answers ───────────────────────────────────────────

    /** How much of a body the capture keeps (`MAX_LOGGED_BODY_BYTES` in the engine). */
    const MAX_LOGGED = 512 * 1024;
    const NULL_BODY = new Set([101, 103, 204, 205, 304]);
    const nativeFetch = window.fetch;

    function toBase64(bytes) {
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary);
    }

    function fromBase64(text) {
        const binary = atob(text || "");
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function concat(parts) {
        const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
        let at = 0;
        for (const part of parts) {
            out.set(part, at);
            at += part.length;
        }
        return out;
    }

    function headerObject(headers) {
        const out = {};
        headers.forEach((value, name) => { out[name] = value; });
        return out;
    }

    /** What the browser adds to a request itself, which the page's own request does not show. */
    function withBrowserHeaders(headers, url, referrer, method) {
        const crossOrigin = new URL(url).origin !== location.origin;
        headers["user-agent"] ??= navigator.userAgent;
        headers["accept"] ??= "*/*";
        if (crossOrigin || !["GET", "HEAD"].includes(method)) headers["origin"] ??= location.origin;
        // The default policy (strict-origin-when-cross-origin) sends only the origin across origins.
        if (referrer === "about:client") {
            headers["referer"] ??= crossOrigin ? `${location.origin}/` : location.href.split("#")[0];
        } else if (referrer) {
            headers["referer"] ??= referrer;
        }
        return headers;
    }

    function abortError(signal) {
        return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }

    /** A relayed body, pulled from the engine as the page reads it. */
    function relayBody(id, signal) {
        let controller;
        const abort = () => {
            tell("cancel", { id });
            try { controller.error(abortError(signal)); } catch { /* already closed */ }
        };
        return new ReadableStream({
            start(c) {
                controller = c;
                signal?.addEventListener("abort", abort, { once: true });
            },
            async pull(c) {
                for (;;) {
                    // The engine or the extension went away: a broken body, as the browser reports one.
                    const read = await call("read", { id }).catch(() => ({ chunks: [], done: true, error: true }));
                    for (const chunk of read.chunks) c.enqueue(fromBase64(chunk));
                    if (read.done) {
                        signal?.removeEventListener("abort", abort);
                        if (read.error) c.error(new TypeError("network error"));
                        else c.close();
                        return;
                    }
                    if (read.chunks.length) return;
                }
            },
            cancel() {
                signal?.removeEventListener("abort", abort);
                tell("cancel", { id });
            },
        });
    }

    /** The page's Response for an answer the engine gave. */
    function pageResponse(decision, request, body) {
        const { status } = decision;
        const empty = NULL_BODY.has(status) || request.method === "HEAD";
        if (status < 200 || status > 599 || (empty && decision.action === "relay")) {
            if (decision.action === "relay") tell("cancel", { id: decision.id });
            if (status < 200 || status > 599) throw new TypeError("Failed to fetch");
        }
        const headers = new Headers();
        for (const [name, value] of decision.headers) {
            try { headers.append(name, value); } catch { /* a header a page can never see */ }
        }
        const response = new Response(empty ? null : body, { status, headers });
        Object.defineProperty(response, "url", { value: request.url });
        return response;
    }

    /**
     * Ask the engine about `request`. Resolves to the Response for an answer it gave, or to `{ continueId }`
     * when the browser should send the request itself (`null` when the engine could not be asked).
     */
    async function askEngine(request, signal) {
        const bytes = ["GET", "HEAD"].includes(request.method) ? null : new Uint8Array(await request.arrayBuffer());
        const headers = withBrowserHeaders(headerObject(request.headers), request.url, request.referrer, request.method);
        let decision;
        try {
            decision = await call("decide", {
                method: request.method,
                url: request.url,
                headers,
                body: bytes && bytes.length ? toBase64(bytes) : "",
                credentials: request.credentials,
            });
        } catch {
            return { continueId: null };
        }
        if (signal?.aborted) {
            if (decision.id) tell("cancel", { id: decision.id });
            throw abortError(signal);
        }
        switch (decision.action) {
            case "respond":
                return pageResponse(decision, request, fromBase64(decision.body));
            case "relay":
                return pageResponse(decision, request, relayBody(decision.id, signal));
            case "continue":
                return { continueId: decision.id };
        }
        throw new TypeError("Failed to fetch");
    }

    /** The events of an event stream, fed its bytes as they arrive. `retry` is the last reconnection time it set. */
    function eventParser(onEvent) {
        const decoder = new TextDecoder();
        let buffer = "";
        let data = [];
        let type = "";
        let hasData = false;
        const parser = { lastId: "", retry: null };
        const line = (text) => {
            if (text === "") {
                if (hasData) onEvent({ type: type || "message", data: data.join("\n"), id: parser.lastId });
                data = [];
                type = "";
                hasData = false;
                return;
            }
            if (text[0] === ":") return;
            const colon = text.indexOf(":");
            const field = colon < 0 ? text : text.slice(0, colon);
            let value = colon < 0 ? "" : text.slice(colon + 1);
            if (value[0] === " ") value = value.slice(1);
            if (field === "data") {
                data.push(value);
                hasData = true;
            } else if (field === "event") {
                type = value;
            } else if (field === "id" && !value.includes("\0")) {
                parser.lastId = value;
            } else if (field === "retry" && /^\d+$/.test(value)) {
                parser.retry = Number(value);
            }
        };
        parser.feed = (bytes) => {
            buffer += decoder.decode(bytes, { stream: true });
            let start = 0;
            for (let i = 0; i < buffer.length; i++) {
                const c = buffer[i];
                if (c !== "\n" && c !== "\r") continue;
                // A \r\n can be split across two chunks.
                if (c === "\r" && i + 1 === buffer.length) break;
                line(buffer.slice(start, i));
                if (c === "\r" && buffer[i + 1] === "\n") i++;
                start = i + 1;
            }
            buffer = buffer.slice(start);
        };
        return parser;
    }

    /** Report to the capture what came back for a request the browser sent itself. */
    function mirrorResponse(id, response) {
        const sse = (response.headers.get("content-type") || "").includes("text/event-stream");
        tell("open", { id, status: response.status, headers: headerObject(response.headers), kind: sse ? "sse" : undefined });
        if (!response.body) {
            tell("close", { id, body: "" });
            return;
        }
        mirrorBody(id, response.clone().body, sse);
    }

    async function mirrorBody(id, body, sse) {
        const reader = body.getReader();
        const kept = [];
        let size = 0;
        const events = sse && eventParser((event) => tell("message", {
            id,
            message: { direction: "received", data: event.data, event: event.type, eventId: event.id },
        }));
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (size < MAX_LOGGED) {
                    const part = value.subarray(0, MAX_LOGGED - size);
                    kept.push(part);
                    size += part.length;
                }
                if (events) {
                    events.feed(value);
                } else if (size >= MAX_LOGGED) {
                    reader.cancel();
                    break;
                }
            }
        } catch { /* the page aborted or the connection dropped: what arrived is logged */ }
        tell("close", { id, body: toBase64(concat(kept)) });
    }

    // ── fetch ─────────────────────────────────────────────────────────────────

    async function fetchThroughEngine(request) {
        if (!(await routed(request.url))) return nativeFetch.call(window, request);
        const native = request.clone();
        const answer = await askEngine(request, request.signal);
        if (answer instanceof Response) return answer;
        if (answer.continueId === null) return nativeFetch.call(window, native);
        let response;
        try {
            response = await nativeFetch.call(window, native);
        } catch (error) {
            // No answer: the capture shows the request as failed.
            tell("close", { id: answer.continueId });
            throw error;
        }
        mirrorResponse(answer.continueId, response);
        return response;
    }

    window.fetch = function fetch(input, init) {
        if (on === false) return nativeFetch.apply(this, arguments);
        let request;
        try {
            request = new Request(input, init);
        } catch {
            return nativeFetch.apply(this, arguments);
        }
        // `new Request` took the input's body, so from here on only `request` can be sent.
        if (request.keepalive || request.mode === "no-cors" || !/^https:/i.test(request.url)) {
            return nativeFetch.call(window, request);
        }
        return fetchThroughEngine(request);
    };

    // ── XMLHttpRequest ────────────────────────────────────────────────────────
    //
    // A subclass, so `instanceof` and everything the engine does not answer stay
    // native. While the engine answers, the getters read that answer and the
    // events are dispatched on the object itself. A request the browser sends
    // itself goes out through the native send once the engine said so.

    const NativeXHR = window.XMLHttpRequest;
    const TEXT_TYPES = new Set(["", "text"]);

    function charsetOf(mime) {
        const match = /charset=([^;]+)/i.exec(mime || "");
        try {
            return new TextDecoder(match ? match[1].trim().replace(/"/g, "") : "utf-8");
        } catch {
            return new TextDecoder();
        }
    }

    function headerBlock(text) {
        const out = {};
        for (const line of text.trim().split(/\r?\n/)) {
            const colon = line.indexOf(":");
            if (colon > 0) out[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
        return out;
    }

    class XMLHttpRequest extends NativeXHR {
        #request = null;
        #headers = {};
        #mimeOverride = null;
        /** The engine's answer while it gives one: readyState, status, headers, parts, finished. */
        #answer = null;
        #controller = null;

        open(method, url, async, user, password) {
            super.open(...arguments);
            // Opening again ends the request the engine was still answering.
            if (this.#answer && !this.#answer.finished) {
                this.#answer.finished = true;
                this.#controller.abort();
            }
            this.#request = {
                method: String(method).toUpperCase(),
                url: new URL(url, document.baseURI).href,
                async: arguments.length < 3 || !!async,
                withUser: user != null || password != null,
            };
            this.#headers = {};
            this.#answer = null;
        }

        setRequestHeader(name, value) {
            super.setRequestHeader(name, value);
            const key = String(name).toLowerCase();
            this.#headers[key] = key in this.#headers ? `${this.#headers[key]}, ${value}` : String(value);
        }

        overrideMimeType(mime) {
            super.overrideMimeType(mime);
            this.#mimeOverride = String(mime);
        }

        send(body) {
            const r = this.#request;
            // Synchronous XHR cannot wait for the engine.
            if (on !== true || !r || !r.async || r.withUser || !/^https:/i.test(r.url) || super.readyState !== 1) {
                return super.send(body);
            }
            this.#takeOver(body ?? null);
        }

        abort() {
            const a = this.#answer;
            if (!a || a.finished) return super.abort();
            this.#controller.abort();
            this.#finish("abort");
            a.readyState = 0;
        }

        async #takeOver(body) {
            const r = this.#request;
            const a = (this.#answer = { readyState: 1, status: 0, headers: [], parts: [], finished: false, text: null });
            const init = { method: r.method, headers: this.#headers, credentials: this.withCredentials ? "include" : "same-origin" };
            if (body !== null && !["GET", "HEAD"].includes(r.method)) {
                init.body = body instanceof Document ? new XMLSerializer().serializeToString(body) : body;
            }
            let request;
            try {
                request = new Request(r.url, init);
            } catch {
                this.#answer = null;
                return super.send(body);
            }
            const controller = (this.#controller = new AbortController());
            if (this.timeout > 0) {
                a.timer = setTimeout(() => {
                    controller.abort();
                    this.#finish("timeout");
                }, this.timeout);
            }
            let answer;
            try {
                answer = await askEngine(request, controller.signal);
            } catch {
                if (this.#answer === a) this.#finish("error");
                return;
            }
            if (a.finished) return;
            if (!(answer instanceof Response)) {
                clearTimeout(a.timer);
                this.#answer = null;
                if (answer.continueId) this.#mirror(answer.continueId);
                return super.send(body);
            }
            await this.#deliver(answer, init.body !== undefined);
        }

        async #deliver(response, uploaded) {
            const a = this.#answer;
            this.#progress(this, "loadstart", 0, 0);
            if (uploaded) for (const type of ["loadstart", "progress", "load", "loadend"]) this.#progress(this.upload, type, 0, 0);
            a.status = response.status;
            a.headers = [...response.headers];
            this.#setState(2);
            const total = Number(response.headers.get("content-length")) || 0;
            let loaded = 0;
            try {
                const reader = response.body?.getReader();
                while (reader) {
                    const { value, done } = await reader.read();
                    if (a.finished) return;
                    if (done) break;
                    a.parts.push(value);
                    a.text = null;
                    loaded += value.length;
                    this.#setState(3);
                    this.#progress(this, "progress", loaded, total);
                }
            } catch {
                if (this.#answer === a) this.#finish("error");
                return;
            }
            this.#finish("load", loaded, total);
        }

        #setState(state) {
            this.#answer.readyState = state;
            this.dispatchEvent(new Event("readystatechange"));
        }

        #progress(target, type, loaded, total) {
            target.dispatchEvent(new ProgressEvent(type, { lengthComputable: total > 0, loaded, total }));
        }

        /** The end of an answer the engine gave: `load`, or `error` / `abort` / `timeout` with no response. */
        #finish(type, loaded = 0, total = 0) {
            const a = this.#answer;
            if (!a || a.finished) return;
            a.finished = true;
            clearTimeout(a.timer);
            if (type !== "load") Object.assign(a, { status: 0, headers: [], parts: [], text: null });
            this.#setState(4);
            this.#progress(this, type, loaded, total);
            this.#progress(this, "loadend", loaded, total);
        }

        #mime() {
            const a = this.#answer;
            return this.#mimeOverride || (a.headers.find(([name]) => name === "content-type") || [])[1] || "";
        }

        #text() {
            const a = this.#answer;
            a.text ??= charsetOf(this.#mime()).decode(concat(a.parts));
            return a.text;
        }

        get readyState() { return this.#answer ? this.#answer.readyState : super.readyState; }
        get status() { return this.#answer ? this.#answer.status : super.status; }
        get statusText() { return this.#answer ? "" : super.statusText; }

        get responseURL() {
            if (!this.#answer) return super.responseURL;
            return this.#answer.readyState >= 2 && this.#answer.status ? this.#request.url : "";
        }

        getResponseHeader(name) {
            const a = this.#answer;
            if (!a) return super.getResponseHeader(name);
            const wanted = String(name).toLowerCase();
            const values = a.readyState < 2 ? [] : a.headers.filter(([n]) => n === wanted).map(([, v]) => v);
            return values.length ? values.join(", ") : null;
        }

        getAllResponseHeaders() {
            const a = this.#answer;
            if (!a) return super.getAllResponseHeaders();
            return a.readyState < 2 ? "" : a.headers.map(([name, value]) => `${name}: ${value}\r\n`).join("");
        }

        get responseText() {
            if (!this.#answer) return super.responseText;
            if (!TEXT_TYPES.has(this.responseType)) {
                throw new DOMException("responseText is only for a text responseType", "InvalidStateError");
            }
            return this.#answer.readyState >= 3 ? this.#text() : "";
        }

        get response() {
            const a = this.#answer;
            if (!a) return super.response;
            const type = this.responseType;
            if (TEXT_TYPES.has(type)) return a.readyState >= 3 ? this.#text() : "";
            if (a.readyState !== 4 || a.status === 0) return null;
            switch (type) {
                case "json":
                    try { return JSON.parse(this.#text()); } catch { return null; }
                case "arraybuffer":
                    return concat(a.parts).buffer;
                case "blob":
                    return new Blob(a.parts, { type: this.#mime() });
                case "document":
                    return this.#document();
            }
            return null;
        }

        get responseXML() {
            const a = this.#answer;
            if (!a) return super.responseXML;
            if (!["", "document"].includes(this.responseType)) {
                throw new DOMException("responseXML is only for a document responseType", "InvalidStateError");
            }
            return a.readyState === 4 && a.status ? this.#document() : null;
        }

        #document() {
            const mime = this.#mime();
            const kind = /html/i.test(mime) ? "text/html" : /xml/i.test(mime) ? "application/xml" : null;
            return kind ? new DOMParser().parseFromString(this.#text(), kind) : null;
        }

        /** Report to the capture what came back for a request the native send made. */
        #mirror(id) {
            let opened = false;
            const open = () => {
                if (opened || super.readyState < 2) return;
                opened = true;
                tell("open", { id, status: super.status, headers: headerBlock(super.getAllResponseHeaders()) });
            };
            this.addEventListener("readystatechange", open);
            this.addEventListener("loadend", async () => {
                this.removeEventListener("readystatechange", open);
                if (super.status === 0) {
                    tell("close", { id });
                    return;
                }
                open();
                let bytes = new Uint8Array(0);
                try {
                    const type = super.responseType;
                    if (TEXT_TYPES.has(type)) bytes = new TextEncoder().encode(super.responseText);
                    else if (type === "json") bytes = new TextEncoder().encode(JSON.stringify(super.response));
                    else if (type === "arraybuffer") bytes = new Uint8Array(super.response);
                    else if (type === "blob") bytes = new Uint8Array(await super.response.arrayBuffer());
                } catch { /* the body stays out of the capture */ }
                tell("close", { id, body: toBase64(bytes.subarray(0, MAX_LOGGED)) });
            }, { once: true });
        }
    }

    window.XMLHttpRequest = XMLHttpRequest;

    // ── EventSource and WebSocket ─────────────────────────────────────────────
    //
    // Stand-ins: the engine has to be asked before anything is opened, which a
    // native object cannot wait for. Where the page is not routed, the
    // constructor returns the native object itself. Either way `instanceof`
    // holds for both kinds.

    /** `on<type>` properties that behave as event handler attributes do. */
    function handlerProperties(proto, types) {
        for (const type of types) {
            const handler = Symbol(type);
            const listening = Symbol(`${type} listening`);
            Object.defineProperty(proto, `on${type}`, {
                configurable: true,
                enumerable: true,
                get() { return this[handler] ?? null; },
                set(fn) {
                    if (!this[listening]) {
                        this[listening] = true;
                        this.addEventListener(type, (event) => this[handler]?.call(this, event));
                    }
                    this[handler] = typeof fn === "function" ? fn : null;
                },
            });
        }
    }

    function keepInstanceof(Patched, Native) {
        Object.setPrototypeOf(Patched.prototype, Native.prototype);
        Object.defineProperty(Patched, Symbol.hasInstance, { value: (value) => value instanceof Native });
    }

    const NativeEventSource = window.EventSource;

    class EventSource extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 2;
        #url;
        #withCredentials;
        #readyState = 0;
        #controller = null;
        #lastId = "";
        #retry = 3000;

        constructor(url, init) {
            let href = null;
            try { href = new URL(url, document.baseURI).href; } catch { /* the native constructor says why */ }
            if (arguments.length === 0 || on !== true || !href || !/^https:/i.test(href)) {
                return new NativeEventSource(...arguments);
            }
            super();
            this.#url = href;
            this.#withCredentials = !!(init && init.withCredentials);
            this.#connect();
        }

        get url() { return this.#url; }
        get withCredentials() { return this.#withCredentials; }
        get readyState() { return this.#readyState; }

        close() {
            this.#readyState = 2;
            this.#controller?.abort();
        }

        async #connect() {
            const controller = (this.#controller = new AbortController());
            const headers = { accept: "text/event-stream", "cache-control": "no-cache" };
            if (this.#lastId) headers["last-event-id"] = this.#lastId;
            let response;
            try {
                response = await fetchThroughEngine(new Request(this.#url, {
                    headers,
                    cache: "no-store",
                    credentials: this.#withCredentials ? "include" : "same-origin",
                    signal: controller.signal,
                }));
            } catch {
                this.#reconnect();
                return;
            }
            if (this.#readyState === 2) return;
            const type = (response.headers.get("content-type") || "").toLowerCase();
            if (response.status !== 200 || !type.startsWith("text/event-stream")) {
                // Not an event stream: the connection fails for good.
                response.body?.cancel();
                this.#readyState = 2;
                this.dispatchEvent(new Event("error"));
                return;
            }
            this.#readyState = 1;
            this.dispatchEvent(new Event("open"));
            const origin = new URL(this.#url).origin;
            const parser = eventParser((event) => {
                this.#lastId = event.id;
                if (this.#readyState === 1) {
                    this.dispatchEvent(new MessageEvent(event.type, { data: event.data, lastEventId: event.id, origin }));
                }
            });
            parser.lastId = this.#lastId;
            try {
                const reader = response.body.getReader();
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    parser.feed(value);
                    if (parser.retry !== null) this.#retry = parser.retry;
                }
            } catch { /* closed by the page, or the connection dropped */ }
            this.#reconnect();
        }

        /** The stream ended: try again after the retry time, unless the page closed it (also from onerror). */
        #reconnect() {
            if (this.#readyState === 2) return;
            this.#readyState = 0;
            this.dispatchEvent(new Event("error"));
            if (this.#readyState === 2) return;
            setTimeout(() => { if (this.#readyState === 0) this.#connect(); }, this.#retry);
        }
    }
    handlerProperties(EventSource.prototype, ["open", "message", "error"]);
    keepInstanceof(EventSource, NativeEventSource);
    window.EventSource = EventSource;

    const NativeWebSocket = window.WebSocket;
    const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

    function byteSize(data) {
        if (typeof data === "string") return new TextEncoder().encode(data).length;
        return data instanceof Blob ? data.size : data.byteLength;
    }

    /** A WebSocket message as the engine takes it: text as is, anything else as base64. */
    async function frameOf(data, direction, cap = Infinity) {
        if (typeof data === "string") return { direction, data };
        let bytes;
        if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
        else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        else bytes = new Uint8Array(data);
        return { direction, data: toBase64(bytes.subarray(0, cap)), binary: true };
    }

    class WebSocket extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        #url;
        #protocol = "";
        #extensions = "";
        #binaryType = "blob";
        #readyState = 0;
        #buffered = 0;
        /** The engine's relay, when a rule claimed the socket. */
        #id = null;
        /** The browser's own socket, when nothing did; `#mirrorId` reports it to the capture. */
        #native = null;
        #mirrorId = null;
        #sending = Promise.resolve();
        #closeAsked = false;

        constructor(url, protocols) {
            let target = null;
            try {
                target = new URL(url, document.baseURI);
                if (target.protocol === "https:") target.protocol = "wss:";
            } catch { /* the native constructor says why */ }
            const list = protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : [...protocols];
            const valid = list.every((p) => TOKEN.test(p)) && new Set(list).size === list.length;
            if (arguments.length === 0 || on !== true || !target || target.protocol !== "wss:" || target.hash || !valid) {
                return new NativeWebSocket(...arguments);
            }
            super();
            this.#url = target.href;
            this.#connect(list);
        }

        get url() { return this.#url; }
        get readyState() { return this.#readyState; }
        get protocol() { return this.#protocol; }
        get extensions() { return this.#extensions; }
        get bufferedAmount() { return this.#native ? this.#native.bufferedAmount : this.#buffered; }
        get binaryType() { return this.#binaryType; }
        set binaryType(value) {
            if (value === "blob" || value === "arraybuffer") this.#binaryType = value;
        }

        async #connect(protocols) {
            const headers = { "user-agent": navigator.userAgent, origin: location.origin };
            if (protocols.length) headers["sec-websocket-protocol"] = protocols.join(", ");
            let decision = null;
            try {
                decision = await call("decide", { method: "GET", url: this.#url, headers, body: "", credentials: "include" });
            } catch { /* the browser opens it */ }
            if (this.#closeAsked) {
                if (decision?.id) tell("cancel", { id: decision.id });
                this.#fail();
                return;
            }
            if (!decision || decision.action === "continue") {
                this.#openNative(protocols, decision?.id ?? null);
                return;
            }
            if (decision.action !== "socket") {
                // The target refused the upgrade, or a fault dropped it.
                this.#fail();
                return;
            }
            this.#id = decision.id;
            this.#protocol = (decision.headers.find(([name]) => name === "sec-websocket-protocol") || [])[1] || "";
            this.#readyState = 1;
            this.dispatchEvent(new Event("open"));
            this.#pump();
        }

        #openNative(protocols, mirrorId) {
            let socket;
            try {
                socket = new NativeWebSocket(this.#url, protocols);
            } catch {
                if (mirrorId) tell("close", { id: mirrorId });
                this.#fail();
                return;
            }
            socket.binaryType = "arraybuffer";
            this.#native = socket;
            this.#mirrorId = mirrorId;
            socket.addEventListener("open", () => {
                this.#protocol = socket.protocol;
                this.#extensions = socket.extensions;
                this.#readyState = 1;
                if (mirrorId) tell("open", { id: mirrorId, status: 101, headers: {}, kind: "ws" });
                this.dispatchEvent(new Event("open"));
            });
            socket.addEventListener("message", (event) => {
                const data = typeof event.data === "string" ? event.data : new Uint8Array(event.data);
                if (mirrorId) frameOf(data, "received", MAX_LOGGED).then((message) => tell("message", { id: mirrorId, message }));
                this.#deliver(data, event.origin);
            });
            socket.addEventListener("error", () => this.dispatchEvent(new Event("error")));
            socket.addEventListener("close", (event) => {
                if (mirrorId) {
                    tell("message", { id: mirrorId, message: { direction: "received", data: event.reason, close: event.code } });
                    tell("close", { id: mirrorId });
                }
                this.#closed(event.code, event.reason, event.wasClean);
            });
        }

        /** Frames from the rule's target, until the relay ends. */
        async #pump() {
            const origin = new URL(this.#url).origin;
            let closing = null;
            let broken = false;
            try {
                for (;;) {
                    const read = await call("read", { id: this.#id });
                    for (const frame of read.frames) {
                        if (frame.close !== undefined) closing = frame;
                        else this.#deliver(frame.binary ? fromBase64(frame.data) : frame.data, origin);
                    }
                    if (read.done) {
                        broken = !!read.error;
                        break;
                    }
                }
            } catch {
                broken = true;
            }
            if (!closing) this.dispatchEvent(new Event("error"));
            this.#closed(closing ? closing.close : 1006, closing ? closing.data : "", !!closing && !broken);
        }

        #deliver(data, origin) {
            const payload = typeof data === "string"
                ? data
                : this.#binaryType === "arraybuffer" ? data.slice().buffer : new Blob([data]);
            this.dispatchEvent(new MessageEvent("message", { data: payload, origin }));
        }

        send(data) {
            if (this.#readyState === 0) {
                throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", "InvalidStateError");
            }
            const size = byteSize(data);
            if (this.#readyState !== 1) {
                this.#buffered += size;
                return;
            }
            if (this.#native) {
                this.#native.send(data);
                const id = this.#mirrorId;
                if (id) frameOf(data, "sent", MAX_LOGGED).then((message) => tell("message", { id, message }));
                return;
            }
            this.#buffered += size;
            const id = this.#id;
            // In order, whatever a Blob takes to read.
            this.#sending = this.#sending.then(async () => {
                const frame = await frameOf(data, "sent");
                await call("wsSend", { id, data: frame.data, binary: !!frame.binary }).catch(() => { });
                this.#buffered -= size;
            });
        }

        close(code, reason) {
            if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999)) {
                throw new DOMException(`Failed to execute 'close' on 'WebSocket': The code must be 1000 or between 3000 and 4999. ${code} is neither.`, "InvalidAccessError");
            }
            if (reason !== undefined && new TextEncoder().encode(String(reason)).length > 123) {
                throw new DOMException("Failed to execute 'close' on 'WebSocket': The close reason must not be greater than 123 UTF-8 bytes.", "SyntaxError");
            }
            if (this.#readyState >= 2) return;
            if (this.#native) {
                this.#readyState = 2;
                this.#native.close(...arguments);
                return;
            }
            if (this.#readyState === 0) {
                // Still asking the engine: the connection fails once it answers.
                this.#readyState = 2;
                this.#closeAsked = true;
                return;
            }
            this.#readyState = 2;
            const id = this.#id;
            const payload = { id, reason: reason === undefined ? "" : String(reason) };
            if (code !== undefined) payload.code = code;
            this.#sending = this.#sending.then(() => call("wsClose", payload).catch(() => { }));
        }

        #fail() {
            this.#readyState = 3;
            this.dispatchEvent(new Event("error"));
            this.#closed(1006, "", false);
        }

        #closed(code, reason, wasClean) {
            this.#readyState = 3;
            this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean }));
        }
    }
    handlerProperties(WebSocket.prototype, ["open", "message", "error", "close"]);
    keepInstanceof(WebSocket, NativeWebSocket);
    window.WebSocket = WebSocket;
})();
