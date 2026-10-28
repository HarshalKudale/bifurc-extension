/**
 * End-to-end check of HTTPS routing through the extension (mocks, proxy rules, cookies, capture of fetch / XHR /
 * EventSource / WebSocket) without the engine's certificate: a scratch engine with its own data directory and
 * ports, an HTTPS test site, a plain-HTTP rule target, and a Chromium browser with this extension unpacked.
 *
 *   cd scripts/e2e && npm install && node run.mjs
 *
 * BIFURC_BIN  the directory holding bifurc-engine and bifurc (default ../Bifurc/target/debug beside this repo)
 * BROWSER     a Chromium-based browser (default Playwright's Chromium; Edge works too)
 * SKIP        checks to leave out, comma-separated by name
 * HEADFUL=1   show the browser    VERBOSE=1  page console and engine log
 *
 * Needs `openssl` on the PATH for the test site's certificate. Prints one line per check; exits 1 if any failed.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import https from "node:https";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { chromium } from "playwright-core";

const EXT = join(import.meta.dirname, "../..");
const BIFURC = process.env.BIFURC_BIN || join(EXT, "../Bifurc/target/debug");
const EXE = process.platform === "win32" ? ".exe" : "";
const CHROME = process.env.BROWSER || playwrightChromium();

/** The newest Chromium Playwright has downloaded (`npx playwright install chromium`). */
function playwrightChromium() {
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === "win32"
        ? join(process.env.LOCALAPPDATA, "ms-playwright")
        : join(process.env.HOME, process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright"));
    const builds = existsSync(root) ? readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort() : [];
    if (!builds.length) throw new Error(`no Chromium under ${root}: set BROWSER or run npx playwright install chromium`);
    const dir = join(root, builds.at(-1));
    const exe = readdirSync(dir).map((d) => join(dir, d, process.platform === "win32" ? "chrome.exe" : "chrome")).find(existsSync);
    return exe || join(dir, "chrome-mac/Chromium.app/Contents/MacOS/Chromium");
}
const PORTS = { edge: 18080, forward: 18888, companion: 15747, mail: 11025, site: 18443, target: 18500 };
const SKIP = new Set((process.env.SKIP || "").split(",").filter(Boolean));

// ── Servers ──
const certDir = mkdtempSync(join(tmpdir(), "bifurc-e2e-cert-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certDir, "key.pem"),
    "-out", join(certDir, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
    { stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const tls = { key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) };
const site = https.createServer(tls, (req, res) => {
    if (req.url === "/") return res.end("<!doctype html><title>site</title><p>site");
    if (req.url === "/data") return res.end(JSON.stringify({ from: "site" }));
    // A script a site loads with fetch, with and without the .js a URL usually tells it by.
    if (req.url === "/app.js" || req.url === "/bundle") {
        res.writeHead(200, { "content-type": "application/javascript" });
        return res.end("console.log(1)");
    }
    // Readable from another origin, with a header the page is not allowed to see.
    if (req.url === "/cors") {
        res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "application/json", "x-hidden": "seen" });
        return res.end("{}");
    }
    if (req.url === "/upload") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => res.end(`got:${body}`));
        return;
    }
    if (req.url === "/sse") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        let n = 0;
        const timer = setInterval(() => {
            n++;
            res.write(`id: ${n}\nevent: ${n === 2 ? "tick" : "message"}\ndata: ${JSON.stringify({ n })}\n\n`);
            if (n === 3) clearInterval(timer);
        }, 50);
        req.on("close", () => clearInterval(timer));
        return;
    }
    res.writeHead(404).end();
});
new WebSocketServer({ server: site, path: "/ws" }).on("connection", (ws) =>
    ws.on("message", (data, binary) => ws.send(binary ? data : `echo:${data}`)));

const target = http.createServer((req, res) => {
    if (req.url === "/api/hello") return res.end(`local:${req.headers.host}`);
    if (req.url === "/login") {
        res.setHeader("set-cookie", ["sid=abc123; Path=/; Secure; HttpOnly; SameSite=None", "theme=dark; Path=/"]);
        return res.end("logged in");
    }
    if (req.url === "/me") return res.end(`cookie:${req.headers.cookie || ""}`);
    if (req.url === "/slow") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first;");
        const timer = setInterval(() => res.write("."), 200);
        req.on("close", () => clearInterval(timer));
        return;
    }
    if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/plain" });
        let n = 0;
        const timer = setInterval(() => {
            res.write(`part${++n};`);
            if (n === 3) {
                clearInterval(timer);
                res.end();
            }
        }, 100);
        return;
    }
    res.writeHead(404).end();
});
new WebSocketServer({ server: target, path: "/ws" }).on("connection", (ws, req) =>
    ws.on("message", (data) => ws.send(`TARGET(${req.headers.host}):${String(data).toUpperCase()}`)));

