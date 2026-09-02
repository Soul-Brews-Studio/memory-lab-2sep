#!/usr/bin/env node
/**
 * Deploy without committing Cloudflare IDs.
 *
 * wrangler.jsonc carries a placeholder D1 id so the repo stays public-safe and
 * the Deploy button can provision its own database. This script resolves the
 * real id by NAME at deploy time, writes a temporary config, and deploys.
 *
 *   node scripts/deploy.mjs             resolve → deploy
 *   node scripts/deploy.mjs --create    create the D1 database first if missing
 *   node scripts/deploy.mjs --dry-run   resolve → wrangler deploy --dry-run
 *
 * If `wrangler d1 list` is not permitted (some build containers), it falls
 * back to a plain `wrangler deploy` with the config as-is — which works when
 * the Deploy button has already patched the id into the config.
 *
 * Schema: applied lazily by the Worker itself (src/schema.ts), so no
 * migration step is needed here. `migrations/` exists for people who prefer
 * `wrangler d1 migrations apply DB --remote`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const create = args.has("--create");

function wrangler(argv, { allowFail = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...argv], { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0 && !allowFail) {
    console.error((r.stderr || r.stdout || "").replace(/\b[0-9a-f]{32}\b/gi, "<id>"));
    throw new Error(`wrangler ${argv[0]} failed`);
  }
  return r;
}

function loadConfig() {
  // wrangler.jsonc: strip comments (no strings contain // or /* in this file).
  const raw = readFileSync(resolve("wrangler.jsonc"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(raw);
}

const config = loadConfig();
const d1 = (config.d1_databases ?? []).find((d) => d.binding === "DB");
if (!d1) throw new Error("wrangler.jsonc has no D1 binding named DB");
const dbName = d1.database_name;

let databaseId = null;
const list = wrangler(["d1", "list", "--json"], { allowFail: true });
if (list.status === 0) {
  let dbs = [];
  try {
    dbs = JSON.parse(list.stdout);
  } catch {
    dbs = [];
  }
  let found = dbs.find((d) => d.name === dbName);
  if (!found && create) {
    console.log(`[d1] creating ${dbName}`);
    wrangler(["d1", "create", dbName]);
    const again = wrangler(["d1", "list", "--json"]);
    found = JSON.parse(again.stdout).find((d) => d.name === dbName);
  }
  if (!found) throw new Error(`D1 database ${dbName} not found; run with --create`);
  databaseId = found.uuid;
  console.log(`[d1] ${dbName} resolved`);
} else {
  console.warn("[d1] wrangler d1 list not permitted here; deploying with the config as-is");
}

let tmp = null;
try {
  let configPath = resolve("wrangler.jsonc");
  if (databaseId) {
    const patched = { ...config, main: resolve(config.main), d1_databases: config.d1_databases.map((d) => (d.binding === "DB" ? { ...d, database_id: databaseId, migrations_dir: resolve(d.migrations_dir ?? "migrations") } : d)) };
    delete patched.$schema;
    tmp = mkdtempSync(join(tmpdir(), "memory-lab-2sep-"));
    configPath = join(tmp, "wrangler.json");
    writeFileSync(configPath, JSON.stringify(patched), { mode: 0o600 });
  }
  const out = wrangler(["deploy", ...(dryRun ? ["--dry-run"] : []), "--config", configPath]);
  process.stdout.write(out.stdout.replace(/\b[0-9a-f]{32}\b/gi, "<id>"));
  console.log(dryRun ? "[deploy] dry run complete" : "[deploy] complete");
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}
