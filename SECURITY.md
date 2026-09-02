# Security and privacy

This Worker holds one owner's memories and a ledger of who called it. It is a
lab, not a multi-tenant service: one passphrase, one optional static token, no
accounts, no rate limiting.

## Two secrets, never in git

| secret | what it opens |
|---|---|
| `OWNER_PASSPHRASE` | the dashboard at `/` and the OAuth approval page that authorizes an MCP client |
| `API_TOKEN` | optional static bearer for Claude Code, Codex and curl; blank disables that door |

Set them as Cloudflare Worker secrets (`just secrets`), or in `.dev.vars` for
local runs. `.dev.vars`, `.env` and `.envrc` are git-ignored and must stay that
way. Generate a passphrase with `openssl rand -base64 32`.

## What must never be committed

- `.dev.vars` / `.env` — the two secrets above.
- `backup/*.sql` — a D1 export contains the `oauth_tokens` table, i.e. live
  bearer tokens for every connected client. Git-ignored; treat a copy on disk
  as a credential.
- Unscrubbed logs or screenshots. The tracked files under `out/` and
  `docs/images/` were scrubbed before publication: absolute paths and the
  developer's username removed, dashboard IP addresses masked, OAuth client
  ids truncated to the 8-character prefix, a private home-lab hostname
  replaced.

## What is intentionally public

An OAuth `client_id` is a public identifier, not a credential: this server
issues no client secrets, and PKCE S256 is what binds an authorization code to
the client that requested it. Cloudflare colo codes, country codes, MCP client
names and protocol versions appear in the ledger by design — that is the
feature.

## What the ledger stores

`clients` and `calls` record the auth method, the principal (an OAuth
`client_id`, or a user-agent family for the static token), the JSON-RPC method
and tool name, the request's IP / country / colo, duration and outcome. The
bearer that proved the caller is discarded at the gate and never stored.
Memory content is never copied into the ledger. `calls` is bounded to the
newest 2,000 rows.

## Reporting

Please report vulnerabilities privately to the repository maintainers rather
than opening a public issue.
