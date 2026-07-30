# swarm-control fork

Fork of [sst/opencode](https://github.com/sst/opencode), branch `swarm-control`,
based on tag `v1.18.9`. Adds a control plane for the swarm LiteLLM gateway
(see `~/Desktop/swarm`): a routing dashboard + admin API served by the
opencode server at `/gateway/`.

## Fork policy

Minimal diff. All logic lives in the new package
`packages/gateway-control/` — upstream files carry only registration glue,
each marked with a `FORK(swarm-control)` comment. Rebase onto upstream release
tags; when a rebase conflicts, the conflict surface is the list below.

## Upstream touchpoints (complete list)

1. `packages/opencode/src/server/routes/instance/httpapi/server.ts`
   - import of `@opencode-ai/gateway-control`
   - `gatewayRoute` layer definition (10 lines of Effect-http glue)
   - `gatewayRoute` added to the `createRoutes` mergeAll (before `uiRoute`'s
     `/*` catch-all, order matters)
2. `packages/opencode/package.json`
   - dependency `"@opencode-ai/gateway-control": "workspace:*"`

Everything else is additive: `packages/gateway-control/`, this file.

## What it serves

- `GET /gateway/` — self-contained mobile-friendly routing dashboard
- `GET /gateway/state` — role aliases (DB models on the gateway) + deployments
- `GET /gateway/catalogs` — LIVE model catalogs per provider (azure deployments,
  fireworks, uuapi proxy, vertex publisher list; 60s cache) — new provider
  models appear with zero config changes
- `POST /gateway/route {alias, provider, model}` — re-point an alias live.
  Implemented as model/new (fresh id) + model/delete (old), NOT in-place
  model/update: LiteLLM 1.93.0 caches provider clients per deployment id and
  an in-place update can keep serving the old backend. Takes effect within
  ~40s (gateway router sync loop).
- `POST /gateway/test {alias}` — run a tiny completion through the alias and
  report which backend served it (`x-litellm-model-api-base`).

## Configuration

Reads the swarm repo's `.env` (default `~/Desktop/swarm/.env`, override with
`SWARM_ENV_FILE`). Secrets stay in the server process; the browser only ever
sees model ids and alias names. The dashboard inherits the opencode server's
bind/auth — keep it on localhost/Tailscale like the gateway itself.

## Run

```bash
bun run --cwd packages/opencode src/index.ts serve
# then open http://127.0.0.1:<port>/gateway/
```
