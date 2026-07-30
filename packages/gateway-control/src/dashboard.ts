// Self-contained routing dashboard served at /gateway/. No build step, no
// external assets — works on a phone over Tailscale. Talks only to the
// same-origin /gateway/* JSON API; secrets never reach the browser.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>swarm · routing</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; background:#101014; color:#e6e6ea; padding:16px; max-width:720px; margin:0 auto; }
  h1 { font-size:18px; margin:8px 0 2px; }
  .sub { color:#8b8b96; font-size:13px; margin-bottom:16px; }
  .card { background:#1a1a21; border:1px solid #2a2a33; border-radius:12px; padding:14px; margin-bottom:12px; }
  .row { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .alias { font-weight:600; font-size:16px; }
  .badge { font-size:11px; padding:2px 8px; border-radius:99px; border:1px solid #3a3a46; color:#b9b9c6; }
  .badge.azure { border-color:#2e6bd6; color:#7fa8f0; } .badge.fireworks { border-color:#c2571f; color:#f0a06e; }
  .badge.vertex { border-color:#2e9e5b; color:#7fd6a4; } .badge.proxy { border-color:#8b5cf6; color:#c1a6fa; }
  .badge.bedrock { border-color:#d6a02e; color:#f0d07f; }
  .model { color:#a9a9b6; font-size:13px; word-break:break-all; margin-top:2px; }
  select, button { font:inherit; border-radius:8px; border:1px solid #3a3a46; background:#22222b; color:#e6e6ea; padding:8px 10px; }
  select { width:100%; margin-top:10px; }
  button { cursor:pointer; } button:disabled { opacity:.5; cursor:default; }
  button.primary { background:#2e6bd6; border-color:#2e6bd6; }
  .actions { display:flex; gap:8px; margin-top:10px; }
  .note { font-size:12px; color:#8b8b96; margin-top:8px; min-height:16px; }
  .ok { color:#7fd6a4; } .err { color:#f08080; }
  .spin { display:inline-block; animation:r 1s linear infinite; } @keyframes r { to { transform:rotate(360deg); } }
</style>
</head>
<body>
<h1>swarm · routing</h1>
<div class="sub" id="sub">loading gateway state…</div>
<div id="aliases"></div>
<script>
const $ = (s, el=document) => el.querySelector(s);
let CATALOGS = null;
const PROVIDERS = ["azure","fireworks","proxy","vertex","bedrock"];

async function j(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { error: text.slice(0,200) }; }
  if (!r.ok) throw new Error(data.error || r.status);
  return data;
}

function optionsHtml(current) {
  let html = "";
  // pin the current backend first so the select always reflects reality,
  // even when its provider catalog is unavailable (e.g. bedrock w/o creds)
  const [cp, cm] = current.split("|");
  if (!(CATALOGS[cp] || []).includes(cm)) {
    html += '<optgroup label="current (' + cp + ')"><option value="' + current + '" selected>' + cm + "</option></optgroup>";
  }
  for (const p of PROVIDERS) {
    const models = CATALOGS[p] || [];
    if (!models.length) continue;
    html += '<optgroup label="' + p + '">';
    for (const m of models) {
      const v = p + "|" + m;
      const sel = (current === v) ? " selected" : "";
      html += '<option value="' + v + '"' + sel + '>' + m + "</option>";
    }
    html += "</optgroup>";
  }
  return html;
}

function card(a) {
  const el = document.createElement("div");
  el.className = "card";
  const current = a.provider + "|" + a.model;
  el.innerHTML =
    '<div class="row"><span class="alias">' + a.name + '</span>' +
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
      const badge = $(".badge", el); badge.textContent = provider; badge.className = "badge " + provider;
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

async function load() {
  try {
    const [state, catalogs] = await Promise.all([j("/gateway/state"), j("/gateway/catalogs")]);
    CATALOGS = catalogs;
    $("#sub").textContent = state.aliases.length + " aliases · gateway " + state.gateway;
    const wrap = $("#aliases"); wrap.innerHTML = "";
    for (const a of state.aliases) wrap.appendChild(card(a));
    const errs = Object.entries(catalogs.errors || {}).filter(([,v]) => v);
    if (errs.length) {
      const d = document.createElement("div"); d.className = "sub";
      d.textContent = "catalog gaps: " + errs.map(([k,v]) => k + " (" + v + ")").join(" · ");
      wrap.appendChild(d);
    }
  } catch (e) { $("#sub").innerHTML = '<span class="err">' + e.message + "</span>"; }
}
load();
</script>
</body>
</html>`
