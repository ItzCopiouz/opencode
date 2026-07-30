// Jobs + credits glue: the swarm repo's CLIs are the single source of truth
// (bin/swarm, bin/credits, lib/ledger.py); this module only reads the ledger
// file and shells out — the dashboard dispatch path IS `swarm run`, per the
// seam design. No message bus, no live IPC: the ledger file is the contract.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { execFile } from "node:child_process"

const swarmRoot = () => process.env["SWARM_ROOT"] ?? join(homedir(), "Desktop", "swarm")
const targetRepo = () => process.env["SWARM_TARGET_REPO"] ?? swarmRoot()

export type Job = {
  id: string
  title: string
  created_by: string
  status: string
  worktree?: string
  branch?: string
  alias?: string
  spend_usd?: number
  notes?: string[]
}

export function readLedger(): { repo: string; jobs: Job[] } {
  const repo = targetRepo()
  try {
    const data = JSON.parse(readFileSync(join(repo, ".swarm", "ledger.json"), "utf8"))
    return { repo, jobs: (data.jobs ?? []).slice().reverse() }
  } catch {
    return { repo, jobs: [] }
  }
}

export function dispatch(task: string, alias: string, n: number): { started: true; repo: string } {
  const repo = targetRepo()
  const args = [join(swarmRoot(), "bin", "swarm"), "--repo", repo, "run", task, "--alias", alias, "--n", String(n)]
  const child = spawn("python3", args, { detached: true, stdio: "ignore" })
  child.unref()
  return { started: true, repo }
}

let creditsCache: { at: number; data: unknown } | undefined

export function credits(): Promise<unknown> {
  if (creditsCache && Date.now() - creditsCache.at < 300_000) return Promise.resolve(creditsCache.data)
  return new Promise((resolve, reject) => {
    execFile(
      "python3",
      [join(swarmRoot(), "bin", "credits"), "--json"],
      { timeout: 150_000 },
      (err, stdout) => {
        if (err) return reject(new Error(`credits CLI failed: ${String(err).slice(0, 200)}`))
        try {
          const data = JSON.parse(stdout)
          creditsCache = { at: Date.now(), data }
          resolve(data)
        } catch (e) {
          reject(new Error(`credits CLI bad JSON: ${String(e)}`))
        }
      },
    )
  })
}
