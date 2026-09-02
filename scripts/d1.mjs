#!/usr/bin/env node
/**
 * Run `wrangler d1 <args>` against the REAL database. wrangler.jsonc keeps a
 * placeholder id (public-safe, Deploy-button-friendly), so remote d1 commands
 * need the id resolved by name first. Local commands (--local) pass through.
 *
 *   node scripts/d1.mjs export --remote --output backup/x.sql
 *   node scripts/d1.mjs execute --remote --json --command "SELECT 1"
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const raw = readFileSync(resolve("wrangler.jsonc"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const config = JSON.parse(raw);
const d1 = config.d1_databases.find((d) => d.binding === "DB");
const [command, ...rest] = args;

function run(argv) {
  const r = spawnSync("npx", ["wrangler", "d1", ...argv], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}

if (rest.includes("--local")) run([command, d1.database_name, ...rest]);

const list = spawnSync("npx", ["wrangler", "d1", "list", "--json"], { encoding: "utf8", env: process.env });
if (list.status !== 0) {
  console.error("could not list D1 databases");
  process.exit(1);
}
const found = JSON.parse(list.stdout).find((d) => d.name === d1.database_name);
if (!found) {
  console.error(`D1 database ${d1.database_name} not found on this account`);
  process.exit(1);
}
const tmp = mkdtempSync(join(tmpdir(), "memory-lab-2sep-d1-"));
const cfg = join(tmp, "wrangler.json");
writeFileSync(cfg, JSON.stringify({ ...config, $schema: undefined, main: resolve(config.main), d1_databases: [{ ...d1, database_id: found.uuid, migrations_dir: resolve(d1.migrations_dir ?? "migrations") }] }), { mode: 0o600 });
const r = spawnSync("npx", ["wrangler", "d1", command, d1.database_name, ...rest, "--config", cfg], { stdio: "inherit", env: process.env });
rmSync(tmp, { recursive: true, force: true });
process.exit(r.status ?? 1);
