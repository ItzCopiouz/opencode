// Client for the LiteLLM gateway admin API.
//
// Alias re-pointing uses REPLACE (model/new with a fresh id + model/delete of
// the old), never in-place model/update: LiteLLM 1.93.0 keeps a provider
// client cached per deployment id, so an in-place update can silently keep
// serving the OLD backend. A fresh id guarantees a fresh client. The router
// applies DB changes on its sync loop, so a re-point takes up to ~40s to serve.
import { swarmEnv } from "./env.js"

export type AliasInfo = {
  name: string
  id: string
  provider: string
  model: string
  effort?: string
  fast?: boolean
  weight?: number
}

// Per-deployment tuning options. Effort maps per provider (OpenAI-style
// reasoning_effort vs Anthropic output_config.effort); fast is the Anthropic
// fast-mode research preview (Claude Opus 5 / Opus 4.8, Claude API only,
// $10/$50 per MTok — speed:"fast" + beta flag fast-mode-2026-02-01).
export type DeployOpts = {
  effort?: string // low | medium | high | xhigh | max
  fast?: boolean
  weight?: number // load-balancing weight within a role group (simple-shuffle)
}

export const EFFORT_PROVIDERS = new Set(["anthropic", "azure", "proxy", "chatgpt"])
export const FAST_MODELS = new Set(["claude-opus-5", "claude-opus-4-8"])

export type DeploymentInfo = {
  name: string
  id?: string
  model: string
  dbModel: boolean
}

type ModelInfoEntry = {
  model_name: string
  litellm_params: { model?: string; [k: string]: unknown }
  model_info: { id?: string; db_model?: boolean }
}

