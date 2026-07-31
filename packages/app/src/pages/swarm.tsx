// FORK(swarm-control): native Swarm control page — roles, jobs, credits.
// Talks to the same-origin /gateway/* API served by gateway-control; no
// secrets ever reach the browser. Route: /swarm (the standalone fallback
// dashboard remains at /gateway/).
import { createResource, createSignal, For, Show } from "solid-js"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"

type Alias = { name: string; id: string; provider: string; model: string }
type Score = { score?: number; speed?: number; price?: number }

const TIERS: Record<string, { label: string; blurb: string }> = {
  plan: { label: "Planner", blurb: "smartest model — decomposition & strategy" },
  iterate: { label: "Power iterators", blurb: "heavy implementation, load-balanced across the group" },
  review: { label: "Reviewer", blurb: "verify & critique — iterator tier, never degrades silently" },
  grunt: { label: "Middle tier", blurb: "smaller tasks, fast & cheap at volume" },
  cheap: { label: "Low tier", blurb: "throwaway calls" },
}
const TIER_ORDER = ["plan", "iterate", "review", "grunt", "cheap"]
const PROVIDERS = ["anthropic", "azure", "fireworks", "proxy", "chatgpt", "vertex", "bedrock"]

async function j(url: string, opts?: RequestInit) {
  const r = await fetch(url, opts)
  const data = await r.json().catch(() => ({ error: `bad response ${r.status}` }))
  if (!r.ok) throw new Error((data as any).error ?? String(r.status))
  return data
}

const card =
  "flex flex-col gap-2 rounded-xl border border-v2-border-border-faint bg-v2-background-bg-base p-4"
const btn =
  "rounded-lg border border-v2-border-border-faint px-3 py-1.5 text-sm text-v2-text-text-base hover:bg-v2-background-bg-raised disabled:opacity-50"
const btnPrimary = btn + " bg-v2-background-bg-inverted text-v2-text-text-inverted hover:opacity-90"
const selectCls =
  "w-full rounded-lg border border-v2-border-border-faint bg-v2-background-bg-raised px-2 py-1.5 text-sm text-v2-text-text-base"
const chip = "rounded-full border border-v2-border-border-faint px-2 py-0.5 text-xs text-v2-text-text-faint"

export function SwarmPage() {
  const [state, { refetch: refetchState }] = createResource(() => j("/gateway/state"))
  const [catalogs] = createResource(() => j("/gateway/catalogs"))
  const [scoresData] = createResource(() => j("/gateway/scores").catch(() => ({ byKey: {} })))
  const [jobs, { refetch: refetchJobs }] = createResource(() => j("/gateway/jobs"))
  const [credits] = createResource(() => j("/gateway/credits").catch((e: Error) => ({ error: e.message, rows: [] })))

  const scoreOf = (provider: string, model: string): Score =>
    (scoresData()?.byKey ?? {})[`${provider}|${model}`] ?? {}

  const groups = () => {
    const by: Record<string, Alias[]> = {}
    for (const a of (state()?.aliases ?? []) as Alias[]) (by[a.name] ??= []).push(a)
    return by
  }
  const roleNames = () => {
    const names = Object.keys(groups())
    return [...TIER_ORDER.filter((n) => names.includes(n)), ...names.filter((n) => !TIER_ORDER.includes(n)).sort()]
  }

  return (
    <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 overflow-y-auto p-6">
      <header class="flex flex-col gap-1">
        <h1 class="flex items-center gap-2 text-lg font-semibold text-v2-text-text-strong">
          <IconV2 name="branch" size="small" /> Swarm
        </h1>
        <p class="text-sm text-v2-text-text-faint">
          gateway {state()?.gateway ?? "…"} ·{" "}
          {Object.values(scoresData()?.byKey ?? {}).filter((s: any) => s.score != null).length} models scored
          (Artificial Analysis) · <a class="underline" href="/gateway/">fallback dashboard</a>
        </p>
      </header>

      <section class="flex flex-col gap-3">
        <h2 class="text-sm font-medium text-v2-text-text-strong">Roles</h2>
        <For each={roleNames()}>
          {(name) => (
            <RoleCard
              name={name}
              deployments={groups()[name] ?? []}
              catalogs={catalogs()}
              scoreOf={scoreOf}
              onChanged={refetchState}
            />
          )}
        </For>
      </section>

      <JobsSection jobs={jobs()} onRefresh={refetchJobs} />
      <CreditsSection credits={credits()} />
    </div>
  )
}

