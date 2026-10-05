/**
 * Bifurc Companion — store packaging
 *
 *   node scripts/package.mjs chrome    ->  dist/bifurc-companion-chrome-<version>.zip
 *   node scripts/package.mjs firefox   ->  dist/bifurc-companion-firefox-<version>.zip
 *
 * The repo root loads unpacked in both browsers as it is: `manifest.json`
 * carries the keys of both, and each browser ignores the other's. A store
 * package gets a manifest with only its own browser's keys, so neither store
 * sees a warning about the other.
 *
 * No dependencies: the zip is written here (deflate + CRC-32 from node:zlib).
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "dist");

/** Root files with these extensions ship; so do the icons the manifest names. */
const SHIPPED_EXTENSIONS = new Set([".js", ".html", ".css"]);

/** What each browser's manifest drops from the shared one. */
const TARGETS = {
    chrome(manifest) {
        delete manifest.background.scripts;
        delete manifest.browser_specific_settings;
    },
    firefox(manifest) {
        delete manifest.background.service_worker;
        delete manifest.minimum_chrome_version;
    },
};

// ── Zip ───────────────────────────────────────────────────────────────────────

// A fixed timestamp (1980-01-01 00:00), so the same sources give the same zip.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

/** Build a zip from `[{ name, data }]`; names use forward slashes. */
function zip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBytes = Buffer.from(name, "utf8");
        const compressed = deflateRawSync(data, { level: 9 });
        const checksum = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);     // local file header
        local.writeUInt16LE(20, 4);             // version needed
        local.writeUInt16LE(0x0800, 6);         // flags: UTF-8 names
        local.writeUInt16LE(8, 8);              // method: deflate
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        locals.push(local, nameBytes, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);   // central directory header
        central.writeUInt16LE(20, 4);           // version made by
        central.writeUInt16LE(20, 6);           // version needed
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);      // where the local header starts
        centrals.push(central, nameBytes);

        offset += local.length + nameBytes.length + compressed.length;
    }

    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);           // end of central directory
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...locals, directory, end]);
}

// ── Package ───────────────────────────────────────────────────────────────────

const target = process.argv[2];
if (!Object.hasOwn(TARGETS, target)) {
    console.error(`Usage: node scripts/package.mjs <${Object.keys(TARGETS).join("|")}>`);
    process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
TARGETS[target](manifest);

const names = readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SHIPPED_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => entry.name)
    .concat(Object.values(manifest.icons))
    .sort();

const entries = [
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 4) + "\n") },
    ...names.map((name) => ({ name, data: readFileSync(join(ROOT, name)) })),
];

const outFile = join(OUT_DIR, `bifurc-companion-${target}-${manifest.version}.zip`);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(outFile, zip(entries));

console.log(`${outFile}`);
for (const { name } of entries) console.log(`  ${name}`);