await new Promise((r) => site.listen(PORTS.site, "127.0.0.1", r));
await new Promise((r) => target.listen(PORTS.target, "127.0.0.1", r));

// ── Engine ──
const data = mkdtempSync(join(tmpdir(), "bifurc-e2e-"));
writeFileSync(join(data, "app.json"), JSON.stringify({
    hasSeenWelcome: true, port: PORTS.edge, forwardProxyPort: PORTS.forward, companionPort: PORTS.companion,
    mailPort: PORTS.mail,
}));
const env = { ...process.env, BIFURC_TELEMETRY: "0", DO_NOT_TRACK: "1" };
const engine = spawn(join(BIFURC, `bifurc-engine${EXE}`), ["--data-dir", data, "--no-tray", "--edge-port", String(PORTS.edge)], { env, stdio: ["ignore", "pipe", "pipe"] });
let engineLog = "";
engine.stdout.on("data", (c) => (engineLog += c));
engine.stderr.on("data", (c) => (engineLog += c));
const cli = (...args) => execFileSync(join(BIFURC, `bifurc${EXE}`), ["--data-dir", data, "--no-start", ...args], { env, encoding: "utf8" });
for (let i = 0; ; i++) {
    try { cli("status"); break; } catch (e) { if (i > 60) throw new Error(`engine did not answer: ${e.stderr || e.message}\n${engineLog}`); }
    await new Promise((r) => setTimeout(r, 500));
}
cli("workspaces", "create", "e2e");
cli("mocks", "create", "https://api.test/users", "--status", "200", "-d", '{"id":1}', "-H", "content-type: application/json");
cli("rules", "create", "^https://prod\\.test/", "--regex", "--target", `http://127.0.0.1:${PORTS.target}`);
// The CLI stores --target as the URL it was given; the engine reads a target as host:port.
const rules = JSON.parse(cli("rules", "list", "--json"));
const ruleId = (Array.isArray(rules) ? rules : rules.rules || rules.items)[0].id;
cli("rules", "patch", ruleId, "--data", JSON.stringify({ targetExternal: `127.0.0.1:${PORTS.target}` }));

// ── Browser ──
const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "bifurc-e2e-profile-")), {
    executablePath: CHROME,
    headless: process.env.HEADFUL ? false : true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--ignore-certificate-errors"],
    ignoreHTTPSErrors: true,
});
const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
await worker.evaluate(async (port) => {
    await chrome.storage.local.set({ proxyEnabled: true, basePort: port, lastPort: null });
    searchAgain();
}, PORTS.companion);
for (let i = 0; ; i++) {
    const state = await worker.evaluate(() => getState());
    if (state.proxyActive) break;
    if (i > 40) throw new Error(`extension never connected: ${JSON.stringify(state)}\n${engineLog}`);
    await new Promise((r) => setTimeout(r, 250));
}

const page = await context.newPage();
page.on("console", (m) => { if (process.env.VERBOSE) console.log("page:", m.text()); });
await page.goto(`https://127.0.0.1:${PORTS.site}/`);