function RoleCard(props: {
  name: string
  deployments: Alias[]
  catalogs: any
  scoreOf: (p: string, m: string) => Score
  onChanged: () => void
}) {
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal("")
  const [selection, setSelection] = createSignal("")
  const tier = () => TIERS[props.name]
  const isGroup = () => props.deployments.length > 1

  const options = () => {
    const out: { value: string; label: string; group: string }[] = []
    for (const p of PROVIDERS) {
      for (const m of (props.catalogs?.[p] ?? []) as string[]) {
        const s = props.scoreOf(p, m)
        const extra = [
          s.score != null ? `${s.score}` : null,
          s.speed != null ? `${Math.round(s.speed)} t/s` : null,
          s.price != null ? `$${s.price.toFixed(2)}/M` : null,
        ]
          .filter(Boolean)
          .join(" · ")
        out.push({ value: `${p}|${m}`, label: extra ? `${m} · ${extra}` : m, group: p })
      }
    }
    out.sort((a, b) => {
      const sa = props.scoreOf(...(a.value.split("|") as [string, string])).score ?? -1
      const sb = props.scoreOf(...(b.value.split("|") as [string, string])).score ?? -1
      return sb - sa
    })
    return out
  }

  const act = (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    setNote("working…")
    fn()
      .then(() => {
        if (done) {
          setNote(done)
          props.onChanged()
        }
      })
      .catch((e: Error) => setNote(`error: ${e.message}`))
      .finally(() => setBusy(false))
  }

  return (
    <div class={card}>
      <div class="flex items-center justify-between gap-2">
        <div class="flex flex-col">
          <span class="font-medium text-v2-text-text-strong">
            {props.name}
            <Show when={tier()}>
              <span class="ml-2 text-xs text-v2-text-text-faint">{tier()!.label}</span>
            </Show>
          </span>
          <Show when={tier()}>
            <span class="text-xs text-v2-text-text-faint">{tier()!.blurb}</span>
          </Show>
        </div>
        <span class={chip}>{isGroup() ? `${props.deployments.length}-way group` : props.deployments[0]?.provider}</span>
      </div>

      <ul class="flex flex-col gap-1">
        <For each={props.deployments}>
          {(d) => {
            const s = props.scoreOf(d.provider, d.model)
            return (
              <li class="flex items-center justify-between gap-2 rounded-lg bg-v2-background-bg-raised px-3 py-1.5 text-sm">
                <span class="min-w-0 truncate text-v2-text-text-base">
                  <span class={chip + " mr-2"}>{d.provider}</span>
                  {d.model}
                  <Show when={s.score != null}>
                    <span class="ml-2 text-xs text-v2-text-text-faint">score {s.score}</span>
                  </Show>
                </span>
                <Show when={isGroup()}>
                  <button
                    class={btn + " shrink-0 text-xs"}
                    disabled={busy()}
                    onClick={() =>
                      act(
                        () =>
                          j("/gateway/deployment/delete", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ id: d.id }),
                          }),
                        `removed ${d.model} (live within ~40s)`,
                      )
                    }
                  >
                    remove
                  </button>
                </Show>
              </li>
            )
          }}
        </For>
      </ul>

      <div class="flex items-center gap-2">
        <select class={selectCls} value={selection()} onChange={(e) => setSelection(e.currentTarget.value)}>
          <option value="">select model…</option>
          <For each={options()}>{(o) => <option value={o.value}>{`${o.group} · ${o.label}`}</option>}</For>
        </select>
        <button
          class={btnPrimary + " shrink-0"}
          disabled={busy() || !selection()}
          onClick={() => {
            const [provider, model] = selection().split("|")
            const body = JSON.stringify({ alias: props.name, provider, model })
            act(
              () =>
                j(isGroup() ? "/gateway/deployment" : "/gateway/route", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body,
                }),
              isGroup() ? `added to group (live within ~40s)` : `re-pointed (live within ~40s)`,
            )
          }}
        >
          {isGroup() ? "Add to group" : "Re-point"}
        </button>
        <button
          class={btn + " shrink-0"}
          disabled={busy()}
          onClick={() =>
            act(async () => {
              const r = await j("/gateway/test", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ alias: props.name }),
              })
              setNote(`served by ${r.apiBase ?? "?"} · "${String(r.content).slice(0, 40)}"`)
            }, "")
          }
        >
          Test
        </button>
      </div>
      <Show when={note()}>
        <p class="text-xs text-v2-text-text-faint">{note()}</p>
      </Show>
    </div>
  )
}

