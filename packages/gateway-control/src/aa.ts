// Artificial Analysis benchmark data → composite model scores.
//
// Source preference:
//   1. Official API (https://artificialanalysis.ai/api) when AA_API_KEY is in
//      the swarm .env — cleaner and ToS-friendlier; get a free key and add it.
//   2. Fallback: parse the public site's Next.js flight payloads
//      (/leaderboards/models for all models, /providers/fireworks for
//      Fireworks-hosted per-model output speeds).
//
// Score = weighted blend of intelligence, cost, speed — weights configurable
// via SWARM_SCORE_WEIGHTS="0.5,0.3,0.2" (intelligence,cost,speed).
// Never fabricates: unmatched catalog models simply carry no score.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type AAModel = {
  slug: string
  name: string
  intelligence?: number
  speed?: number // median output tok/s (model-level, across hosts)
  price?: number // $/M tokens, 3:1 input:output blend
}

export type ModelScore = {
  score?: number
  intelligence?: number
  speed?: number
  price?: number
  aaName?: string
  fwSpeed?: number // fireworks-hosted speed override, when applicable
}

const TTL_MS = 6 * 3600_000
const CACHE_FILE = join(homedir(), ".cache", "swarm-aa.json")
let mem: { at: number; models: AAModel[]; fwSpeeds: Record<string, number> } | undefined

const UA = { "User-Agent": "Mozilla/5.0 (swarm-control; local dashboard)" }

function decodeFlight(html: string): string {
  // chunk contents are already escaped as JSON-string bodies; wrap and parse.
  // NOTE: the "safe" strict pattern ((?:[^"\\]|\\.)*) silently drops large
  // chunks in V8 (backtrack bail-out on multi-MB strings); the lazy variant
  // matches Python byte-for-byte on real payloads. Content is JSON-escaped,
  // so an unescaped '"])' cannot occur inside a chunk.
  const joined = [...html.matchAll(/self\.__next_f\.push\(\[1,\s*"([\s\S]*?)"\]\)/g)]
    .map((m) => m[1]!)
    .join("")
  try {
    return JSON.parse('"' + joined + '"')
  } catch {
    // tolerate \xNN escapes (valid JS, invalid JSON)
    return JSON.parse('"' + joined.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => "\\u00" + h) + '"')
  }
}

