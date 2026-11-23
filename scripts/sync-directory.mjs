#!/usr/bin/env node
/**
 * Rebuilds src/directory/data.ts from PromoStandards' endpoint directory.
 *
 *   pnpm directory:sync               fetch, write data.ts, print what was left out
 *   pnpm directory:sync --check       exit 1 if data.ts is out of date (for CI)
 *   pnpm directory:sync --save DIR    also keep the raw answers in DIR
 *   pnpm directory:sync --from DIR    read saved answers instead of fetching
 *
 * Runs on the built library (pnpm build first). Asks the repository a few
 * companies at a time, politely.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPOSITORY, readCompanies, readEndpoints, listingsFromRepository, renderDirectoryData } from "../dist/directory/sync.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "src/directory/data.ts");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const from = value("--from");
const save = value("--save");

async function getJson(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}
const read = (name) => JSON.parse(readFileSync(join(from, name), "utf8"));
const keep = (name, json) => {
  if (!save) return;
  mkdirSync(dirname(join(save, name)), { recursive: true });
  writeFileSync(join(save, name), JSON.stringify(json, null, 2));
};

const companiesJson = from ? read("companies.json") : await getJson(`${REPOSITORY}/companies`);
keep("companies.json", companiesJson);
// A code that isn't a plain identifier (PromoStandards lists a placeholder "**" with code "..") can't be asked about.
const usable = (c) => !/^\.+$/.test(c.code) && !/[/\\]/.test(c.code);
const listed = readCompanies(companiesJson).filter((c) => /^supplier$/i.test(c.type));
for (const c of listed.filter((c) => !usable(c))) console.error(`  left out: "${c.name}" (code "${c.code}"): not a usable company code`);
const companies = listed.filter(usable);
console.error(`${companies.length} supplier companies listed`);

const endpointsByCode = new Map();
const failed = [];
const queue = [...companies];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const name = `endpoints/${encodeURIComponent(c.code)}.json`;
      try {
        const json = from ? (existsSync(join(from, name)) ? read(name) : []) : await getJson(`${REPOSITORY}/companies/${encodeURIComponent(c.code)}/endpoints`);
        keep(name, json);
        endpointsByCode.set(c.code, readEndpoints(json));
      } catch (e) {
        failed.push(`${c.name} (${c.code}): ${e.message}`);
      }
    }
  }),
);

const { listings, skipped } = listingsFromRepository(companies, endpointsByCode);
const out = renderDirectoryData(listings, new Date().toISOString().slice(0, 10));
const strip = (s) => s.replace(/DIRECTORY_SYNCED_AT[^;]*;/, "");
const current = existsSync(target) ? readFileSync(target, "utf8") : "";

for (const s of skipped) console.error(`  left out: ${s}`);
for (const f of failed) console.error(`  couldn't read: ${f}`);
console.error(`${listings.length} suppliers with services OpenPromo can talk (${listings.reduce((n, l) => n + Object.keys(l.endpoints).length, 0)} endpoints)`);

if (flag("--check")) {
  if (strip(out) !== strip(current)) {
    console.error("src/directory/data.ts is out of date: run pnpm directory:sync");
    process.exit(1);
  }
  console.error("src/directory/data.ts is up to date");
} else if (failed.length && !from) {
  console.error("Some companies couldn't be read, so data.ts was not written. Run it again.");
  process.exit(1);
} else {
  writeFileSync(target, out);
  console.error(`wrote ${target}`);
}