async function admin(path: string, init?: RequestInit): Promise<any> {
  const env = swarmEnv()
  const res = await fetch(`${env.gatewayUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.masterKey}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`gateway ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

export async function modelInfo(): Promise<ModelInfoEntry[]> {
  const data = await admin("/model/info")
  return data.data as ModelInfoEntry[]
}

export function providerOf(litellmModel: string, apiBase?: unknown): string {
  if (litellmModel.startsWith("azure/")) return "azure"
  if (litellmModel.startsWith("fireworks_ai/")) return "fireworks"
  if (litellmModel.startsWith("vertex_ai/")) return "vertex"
  if (litellmModel.startsWith("bedrock/")) return "bedrock"
  if (litellmModel.startsWith("anthropic/")) return "anthropic"
  // openai/ prefix serves both the untrusted proxy (custom api_base) and the
  // real ChatGPT API (no api_base)
  if (litellmModel.startsWith("openai/")) return apiBase ? "proxy" : "chatgpt"
  return "unknown"
}

export function shortModel(litellmModel: string): string {
  return litellmModel.replace(/^(azure|fireworks_ai|vertex_ai|bedrock|openai)\//, "")
}

export async function listState(): Promise<{ aliases: AliasInfo[]; deployments: DeploymentInfo[] }> {
  const entries = await modelInfo()
  const aliases: AliasInfo[] = []
  const deployments: DeploymentInfo[] = []
  for (const e of entries) {
    const model = e.litellm_params.model ?? ""
    if (e.model_info?.db_model) {
      const p = e.litellm_params as Record<string, any>
      aliases.push({
        name: e.model_name,
        id: e.model_info.id ?? "",
        provider: providerOf(model, e.litellm_params["api_base"]),
        model: shortModel(model),
        effort: p["reasoning_effort"] ?? p["extra_body"]?.["output_config"]?.["effort"],
        fast: p["extra_body"]?.["speed"] === "fast" || undefined,
        weight: typeof p["weight"] === "number" ? p["weight"] : undefined,
      })
    } else {
      deployments.push({ name: e.model_name, id: e.model_info?.id, model, dbModel: false })
    }
  }
  aliases.sort((a, b) => a.name.localeCompare(b.name))
  return { aliases, deployments }
}

// litellm_params for a given provider/model pair. Credentials are os.environ/
// REFERENCES resolved inside the gateway process — raw secrets never enter
// the gateway DB or cross this API.
export function paramsFor(provider: string, model: string, opts?: DeployOpts): Record<string, unknown> {
  const base = baseParamsFor(provider, model)
  if (opts?.weight != null && opts.weight > 0) base["weight"] = opts.weight
  if (opts?.effort && EFFORT_PROVIDERS.has(provider)) {
    if (provider === "anthropic") {
      // Anthropic: effort lives in output_config (thinking is adaptive/on)
      base["extra_body"] = { ...(base["extra_body"] as object), output_config: { effort: opts.effort } }
    } else {
      base["reasoning_effort"] = opts.effort
    }
  }
  if (opts?.fast && provider === "anthropic" && FAST_MODELS.has(model)) {
    base["extra_body"] = { ...(base["extra_body"] as object), speed: "fast" }
    base["extra_headers"] = { "anthropic-beta": "fast-mode-2026-02-01" }
  }
  return base
}

function baseParamsFor(provider: string, model: string): Record<string, unknown> {
  switch (provider) {
    case "azure":
      return {
        model: `azure/${model}`,
        api_key: "os.environ/AZURE_API_KEY",
        api_base: "os.environ/AZURE_API_BASE",
        api_version: "os.environ/AZURE_API_VERSION",
      }
    case "fireworks":
      return { model: `fireworks_ai/${model}`, api_key: "os.environ/FIREWORKS_AI_API_KEY" }
    case "proxy":
      return {
        model: `openai/${model}`,
        api_base: "os.environ/PROXY_BASE_URL",
        api_key: "os.environ/PROXY_API_KEY",
      }
    case "vertex":
      return {
        model: `vertex_ai/${model}`,
        vertex_project: "os.environ/VERTEXAI_PROJECT",
        vertex_location: "global",
      }
    case "bedrock":
      return {
        model: `bedrock/${model}`,
        aws_access_key_id: "os.environ/AWS_ACCESS_KEY_ID",
        aws_secret_access_key: "os.environ/AWS_SECRET_ACCESS_KEY",
        aws_region_name: "os.environ/AWS_REGION_NAME",
      }
    case "anthropic":
      // metered Anthropic API — never the Max plan (OAuth interactive-only)
      return { model: `anthropic/${model}`, api_key: "os.environ/ANTHROPIC_API_KEY" }
    case "chatgpt":
      return { model: `openai/${model}`, api_key: "os.environ/OPENAI_API_KEY" }
    default:
      throw new Error(`unknown provider: ${provider}`)
  }
}

export async function repointAlias(
  alias: string,
  provider: string,
  model: string,
  opts?: DeployOpts,
): Promise<{ newId: string }> {
  const entries = await modelInfo()
  const current = entries.filter((e) => e.model_name === alias && e.model_info?.db_model)
  if (current.length === 0) throw new Error(`alias not found (or not a DB model): ${alias}`)
  const newId = `alias-${alias}-${Date.now().toString(36)}`
  await admin("/model/new", {
    method: "POST",
    body: JSON.stringify({
      model_name: alias,
      model_info: { id: newId },
      litellm_params: paramsFor(provider, model, opts),
    }),
  })
  for (const old of current) {
    if (old.model_info.id) {
      await admin("/model/delete", { method: "POST", body: JSON.stringify({ id: old.model_info.id }) })
    }
  }
  return { newId }
}

// Group-aware ops for multi-deployment roles (e.g. `iterate` load-balancing
// across several backends): add one deployment / remove one by id, without
// touching siblings. repointAlias remains the whole-role replace.
export async function addDeployment(
  alias: string,
  provider: string,
  model: string,
  opts?: DeployOpts,
): Promise<{ id: string }> {
  const id = `alias-${alias}-${Date.now().toString(36)}`
  await admin("/model/new", {
    method: "POST",
    body: JSON.stringify({
      model_name: alias,
      model_info: { id },
      litellm_params: paramsFor(provider, model, opts),
    }),
  })
  return { id }
}

export async function deleteDeployment(id: string): Promise<void> {
  const entries = await modelInfo()
  const entry = entries.find((e) => e.model_info?.id === id && e.model_info?.db_model)
  if (!entry) throw new Error(`no DB deployment with id ${id}`)
  const siblings = entries.filter((e) => e.model_name === entry.model_name && e.model_info?.db_model)
  if (siblings.length <= 1) throw new Error(`refusing to delete the last deployment of role ${entry.model_name}`)
  await admin("/model/delete", { method: "POST", body: JSON.stringify({ id }) })
}

export async function testAlias(alias: string): Promise<{ content: string; apiBase?: string; modelId?: string }> {
  const env = swarmEnv()
  const res = await fetch(`${env.gatewayUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.masterKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: alias,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      max_tokens: 200,
    }),
  })
  const apiBase = res.headers.get("x-litellm-model-api-base") ?? undefined
  const modelId = res.headers.get("x-litellm-model-id") ?? undefined
  if (!res.ok) throw new Error(`test ${alias} -> ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const data: any = await res.json()
  return { content: data.choices?.[0]?.message?.content ?? "", apiBase, modelId }
}