const results = [];
async function check(name, fn) {
    if (SKIP.has(name)) return;
    try {
        const detail = await fn();
        results.push([true, name, detail]);
    } catch (e) {
        results.push([false, name, String(e && e.message || e).split("\n")[0]]);
    }
}
const inPage = (fn, arg) => page.evaluate(fn, arg);
const expect = (got, want) => { if (got !== want) throw new Error(`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); return got; };
const captured = (pred) => {
    const list = JSON.parse(cli("capture", "list", "--json"));
    const entries = Array.isArray(list) ? list : list.entries || list.items || [];
    return entries.find(pred);
};
async function waitCapture(pred, what) {
    for (let i = 0; i < 40; i++) {
        const hit = captured(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`not captured: ${what}`);
}

await check("fetch mock", async () => expect(await inPage(() => fetch("https://api.test/users").then((r) => r.text())), '{"id":1}'));
await check("fetch mock headers/url", async () => {
    const r = await inPage(() => fetch("https://api.test/users").then((r) => [r.status, r.headers.get("content-type"), r.url]));
    return expect(JSON.stringify(r), JSON.stringify([200, "application/json", "https://api.test/users"]));
});
await check("xhr mock json", async () => expect(await inPage(() => new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    const states = [];
    x.onreadystatechange = () => states.push(x.readyState);
    x.open("GET", "https://api.test/users");
    x.responseType = "json";
    x.onload = () => resolve(`${x.status} ${x.response.id} ${states.join("")} ${x.getResponseHeader("Content-Type")}`);
    x.onerror = () => reject(new Error("xhr error"));
    x.send();
})), "200 1 1234 application/json"));
await check("fetch rule (Host kept)", async () => expect(await inPage(() => fetch("https://prod.test/api/hello").then((r) => r.text())), "local:prod.test"));
await check("rule streamed body", async () => expect(await inPage(async () => {
    const r = await fetch("https://prod.test/stream");
    const reader = r.body.getReader();
    let text = "", reads = 0;
    for (;;) { const { value, done } = await reader.read(); if (done) break; reads++; text += new TextDecoder().decode(value); }
    return text;
}), "part1;part2;part3;"));
await check("rule login cookie", async () => {
    const text = await inPage(async () => {
        await fetch("https://prod.test/login", { credentials: "include" });
        return fetch("https://prod.test/me", { credentials: "include" }).then((r) => r.text());
    });
    if (!text.includes("sid=abc123") || !text.includes("theme=dark")) throw new Error(text);
    const stored = await worker.evaluate(() => chrome.cookies.getAll({ url: "https://prod.test/" }));
    return `${text}; stored ${stored.map((c) => `${c.name}${c.httpOnly ? "(httpOnly)" : ""}`).join(",")}`;
});
await check("credentials omit sends no cookie", async () => expect(await inPage(() => fetch("https://prod.test/me", { credentials: "omit" }).then((r) => r.text())), "cookie:"));
await check("fetch passthrough + capture", async () => {
    expect(await inPage(() => fetch("/data").then((r) => r.text())), '{"from":"site"}');
    const hit = await waitCapture((e) => e.url === `https://127.0.0.1:${PORTS.site}/data` && e.status === 200, "/data");
    return `captured via=${hit.via} status=${hit.status}`;
});
await check("fetch POST passthrough body", async () => {
    expect(await inPage(() => fetch("/upload", { method: "POST", body: "hello" }).then((r) => r.text())), "got:hello");
    const hit = await waitCapture((e) => e.url.endsWith("/upload"), "/upload");
    return `captured status=${hit.status}`;
});
await check("site scripts stay out of capture", async () => {
    const got = await inPage(() => Promise.all(["/app.js", "/bundle"].map((u) => fetch(u).then((r) => r.text()))));
    expect(got.join("|"), "console.log(1)|console.log(1)");
    await new Promise((r) => setTimeout(r, 1000));
    const hit = captured((e) => e.url.endsWith("/app.js") || e.url.endsWith("/bundle"));
    if (hit) throw new Error(`captured ${hit.url}`);
    return "neither captured";
});
await check("cross-origin answer keeps its hidden headers", async () => {
    const seen = await inPage(() => fetch(`https://localhost:${location.port}/cors`).then((r) => r.headers.get("x-hidden")));
    expect(seen, null);
    const hit = await waitCapture((e) => e.url.endsWith("/cors") && e.status === 200, "/cors");
    const shown = JSON.parse(cli("capture", "show", hit.id, "--headers", "--json"));
    const headers = shown.headers || {};
    if (!headers["x-hidden"]) throw new Error(`no x-hidden in ${JSON.stringify(shown).slice(0, 600)}`);
    return expect(headers["x-hidden"], "seen") + " (hidden from the page, shown in capture)";
});
await check("xhr passthrough", async () => expect(await inPage(() => new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open("GET", "/data");
    x.onload = () => resolve(x.responseText);
    x.send();
})), '{"from":"site"}'));
await check("eventsource passthrough", async () => {
    const got = await inPage(() => new Promise((resolve, reject) => {
        const es = new EventSource("/sse");
        const seen = [];
        es.onmessage = (e) => seen.push(`m${JSON.parse(e.data).n}#${e.lastEventId}`);
        es.addEventListener("tick", (e) => seen.push(`t${JSON.parse(e.data).n}`));
        setTimeout(() => { es.close(); resolve(`${seen.join(",")} instanceof=${es instanceof EventSource}`); }, 800);
    }));
    expect(got, "m1#1,t2,m3#3 instanceof=true");
    const hit = await waitCapture((e) => e.url.endsWith("/sse"), "/sse");
    return `captured kind=${hit.kind}`;
});
await check("websocket passthrough", async () => {
    const got = await inPage((port) => new Promise((resolve) => {
        const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`);
        ws.onopen = () => ws.send("hi");
        ws.onmessage = (e) => { ws.close(); resolve(`${e.data} ${ws instanceof WebSocket}`); };
        ws.onerror = () => resolve("error");
    }), PORTS.site);
    expect(got, "echo:hi true");
    const hit = await waitCapture((e) => e.url.includes("/ws") && e.kind === "ws", "passthrough ws");
    return `captured kind=${hit.kind}`;
});
await check("websocket rule relay", async () => expect(await inPage(() => new Promise((resolve) => {
    const ws = new WebSocket("wss://prod.test/ws");
    ws.onopen = () => ws.send("hello");
    ws.onmessage = (e) => { ws.close(1000, "bye"); resolve(e.data); };
    ws.onerror = () => resolve("error");
})), "TARGET(prod.test):HELLO"));
await check("websocket binary relay", async () => expect(await inPage(() => new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${location.port}/ws`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => ws.send(new Uint8Array([1, 2, 3]));
    ws.onmessage = (e) => { ws.close(); resolve(Array.from(new Uint8Array(e.data)).join(",")); };
    ws.onerror = () => resolve("error");
})), "1,2,3"));
await check("abort a mocked fetch", async () => expect(await inPage(async () => {
    const c = new AbortController();
    const p = fetch("https://api.test/users", { signal: c.signal });
    c.abort();
    try { await p; return "resolved"; } catch (e) { return e.name; }
}), "AbortError"));
await check("capture → mock and request", async () => {
    const entry = await waitCapture((e) => e.url === `https://127.0.0.1:${PORTS.site}/data` && e.status === 200, "/data");
    const savedRequest = cli("capture", "request", entry.id);
    const savedMock = cli("capture", "mock", entry.id, "--json");
    const mock = JSON.parse(savedMock);
    const mockId = mock.id || mock.entity?.id || mock.mock?.id;
    cli("mocks", "update", mockId, "-d", '{"from":"mock"}');
    // A capture becomes a merge mock (the real headers, this body); the test site's self-signed certificate
    // keeps the engine from fetching it to merge with, so this one stands alone.
    cli("mocks", "patch", mockId, "--data", JSON.stringify({ standalone: true }));
    if (process.env.VERBOSE) console.log("mock:", cli("mocks", "show", mockId, "--json"));
    // The mock made from a passthrough capture now answers the same call in the page.
    return expect(await inPage(() => fetch("/data").then((r) => r.text())), '{"from":"mock"}') + ` (request: ${savedRequest.trim()})`;
});
await check("plain http page via PAC", async () => {
    cli("mocks", "create", "http://plain.test/hello", "--status", "200", "-d", "plain mocked", "-H", "content-type: text/plain");
    const page3 = await context.newPage();
    await page3.goto("http://plain.test/hello");
    const text = await page3.evaluate(() => document.body.innerText);
    await page3.close();
    return expect(text.trim(), "plain mocked");
});
await check("engine intercepting HTTPS → extension stays out", async () => {
    // Stands in for TLS interception on with the CA loaded: the background sees `https` from server.status.
    await worker.evaluate(async () => { forward.https = true; await applyProxy(); });
    const page4 = await context.newPage();
    await page4.goto(`https://127.0.0.1:${PORTS.site}/`, { waitUntil: "commit" }).catch(() => {});
    const got = await page4.evaluate(() => new Promise((r) => setTimeout(r, 400)).then(() =>
        fetch("https://api.test/users").then(() => "answered by the engine", (e) => e.name))).catch((e) => `page: ${e.message}`);
    await page4.close();
    await worker.evaluate(async () => { forward.https = false; await applyProxy(); });
    return expect(got, "TypeError");
});
await check("app quits mid-stream → network error", async () => {
    const reading = inPage(async () => {
        const r = await fetch("https://prod.test/slow");
        const reader = r.body.getReader();
        await reader.read();
        window.__firstChunk = true;
        try { for (;;) { const { done } = await reader.read(); if (done) return "ended cleanly"; } }
        catch (e) { return `errored: ${e.name}`; }
    });
    for (let i = 0; i < 40 && !(await inPage(() => window.__firstChunk === true)); i++) await new Promise((r) => setTimeout(r, 100));
    engine.kill();
    const got = await reading;
    if (!got.startsWith("errored")) throw new Error(got);
    for (let i = 0; i < 40; i++) {
        const state = await worker.evaluate(() => getState());
        if (!state.proxyActive) return `${got}; extension fell back to direct`;
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("extension still routing after the engine quit");
});
await check("toggle off = native", async () => {
    await worker.evaluate(async () => { await chrome.storage.local.set({ proxyEnabled: false }); await applyProxy(); });
    const page2 = await context.newPage();
    await page2.goto(`https://127.0.0.1:${PORTS.site}/`);
    const got = await page2.evaluate(() => fetch("https://api.test/users").then(() => "answered", (e) => e.name));
    const native = await page2.evaluate(() => window.fetch.toString().includes("[native code]"));
    await page2.close();
    return expect(`${got}`, "TypeError") + ` (patched fetch present: ${!native})`;
});

for (const [ok, name, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
await context.close();
engine.kill();
site.close();
target.close();
if (process.env.VERBOSE) console.log(engineLog);
process.exit(results.every(([ok]) => ok) ? 0 : 1);