function balancedArray(blob: string, key: string): any[] | undefined {
  const i = blob.indexOf(key)
  if (i < 0) return undefined
  const start = i + key.length
  let depth = 0
  let inStr = false
  for (let j = start; j < blob.length; j++) {
    const c = blob[j]
    if (inStr) {
      if (c === "\\") j++
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === "[") depth++
    else if (c === "]") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(blob.slice(start, j + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

async function fetchViaApi(key: string): Promise<AAModel[]> {
  const res = await fetch("https://artificialanalysis.ai/api/v2/data/llms/models", {
    headers: { "x-api-key": key },
  })
  if (!res.ok) throw new Error(`AA API ${res.status}`)
  const data: any = await res.json()
  return (data.data ?? []).map((m: any) => ({
    slug: String(m.slug ?? m.id ?? ""),
    name: String(m.name ?? m.slug ?? ""),
    intelligence:
      m.evaluations?.artificial_analysis_intelligence_index ?? m.intelligence_index ?? undefined,
    speed: m.median_output_tokens_per_second ?? m.median_output_speed ?? undefined,
    price: m.pricing?.price_1m_blended_3_to_1 ?? m.price_1m_blended ?? undefined,
  }))
}

async function fetchViaSite(): Promise<{ models: AAModel[]; fwSpeeds: Record<string, number> }> {
  const [lbRes, fwRes] = await Promise.all([
    fetch("https://artificialanalysis.ai/leaderboards/models", { headers: UA }),
    fetch("https://artificialanalysis.ai/providers/fireworks", { headers: UA }),
  ])
  const lbBlob = decodeFlight(await lbRes.text())
  // several "models": arrays exist (filter indexes etc.) — take the one whose
  // entries actually carry benchmark metrics
  let raw: any[] = []
  let from = 0
  while (true) {
    const i = lbBlob.indexOf('"models":[', from)
    if (i < 0) break
    const arr = balancedArray(lbBlob.slice(i), '"models":')
    if (arr?.length && arr[0] && typeof arr[0] === "object" && "intelligenceIndex" in arr[0]) {
      raw = arr
      break
    }
    from = i + 10
  }
  if (!raw.length) raw = balancedArray(lbBlob, '"initialModels":') ?? []
  const models: AAModel[] = raw
    .filter((m: any) => m && m.slug)
    .map((m: any) => ({
      slug: String(m.slug),
      name: String(m.name ?? m.shortName ?? m.slug),
      intelligence: numOr(m.intelligenceIndex),
      speed: numOr(m.outputSpeedVariance?.median ?? m.medianOutputSpeed),
      price: numOr(
        m.price1mBlended0To3To1 ??
          (m.price1mInputTokens != null && m.price1mOutputTokens != null
            ? (3 * m.price1mInputTokens + m.price1mOutputTokens) / 4
            : undefined),
      ),
    }))
  const fwBlob = decodeFlight(await fwRes.text())
  const fwSpeeds: Record<string, number> = {}
  // provider page embeds dataset arrays of {label, medianOutputSpeed, detailsUrl}
  for (const m of fwBlob.matchAll(/\{"label":"((?:[^"\\]|\\.)*)","medianOutputSpeed":([0-9.]+)/g)) {
    fwSpeeds[norm(m[1]!)] = Number(m[2])
  }
  return { models, fwSpeeds }
}

const numOr = (v: any): number | undefined => (typeof v === "number" && isFinite(v) ? v : undefined)

async function data(): Promise<{ models: AAModel[]; fwSpeeds: Record<string, number> }> {
  if (mem && Date.now() - mem.at < TTL_MS) return mem
  try {
    const disk = JSON.parse(readFileSync(CACHE_FILE, "utf8"))
    if (Date.now() - disk.at < TTL_MS) return (mem = disk)
  } catch {}
  const key = process.env["AA_API_KEY"] ?? readEnvKey()
  let result: { models: AAModel[]; fwSpeeds: Record<string, number> }
  if (key) {
    const models = await fetchViaApi(key)
    // fireworks per-host speeds are site-only for now
    let fwSpeeds: Record<string, number> = {}
    try {
      fwSpeeds = (await fetchViaSite()).fwSpeeds
    } catch {}
    result = { models, fwSpeeds }
  } else {
    result = await fetchViaSite()
  }
  mem = { at: Date.now(), ...result }
  try {
    mkdirSync(join(homedir(), ".cache"), { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(mem))
  } catch {}
  return mem
}

function readEnvKey(): string | undefined {
  try {
    const file = process.env["SWARM_ENV_FILE"] ?? join(homedir(), "Desktop", "swarm", ".env")
    const m = readFileSync(file, "utf8").match(/^AA_API_KEY=(.+)$/m)
    return m?.[1]?.trim()
  } catch {
    return undefined
  }
}

export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/^accounts\/fireworks\/(models|routers)\//, "")
    .replace(/^us\.(anthropic|meta|amazon)\./, "")
    .replace(/-\d{8}-v\d+:\d+$/, "") // bedrock date+version suffix
    .replace(/(\d)p(\d)/g, "$1.$2") // fireworks 2p7 -> 2.7
    .replace(/-preview$/, "")
    .replace(/[^a-z0-9]/g, "")
}

function match(models: AAModel[], catalogModel: string): AAModel | undefined {
  const n = norm(catalogModel)
  if (!n) return undefined
  const exact = models.filter((m) => norm(m.slug) === n || norm(m.name) === n)
  if (exact.length) return exact[0]
  const contains = models.filter((m) => {
    const ms = norm(m.slug)
    return (ms.length >= 4 && n.includes(ms)) || (n.length >= 4 && ms.includes(n))
  })
  if (contains.length === 1) return contains[0]
  return undefined
}

function weights(): [number, number, number] {
  const raw = process.env["SWARM_SCORE_WEIGHTS"]?.split(",").map(Number)
  if (raw?.length === 3 && raw.every((x) => isFinite(x))) {
    const sum = raw[0]! + raw[1]! + raw[2]!
    return [raw[0]! / sum, raw[1]! / sum, raw[2]! / sum]
  }
  return [0.5, 0.3, 0.2] // intelligence, cost, speed
}

const clamp = (x: number) => Math.max(0, Math.min(100, x))

export function composite(intelligence?: number, price?: number, speed?: number): number | undefined {
  if (intelligence == null) return undefined
  const [wi, wc, ws] = weights()
  const iN = clamp((intelligence / 70) * 100)
  const cN = price != null && price > 0 ? clamp(100 - 30 * Math.log10(price / 0.05)) : 50
  const sN = speed != null ? clamp((speed / 300) * 100) : 50
  return Math.round(wi * iN + wc * cN + ws * sN)
}

export async function scores(
  catalog: Record<string, string[]>,
): Promise<{ source: string; byKey: Record<string, ModelScore> }> {
  const { models, fwSpeeds } = await data()
  const byKey: Record<string, ModelScore> = {}
  for (const [provider, ids] of Object.entries(catalog)) {
    for (const id of ids) {
      const m = match(models, id)
      if (!m) {
        byKey[`${provider}|${id}`] = {}
        continue
      }
      let speed = m.speed
      let fwSpeed: number | undefined
      if (provider === "fireworks") {
        fwSpeed = fwSpeeds[norm(m.name)] ?? fwSpeeds[norm(id)]
        if (fwSpeed != null) speed = fwSpeed
      }
      byKey[`${provider}|${id}`] = {
        score: composite(m.intelligence, m.price, speed),
        intelligence: m.intelligence,
        speed,
        price: m.price,
        aaName: m.name,
        fwSpeed,
      }
    }
  }
  return { source: process.env["AA_API_KEY"] ? "api" : "site", byKey }
}
