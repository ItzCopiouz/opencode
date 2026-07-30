// Live provider catalogs — the reason the UI never goes stale: pickers are
// populated from each provider's own model listing at view time (60s cache),
// so newly launched models appear with zero config changes anywhere.
import { GoogleAuth } from "google-auth-library"
import { swarmEnv } from "./env.js"
import { listState } from "./litellm.js"

export type Catalogs = {
  azure: string[]
  fireworks: string[]
  proxy: string[]
  vertex: string[]
  bedrock: string[]
  errors: Record<string, string>
}

const TTL_MS = 60_000
let cache: { at: number; data: Catalogs } | undefined

async function openaiCompatibleModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) throw new Error(`${res.status}`)
  const data: any = await res.json()
  return (data.data ?? []).map((m: any) => String(m.id))
}

async function vertexModels(): Promise<string[]> {
  const env = swarmEnv()
  if (!env.googleCredentials) throw new Error("no GOOGLE_APPLICATION_CREDENTIALS")
  const auth = new GoogleAuth({
    keyFile: env.googleCredentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  })
  const token = await auth.getAccessToken()
  const res = await fetch(
    "https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=200&listAllVersions=false",
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) throw new Error(`${res.status}`)
  const data: any = await res.json()
  const ids: string[] = (data.publisherModels ?? []).map((m: any) => String(m.name ?? "").split("/").pop() ?? "")
  // text-generation gemini models only — drop tts/image/embedding/live modalities
  return ids
    .filter((id) => id.startsWith("gemini"))
    .filter((id) => !/(tts|image|embedding|live|omni|computer-use|reranker)/.test(id))
    .sort()
}

async function azureDeployments(): Promise<string[]> {
  // v1: the selectable azure set = deployments already configured on the
  // gateway. Creating NEW azure deployments needs `az` and is out of scope
  // for the routing screen.
  const { deployments } = await listState()
  return [
    ...new Set(
      deployments
        .filter((d) => d.model.startsWith("azure/"))
        .map((d) => d.model.replace(/^azure\//, "")),
    ),
  ].sort()
}

export async function catalogs(): Promise<Catalogs> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data
  const env = swarmEnv()
  const errors: Record<string, string> = {}
  const grab = async (name: string, fn: () => Promise<string[]>): Promise<string[]> => {
    try {
      return await fn()
    } catch (e) {
      errors[name] = String(e instanceof Error ? e.message : e).slice(0, 200)
      return []
    }
  }
  const [azure, fireworks, proxy, vertex] = await Promise.all([
    grab("azure", azureDeployments),
    grab("fireworks", async () => {
      if (!env.fireworksApiKey) throw new Error("no FIREWORKS_AI_API_KEY")
      return openaiCompatibleModels("https://api.fireworks.ai/inference/v1", env.fireworksApiKey)
    }),
    grab("proxy", async () => {
      if (!env.proxyBaseUrl || !env.proxyApiKey) throw new Error("no PROXY_BASE_URL/PROXY_API_KEY")
      return openaiCompatibleModels(env.proxyBaseUrl, env.proxyApiKey)
    }),
    grab("vertex", vertexModels),
  ])
  const data: Catalogs = { azure, fireworks, proxy, vertex, bedrock: [], errors }
  if (!errors["bedrock"]) errors["bedrock"] = "no AWS credentials configured yet"
  cache = { at: Date.now(), data }
  return data
}