function JobsSection(props: { jobs: any; onRefresh: () => void }) {
  const [task, setTask] = createSignal("")
  const [alias, setAlias] = createSignal("grunt")
  const [n, setN] = createSignal(1)
  const [note, setNote] = createSignal("")
  return (
    <section class="flex flex-col gap-3">
      <h2 class="text-sm font-medium text-v2-text-text-strong">Jobs</h2>
      <div class={card}>
        <textarea
          class={selectCls}
          rows={2}
          placeholder="background task, e.g. add docstrings to every function in lib/"
          value={task()}
          onInput={(e) => setTask(e.currentTarget.value)}
        />
        <div class="flex items-center gap-2">
          <select class={selectCls} value={alias()} onChange={(e) => setAlias(e.currentTarget.value)}>
            <For each={["grunt", "iterate", "plan", "review", "cheap"]}>{(a) => <option value={a}>{a}</option>}</For>
          </select>
          <input
            class={selectCls + " w-20"}
            type="number"
            min="1"
            max="8"
            value={n()}
            onInput={(e) => setN(Number(e.currentTarget.value))}
          />
          <button
            class={btnPrimary + " shrink-0"}
            disabled={!task().trim()}
            onClick={() => {
              setNote("dispatching…")
              j("/gateway/jobs", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ task: task(), alias: alias(), n: n() }),
              })
                .then((r) => {
                  setNote(`dispatched into ${r.repo}`)
                  setTimeout(props.onRefresh, 1500)
                })
                .catch((e: Error) => setNote(`error: ${e.message}`))
            }}
          >
            Dispatch
          </button>
        </div>
        <Show when={note()}>
          <p class="text-xs text-v2-text-text-faint">{note()}</p>
        </Show>
      </div>
      <div class={card}>
        <div class="flex items-center justify-between">
          <span class="text-sm text-v2-text-text-faint">
            {props.jobs?.repo ?? "…"} · {props.jobs?.jobs?.length ?? 0} jobs
          </span>
          <button class={btn} onClick={props.onRefresh}>
            Refresh
          </button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-v2-text-text-faint">
                <th class="py-1 pr-3">id</th>
                <th class="py-1 pr-3">status</th>
                <th class="py-1 pr-3">alias</th>
                <th class="py-1 pr-3">spend</th>
                <th class="py-1">title</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.jobs?.jobs ?? []}>
                {(jb: any) => (
                  <tr class="border-t border-v2-border-border-faint text-v2-text-text-base">
                    <td class="py-1 pr-3 whitespace-nowrap">{jb.id}</td>
                    <td class="py-1 pr-3">
                      <span class={chip}>{jb.status}</span>
                    </td>
                    <td class="py-1 pr-3">{jb.alias}</td>
                    <td class="py-1 pr-3">${(jb.spend_usd ?? 0).toFixed(4)}</td>
                    <td class="py-1">{jb.title}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}

function CreditsSection(props: { credits: any }) {
  return (
    <section class="flex flex-col gap-3">
      <h2 class="text-sm font-medium text-v2-text-text-strong">Credits</h2>
      <div class={card}>
        <Show when={props.credits?.error}>
          <p class="text-xs text-v2-text-text-faint">unavailable: {props.credits.error}</p>
        </Show>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-xs text-v2-text-text-faint">
                <th class="py-1 pr-3">pool</th>
                <th class="py-1 pr-3">used</th>
                <th class="py-1 pr-3">balance</th>
                <th class="py-1 pr-3">expiry</th>
                <th class="py-1">notes</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.credits?.rows ?? []}>
                {(r: any) => (
                  <tr
                    class="border-t border-v2-border-border-faint text-v2-text-text-base"
                    classList={{ "text-v2-text-text-danger": (r.flags ?? []).includes("low") }}
                  >
                    <td class="py-1 pr-3">{r.pool}</td>
                    <td class="py-1 pr-3">{r.used == null ? "?" : `$${r.used.toFixed(2)}`}</td>
                    <td class="py-1 pr-3">{r.balance == null ? "—" : `$${r.balance.toFixed(0)}`}</td>
                    <td class="py-1 pr-3 whitespace-nowrap">
                      {r.expiry ? `${r.expiry}${r.days_to_expiry != null ? ` (${r.days_to_expiry}d)` : ""}` : "—"}
                    </td>
                    <td class="py-1 text-xs">{r.notes}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
