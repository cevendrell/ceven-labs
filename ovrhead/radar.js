/* ══════════════════════════════════════════════════════════════════════════
   Flight radar: a 3D airspace over one ADS-B antenna in Aarhus.

   mountRadar(host, opts) builds the whole thing inside `host` and returns
   { stop() }. The same file runs on cevendrell.com (Tech → Flight Radar) and
   on OvrHead's Week page; each copy is identical, the page passes its theme.

   Data, in order:
     1. the receiver's own tar1090 (opts.live), when the browser may reach it
     2. the antenna's daily recording, published by OvrHead as Parquet files
        (one snapshot of every aircraft each 30 s); opts.days limits the choice
     3. synthetic traffic (opts.demo), or when nothing else answers

   Scale: 1 unit = 1 km; altitude is drawn 6× taller so it reads at this range.
   Theme: CSS custom properties on the host (see CSS below), plus opts.colors
   for the 3D scene.
   ══════════════════════════════════════════════════════════════════════════ */
import * as T from 'https://unpkg.com/three@0.160.0/build/three.module.js';

const RECORD_BASE = 'https://raw.githubusercontent.com/cevendrell/flight-macro/main/data/adsb/';
const HYPARQUET   = 'https://cdn.jsdelivr.net/npm/hyparquet@1.31.4/+esm';
const HYPARQUET_Z = 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.2/+esm';
const RANGE_KM = 300, POLL_MS = 3000, STATS_MS = 10000, TIMEOUT_MS = 4500, ALT_X = 6, TRAIL_N = 48;
const FALLBACK_RX = { lat: 56.1629, lon: 10.2039 };
const TZ = 'Europe/Copenhagen';

const DEFAULT_COLORS = {
  clear: '#050816', floorIn: 'rgba(30,60,120,0.55)', floorMid: 'rgba(12,24,60,0.35)', floorOut: 'rgba(5,8,22,0)',
  ring: '#6a8db5', coast: '#e8dcc4', mast: '#e8dcc4', tip: '#ffd9a0'
};

