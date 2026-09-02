# memory-lab-2sep — one owner's memory MCP on Cloudflare Workers + D1, with a stateless client/method-call ledger.
#
#   just demo            the whole loop on the live Worker: check → deploy → smoke (Thai recall, OAuth, MCP) → dig → ledger → backup/restore
#   just smoke           end-to-end against the live Worker (needs OWNER_PASSPHRASE; API_TOKEN optional)
#   just dev             local Worker on a free port (needs .dev.vars — copy .env.example)
#
# Secrets are read from the environment (or a direnv/.env you keep OUT of git). Nothing here prints one.

set shell := ["zsh", "-cu"]
set dotenv-load := true

worker := "memory-lab-2sep"
base   := env_var_or_default("BASE", "https://memory-lab-2sep.laris.workers.dev")
here   := justfile_directory()
stamp  := `date +%Y%m%d-%H%M`

default:
    @just --list --justfile "{{justfile()}}"

# typecheck + unit tests
check:
    cd "{{here}}" && bun run typecheck && bun test src

# local Worker + local D1 (reads .dev.vars). Prints the port it picked.
dev:
    cd "{{here}}" && port=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1])") && echo "http://127.0.0.1:$port" && npx wrangler dev --local --port "$port"

# resolve the D1 id by name, deploy the Worker (pass --create the first time)
deploy *ARGS:
    cd "{{here}}" && node scripts/deploy.mjs {{ARGS}}

# upload OWNER_PASSPHRASE and API_TOKEN from the environment as Worker secrets
secrets:
    cd "{{here}}" && printf '%s' "$OWNER_PASSPHRASE" | npx wrangler secret put OWNER_PASSPHRASE && printf '%s' "$API_TOKEN" | npx wrangler secret put API_TOKEN

# 1 · health + OAuth discovery (public, no secret)
health:
    curl -sS "{{base}}/api/health"; echo
    curl -sS "{{base}}/.well-known/oauth-protected-resource/mcp"; echo

# 2 · the loop a real client walks: discovery → DCR → PKCE authorize → token → MCP (remember Thai, recall Thai) → ledger tools
smoke:
    cd "{{here}}" && mkdir -p out && BASE="{{base}}" python3 scripts/smoke.py | tee "out/smoke-{{stamp}}.log"

# 3 · MCP by hand over the static token: initialize, tools/list, one recall (Thai)
mcp QUERY="ความจำ":
    @cd "{{here}}" && BASE="{{base}}" python3 scripts/mcp.py initialize
    @cd "{{here}}" && BASE="{{base}}" python3 scripts/mcp.py tools/list
    @cd "{{here}}" && BASE="{{base}}" python3 scripts/mcp.py recall "{{QUERY}}"

# 4 · digger fan-out: one keyword → query variants → recall each → dedupe → one ranked report (learned from ψ/lab/02-arra-memory-digger)
dig KEYWORD="memorylab":
    cd "{{here}}" && BASE="{{base}}" python3 scripts/dig.py "{{KEYWORD}}"

# 5 · who connected + which methods from where (the stateless ledger), newest first
ledger:
    @cd "{{here}}" && BASE="{{base}}" python3 scripts/mcp.py status
    @cd "{{here}}" && BASE="{{base}}" python3 scripts/mcp.py list_clients
    @cd "{{here}}" && BASE="{{base}}" python3 scripts/mcp.py list_calls 15

# 6a · backup: export the live D1 to backup/<stamp>.sql (schema + data)
backup:
    cd "{{here}}" && mkdir -p backup && node scripts/d1.mjs export --remote --output "backup/{{stamp}}.sql" && ls -la "backup/{{stamp}}.sql" && grep -c "^INSERT" "backup/{{stamp}}.sql" | sed 's/^/INSERT rows: /'

# 6b · restore the newest backup into a LOCAL D1 and count rows on both sides (never touches the live database)
restore:
    cd "{{here}}" && f=$(ls -t backup/*.sql | head -1) && echo "restoring $f → local D1" \
      && node scripts/d1.mjs execute --local --command "DROP TABLE IF EXISTS memories; DROP TABLE IF EXISTS calls; DROP TABLE IF EXISTS clients; DROP TABLE IF EXISTS oauth_clients; DROP TABLE IF EXISTS oauth_codes; DROP TABLE IF EXISTS oauth_tokens;" >/dev/null \
      && node scripts/d1.mjs execute --local --file "$f" >/dev/null \
      && echo "local:  $(node scripts/d1.mjs execute --local --json --command "SELECT (SELECT COUNT(*) FROM memories) AS memories, (SELECT COUNT(*) FROM clients) AS clients, (SELECT COUNT(*) FROM calls) AS calls" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["results"][0])')" \
      && echo "remote: $(node scripts/d1.mjs execute --remote --json --command "SELECT (SELECT COUNT(*) FROM memories) AS memories, (SELECT COUNT(*) FROM clients) AS clients, (SELECT COUNT(*) FROM calls) AS calls" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["results"][0])')"

# register in Claude Code (user scope). With API_TOKEN set: static header; without: OAuth login in the browser.
mcp-add:
    cd "{{here}}" && if [ -n "${API_TOKEN:-}" ]; then claude mcp add --scope user --transport http "{{worker}}" "{{base}}/mcp" --header "Authorization: Bearer $API_TOKEN"; else claude mcp add --scope user --transport http "{{worker}}" "{{base}}/mcp" && claude mcp login "{{worker}}"; fi
    claude mcp list | grep "{{worker}}"

mcp-remove:
    claude mcp remove --scope user "{{worker}}"

# the whole thing, each step its own recipe, real output
demo:
    @echo "━━ 0 · check (tsc + bun test)";          just --justfile "{{justfile()}}" check
    @echo "━━ 1 · deploy";                          just --justfile "{{justfile()}}" deploy
    @echo "━━ 2 · health + discovery";              just --justfile "{{justfile()}}" health
    @echo "━━ 3 · smoke: OAuth → MCP → Thai recall"; just --justfile "{{justfile()}}" smoke
    @echo "━━ 4 · MCP by hand (static token)";      just --justfile "{{justfile()}}" mcp
    @echo "━━ 5 · digger fan-out";                  just --justfile "{{justfile()}}" dig
    @echo "━━ 6 · ledger: who, which method, from where"; just --justfile "{{justfile()}}" ledger
    @echo "━━ 7 · backup → restore";                just --justfile "{{justfile()}}" backup && just --justfile "{{justfile()}}" restore
    @echo "━━ done"
