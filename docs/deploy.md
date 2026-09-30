# Deploying the myc team server

One binary and one Postgres. The server holds the team's workspace; every
person and every agent keeps a local workspace and exchanges with it through
`myc sync`.

Read [what does not work yet](#what-does-not-work-yet) before you plan around
this: the server is where replicas **meet**, not yet where the whole working
loop lives.

## What you need

- A host with Docker and a domain name pointing at it.
- Postgres 17 with [pgvector](https://github.com/pgvector/pgvector) ≥ 0.7 —
  the schema uses `halfvec` and HNSW. The sample compose file runs one for
  you; a managed Postgres works too if it offers the extension.
- A reverse proxy for TLS. The server speaks plain HTTP on purpose and never
  terminates TLS itself.

## 1. Bring the server up

```bash
git clone https://github.com/aistastudio/myc && cd myc
cp deploy/compose.yml deploy/compose.prod.yml
```

Edit `deploy/compose.prod.yml` and change three things before the first
start. They are the difference between the sample and an installation:

1. **The password**, in three places: `POSTGRES_PASSWORD`, the password
   inside `MYC_PG_URL`, and `deploy/initdb/10-app-role.sql`. Take it from your
   orchestrator's secret store, not from the file.
2. **The published port** — leave it on `127.0.0.1` so only the proxy can
   reach it.
3. **`MYC_BOOTSTRAP_TENANT` and `MYC_BOOTSTRAP_TOKEN`** — keep them for the
   first start, then delete both lines. They exist so that `up -d` gives you
   a server you can log into; they print the first secret **into the
   container log**, which is the wrong place for it in the long run.

```bash
docker compose -f deploy/compose.prod.yml up -d
docker compose -f deploy/compose.prod.yml logs server | grep -A2 'bootstrap token'
```

On an empty volume Postgres runs the schema itself: first the login role
(`10-app-role.sql`), then `db/schema.postgres.sql`. The schema creates tables,
triggers and the row-level security policies, which the application role is
deliberately not allowed to do — so the superuser applies it and the server
then lives as `myc_app`.

Write down the bootstrap secret. It is shown once: the database keeps only its
sha256.

## 2. Put TLS in front

The server decides whether to mark the session cookie `Secure` by
`X-Forwarded-Proto`, so the proxy must set it. Caddy is two lines:

```caddyfile
myc.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

Caddy sets `X-Forwarded-Proto` itself. With nginx, add it by hand:

```nginx
location / {
	proxy_pass http://127.0.0.1:8080;
	proxy_set_header X-Forwarded-Proto $scheme;
	proxy_set_header Host $host;
}
```

Check from outside:

```bash
curl https://myc.example.com/v1/health
# {"ok":true,"ver":"0.4.0","uptime_s":…,"pid":…}
```

`/v1/health` is the only route without a token. Everything else answers 401
until one is sent.

## 3. Tenants and tokens

A **tenant** is an organisation; tokens are issued under it and rows are
isolated between tenants by row-level security. Most teams need exactly one.

```bash
alias myc-srv='docker compose -f deploy/compose.prod.yml exec -T server myc serve'

myc-srv --add-tenant acme:Acme
myc-srv --add-token acme:anna --role owner
myc-srv --add-token acme:boris --role member
myc-srv --add-token acme:reviewer-bot --role agent
myc-srv --tokens          # who holds what, and when each was last used
myc-srv --revoke-token tok_…
```

One token per person and per agent — never a shared one. Revoking is then one
row and costs nobody else their access.

**Roles and rights.** Roles are `owner`, `maintainer`, `member`, `agent`,
`viewer`; rights are `read`, `write`, `claim`, `sync`, `admin`. A role is a
default set of rights, and `--scopes read,sync` narrows it explicitly.

`sync` belongs only to `owner` and `maintainer` by default, and that is not
caution — it is what a replica is. The exchange carries the **oplog**, which
no visibility predicate filters: a replica is complete by construction,
otherwise it would not converge. So the right to pull one is the right to see
everything in the workspace, including other people's private notes. Give
`sync` to the people who would have that access anyway, and give everyone else
`member`, which reads through the API under ACL.

**The admin page** is at `https://myc.example.com/v1/admin`. It asks a browser
for a token in a form and keeps it in an HttpOnly, SameSite=Strict cookie. It
needs the `admin` right.

## 4. What each teammate does

The workspace name on the server and the workspace **slug** on the machine
must match — the slug is part of every node's id, and syncing a `cherry`
workspace into a `web` one would move nodes into a workspace neither side
lists. `myc sync` refuses that outright rather than merging.

```bash
# once per machine, in the project directory
myc init --slug acme          # or: the slug already in .myc/workspace.toml

export MYC_SERVER=https://myc.example.com/acme   # workspace in the path
export MYC_TOKEN=myc_…                            # never on the command line
myc sync
```

`MYC_TOKEN` goes in the environment because arguments are visible in `ps`, in
shell history and in hook logs. Put the two exports in the shell profile, or
in a per-project `.envrc` that is not committed.

Then it is the ordinary local loop — `myc prime`, `myc ready --claim`,
`myc recall`, `myc remember`, `myc close` — all against the local database, at
local speed, with `myc sync` when you want to publish and receive. The
exchange is idempotent: an interrupted one is resumed by running it again.

## 5. Back up the database

The Postgres volume is the only state the server has: the binary is
stateless, and the admin page and tokens live in that same database.

```bash
docker compose -f deploy/compose.prod.yml exec -T db \
  pg_dump -U postgres -Fc myc > myc-$(date +%F).dump
```

Every machine also holds a full replica of the workspace, so a lost server
costs you the server, not the knowledge — but only for workspaces someone has
actually synced. Back up anyway.

## 6. Upgrading

The image is built from the repository, so an upgrade is a rebuild:

```bash
git pull
docker compose -f deploy/compose.prod.yml build server
docker compose -f deploy/compose.prod.yml up -d server
curl -s https://myc.example.com/v1/health   # "ver" must be the new one
```

**A release that changes the Postgres schema has no automatic migration
today.** `--apply-schema` writes the schema into an **empty** database and
refuses a populated one on purpose: applying DDL over live data is a
migration, with its own order, checks and rollback, and doing it silently on
every container start is how databases are lost. Check the release notes
before upgrading; if the schema number moved, treat it as a planned operation.

## What does not work yet

**Only part of the CLI speaks to a server.** Working remotely today:
`create`/`task`/`bug`/`epic`/`msg`, `update`, `claim`, `list`, `ready`,
`show`, `prime` and `sync`. Everything else — `close`, `remember`, `recall`,
`comment`, `link`, `dep`, `attempt`, `search`, `code` — refuses with
`precond.no_remote` rather than quietly using the local database, because
seeing someone else's tasks and taking them for the team's is worse than an
error.

So the shape that works is: everyone keeps a local workspace and exchanges
through the server. Pointing `MYC_SERVER` at the server and working "in" it
is not the mode to plan around yet.

Also not there yet: hybrid search on Postgres (the server's own `recall` has
no lexical or vector branch), SSE deltas for the web interface, and a bulk
SQLite→Postgres import of an existing workspace.

## When something refuses

| What you see | What it means |
|---|---|
| `401 denied.no_token` | no `MYC_TOKEN`, or the proxy is stripping `Authorization` |
| `denied.scope: this token has no 'sync' scope` | the token is a `member`; mint one with `--role owner` or `--scopes …,sync` |
| `usage.ws_mismatch` | the local slug and the server workspace differ — the message names both |
| `precond.no_remote` | that command has no remote mode; run it locally |
| health says `ok`, every other route `500 Something went wrong!` | the container is alive but cannot reach Postgres. The liveness probe knows nothing about the database on purpose; the 500 is a bare page with no code or reason (a known defect, memory-3h980j79swnh) — the reason is in the container log |
| `/v1/readyz` answers `401` | readiness reports system state, so it needs a token too; use `/v1/health` for the orchestrator's liveness probe |

---

Russian version: [`deploy.ru.md`](deploy.ru.md).
