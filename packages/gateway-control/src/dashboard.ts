// Self-contained control dashboard served at /gateway/. No build step, no
// external assets — works on a phone over Tailscale. Talks only to the
// same-origin /gateway/* JSON API; secrets never reach the browser.
// Three screens: Routing (score-ranked pickers), Jobs (ledger + dispatch),
// Credits (pool table).
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>swarm control</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; background:#101014; color:#e6e6ea; padding:16px; max-width:760px; margin:0 auto; }
  h1 { font-size:18px; margin:8px 0 2px; }
  .sub { color:#8b8b96; font-size:13px; margin-bottom:12px; }
  nav { display:flex; gap:8px; margin-bottom:16px; }
  nav button { flex:1; }
  nav button.active { background:#2e6bd6; border-color:#2e6bd6; }
  .card { background:#1a1a21; border:1px solid #2a2a33; border-radius:12px; padding:14px; margin-bottom:12px; }
  .row { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .alias { font-weight:600; font-size:16px; }
  .badge { font-size:11px; padding:2px 8px; border-radius:99px; border:1px solid #3a3a46; color:#b9b9c6; }
  .badge.azure { border-color:#2e6bd6; color:#7fa8f0; } .badge.fireworks { border-color:#c2571f; color:#f0a06e; }
  .badge.vertex { border-color:#2e9e5b; color:#7fd6a4; } .badge.proxy { border-color:#8b5cf6; color:#c1a6fa; }
  .badge.bedrock { border-color:#d6a02e; color:#f0d07f; }
  .model { color:#a9a9b6; font-size:13px; word-break:break-all; margin-top:2px; }
  select, button, textarea, input { font:inherit; border-radius:8px; border:1px solid #3a3a46; background:#22222b; color:#e6e6ea; padding:8px 10px; }
  select, textarea, input { width:100%; margin-top:10px; }
  button { cursor:pointer; } button:disabled { opacity:.5; cursor:default; }
  button.primary { background:#2e6bd6; border-color:#2e6bd6; }
  .actions { display:flex; gap:8px; margin-top:10px; }
  .note { font-size:12px; color:#8b8b96; margin-top:8px; min-height:16px; }
  .ok { color:#7fd6a4; } .err { color:#f08080; } .warn { color:#f0d07f; } .low { color:#f08080; }
  .spin { display:inline-block; animation:r 1s linear infinite; } @keyframes r { to { transform:rotate(360deg); } }
  .tablewrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #2a2a33; white-space:nowrap; }
  th { color:#8b8b96; font-weight:500; }
  td.wrap { white-space:normal; word-break:break-word; }
  .st { padding:1px 7px; border-radius:99px; font-size:11px; border:1px solid #3a3a46; }
  .st.merged { color:#7fd6a4; border-color:#2e9e5b; } .st.done { color:#7fa8f0; border-color:#2e6bd6; }
  .st.failed { color:#f08080; border-color:#a04040; } .st.running, .st.claimed { color:#f0d07f; border-color:#d6a02e; }
  .scorehint { font-size:12px; color:#8b8b96; margin-top:6px; }
</style>
</head>
<body>
<h1>swarm control</h1>
<div class="sub" id="sub">loading…</div>
<nav>
  <button data-tab="routing" class="active">Routing</button>
  <button data-tab="jobs">Jobs</button>
  <button data-tab="credits">Credits</button>
</nav>
<div id="tab-routing"></div>
<div id="tab-jobs" style="display:none"></div>
<div id="tab-credits" style="display:none"></div>
<script>
const $ = (s, el=document) => el.querySelector(s);
let CATALOGS = null, SCORES = {};
const PROVIDERS = ["azure","fireworks","proxy","vertex","bedrock"];

async function j(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text.slice(0,200) }; }
  if (!r.ok) throw new Error(data.error || r.status);
  return data;
}

document.querySelectorAll("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("active", x === b));
  for (const t of ["routing","jobs","credits"]) $("#tab-" + t).style.display = (b.dataset.tab === t) ? "" : "none";
  if (b.dataset.tab === "jobs") loadJobs();
  if (b.dataset.tab === "credits") loadCredits();
});

// ---------- Routing ----------
function scoreOf(p, m) { const s = SCORES[p + "|" + m]; return s && s.score != null ? s.score : null; }
function optLabel(p, m) {
  const sc = scoreOf(p, m);
  const s = SCORES[p + "|" + m] || {};
  let extra = sc == null ? "" : " · " + sc;
  if (s.speed != null) extra += " · " + Math.round(s.speed) + " t/s";
  if (s.price != null) extra += " · $" + s.price.toFixed(2) + "/M";
  return m + extra;
}
function optionsHtml(current) {
  let html = "";
  const [cp, cm] = current.split("|");
  if (!(CATALOGS[cp] || []).includes(cm)) {
    html += '<optgroup label="current (' + cp + ')"><option value="' + current + '" selected>' + cm + "</option></optgroup>";
  }
  // recommended = top 5 scored models across all providers
  const all = [];
  for (const p of PROVIDERS) for (const m of (CATALOGS[p] || [])) {
    const sc = scoreOf(p, m); if (sc != null) all.push([sc, p, m]);
  }
  all.sort((a,b) => b[0]-a[0]);
  if (all.length) {
    html += '<optgroup label="★ recommended (score = intelligence/cost/speed)">';
    for (const [sc,p,m] of all.slice(0,5)) {
      const v = p + "|" + m; const sel = current === v ? " selected" : "";
      html += '<option value="' + v + '"' + sel + '>' + p + " · " + optLabel(p,m) + "</option>";
    }
    html += "</optgroup>";
  }
  for (const p of PROVIDERS) {
    const models = (CATALOGS[p] || []).slice()
      .sort((a,b) => (scoreOf(p,b) ?? -1) - (scoreOf(p,a) ?? -1));
    if (!models.length) continue;
    html += '<optgroup label="' + p + '">';
    for (const m of models) {
      const v = p + "|" + m;
      const sel = (current === v) ? " selected" : "";
      html += '<option value="' + v + '"' + sel + '>' + optLabel(p, m) + "</option>";
    }
    html += "</optgroup>";
  }
  return html;
}
function card(a) {
  const el = document.createElement("div");
  el.className = "card";
  const current = a.provider + "|" + a.model;
  const sc = scoreOf(a.provider, a.model);
  el.innerHTML =
    '<div class="row"><span class="alias">' + a.name + (sc != null ? ' <span class="badge">score ' + sc + "</span>" : "") + '</span>' +
    '<span class="badge ' + a.provider + '">' + a.provider + "</span></div>" +
    '<div class="model">' + a.model + "</div>" +
    '<select>' + optionsHtml(current) + "</select>" +
    '<div class="actions">' +
    '<button class="primary apply" disabled>Apply</button>' +
    '<button class="test">Test</button></div>' +
    '<div class="note"></div>';
  const sel = $("select", el), apply = $(".apply", el), test = $(".test", el), note = $(".note", el);
  sel.onchange = () => { apply.disabled = sel.value === current; };
  apply.onclick = async () => {
    const [provider, model] = sel.value.split("|");
    apply.disabled = true; note.className = "note";
    note.innerHTML = '<span class="spin">◌</span> re-pointing ' + a.name + " → " + model + " …";
    try {
      await j("/gateway/route", { method: "POST", headers: {"content-type":"application/json"},
        body: JSON.stringify({ alias: a.name, provider, model }) });
      note.innerHTML = '<span class="ok">re-pointed.</span> takes effect within ~40s (router sync). Use Test to confirm.';
      $(".model", el).textContent = model;
      const badge = el.querySelectorAll(".badge")[el.querySelectorAll(".badge").length-1];
      badge.textContent = provider; badge.className = "badge " + provider;
    } catch (e) { note.innerHTML = '<span class="err">' + e.message + "</span>"; apply.disabled = false; }
  };
  test.onclick = async () => {
    test.disabled = true; note.className = "note";
    note.innerHTML = '<span class="spin">◌</span> running completion via ' + a.name + " …";
    try {
      const r = await j("/gateway/test", { method: "POST", headers: {"content-type":"application/json"},
        body: JSON.stringify({ alias: a.name }) });
      note.innerHTML = '<span class="ok">served by ' + (r.apiBase || "?") + '</span> · "' + r.content.slice(0,40) + '"';
    } catch (e) { note.innerHTML = '<span class="err">' + e.message + "</span>"; }
    test.disabled = false;
  };
  return el;
}
async function loadRouting() {
  try {
    const [state, catalogs] = await Promise.all([j("/gateway/state"), j("/gateway/catalogs")]);
    CATALOGS = catalogs;
    try { SCORES = (await j("/gateway/scores")).byKey || {}; } catch (e) { SCORES = {}; }
    $("#sub").textContent = state.aliases.length + " aliases · gateway " + state.gateway +
      " · " + Object.values(SCORES).filter(s => s.score != null).length + " models scored (Artificial Analysis)";
    const wrap = $("#tab-routing"); wrap.innerHTML = "";
    for (const a of state.aliases) wrap.appendChild(card(a));
    const hint = document.createElement("div"); hint.className = "scorehint";
    hint.textContent = "score = weighted intelligence (.5) / cost (.3) / speed (.2), data: artificialanalysis.ai; fireworks speeds are fireworks-hosted medians";
    wrap.appendChild(hint);
    const errs = Object.entries(catalogs.errors || {}).filter(([,v]) => v);
    if (errs.length) {
      const d = document.createElement("div"); d.className = "sub";
      d.textContent = "catalog gaps: " + errs.map(([k,v]) => k + " (" + v + ")").join(" · ");
      wrap.appendChild(d);
    }
  } catch (e) { $("#sub").innerHTML = '<span class="err">' + e.message + "</span>"; }
}

// ---------- Jobs ----------
async function loadJobs() {
  const wrap = $("#tab-jobs");
  wrap.innerHTML = '<div class="card"><div class="alias">Dispatch background job</div>' +
    '<textarea id="task" rows="3" placeholder="task, e.g. add docstrings to every function in lib/"></textarea>' +
    '<div class="row"><select id="jalias" style="flex:1"><option>grunt</option><option>build</option><option>review</option><option>cheap</option></select>' +
    '<input id="jn" type="number" value="1" min="1" max="8" style="width:80px"></div>' +
    '<div class="actions"><button class="primary" id="go">Dispatch</button></div>' +
    '<div class="note" id="jnote"></div></div>' +
    '<div class="card"><div class="row"><span class="alias">Ledger</span><button id="refresh">Refresh</button></div>' +
    '<div class="tablewrap"><table id="jt"><thead><tr><th>id</th><th>status</th><th>alias</th><th>spend</th><th>branch</th><th>title</th></tr></thead><tbody></tbody></table></div>' +
    '<div class="note" id="lnote"></div></div>';
  $("#go").onclick = async () => {
    const task = $("#task").value.trim();
    if (!task) return;
    $("#jnote").innerHTML = '<span class="spin">◌</span> dispatching…';
    try {
      const r = await j("/gateway/jobs", { method:"POST", headers:{"content-type":"application/json"},
        body: JSON.stringify({ task, alias: $("#jalias").value, n: Number($("#jn").value) }) });
      $("#jnote").innerHTML = '<span class="ok">dispatched into ' + r.repo + "</span> — same path as swarm run; watch the ledger.";
      setTimeout(refreshLedger, 1500);
    } catch (e) { $("#jnote").innerHTML = '<span class="err">' + e.message + "</span>"; }
  };
  $("#refresh").onclick = refreshLedger;
  await refreshLedger();
}
async function refreshLedger() {
  try {
    const { repo, jobs } = await j("/gateway/jobs");
    $("#lnote").textContent = repo + " · " + jobs.length + " jobs";
    const tb = $("#jt tbody"); tb.innerHTML = "";
    for (const jb of jobs) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + jb.id + '</td><td><span class="st ' + jb.status + '">' + jb.status + "</span></td><td>" +
        (jb.alias||"") + "</td><td>$" + (jb.spend_usd||0).toFixed(4) + "</td><td>" + (jb.branch||"") +
        '</td><td class="wrap">' + (jb.title||"") + "</td>";
      tb.appendChild(tr);
    }
  } catch (e) { $("#lnote").innerHTML = '<span class="err">' + e.message + "</span>"; }
}

// ---------- Credits ----------
async function loadCredits() {
  const wrap = $("#tab-credits");
  wrap.innerHTML = '<div class="card"><div class="alias">Credit pools</div><div class="note" id="cnote"><span class="spin">◌</span> collecting…</div>' +
    '<div class="tablewrap"><table id="ct"><thead><tr><th>pool</th><th>type</th><th>used</th><th>balance</th><th>expiry</th><th>notes</th></tr></thead><tbody></tbody></table></div></div>' +
    '<div class="card" id="pm" style="display:none"><div class="alias">Per-model burn (gateway)</div><div class="tablewrap"><table id="pmt"><tbody></tbody></table></div></div>';
  try {
    const data = await j("/gateway/credits");
    $("#cnote").textContent = "generated " + (data.generated || "");
    const tb = $("#ct tbody"); tb.innerHTML = "";
    for (const r of data.rows || []) {
      const tr = document.createElement("tr");
      const cls = (r.flags||[]).includes("low") ? "low" : ((r.flags||[]).includes("expiring") ? "warn" : "");
      tr.className = cls;
      const exp = r.expiry ? r.expiry + (r.days_to_expiry != null ? " (" + r.days_to_expiry + "d)" : "") : "—";
      tr.innerHTML = "<td>" + r.pool + "</td><td>" + r.type + "</td><td>" +
        (r.used == null ? "?" : "$" + r.used.toFixed(2)) + "</td><td>" +
        (r.balance == null ? "—" : "$" + r.balance.toFixed(0)) + "</td><td>" + exp +
        '</td><td class="wrap">' + (r.notes||"") + "</td>";
      tb.appendChild(tr);
    }
    const pm = (data.rows || [])[0]?.per_model || {};
    const entries = Object.entries(pm).sort((a,b) => b[1]-a[1]).slice(0,12);
    if (entries.length) {
      $("#pm").style.display = "";
      const tb2 = $("#pmt tbody"); tb2.innerHTML = "";
      for (const [k,v] of entries) {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td class='wrap'>" + k + "</td><td>$" + v.toFixed(4) + "</td>";
        tb2.appendChild(tr);
      }
    }
  } catch (e) { $("#cnote").innerHTML = '<span class="err">' + e.message + "</span>"; }
}

loadRouting();
</script>
</body>
</html>`
