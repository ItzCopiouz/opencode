// Loads swarm gateway settings from the swarm repo's .env file. The opencode
// server process holds these secrets server-side; nothing is ever sent to the
// browser except catalog model ids and alias names.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type SwarmEnv = {
  gatewayUrl: string
  masterKey: string
  proxyBaseUrl?: string
  proxyApiKey?: string
  fireworksApiKey?: string
  vertexProject?: string
  googleCredentials?: string
  anthropicApiKey?: string
  openaiApiKey?: string
}

const real = (v: string | undefined) => (v && v !== "PLACEHOLDER" ? v : undefined)

let cached: SwarmEnv | undefined

export function swarmEnv(): SwarmEnv {
  if (cached) return cached
  const file = process.env["SWARM_ENV_FILE"] ?? join(homedir(), "Desktop", "swarm", ".env")
  const vars: Record<string, string> = {}
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) vars[m[1]!] = m[2]!
    }
  } catch {
    throw new Error(`gateway-control: cannot read swarm env file at ${file} (set SWARM_ENV_FILE)`)
  }
  const masterKey = vars["LITELLM_MASTER_KEY"]
  if (!masterKey) throw new Error(`gateway-control: LITELLM_MASTER_KEY missing in ${file}`)
  cached = {
    gatewayUrl: process.env["SWARM_GATEWAY_URL"] ?? vars["GATEWAY_URL"] ?? "http://127.0.0.1:4000",
    masterKey,
    proxyBaseUrl: vars["PROXY_BASE_URL"],
    proxyApiKey: vars["PROXY_API_KEY"],
    fireworksApiKey: real(vars["FIREWORKS_AI_API_KEY"]),
    vertexProject: real(vars["VERTEXAI_PROJECT"]),
    googleCredentials: real(vars["GOOGLE_APPLICATION_CREDENTIALS"]),
    anthropicApiKey: real(vars["ANTHROPIC_API_KEY"]),
    openaiApiKey: real(vars["OPENAI_API_KEY"]),
  }
  return cached
}