/* ── Altitude palette and formatting ── */
const ALT_STOPS = [[0, '#ff4444'], [5000, '#ff8c1a'], [10000, '#ffd633'], [20000, '#66cc44'], [30000, '#33cccc'], [40000, '#4488ff']];
function altitudeColor(ft) {
  if (ft == null || ft === 'ground') return '#8a8f99';
  let c = ALT_STOPS[0][1]; for (const [a, col] of ALT_STOPS) if (ft >= a) c = col; return c;
}
const fmtAlt = ft => ft === 'ground' ? 'GND' : ft == null ? '—' : ft >= 1000 ? (ft / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : Math.round(ft);
const fmtSpeed = kt => kt == null ? '—' : Math.round(kt) + ' kt';
const fmtDist = km => km == null ? '—' : km < 10 ? km.toFixed(1) + ' km' : Math.round(km) + ' km';
const fmtRssi = db => db == null ? '—' : db.toFixed(1);
const fmtUptime = s => { if (s == null) return '—'; const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`; };
const fmtClock = sec => new Date(sec * 1000).toLocaleTimeString('en-GB', { hour12: false, timeZone: TZ });
const hourLocal = ts => +new Date(ts * 1000).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: TZ }) % 24;
const dayLabel = d => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function haversineKm(a1, o1, a2, o2) { const R = 6371, r = d => d * Math.PI / 180, dA = r(a2 - a1), dO = r(o2 - o1); const h = Math.sin(dA / 2) ** 2 + Math.cos(r(a1)) * Math.cos(r(a2)) * Math.sin(dO / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
function bearingDeg(a1, o1, a2, o2) { const r = d => d * Math.PI / 180, y = Math.sin(r(o2 - o1)) * Math.cos(r(a2)), x = Math.cos(r(a1)) * Math.sin(r(a2)) - Math.sin(r(a1)) * Math.cos(r(a2)) * Math.cos(r(o2 - o1)); return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; }
async function fetchJSON(url) {
  const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { const r = await fetch(url, { cache: 'no-store', mode: 'cors', signal: ctrl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
const normalize = raw => (raw.aircraft || raw.ac || []).map(a => ({
  hex: a.hex || '?', flight: (a.flight || '').trim(),
  altFt: a.alt_baro === 'ground' ? 'ground' : (a.alt_baro ?? a.alt_geom ?? null),
  gs: a.gs ?? null, track: a.track ?? null, lat: a.lat ?? null, lon: a.lon ?? null,
  rssi: a.rssi ?? null, squawk: a.squawk ?? null, stale: (a.seen_pos ?? a.seen ?? 0) > 60
}));

/* ── Styles, injected once. Everything is scoped under .rdr and themed by variables. ── */
const CSS = `
.rdr { --rdr-bg:#050816; --rdr-panel:rgba(255,255,255,0.02); --rdr-ink:#ececea; --rdr-ink2:#a8a9af; --rdr-mute:#6b6d75;
  --rdr-line:rgba(255,255,255,0.08); --rdr-accent:#6a8db5; --rdr-accent-ink:#fff; --rdr-hl:#e8dcc4; --rdr-live:#22c55e; --rdr-replay:#fbbf24;
  --rdr-chip:rgba(5,8,22,0.78); --rdr-radius:16px; --rdr-ctl:999px; --rdr-sans:Inter,system-ui,sans-serif; --rdr-mono:'JetBrains Mono',ui-monospace,monospace;
  --rdr-h:clamp(460px,72vh,780px);
  font-family:var(--rdr-sans); color:var(--rdr-ink); border:1px solid var(--rdr-line); border-radius:var(--rdr-radius); overflow:hidden; background:var(--rdr-bg); }
.rdr *{box-sizing:border-box}
.rdr-kpis { display:grid; grid-template-columns:repeat(6,1fr); border-bottom:1px solid var(--rdr-line); }
.rdr-kpi { padding:1rem 1.2rem; border-right:1px solid var(--rdr-line); display:flex; flex-direction:column; gap:.35rem; min-width:0; }
.rdr-kpi:last-child { border-right:none; }
.rdr-kpi b { font-size:clamp(1.25rem,2vw,1.7rem); font-weight:800; letter-spacing:-.03em; line-height:1; font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.rdr-kpi b small { font-size:.55em; font-weight:500; color:var(--rdr-mute); margin-left:.2rem; }
.rdr-kpi span { font-family:var(--rdr-mono); font-size:.6rem; letter-spacing:.12em; text-transform:uppercase; color:var(--rdr-mute); }
.rdr-stage { position:relative; height:var(--rdr-h); overflow:hidden; touch-action:pan-y; cursor:grab;
  background:radial-gradient(ellipse at 50% 60%, color-mix(in srgb, var(--rdr-accent) 14%, var(--rdr-bg)) 0%, var(--rdr-bg) 70%); }
.rdr-stage:active { cursor:grabbing; }
.rdr-stage canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
.rdr-stage::after { content:''; position:absolute; inset:0; pointer-events:none; background:radial-gradient(ellipse at 50% 50%, transparent 58%, rgba(0,0,0,.55) 100%); }
.rdr-labels { position:absolute; inset:0; pointer-events:none; z-index:2; }
.rdr-tag, .rdr-place { position:absolute; top:0; left:0; white-space:nowrap; will-change:transform; font-family:var(--rdr-mono); transition:opacity .3s; }
.rdr-tag { font-size:.6rem; letter-spacing:.05em; color:#fff; padding:.15rem .4rem; border-radius:4px; background:rgba(0,0,0,.7); border-left:2px solid var(--ac,var(--rdr-accent)); }
.rdr-tag.sel { font-size:.7rem; box-shadow:0 0 0 1px var(--ac); }
.rdr-place { font-size:.55rem; letter-spacing:.2em; text-transform:uppercase; color:color-mix(in srgb, var(--rdr-hl) 60%, transparent); }
.rdr-place.card { font-size:.75rem; font-weight:700; letter-spacing:0; color:var(--rdr-accent); }
.rdr-hud { position:absolute; z-index:3; display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; font-family:var(--rdr-mono); font-size:.62rem; letter-spacing:.12em; text-transform:uppercase; color:var(--rdr-mute); }
.rdr-tl { top:1rem; left:1rem; } .rdr-tr { top:1rem; right:1rem; flex-direction:column; align-items:flex-end; }
.rdr-bl { bottom:1rem; left:1rem; flex-direction:column; align-items:flex-start; gap:.3rem; }
.rdr-br { bottom:1.35rem; right:4.6rem; text-transform:none; letter-spacing:.04em; opacity:.7; }
.rdr-mode { padding:.35rem .7rem; border-radius:var(--rdr-ctl); font-weight:600; background:var(--rdr-chip); border:1px solid var(--rdr-line); color:var(--rdr-ink2); }
.rdr-mode[data-state=live] { color:var(--rdr-live); border-color:color-mix(in srgb, var(--rdr-live) 45%, transparent); }
.rdr-mode[data-state=record] { color:var(--rdr-replay); border-color:color-mix(in srgb, var(--rdr-replay) 45%, transparent); }
.rdr-clock { font-size:1rem; letter-spacing:.08em; color:var(--rdr-hl); font-variant-numeric:tabular-nums; }
.rdr-seg { display:inline-flex; padding:2px; border-radius:var(--rdr-ctl); background:var(--rdr-chip); border:1px solid var(--rdr-line); }
.rdr-seg button { font:inherit; letter-spacing:.1em; text-transform:uppercase; color:var(--rdr-mute); background:none; border:0; border-radius:var(--rdr-ctl); padding:.35rem .7rem; cursor:pointer; }
.rdr-seg button[aria-pressed=true] { background:var(--rdr-accent); color:var(--rdr-accent-ink); }
.rdr-seg .lbl { padding:.35rem .4rem .35rem .7rem; color:var(--rdr-mute); }
.rdr-info { font-size:.56rem; letter-spacing:.06em; text-transform:none; color:var(--rdr-ink2); min-height:1em; }
.rdr-grad { display:block; width:180px; height:6px; border-radius:3px; background:linear-gradient(90deg,#ff4444 0 12.5%,#ff8c1a 12.5% 25%,#ffd633 25% 50%,#66cc44 50% 75%,#33cccc 75% 100%); }
.rdr-gradl { display:flex; justify-content:space-between; width:180px; font-size:.52rem; letter-spacing:.04em; }
.rdr-card { position:absolute; z-index:3; top:7.6rem; right:1rem; width:236px; padding:.9rem 1rem; border-radius:12px; background:var(--rdr-chip); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
  border:1px solid var(--rdr-line); border-top:2px solid var(--ac,var(--rdr-accent)); font-family:var(--rdr-mono); font-size:.68rem; color:var(--rdr-ink2); }
.rdr-card[hidden] { display:none; }
.rdr-card b { display:block; font-size:1.05rem; color:var(--rdr-hl); letter-spacing:.04em; }
.rdr-card .hex { color:var(--rdr-mute); font-size:.6rem; letter-spacing:.12em; }
.rdr-card dl { display:grid; grid-template-columns:auto 1fr; gap:.3rem .8rem; margin:.7rem 0 .6rem; }
.rdr-card dt { color:var(--rdr-mute); } .rdr-card dd { margin:0; color:var(--rdr-ink); text-align:right; }
.rdr-card a { color:var(--rdr-accent); }
.rdr-compass { position:absolute; z-index:3; right:1rem; bottom:.9rem; width:46px; height:46px; padding:0; border:1px solid var(--rdr-line); border-radius:50%; background:var(--rdr-chip); cursor:pointer; }
.rdr-compass:hover { border-color:var(--rdr-accent); }
.rdr-compass svg { width:100%; height:100%; display:block; }
.rdr-compass circle { fill:none; stroke:var(--rdr-line); } .rdr-compass g { transform-origin:20px 20px; }
.rdr-compass .n { fill:#ff5a4f; } .rdr-compass .s { fill:color-mix(in srgb, var(--rdr-hl) 55%, transparent); }
.rdr-compass text { font:700 5.5px var(--rdr-mono); fill:#fff; text-anchor:middle; }
.rdr-fallback { position:absolute; inset:0; display:grid; place-items:center; color:var(--rdr-mute); font-size:.85rem; z-index:4; }
.rdr-fallback[hidden] { display:none; }
.rdr-time { display:flex; align-items:center; gap:.75rem; padding:.7rem 1.25rem .55rem; border-top:1px solid var(--rdr-line); border-bottom:1px solid var(--rdr-line); background:var(--rdr-panel);
  font-family:var(--rdr-mono); font-size:.62rem; letter-spacing:.1em; color:var(--rdr-mute); }
.rdr-time[hidden] { display:none; }
.rdr-time.is-live .rdr-play, .rdr-time.is-live .rdr-speed { display:none; }
.rdr-play { flex:none; width:30px; height:30px; border-radius:50%; border:1px solid var(--rdr-line); background:var(--rdr-chip); cursor:pointer; display:grid; place-items:center; padding:0; }
.rdr-play svg { width:11px; height:11px; fill:var(--rdr-hl); } .rdr-play .pl { display:none; }
.rdr-play[aria-pressed=true] .pa { display:none; } .rdr-play[aria-pressed=true] .pl { display:inline; }
.rdr-day { flex:none; font:inherit; color:var(--rdr-ink); background:var(--rdr-chip); border:1px solid var(--rdr-line); border-radius:var(--rdr-ctl); padding:.4rem .7rem; cursor:pointer; }
.rdr-scrub { position:relative; flex:1; min-width:0; height:40px; }
.rdr-hist { position:absolute; left:0; right:0; top:2px; width:100%; height:22px; fill:color-mix(in srgb, var(--rdr-accent) 45%, transparent); }
.rdr-scrub input { position:absolute; left:0; right:0; top:4px; width:100%; height:22px; margin:0; -webkit-appearance:none; appearance:none; background:transparent; cursor:pointer; }
.rdr-scrub input::-webkit-slider-runnable-track { height:22px; background:linear-gradient(transparent 20px, var(--rdr-line) 20px); }
.rdr-scrub input::-moz-range-track { height:22px; background:linear-gradient(transparent 20px, var(--rdr-line) 20px); }
.rdr-scrub input::-webkit-slider-thumb { -webkit-appearance:none; width:3px; height:22px; background:var(--rdr-hl); border-radius:2px; box-shadow:0 0 10px var(--rdr-hl); }
.rdr-scrub input::-moz-range-thumb { width:3px; height:22px; border:0; background:var(--rdr-hl); border-radius:2px; }
.rdr-ticks { position:absolute; left:0; right:0; bottom:0; height:12px; } .rdr-ticks span { position:absolute; transform:translateX(-50%); font-size:.55rem; }
.rdr-live { flex:none; font:inherit; letter-spacing:.1em; text-transform:uppercase; color:var(--rdr-live); background:none; border:1px solid color-mix(in srgb, var(--rdr-live) 45%, transparent); border-radius:var(--rdr-ctl); padding:.4rem .7rem; cursor:pointer; }
.rdr-live[hidden], .rdr-speed[hidden] { display:none; }
.rdr-list { padding:1.25rem 1.25rem 1.4rem; }
.rdr-list header { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:.8rem; gap:.5rem; flex-wrap:wrap; }
.rdr-list h3 { margin:0; font-size:.75rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--rdr-accent); }
.rdr-list header span { font-family:var(--rdr-mono); font-size:.7rem; color:var(--rdr-mute); letter-spacing:.08em; }
.rdr-list header b { color:var(--rdr-hl); }
.rdr-scroll { max-height:360px; overflow:auto; border:1px solid var(--rdr-line); border-radius:12px; background:var(--rdr-panel); }
.rdr-table { width:100%; border-collapse:collapse; font-size:.78rem; min-width:460px; }
.rdr-table thead { position:sticky; top:0; z-index:2; background:var(--rdr-bg); }
.rdr-table th { text-align:left; padding:.6rem .75rem; font-family:var(--rdr-mono); font-size:.6rem; letter-spacing:.14em; text-transform:uppercase; color:var(--rdr-accent); font-weight:600; border-bottom:1px solid var(--rdr-line); }
.rdr-table td { padding:.55rem .75rem; border-bottom:1px solid var(--rdr-line); color:var(--rdr-ink2); font-family:var(--rdr-mono); font-size:.74rem; white-space:nowrap; font-variant-numeric:tabular-nums; }
.rdr-table tbody tr[data-hex] { cursor:pointer; } .rdr-table tbody tr[data-hex]:hover td { background:rgba(255,255,255,.03); }
.rdr-table tr.sel td { background:color-mix(in srgb, var(--rdr-accent) 18%, transparent); }
.rdr-table td.f { color:var(--rdr-hl); font-weight:600; } .rdr-table td.h { color:var(--rdr-mute); text-transform:uppercase; }
.rdr-table td.a { color:var(--rdr-ink); } .rdr-table .dot { display:inline-block; width:6px; height:6px; border-radius:50%; margin-right:.4rem; vertical-align:middle; box-shadow:0 0 4px currentColor; }
.rdr-empty { padding:2.2rem 1rem; text-align:center; color:var(--rdr-mute); font-style:italic; font-family:var(--rdr-sans) !important; white-space:normal !important; }
@media (max-width:900px) { .rdr-kpis { grid-template-columns:repeat(3,1fr); } .rdr-kpi:nth-child(3n){border-right:none} .rdr-kpi:nth-child(-n+3){border-bottom:1px solid var(--rdr-line)} }
@media (max-width:640px) {
  .rdr { --rdr-h:460px; }
  .rdr-br, .rdr-info { display:none; }
  .rdr-card { top:auto; bottom:4.2rem; right:.75rem; left:.75rem; width:auto; }
  .rdr-tl { right:.75rem; left:.75rem; top:.75rem; } .rdr-tr { top:3.2rem; right:.75rem; } .rdr-bl { left:.75rem; bottom:.75rem; }
  .rdr-compass { right:.75rem; bottom:.75rem; width:40px; height:40px; }
  .rdr-time { flex-wrap:wrap; padding:.7rem .75rem .5rem; } .rdr-scrub { order:5; flex-basis:100%; }
  .rdr-kpis { grid-template-columns:repeat(2,1fr); } .rdr-kpi:nth-child(3n){border-right:1px solid var(--rdr-line)} .rdr-kpi:nth-child(2n){border-right:none} .rdr-kpi:nth-child(-n+4){border-bottom:1px solid var(--rdr-line)}
}
@media (prefers-reduced-motion:reduce) { .rdr-tag, .rdr-place { transition:none; } }
`;

const MARKUP = `
<div class="rdr-kpis">
  <div class="rdr-kpi"><b data-k="ac">—</b><span>aircraft heard</span></div>
  <div class="rdr-kpi"><b data-k="pos">—</b><span>with position</span></div>
  <div class="rdr-kpi"><b data-k="max">—</b><span>farthest now</span></div>
  <div class="rdr-kpi"><b data-k="k4">—</b><span data-l="k4">—</span></div>
  <div class="rdr-kpi"><b data-k="k5">—</b><span data-l="k5">—</span></div>
  <div class="rdr-kpi"><b data-k="k6">—</b><span data-l="k6">—</span></div>
</div>
<div class="rdr-stage">
  <div class="rdr-labels" aria-hidden="true"></div>
  <div class="rdr-hud rdr-tl"><span class="rdr-mode" data-state="loading">Connecting</span><span class="rdr-clock">--:--:--</span></div>
  <div class="rdr-hud rdr-tr">
    <div class="rdr-seg" role="group" aria-label="View"><button type="button" data-view="radar" aria-pressed="false">Radar</button><button type="button" data-view="tilt" aria-pressed="true">Tilt</button><button type="button" data-view="low" aria-pressed="false">Low</button></div>
    <div class="rdr-seg" role="group" aria-label="Flight paths"><span class="lbl">Paths</span><button type="button" data-paths="off" aria-pressed="true">Off</button><button type="button" data-paths="day" aria-pressed="false">Day</button><button type="button" data-paths="week" aria-pressed="false">Week</button></div>
    <span class="rdr-info"></span>
  </div>
  <div class="rdr-card" hidden></div>
  <div class="rdr-hud rdr-bl"><span>Altitude</span><i class="rdr-grad"></i><span class="rdr-gradl"><em>0</em><em>10k</em><em>20k</em><em>30k</em><em>40k ft</em></span></div>
  <div class="rdr-hud rdr-br">Drag to turn · click, then scroll to zoom · tap a flight · rings every 75 km</div>
  <button type="button" class="rdr-compass" aria-label="Turn to face north" title="Face north"><svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18.5"/><g><path d="M20 6 L24.5 20 L15.5 20 Z" class="n"/><path d="M20 34 L24.5 20 L15.5 20 Z" class="s"/><text x="20" y="5.2">N</text></g></svg></button>
  <p class="rdr-fallback" hidden>This browser can’t draw the 3D view. The table below still updates.</p>
</div>
<div class="rdr-time" hidden>
  <button type="button" class="rdr-play" aria-label="Pause" aria-pressed="false"><svg viewBox="0 0 12 12" aria-hidden="true"><rect class="pa" x="2" y="1.5" width="2.6" height="9" rx="0.6"/><rect class="pa" x="7.4" y="1.5" width="2.6" height="9" rx="0.6"/><path class="pl" d="M3 1.5 L10.5 6 L3 10.5 Z"/></svg></button>
  <select class="rdr-day" aria-label="Day"></select>
  <div class="rdr-scrub"><svg class="rdr-hist" viewBox="0 0 144 24" preserveAspectRatio="none" aria-hidden="true"></svg><input type="range" min="0" max="1" step="30" value="0" aria-label="Time of day"><div class="rdr-ticks" aria-hidden="true"></div></div>
  <span class="rdr-seg rdr-speed" hidden><button type="button" data-spd="1" aria-pressed="true">1×</button><button type="button" data-spd="10" aria-pressed="false">10×</button><button type="button" data-spd="60" aria-pressed="false">60×</button></span>
  <button type="button" class="rdr-live" hidden>Back to live</button>
</div>
<div class="rdr-list">
  <header><h3>In range</h3><span><b class="rdr-count">—</b> aircraft · nearest first</span></header>
  <div class="rdr-scroll"><table class="rdr-table"><thead><tr><th>Flight</th><th>Hex</th><th>Alt</th><th>Spd</th><th>Dist</th><th>Signal</th></tr></thead>
  <tbody><tr><td colspan="6" class="rdr-empty">Waiting for the first message…</td></tr></tbody></table></div>
</div>`;

export function mountRadar(host, opts = {}) {
  if (!document.getElementById('rdr-css')) { const st = document.createElement('style'); st.id = 'rdr-css'; st.textContent = CSS; document.head.appendChild(st); }
  const C = Object.assign({}, DEFAULT_COLORS, opts.colors || {});
  const onStatus = opts.onStatus || (() => {});
  const onDay = opts.onDay || (() => {});
  host.classList.add('rdr');
  host.innerHTML = MARKUP;
  const q = s => host.querySelector(s), qa = s => [...host.querySelectorAll(s)];
  const K = Object.fromEntries(qa('[data-k]').map(e => [e.dataset.k, e]));
  const L = Object.fromEntries(qa('[data-l]').map(e => [e.dataset.l, e]));
  const sky = q('.rdr-stage'), skyLabels = q('.rdr-labels'), skyMode = q('.rdr-mode'), skyClock = q('.rdr-clock'), skyCard = q('.rdr-card');
  const skyCompass = q('.rdr-compass'), skyNeedle = q('.rdr-compass g'), skyTime = q('.rdr-time'), skyRange = q('.rdr-scrub input'), skyDay = q('.rdr-day');
  const skyPlay = q('.rdr-play'), skyHist = q('.rdr-hist'), skyTicks = q('.rdr-ticks'), skyLive = q('.rdr-live'), skySpeed = q('.rdr-speed'), skyInfo = q('.rdr-info');
  const tbody = q('.rdr-table tbody'), count = q('.rdr-count');

  let stopped = false; const timers = new Set(), observers = [];
  const every = (f, ms) => { const id = setInterval(f, ms); timers.add(id); return id; };
  const clear = id => { clearInterval(id); timers.delete(id); };

  /* ── State ── */
  let rx = FALLBACK_RX, mode = null, simT = 0, speed = 1, selected = null, onScreen = false, built = false;
  const planes = new Map();
  const kmX = lon => (lon - rx.lon) * 111.32 * Math.cos(rx.lat * Math.PI / 180);
  const kmN = lat => (lat - rx.lat) * 110.574;
  const altY = ft => ft === 'ground' || ft == null ? 0.3 : Math.max(0.3, ft * 0.0003048 * ALT_X);

  /* ── Scene ── */
  let renderer, scene, camera, raycaster, arrowGeo, glowTex, raf = 0;
  const cam = { r: 520, pol: 0.95, az: 0, tween: null };
  function buildScene() {
    try { renderer = new T.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' }); }
    catch (e) { q('.rdr-fallback').hidden = false; return false; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.setClearColor(new T.Color(C.clear), 1);
    sky.prepend(renderer.domElement);
    scene = new T.Scene();
    scene.fog = new T.Fog(new T.Color(C.clear), 520, 1300);
    camera = new T.PerspectiveCamera(38, 1, 1, 4000);
    raycaster = new T.Raycaster();
    const fc = document.createElement('canvas'); fc.width = fc.height = 512;
    { const g = fc.getContext('2d'), gr = g.createRadialGradient(256, 256, 0, 256, 256, 256); gr.addColorStop(0, C.floorIn); gr.addColorStop(0.7, C.floorMid); gr.addColorStop(1, C.floorOut); g.fillStyle = gr; g.fillRect(0, 0, 512, 512); }
    const ftex = new T.CanvasTexture(fc); ftex.colorSpace = T.SRGBColorSpace;
    const floor = new T.Mesh(new T.CircleGeometry(RANGE_KM * 1.08, 96), new T.MeshBasicMaterial({ map: ftex, transparent: true, depthWrite: false }));
    floor.rotation.x = -Math.PI / 2; scene.add(floor);
    const ringMat = new T.LineBasicMaterial({ color: new T.Color(C.ring), transparent: true, opacity: 0.32 });
    for (let k = 1; k <= 4; k++) {
      const r = RANGE_KM * k / 4, pts = [];
      for (let i = 0; i <= 128; i++) { const a = i / 128 * Math.PI * 2; pts.push(new T.Vector3(r * Math.sin(a), 0.05, -r * Math.cos(a))); }
      scene.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), ringMat));
    }
    const ticks = [];
    for (let d = 0; d < 360; d += 10) { const a = d * Math.PI / 180, r0 = RANGE_KM * (d % 90 ? 0.97 : 0.92); ticks.push(new T.Vector3(r0 * Math.sin(a), 0.05, -r0 * Math.cos(a)), new T.Vector3(RANGE_KM * Math.sin(a), 0.05, -RANGE_KM * Math.cos(a))); }
    scene.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(ticks), ringMat));
    const cross = [new T.Vector3(-RANGE_KM, 0.04, 0), new T.Vector3(RANGE_KM, 0.04, 0), new T.Vector3(0, 0.04, -RANGE_KM), new T.Vector3(0, 0.04, RANGE_KM)];
    scene.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(cross), new T.LineBasicMaterial({ color: new T.Color(C.ring), transparent: true, opacity: 0.12 })));
    const mast = new T.Mesh(new T.CylinderGeometry(0.6, 1.2, 14, 12), new T.MeshBasicMaterial({ color: new T.Color(C.mast) })); mast.position.y = 7; scene.add(mast);
    const tip = new T.Mesh(new T.SphereGeometry(1.6, 16, 12), new T.MeshBasicMaterial({ color: new T.Color(C.tip) })); tip.position.y = 14.5; scene.add(tip);
    const gc = document.createElement('canvas'); gc.width = gc.height = 64;
    { const g = gc.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); }
    glowTex = new T.CanvasTexture(gc);
    arrowGeo = new T.ConeGeometry(2.2, 7, 3).rotateX(Math.PI / 2);
    fetchJSON(RECORD_BASE + 'coast.json').then(c => {
      if (stopped) return;
      const segs = [];
      for (const line of c.lines || []) for (let i = 1; i < line.length; i++) {
        const [o1, a1] = line[i - 1], [o2, a2] = line[i];
        segs.push(new T.Vector3(kmX(o1), 0.08, -kmN(a1)), new T.Vector3(kmX(o2), 0.08, -kmN(a2)));
      }
      scene.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(segs), new T.LineBasicMaterial({ color: new T.Color(C.coast), transparent: true, opacity: 0.55 })));
    }).catch(() => {});
    addPlaceLabels();
    setView('tilt', true);
    let drag = null, engaged = false;
    const el = renderer.domElement;
    el.addEventListener('pointerleave', () => { engaged = false; });
    el.addEventListener('pointerdown', e => { engaged = true; drag = { x: e.clientX, y: e.clientY, az: cam.az, pol: cam.pol, moved: false }; el.setPointerCapture(e.pointerId); cam.tween = null; });
    el.addEventListener('pointermove', e => {
      if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      cam.az = drag.az - dx * 0.006; cam.pol = Math.min(1.45, Math.max(0.02, drag.pol - dy * 0.005));
    });
    el.addEventListener('pointerup', e => { if (drag && !drag.moved) pick(e); drag = null; });
    el.addEventListener('pointercancel', () => { drag = null; });
    el.addEventListener('wheel', e => { if (!engaged && !e.ctrlKey) return; e.preventDefault(); cam.r = Math.min(1100, Math.max(120, cam.r * Math.exp(e.deltaY * 0.001))); cam.tween = null; }, { passive: false });
    const ro = new ResizeObserver(resize); ro.observe(sky); observers.push(ro); resize();
    built = true;
    raf = requestAnimationFrame(frame);
    return true;
  }
  const PLACES = [['Aarhus', 56.162, 10.203], ['Aalborg', 57.048, 9.92], ['Billund', 55.74, 9.15], ['Copenhagen', 55.676, 12.568], ['Hamburg', 53.551, 9.993], ['Gothenburg', 57.709, 11.974], ['Odense', 55.403, 10.402]];
  const placeEls = [];
  function addPlaceLabels() {
    for (const [n, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) { const d = document.createElement('div'); d.className = 'rdr-place card'; d.textContent = n; skyLabels.appendChild(d); const r = RANGE_KM + 14, rad = a * Math.PI / 180; placeEls.push({ el: d, v: new T.Vector3(r * Math.sin(rad), 0.5, -r * Math.cos(rad)) }); }
    for (const [n, la, lo] of PLACES) { const d = document.createElement('div'); d.className = 'rdr-place'; d.textContent = n; skyLabels.appendChild(d); placeEls.push({ el: d, v: new T.Vector3(kmX(lo), 0.5, -kmN(la)) }); }
  }
  const VIEWS = { radar: { r: 640, pol: 0.03 }, tilt: { r: 560, pol: 0.95 }, low: { r: 430, pol: 1.38 } };
  function setView(v, instant) {
    const t = VIEWS[v]; if (!t) return;
    qa('[data-view]').forEach(b => b.setAttribute('aria-pressed', b.dataset.view === v));
    if (instant) { cam.r = t.r; cam.pol = t.pol; return; }
    cam.tween = { r0: cam.r, p0: cam.pol, r1: t.r, p1: t.pol, k: 0 };
  }
  qa('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  skyCompass.addEventListener('click', () => {
    const a0 = ((cam.az % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    cam.tween = { r0: cam.r, p0: cam.pol, r1: cam.r, p1: cam.pol, a0, a1: 0, k: 0 };
  });
  function resize() {
    if (!renderer) return; const w = sky.clientWidth, h = sky.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  /* ── Aircraft ── */
  function makePlane(hex) {
    const p = { hex, data: null, tgt: new T.Vector3(), cur: null, hist: [], seenAt: 0 };
    const col = new T.Color('#ffffff');
    p.g = new T.Group();
    p.body = new T.Mesh(arrowGeo, new T.MeshBasicMaterial({ color: col }));
    p.glow = new T.Sprite(new T.SpriteMaterial({ map: glowTex, color: col, transparent: true, blending: T.AdditiveBlending, depthWrite: false }));
    p.glow.scale.set(13, 13, 1);
    p.hit = new T.Mesh(new T.SphereGeometry(9, 8, 6), new T.MeshBasicMaterial({ visible: false })); p.hit.userData.hex = hex;
    p.g.add(p.body, p.glow, p.hit);
    const dg = new T.BufferGeometry(); dg.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(6), 3));
    p.drop = new T.Line(dg, new T.LineBasicMaterial({ color: col, transparent: true, opacity: 0.22 }));
    const tg = new T.BufferGeometry(); tg.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(TRAIL_N * 3), 3)); tg.setDrawRange(0, 0);
    p.trail = new T.Line(tg, new T.LineBasicMaterial({ color: col, transparent: true, opacity: 0.5 }));
    p.shadow = new T.Mesh(new T.CircleGeometry(2.2, 12), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.25, depthWrite: false })); p.shadow.rotation.x = -Math.PI / 2;
    scene.add(p.g, p.drop, p.trail, p.shadow);
    p.label = document.createElement('div'); p.label.className = 'rdr-tag'; skyLabels.appendChild(p.label);
    return p;
  }
  function dropPlane(p) {
    scene.remove(p.g, p.drop, p.trail, p.shadow);
    [p.body.material, p.glow.material, p.hit.geometry, p.hit.material, p.drop.geometry, p.drop.material, p.trail.geometry, p.trail.material, p.shadow.geometry, p.shadow.material].forEach(o => o.dispose());
    p.label.remove(); planes.delete(p.hex);
    if (selected === p.hex) select(null);
  }
  function ingest(list, t) {
    for (const a of list) {
      if (a.lat == null || a.lon == null) continue;
      const d = haversineKm(rx.lat, rx.lon, a.lat, a.lon); if (d > RANGE_KM * 1.02) continue;
      let p = planes.get(a.hex); if (!p) { if (!built) continue; p = makePlane(a.hex); planes.set(a.hex, p); }
      a.dist = d; a.brg = bearingDeg(rx.lat, rx.lon, a.lat, a.lon);
      p.data = a; p.t0 = t; p.seenAt = t;
      const c = new T.Color(altitudeColor(a.altFt));
      p.body.material.color.copy(c); p.glow.material.color.copy(c); p.drop.material.color.copy(c); p.trail.material.color.copy(c); p.shadow.material.color.copy(c);
    }
    for (const p of [...planes.values()]) if (t - p.seenAt > 75) dropPlane(p);
  }
  function reckon(p, t, out) {
    const a = p.data, dt = Math.min(90, Math.max(0, t - p.t0));
    let x = kmX(a.lon), n = kmN(a.lat);
    if (a.gs != null && a.track != null && !a.stale) { const v = a.gs * 1.852 / 3600 * dt, tr = a.track * Math.PI / 180; x += v * Math.sin(tr); n += v * Math.cos(tr); }
    return out.set(x, altY(a.altFt), -n);
  }
  function pushTrail(p, t, force) {
    const v = reckon(p, t, new T.Vector3()), last = p.hist[p.hist.length - 1];
    if (force || !last || last.distanceTo(v) > 1.2) { p.hist.push(v); if (p.hist.length > TRAIL_N) p.hist.shift(); }
  }

  /* ── Picking, card, table, KPIs ── */
  function pick(e) {
    const r = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new T.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), camera);
    const hits = raycaster.intersectObjects([...planes.values()].map(p => p.hit));
    select(hits.length ? hits[0].object.userData.hex : null);
  }
  function select(hex) {
    selected = hex;
    qa('.rdr-table tbody tr').forEach(tr => tr.classList.toggle('sel', tr.dataset.hex === hex));
    updateCard();
  }
  function updateCard() {
    const p = selected && planes.get(selected);
    if (!p) { skyCard.hidden = true; return; }
    const a = p.data, ft = a.altFt != null && a.altFt !== 'ground' ? ' ft' : '';
    skyCard.hidden = false; skyCard.style.setProperty('--ac', altitudeColor(a.altFt));
    skyCard.innerHTML = `<b>${esc(a.flight || a.hex.toUpperCase())}</b><span class="hex">${a.flight ? esc(a.hex.toUpperCase()) : 'No callsign'}${a.squawk ? ' · sq ' + esc(a.squawk) : ''}</span>
      <dl><dt>Altitude</dt><dd>${fmtAlt(a.altFt)}${ft}</dd><dt>Speed</dt><dd>${fmtSpeed(a.gs)}</dd>
      <dt>Heading</dt><dd>${a.track != null ? Math.round(a.track) + '°' : '—'}</dd><dt>From antenna</dt><dd>${fmtDist(a.dist)} · ${Math.round(a.brg)}°</dd></dl>
      ${a.flight ? `<a href="https://www.flightradar24.com/${encodeURIComponent(a.flight)}" target="_blank" rel="noopener">Track on FR24 ↗</a>` : ''}`;
  }
  function renderTable() {
    const list = [...planes.values()].map(p => p.data).filter(Boolean).sort((a, b) => a.dist - b.dist).slice(0, 40);
    count.textContent = list.length;
    if (!list.length) { tbody.innerHTML = '<tr><td colspan="6" class="rdr-empty">No aircraft in range at this moment.</td></tr>'; return; }
    tbody.innerHTML = list.map(a => { const c = altitudeColor(a.altFt); return `<tr data-hex="${esc(a.hex)}" class="${a.hex === selected ? 'sel' : ''}">
      <td class="f">${esc(a.flight || '—')}</td><td class="h">${esc(a.hex)}</td>
      <td class="a"><span class="dot" style="background:${c};color:${c}"></span>${fmtAlt(a.altFt)}${a.altFt != null && a.altFt !== 'ground' ? ' ft' : ''}</td>
      <td>${fmtSpeed(a.gs)}</td><td>${fmtDist(a.dist)}</td><td>${fmtRssi(a.rssi)}</td></tr>`; }).join('');
  }
  tbody.addEventListener('click', e => { const tr = e.target.closest('tr[data-hex]'); if (tr) select(tr.dataset.hex === selected ? null : tr.dataset.hex); });
  function kpis(total) {
    const list = [...planes.values()].map(p => p.data).filter(Boolean);
    K.ac.textContent = (total ?? list.length).toLocaleString('en-GB');
    K.pos.textContent = list.length.toLocaleString('en-GB');
    const max = list.reduce((m, a) => Math.max(m, a.dist || 0), 0);
    K.max.innerHTML = max > 0 ? `${Math.round(max)}<small>km</small>` : '—';
  }
  const setKpiLabels = (a, b, c) => { L.k4.textContent = a; L.k5.textContent = b; L.k6.textContent = c; };

  /* ── Source 1: the receiver ── */
  let liveBase = null, liveTimer = null, statsTimer = null;
  async function tryLive() {
    const lv = opts.live; if (!lv) return null;
    const bases = [];
    if (lv.secure) bases.push(lv.secure);
    const mixed = location.protocol === 'https:' && (lv.base || '').startsWith('http:');
    if (lv.base && (lv.force || !mixed)) bases.push(lv.base);
    for (const b of bases) {
      try {
        const d = await fetchJSON(b + 'aircraft.json');
        liveBase = b;
        fetchJSON(b + 'receiver.json').then(r => { if (r && r.lat != null) rx = { lat: r.lat, lon: r.lon }; }).catch(() => {});
        return d;
      } catch (e) { /* next */ }
    }
    return null;
  }
  function startLive(first) {
    mode = 'live'; simT = Date.now() / 1000; skySpeed.hidden = true; skyTime.hidden = false; skyLive.hidden = true; skyTime.classList.add('is-live');
    skyMode.textContent = 'Live'; skyMode.dataset.state = 'live';
    onStatus('live', 'Live', `Live from the receiver · updated every ${POLL_MS / 1000} s`);
    setKpiLabels('msgs / sec', 'avg signal (dBFS)', 'uptime');
    const take = d => { if (mode !== 'live') return; ingest(normalize(d), Date.now() / 1000); kpis((d.aircraft || []).length); renderTable(); updateCard(); };
    take(first);
    liveTimer = every(() => mode === 'live' && fetchJSON(liveBase + 'aircraft.json').then(take).catch(() => onStatus('loading', 'Reconnecting…')), POLL_MS);
    const stats = () => mode === 'live' && fetchJSON(liveBase + 'stats.json').then(s => {
      const latest = s.latest || s.last1min || {}, total = s.total || {}, local = latest.local || total.local || {};
      const win = latest.end && latest.start ? Math.max(1, latest.end - latest.start) : 60;
      K.k4.textContent = latest.messages ? Math.round(latest.messages / win).toLocaleString('en-GB') : '—';
      K.k5.textContent = local.signal != null ? local.signal.toFixed(1) : '—';
      K.k6.textContent = fmtUptime(total.end && total.start ? total.end - total.start : null);
    }).catch(() => {});
    stats(); statsTimer = every(stats, STATS_MS);
    // the time bar shows the latest recorded day; picking a moment switches to the replay
    loadManifest().then(() => loadDay(snaps.length - 1)).then(d => { if (mode !== 'live') return; buildTimebar(d); skyDay.value = String(d.i); skyRange.value = d.frameTs[0] + (Date.now() / 1000) % 86400; }).catch(() => {});
  }

  /* ── Source 2: the recording ── */
  let man = null, snaps = [], hp = null, hz = null, D = null, frames = null, frameTs = [], fi = 0, playing = true, scrubbing = false;
  const days = new Map();
  const dayOf = s => (s.name.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  async function loadManifest() {
    if (man) return;
    man = await fetchJSON(RECORD_BASE + 'manifest.json');
    let all = (man.snapshots || []).filter(s => s.bytes > 100000);
    if (opts.days && opts.days.length) { const want = new Set(opts.days); all = all.filter(s => want.has(dayOf(s))); }
    else all = all.slice(-7);
    snaps = all;
    if (!snaps.length) throw new Error('no recorded days');
    if (mode !== 'live' && man.origin && man.origin.lat != null) rx = { lat: man.origin.lat, lon: man.origin.lng ?? man.origin.lon };
    skyDay.innerHTML = snaps.map((s, i) => `<option value="${i}">${dayLabel(dayOf(s))}</option>`).reverse().join('');
  }
  async function loadDay(i) {
    if (days.has(i)) return days.get(i);
    if (!hp) [hp, hz] = await Promise.all([import(HYPARQUET), import(HYPARQUET_Z)]);
    const snap = snaps[i];
    const buf = await fetch(RECORD_BASE + snap.path.replace(/^data\/adsb\//, '')).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); });
    const rows = await hp.parquetReadObjects({ file: buf, compressors: hz.compressors, columns: ['ts', 'hex', 'flight', 'lat', 'lon', 'alt_baro', 'gs', 'track', 'squawk', 'seen_pos'] });
    const fr = new Map(), tracks = new Map(), hexes = new Set();
    for (const r of rows) {
      const ts = Number(r.ts); let f = fr.get(ts); if (!f) fr.set(ts, f = []);
      const alt = r.alt_baro == null ? null : Number(r.alt_baro);
      hexes.add(r.hex);
      f.push({ hex: r.hex, flight: (r.flight || '').trim(), lat: r.lat, lon: r.lon, alt_baro: alt, gs: r.gs, track: r.track, squawk: r.squawk, seen_pos: r.seen_pos });
      if (r.lat != null && r.lon != null) { let tk = tracks.get(r.hex); if (!tk) tracks.set(r.hex, tk = []); tk.push([ts, r.lat, r.lon, alt]); }
    }
    const d = { i, day: dayOf(snap), frames: fr, frameTs: [...fr.keys()].sort((a, b) => a - b), tracks, unique: hexes.size };
    days.set(i, d); return d;
  }
  async function startRecord(i, at) {
    onStatus('loading', 'Loading the recording…');
    skyMode.textContent = 'Loading'; skyMode.dataset.state = 'loading';
    await loadManifest();
    if (i == null) i = snaps.length - 1;
    D = await loadDay(i); if (stopped) return;
    frames = D.frames; frameTs = D.frameTs;
    mode = 'record'; skySpeed.hidden = false; skyTime.hidden = false; skyTime.classList.remove('is-live'); skyLive.hidden = !liveBase;
    skyDay.value = String(i);
    buildTimebar();
    const day0 = Math.floor(frameTs[0] / 86400) * 86400;
    jumpTo(at != null ? at : day0 + (Date.now() / 1000) % 86400);
    const dayTxt = dayLabel(D.day);
    skyMode.textContent = `Replay · ${dayTxt}`; skyMode.dataset.state = 'record';
    onStatus('replay', 'Replay', dayTxt);
    setKpiLabels('recorded on', 'aircraft that day', 'snapshots that day');
    K.k4.textContent = dayTxt; K.k5.textContent = D.unique.toLocaleString('en-GB'); K.k6.textContent = frameTs.length.toLocaleString('en-GB');
    onDay({ day: D.day, label: dayTxt, unique: D.unique, snapshots: frameTs.length, days: snaps.length });
    if (pathsMode === 'day') setPaths('day');
  }
  function jumpTo(t) {
    for (const p of [...planes.values()]) dropPlane(p);
    fi = frameTs.findIndex(x => x >= t); if (fi < 0) fi = frameTs.length - 1;
    for (let k = Math.max(0, fi - 20); k < fi; k++) { ingest(normalize({ aircraft: frames.get(frameTs[k]) }), frameTs[k]); for (const p of planes.values()) pushTrail(p, frameTs[k], true); }
    simT = frameTs[fi]; applyFrame(fi);
    skyRange.value = simT; skyClock.textContent = fmtClock(simT);
  }
  function applyFrame(k) {
    const f = frames.get(frameTs[k]);
    ingest(normalize({ aircraft: f }), frameTs[k]);
    kpis(f.length); renderTable(); updateCard();
  }
  function stepRecord(dt) {
    if (!playing || scrubbing) return;
    simT += dt * speed;
    while (fi + 1 < frameTs.length && frameTs[fi + 1] <= simT) { fi++; applyFrame(fi); }
    if (fi + 1 >= frameTs.length && simT > frameTs[fi] + 60) jumpTo(frameTs[0]);
  }
  function buildTimebar(d = D) {
    const ts = d.frameTs, fr = d.frames, t0 = ts[0], t1 = ts[ts.length - 1], span = Math.max(1, t1 - t0);
    skyRange.min = t0; skyRange.max = t1; skyRange.step = 30;
    const B = 144, cnt = new Array(B).fill(0), n = new Array(B).fill(0);
    for (const t of ts) { const b = Math.min(B - 1, Math.floor((t - t0) / span * B)); cnt[b] += fr.get(t).filter(a => a.lat != null).length; n[b]++; }
    const avg = cnt.map((c, i) => n[i] ? c / n[i] : 0), mx = Math.max(1, ...avg);
    skyHist.innerHTML = avg.map((v, i) => `<rect x="${i}" y="${(24 - v / mx * 22).toFixed(1)}" width="0.8" height="${(v / mx * 22).toFixed(1)}"/>`).join('');
    let tk = '';
    for (let t = Math.ceil(t0 / 3600) * 3600; t <= t1; t += 3600) { const h = hourLocal(t); if (h % 3 === 0) tk += `<span style="left:${((t - t0) / span * 100).toFixed(2)}%">${String(h).padStart(2, '0')}</span>`; }
    skyTicks.innerHTML = tk;
  }
  skyRange.addEventListener('input', () => { scrubbing = true; if (mode !== 'record') return; simT = +skyRange.value; skyClock.textContent = fmtClock(simT); });
  skyRange.addEventListener('change', async () => {
    const t = +skyRange.value; scrubbing = false;
    if (mode === 'live') { await startRecord(+skyDay.value, t); return; }
    jumpTo(t);
  });
  skyDay.addEventListener('change', async () => {
    const i = +skyDay.value, frac = frameTs.length ? Math.max(0, simT - frameTs[0]) : (Date.now() / 1000) % 86400;
    const d = await loadDay(i);
    await startRecord(i, d.frameTs[0] + frac);
  });
  skyPlay.addEventListener('click', () => { playing = !playing; skyPlay.setAttribute('aria-pressed', !playing); skyPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play'); });
  skyLive.addEventListener('click', () => { if (!liveBase) return; fetchJSON(liveBase + 'aircraft.json').then(d => { clear(liveTimer); clear(statsTimer); for (const p of [...planes.values()]) dropPlane(p); startLive(d); }).catch(() => {}); });
  qa('[data-spd]').forEach(b => b.addEventListener('click', () => { speed = +b.dataset.spd; playing = true; skyPlay.setAttribute('aria-pressed', false); qa('[data-spd]').forEach(x => x.setAttribute('aria-pressed', x === b)); }));

  /* ── Paths: every track of the day, or of all the days on offer, in 3D ── */
  let pathsMode = 'off', pathsObj = null, pathsJob = 0;
  async function setPaths(m) {
    pathsMode = m; const job = ++pathsJob;
    qa('[data-paths]').forEach(b => b.setAttribute('aria-pressed', b.dataset.paths === m));
    if (pathsObj) { scene.remove(pathsObj); pathsObj.geometry.dispose(); pathsObj.material.dispose(); pathsObj = null; }
    skyInfo.textContent = '';
    if (m === 'off' || !scene) return;
    try {
      await loadManifest();
      const want = m === 'day' ? [D ? D.i : snaps.length - 1] : snaps.map((_, i) => i);
      const list = [];
      for (const i of want) { skyInfo.textContent = `Loading ${list.length + 1} / ${want.length}…`; list.push(await loadDay(i)); if (job !== pathsJob || stopped) return; }
      const pos = [], col = [], c = new T.Color(), hexes = new Set();
      for (const d of list) for (const [hex, tk] of d.tracks) {
        hexes.add(hex);
        for (let k = 1; k < tk.length; k++) {
          const [t0, la0, lo0, al0] = tk[k - 1], [t1, la1, lo1, al1] = tk[k];
          if (t1 - t0 > 300) continue;                                   // a gap: it left and came back
          const x0 = kmX(lo0), z0 = -kmN(la0), x1 = kmX(lo1), z1 = -kmN(la1);
          if ((x1 - x0) ** 2 + (z1 - z0) ** 2 > 1600) continue;            // a bad position fix
          if (x0 * x0 + z0 * z0 > RANGE_KM * RANGE_KM * 1.1) continue;
          pos.push(x0, altY(al0), z0, x1, altY(al1), z1);
          c.set(altitudeColor(al0)); col.push(c.r, c.g, c.b); c.set(altitudeColor(al1)); col.push(c.r, c.g, c.b);
        }
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
      pathsObj = new T.LineSegments(g, new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: m === 'week' ? 0.16 : 0.32, blending: T.AdditiveBlending, depthWrite: false }));
      scene.add(pathsObj);
      skyInfo.textContent = `${hexes.size.toLocaleString('en-GB')} aircraft · ${m === 'week' ? list.length + ' days' : dayLabel(list[0].day)}`;
    } catch (e) { console.error('[radar] paths failed', e); skyInfo.textContent = 'Couldn’t load the recording'; }
  }
  qa('[data-paths]').forEach(b => b.addEventListener('click', () => setPaths(b.dataset.paths)));

  /* ── Source 3: synthetic traffic ── */
  function startDemo(reason) {
    mode = 'demo'; simT = Date.now() / 1000; skyTime.hidden = true;
    skyMode.textContent = 'Demo traffic'; skyMode.dataset.state = 'demo';
    onStatus('offline', reason ? 'No data' : 'Demo', reason ? `Couldn’t reach the receiver or the recording (${reason}). Showing synthetic traffic.` : 'Synthetic aircraft.');
    const r = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);
    const list = Array.from({ length: 34 }, (_, i) => {
      const a = r() * Math.PI * 2, d = 30 + r() * 250;
      return { hex: 'demo' + i, flight: ['SAS', 'RYR', 'DLH', 'KLM', 'NAX', 'BAW', 'EZY', 'WZZ'][i % 8] + (100 + Math.floor(r() * 900)), lat: rx.lat + d * Math.cos(a) / 110.574, lon: rx.lon + d * Math.sin(a) / (111.32 * Math.cos(rx.lat * Math.PI / 180)),
        alt_baro: Math.round(2000 + r() * 39000), gs: 220 + r() * 280, track: r() * 360, rssi: -20 - r() * 12 };
    });
    ingest(normalize({ aircraft: list }), simT); kpis(); renderTable();
    setKpiLabels('msgs / sec', 'avg signal (dBFS)', 'uptime');
    every(() => { const t = Date.now() / 1000; for (const p of planes.values()) { const a = p.data, v = reckon(p, t, new T.Vector3()); a.lon = rx.lon + v.x / (111.32 * Math.cos(rx.lat * Math.PI / 180)); a.lat = rx.lat - v.z / 110.574; p.t0 = t; p.seenAt = t; if (haversineKm(rx.lat, rx.lon, a.lat, a.lon) > RANGE_KM) a.track = (a.track + 180) % 360; } kpis(); renderTable(); updateCard(); }, 3000);
  }

  /* ── Per frame ── */
  let last = performance.now(), frameN = 0;
  const proj = new T.Vector3();
  function frame(now) {
    if (stopped) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!onScreen || document.hidden) return;
    frameN++;
    if (mode === 'record') stepRecord(dt); else simT = Date.now() / 1000;
    if (cam.tween) { const tw = cam.tween; tw.k = Math.min(1, tw.k + dt / 0.9); const e = tw.k * tw.k * (3 - 2 * tw.k); cam.r = tw.r0 + (tw.r1 - tw.r0) * e; cam.pol = tw.p0 + (tw.p1 - tw.p0) * e; if (tw.a1 != null) cam.az = tw.a0 + (tw.a1 - tw.a0) * e; if (tw.k >= 1) cam.tween = null; }
    camera.position.set(cam.r * Math.sin(cam.pol) * Math.sin(cam.az), cam.r * Math.cos(cam.pol) + 8, cam.r * Math.sin(cam.pol) * Math.cos(cam.az));
    camera.lookAt(0, cam.pol > 1.2 ? 30 : 0, 0);
    for (const p of planes.values()) {
      if (!p.data) continue;
      reckon(p, simT, p.tgt);
      if (!p.cur) p.cur = p.tgt.clone(); else p.cur.lerp(p.tgt, 1 - Math.exp(-dt * 4));
      p.g.position.copy(p.cur);
      if (p.data.track != null) p.body.rotation.y = Math.PI - p.data.track * Math.PI / 180;
      const pa = p.drop.geometry.attributes.position; pa.setXYZ(0, p.cur.x, p.cur.y, p.cur.z); pa.setXYZ(1, p.cur.x, 0.1, p.cur.z); pa.needsUpdate = true;
      p.shadow.position.set(p.cur.x, 0.12, p.cur.z);
      if (frameN % 10 === 0) pushTrail(p, simT);
      const ta = p.trail.geometry.attributes.position, n = p.hist.length;
      for (let i = 0; i < n; i++) ta.setXYZ(i, p.hist[i].x, p.hist[i].y, p.hist[i].z);
      ta.needsUpdate = true; p.trail.geometry.setDrawRange(0, n);
      const sel = p.hex === selected, s = sel ? 24 : 13;
      p.glow.scale.set(s, s, 1); p.glow.material.opacity = p.data.stale ? 0.3 : 0.6;
      p.body.scale.setScalar(sel ? 1.6 : 1);
    }
    renderer.render(scene, camera);
    const w = sky.clientWidth, h = sky.clientHeight;
    for (const pl of placeEls) { proj.copy(pl.v).project(camera); const vis = proj.z < 1 && Math.abs(proj.x) < 1.05 && Math.abs(proj.y) < 1.05; pl.el.style.opacity = vis ? 1 : 0; if (vis) pl.el.style.transform = `translate(${(proj.x * 0.5 + 0.5) * w}px,${(-proj.y * 0.5 + 0.5) * h}px) translate(-50%,-50%)`; }
    const near = [...planes.values()].filter(p => p.data && p.cur).sort((a, b) => a.data.dist - b.data.dist);
    const show = new Set(near.slice(0, 7).map(p => p.hex)); if (selected) show.add(selected);
    for (const p of planes.values()) {
      if (!show.has(p.hex) || !p.cur) { p.label.style.opacity = 0; continue; }
      proj.copy(p.cur).project(camera);
      if (proj.z > 1) { p.label.style.opacity = 0; continue; }
      p.label.style.opacity = 1; p.label.classList.toggle('sel', p.hex === selected);
      p.label.style.setProperty('--ac', altitudeColor(p.data.altFt));
      p.label.textContent = `${p.data.flight || p.hex.toUpperCase()} · ${fmtAlt(p.data.altFt)}`;
      p.label.style.transform = `translate(${(proj.x * 0.5 + 0.5) * w + 10}px,${(-proj.y * 0.5 + 0.5) * h - 10}px)`;
    }
    { const o = proj.set(0, 0, 0).project(camera), ox = o.x, oy = o.y, nn = proj.set(0, 0, -100).project(camera);
      skyNeedle.style.transform = `rotate(${Math.atan2((nn.x - ox) * w, (nn.y - oy) * h)}rad)`; }
    if (frameN % 15 === 0) { skyClock.textContent = fmtClock(simT); if (mode === 'record' && !scrubbing) skyRange.value = simT; }
  }

  /* ── Boot when the stage comes into view ── */
  async function boot() {
    if (!buildScene()) return;
    if (opts.demo) return startDemo();
    if (opts.live && opts.live.force !== 'record') { const d = await tryLive(); if (stopped) return; if (d) return startLive(d); }
    try { await startRecord(); } catch (e) { if (stopped) return; console.error('[radar] recording failed', e); startDemo(e && e.message || 'network'); }
  }
  const vis = new IntersectionObserver(([en]) => { onScreen = en.isIntersecting; }, { rootMargin: '100px' });
  vis.observe(sky); observers.push(vis);
  const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) { io.disconnect(); boot(); } }, { rootMargin: '300px' });
  io.observe(host); observers.push(io);

  return {
    stop() {
      stopped = true; cancelAnimationFrame(raf);
      timers.forEach(id => clearInterval(id)); timers.clear();
      observers.forEach(o => o.disconnect());
      if (renderer) { renderer.dispose(); try { renderer.forceContextLoss(); } catch (e) {} }
    }
  };
}
