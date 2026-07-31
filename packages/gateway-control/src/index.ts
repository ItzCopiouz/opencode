// swarm gateway control — the fork's only server-side addition.
// Mounted in the opencode server at /gateway/* (see FORK.md for touchpoints).
// Framework-free by design: takes a plain method/path/body, returns a plain
// response description, so the Effect-http glue in the server stays 10 lines.
import { catalogs } from "./catalogs.js"
import { swarmEnv } from "./env.js"
import { addDeployment, deleteDeployment, listState, repointAlias, testAlias } from "./litellm.js"
import { DASHBOARD_HTML } from "./dashboard.js"
import { scores } from "./aa.js"
import { readLedger, dispatch, credits } from "./swarm.js"

export type GatewayRequest = { method: string; url: string; body?: string }
export type GatewayResponse = { status: number; contentType: string; body: string }

const json = (status: number, data: unknown): GatewayResponse => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(data),
})

export async function handle(req: GatewayRequest): Promise<GatewayResponse> {
  const path = new URL(req.url, "http://localhost").pathname.replace(/\/$/, "")
  try {
    if (req.method === "GET" && (path === "/gateway" || path === "")) {
      return { status: 200, contentType: "text/html; charset=utf-8", body: DASHBOARD_HTML }
    }
    if (req.method === "GET" && path === "/gateway/state") {
      const state = await listState()
      return json(200, { gateway: swarmEnv().gatewayUrl, ...state })
    }
    if (req.method === "GET" && path === "/gateway/catalogs") {
      return json(200, await catalogs())
    }
    if (req.method === "POST" && path === "/gateway/route") {
      const { alias, provider, model } = JSON.parse(req.body ?? "{}")
      if (!alias || !provider || !model) return json(400, { error: "alias, provider, model required" })
      const result = await repointAlias(String(alias), String(provider), String(model))
      return json(200, result)
    }
    if (req.method === "POST" && path === "/gateway/test") {
      const { alias } = JSON.parse(req.body ?? "{}")
      if (!alias) return json(400, { error: "alias required" })
      return json(200, await testAlias(String(alias)))
    }
    if (req.method === "GET" && path === "/gateway/scores") {
      const c = await catalogs()
      return json(
        200,
        await scores({
          azure: c.azure,
          fireworks: c.fireworks,
          proxy: c.proxy,
          vertex: c.vertex,
          bedrock: c.bedrock,
          anthropic: c.anthropic,
          chatgpt: c.chatgpt,
        }),
      )
    }
    if (req.method === "POST" && path === "/gateway/deployment") {
      const { alias, provider, model } = JSON.parse(req.body ?? "{}")
      if (!alias || !provider || !model) return json(400, { error: "alias, provider, model required" })
      return json(200, await addDeployment(String(alias), String(provider), String(model)))
    }
    if (req.method === "POST" && path === "/gateway/deployment/delete") {
      const { id } = JSON.parse(req.body ?? "{}")
      if (!id) return json(400, { error: "id required" })
      await deleteDeployment(String(id))
      return json(200, { deleted: id })
    }
    if (req.method === "GET" && path === "/gateway/jobs") {
      return json(200, readLedger())
    }
    if (req.method === "POST" && path === "/gateway/jobs") {
      const { task, alias, n } = JSON.parse(req.body ?? "{}")
      if (!task) return json(400, { error: "task required" })
      return json(200, dispatch(String(task), String(alias ?? "grunt"), Number(n ?? 1)))
    }
    if (req.method === "GET" && path === "/gateway/credits") {
      return json(200, await credits())
    }
    return json(404, { error: "not found" })
  } catch (e) {
    return json(502, { error: String(e instanceof Error ? e.message : e).slice(0, 400) })
  }
}
