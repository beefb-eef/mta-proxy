// index.js
import express from "express";
import fetch from "node-fetch";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import fs from "node:fs";
import path from "node:path";

const app = express();
const PORT = process.env.PORT || 3000;

// Optional (works without it)
const MTA_API_KEY = process.env.MTA_API_KEY || "";

// If no line is provided, we’ll fetch ALL feeds (fallback)
const ALL_FEEDS = [
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si",
];

// Map: LINE -> FEED URL
// Note: S appears in multiple docs; for practical use we map S to the main "gtfs" feed.
const FEED_BY_LINE = {
  // ACE
  A: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
  C: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
  E: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",

  // BDFM
  B: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
  D: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
  F: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
  M: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",

  // G
  G: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",

  // JZ
  J: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
  Z: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",

  // NQRW
  N: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
  Q: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
  R: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
  W: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",

  // L
  L: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",

  // 1-7 + S (shuttle)
  "1": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  "2": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  "3": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  "4": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  "5": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  "6": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  "7": "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  S: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",

  // Staten Island Railway (routeId often shows as SI)
  SI: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si",
  SIR: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si",
};

// ---------- helpers ----------
function asArrayParam(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function normalizeLine(x) {
  return String(x || "").trim().toUpperCase();
}

function readStationsUi() {
  const p = path.join(process.cwd(), "stations-ui.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function pickFeedUrlsForLines(lines) {
  const wanted = (lines || []).map(normalizeLine).filter(Boolean);
  if (!wanted.length) return ALL_FEEDS;

  const set = new Set();
  for (const l of wanted) {
    const u = FEED_BY_LINE[l];
    if (u) set.add(u);
  }
  // Fallback: if user sent weird lines we don’t recognize, fetch all
  return set.size ? Array.from(set) : ALL_FEEDS;
}

// ---------- fetch + decode only needed feeds ----------
async function fetchFeedsForLines(lines) {
  const urls = pickFeedUrlsForLines(lines);

  const headers = {};
  if (MTA_API_KEY) headers["x-api-key"] = MTA_API_KEY;

  const feeds = await Promise.all(
    urls.map(async (url) => {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`MTA feed error: ${res.status} ${res.statusText}`);
      const buffer = await res.arrayBuffer();
      return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
    })
  );

  return feeds;
}

// ---------- extract departures (stopId required, optional line filter) ----------
function filterDeparturesForStops(feeds, stopIds, allowedLines = []) {
  const nowSec = Math.floor(Date.now() / 1000);
  const departures = [];

  const stopSet = new Set(stopIds.map(String));
  const allowSet = new Set((allowedLines || []).map(normalizeLine).filter(Boolean));

  // Dedupe across feeds
  const seen = new Set(); // key: route|stop|timestamp|tripId

  feeds.forEach((feed) => {
    feed.entity.forEach((entity) => {
      if (!entity.tripUpdate || !entity.tripUpdate.stopTimeUpdate) return;

      const routeId = normalizeLine(entity.tripUpdate.trip?.routeId);
      if (allowSet.size && !allowSet.has(routeId)) return;

      const tripId =
        entity.tripUpdate.trip?.tripId ||
        entity.tripUpdate.trip?.trip_id ||
        "";

      entity.tripUpdate.stopTimeUpdate.forEach((stu) => {
        const stopId = stu.stopId;
        if (!stopId || !stopSet.has(stopId)) return;

        const t =
          stu.arrival?.time?.toNumber?.() ??
          stu.arrival?.time ??
          stu.departure?.time?.toNumber?.() ??
          stu.departure?.time;

        if (!t) return;

        const etaSec = t - nowSec;
        if (etaSec < 0) return;

        const key = `${routeId}|${stopId}|${t}|${tripId}`;
        if (seen.has(key)) return;
        seen.add(key);

        departures.push({
          routeId,
          stopId,
          timestamp: t,
          etaMinutes: Math.round(etaSec / 60),
        });
      });
    });
  });

  departures.sort((a, b) => a.timestamp - b.timestamp);
  return departures;
}

// ---------- API: /mta ----------
app.get("/mta", async (req, res) => {
  try {
    const stopIds = asArrayParam(req.query.stopId).map(String).filter(Boolean);
    const lines = asArrayParam(req.query.line).map(String).filter(Boolean);

    if (!stopIds.length) return res.status(400).json({ error: "Provide stopId" });

    const feeds = await fetchFeedsForLines(lines);
    const departures = filterDeparturesForStops(feeds, stopIds, lines);

    res.json({
      stops: stopIds,
      lines: lines.map(normalizeLine),
      lastUpdated: new Date().toISOString(),
      departures,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------- API: stations ----------
app.get("/api/stations", (req, res) => {
  const data = readStationsUi();
  if (!data) {
    return res.status(404).json({
      error:
        "stations-ui.json not found. Generate it (with borough + directions + displayName) and place it in the project root.",
    });
  }
  res.json(data);
});

// ---------- UI: Direction -> Borough -> Stop -> Line(s) ----------
app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>MTA Train Trax</title>
<style>
:root{color-scheme:dark;}
*{box-sizing:border-box;}
body{
  background:#05060a;color:#f0f6fc;
  font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto;
  margin:0;padding:16px;display:flex;justify-content:center;min-height:100vh;
}
.container{max-width:1100px;width:100%;display:flex;flex-direction:column;gap:14px;}
h1{margin:0;font-size:1.8rem;letter-spacing:.02em;}

.panel,.board{
  background:#11151d;border-radius:16px;padding:14px 14px;
  box-shadow:0 14px 35px rgba(0,0,0,.65);
}

.hint{color:#8b949e;font-size:.86rem;margin-top:6px;}
.meta{display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;}
.meta .title{font-size:1.25rem;font-weight:800;}
.meta .sub{color:#8b949e;font-size:.9rem;}

table{width:100%;border-collapse:collapse;margin-top:10px;}
th,td{padding:8px 2px;font-size:1rem;}
th{color:#8b949e;border-bottom:1px solid #30363d;text-align:left;}
tr+tr td{border-top:1px solid #21262d;}

.route-pill{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:30px;height:30px;border-radius:999px;
  font-size:.95rem;font-weight:900;color:#fff;padding:0 12px;
  background:#30363d;
}
/* Line colors */
.route-blue{ background:#0039A6; }      /* A/C/E */
.route-orange{ background:#FF6319; }    /* B/D/F/M */
.route-grey{ background:#6c757d; }      /* S */
.route-brightgreen{ background:#00A550; } /* G */
.route-brown{ background:#996633; }     /* J/Z */
.route-yellow{ background:#FCCC0A; color:#111; } /* N/Q/R/W */
.route-lightgrey{ background:#A7A9AC; color:#111; } /* L */
.route-red{ background:#EE352E; }       /* 1/2/3 */
.route-green{ background:#00933C; }     /* 4/5/6 */
.route-purple{ background:#B933AD; }    /* 7 */
.route-lightblue{ background:#5DA9E9; color:#111; } /* SI/SIR */

.footerRow{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-top:8px;}
button{
  padding:10px 12px;border-radius:12px;border:1px solid #30363d;
  background:#0b0f17;color:#f0f6fc;cursor:pointer;font-weight:800;
}
button:hover{background:#0f1624;}
button.secondary{opacity:.95;}
button.ghost{background:transparent;}
button[disabled]{opacity:.4;cursor:not-allowed;}

select{
  width:100%;padding:10px;border-radius:12px;
  border:1px solid #30363d;background:#0b0f17;color:#f0f6fc;font-size:14px;
}

.steps{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;}
.stepDot{
  display:inline-flex;align-items:center;gap:8px;
  padding:8px 10px;border-radius:999px;border:1px solid #30363d;
  color:#8b949e;font-weight:800;font-size:.85rem;
}
.stepDot.active{color:#f0f6fc;border-color:#556070;}
.stepDot.done{color:#c9d1d9;border-color:#3b4552;}

.screen{display:none;}
.screen.active{display:block;}

.choiceRow{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;}
.choice{
  flex:1;min-width:220px;
  padding:14px 14px;border-radius:16px;border:1px solid #30363d;
  background:#0b0f17;cursor:pointer;
}
.choice:hover{background:#0f1624;}
.choice .big{font-size:1.05rem;font-weight:950;}
.choice .small{color:#8b949e;font-size:.85rem;margin-top:6px;}

.row{display:grid;grid-template-columns:1fr;gap:10px;}
@media(min-width:900px){ .row{grid-template-columns:1fr 1fr;} }

/* line chips */
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
.chip{
  display:inline-flex;align-items:center;gap:8px;
  padding:10px 12px;border-radius:999px;border:1px solid #30363d;
  background:#0b0f17;color:#f0f6fc;cursor:pointer;user-select:none;
  -webkit-tap-highlight-color: transparent;font-weight:800;
}
.chip input{width:18px;height:18px;}
.chip:active{transform:scale(.99);}
.chip .badge{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:28px;height:28px;border-radius:999px;padding:0 10px;color:#fff;font-weight:900;
}
</style>
</head>
<body>
<div class="container">
  <h1>MTA Train Trax</h1>

  <div class="panel">
    <div class="steps" id="steps">
      <div class="stepDot" data-step="1">1. Direction</div>
      <div class="stepDot" data-step="2">2. Borough</div>
      <div class="stepDot" data-step="3">3. Stop</div>
      <div class="stepDot" data-step="4">4. Trains</div>
    </div>

    <div class="hint" id="status">Loading stations…</div>

    <!-- Screen 1 -->
    <div class="screen" id="screen1">
      <div style="margin-top:10px;font-weight:950;font-size:1.1rem;">Which direction are you going?</div>
      <div class="choiceRow">
        <div class="choice" id="pickUptown">
          <div class="big">Uptown</div>
          <div class="small">Prefer northbound (N) when available</div>
        </div>
        <div class="choice" id="pickDowntown">
          <div class="big">Downtown</div>
          <div class="small">Prefer southbound (S) when available</div>
        </div>
      </div>
    </div>

    <!-- Screen 2 -->
    <div class="screen" id="screen2">
      <div style="margin-top:10px;font-weight:950;font-size:1.1rem;">Which borough are you in?</div>
      <div class="row" style="margin-top:10px;">
        <div>
          <label style="display:block;color:#8b949e;font-size:.82rem;margin:0 0 6px;">Borough</label>
          <select id="borough"></select>
        </div>
        <div style="display:flex;align-items:end;gap:10px;">
          <button class="ghost" id="back2">Back</button>
          <button id="next2" disabled>Next</button>
        </div>
      </div>
    </div>

    <!-- Screen 3 -->
    <div class="screen" id="screen3">
      <div style="margin-top:10px;font-weight:950;font-size:1.1rem;">Which stop?</div>
      <div class="row" style="margin-top:10px;">
        <div>
          <label style="display:block;color:#8b949e;font-size:.82rem;margin:0 0 6px;">Stop</label>
          <select id="station"></select>
          <div class="hint">Filtered by borough. Direction is set from Screen 1.</div>
        </div>
        <div style="display:flex;align-items:end;gap:10px;">
          <button class="ghost" id="back3">Back</button>
          <button id="next3" disabled>Next</button>
        </div>
      </div>
    </div>

    <!-- Screen 4 -->
    <div class="screen" id="screen4">
      <div style="margin-top:10px;font-weight:950;font-size:1.1rem;">Which trains would you like to see?</div>
      <div class="hint">Tap to toggle. Leave all off to show everything.</div>
      <div id="lineChips" class="chips" aria-label="Line filters"></div>
      <div class="footerRow">
        <div class="hint" id="lineHint"></div>
        <div style="display:flex; gap:10px; align-items:center;">
          <button class="ghost" id="back4">Back</button>
          <button type="button" id="clearLines">Clear</button>
          <button id="go" disabled>Show times</button>
        </div>
      </div>
    </div>

    <div class="footerRow" style="margin-top:12px;">
      <div class="hint" id="summary"></div>
      <div style="display:flex; gap:10px;">
        <button id="editFilters" style="display:none;">Edit</button>
        <button id="refresh" style="display:none;">Refresh</button>
      </div>
    </div>
  </div>

  <div class="board" id="board" style="display:none;">
    <div class="meta">
      <div class="title">Your next train</div>
      <div class="sub" id="subtitle"></div>
    </div>
    <div class="hint" id="updated" style="margin-top:6px;"></div>
    <table>
      <thead><tr><th>Route</th><th>Stop</th><th>ETA</th></tr></thead>
      <tbody id="tbody">
        <tr><td colspan="3">Make selections to see results…</td></tr>
      </tbody>
    </table>
  </div>
</div>

<script>
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");

const s1 = document.getElementById("screen1");
const s2 = document.getElementById("screen2");
const s3 = document.getElementById("screen3");
const s4 = document.getElementById("screen4");

const stepsEl = document.getElementById("steps");

const pickUptown = document.getElementById("pickUptown");
const pickDowntown = document.getElementById("pickDowntown");

const boroughSel = document.getElementById("borough");
const stationSel = document.getElementById("station");

const back2 = document.getElementById("back2");
const back3 = document.getElementById("back3");
const back4 = document.getElementById("back4");
const next2 = document.getElementById("next2");
const next3 = document.getElementById("next3");
const goBtn = document.getElementById("go");

const board = document.getElementById("board");
const tbody = document.getElementById("tbody");
const updated = document.getElementById("updated");
const subtitle = document.getElementById("subtitle");

const refreshBtn = document.getElementById("refresh");
const editBtn = document.getElementById("editFilters");

const lineChips = document.getElementById("lineChips");
const clearLinesBtn = document.getElementById("clearLines");
const lineHint = document.getElementById("lineHint");

let stations = [];
let filteredStations = [];
let selectedLineSet = new Set();

let chosenDir = "";     // "N" or "S"
let chosenBorough = "";
let chosenStationId = "";

function unique(arr){ return Array.from(new Set(arr)).sort((a,b)=>a.localeCompare(b, undefined, {sensitivity:"base"})); }

function setOptions(select, items, placeholder){
  select.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = placeholder;
  select.appendChild(ph);
  for(const it of items){
    const o = document.createElement("option");
    o.value = it.value;
    o.textContent = it.label;
    select.appendChild(o);
  }
}

function cleanLines(lines){
  return (lines || [])
    .map(l => String(l || "").trim().toUpperCase())
    .filter(Boolean)
    .filter(l => !l.includes("X"));
}

function cleanStationLabel(label){
  label = String(label || "");
  const m = label.match(/^(.*)\\((.*)\\)\\s*$/);
  if (!m) return label;

  const base = m[1].trim();
  const inside = m[2]
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !s.toUpperCase().includes("X"));

  return inside.length ? \`\${base} (\${inside.join(", ")})\` : base;
}

function pill(route){
  route = String(route || "").toUpperCase().trim();
  if(["A","C","E"].includes(route)) return "route-pill route-blue";
  if(["B","D","F","M"].includes(route)) return "route-pill route-orange";
  if(route === "S") return "route-pill route-grey";
  if(route === "G") return "route-pill route-brightgreen";
  if(["J","Z"].includes(route)) return "route-pill route-brown";
  if(["N","Q","R","W"].includes(route)) return "route-pill route-yellow";
  if(route === "L") return "route-pill route-lightgrey";
  if(["1","2","3"].includes(route)) return "route-pill route-red";
  if(["4","5","6"].includes(route)) return "route-pill route-green";
  if(route === "7") return "route-pill route-purple";
  if(route === "SIR" || route === "SI") return "route-pill route-lightblue";
  return "route-pill";
}

function badgeClass(route){
  route = String(route||"").toUpperCase().trim();
  if(["A","C","E"].includes(route)) return "badge route-blue";
  if(["B","D","F","M"].includes(route)) return "badge route-orange";
  if(route === "S") return "badge route-grey";
  if(route === "G") return "badge route-brightgreen";
  if(["J","Z"].includes(route)) return "badge route-brown";
  if(["N","Q","R","W"].includes(route)) return "badge route-yellow";
  if(route === "L") return "badge route-lightgrey";
  if(["1","2","3"].includes(route)) return "badge route-red";
  if(["4","5","6"].includes(route)) return "badge route-green";
  if(route === "7") return "badge route-purple";
  if(route === "SIR" || route === "SI") return "badge route-lightblue";
  return "badge";
}

function renderLineChips(lines){
  const clean = cleanLines(lines);
  lineChips.innerHTML = "";
  lineHint.textContent = clean.length ? \`\${clean.length} available at this stop\` : "No line list found for this stop.";

  clean.forEach(line => {
    const id = "line_" + line.replace(/[^a-z0-9]/gi, "_");

    const wrap = document.createElement("label");
    wrap.className = "chip";
    wrap.htmlFor = id;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.checked = selectedLineSet.has(line);
    cb.addEventListener("change", () => {
      if (selectedLineSet.has(line)) selectedLineSet.delete(line);
      else selectedLineSet.add(line);
      updateSummary();
      goBtn.disabled = !chosenStationId;
    });

    const badge = document.createElement("span");
    badge.className = badgeClass(line);
    badge.textContent = line;

    const text = document.createElement("span");
    text.textContent = line;

    wrap.appendChild(cb);
    wrap.appendChild(badge);
    wrap.appendChild(text);
    lineChips.appendChild(wrap);
  });
}

function setActiveScreen(n){
  [s1,s2,s3,s4].forEach(x => x.classList.remove("active"));
  document.getElementById("screen"+n).classList.add("active");

  // steps UI
  Array.from(stepsEl.querySelectorAll(".stepDot")).forEach(dot => {
    const step = Number(dot.dataset.step);
    dot.classList.remove("active","done");
    if (step < n) dot.classList.add("done");
    if (step === n) dot.classList.add("active");
  });
}

function selectedStationObj(){
  return filteredStations.find(s => String(s.id) === String(chosenStationId)) || null;
}

function pickStopIdForDirection(station, dir){
  // station.directions = [{dir:"N", stopId:"..."}, {dir:"S", stopId:"..."}]
  const dirs = station?.directions || [];
  if (!dirs.length) return station?.id || "";

  const want = String(dir||"").toUpperCase();
  const match = dirs.find(d => String(d.dir||"").toUpperCase() === want);
  if (match?.stopId) return match.stopId;

  // If the preferred direction doesn't exist, fall back to the first one.
  return dirs[0]?.stopId || station?.id || "";
}

function updateSummary(){
  const s = selectedStationObj();
  const baseLabel = s ? cleanStationLabel(s.displayName || s.name) : "";
  const dirLabel = chosenDir === "N" ? "Uptown (N)" : chosenDir === "S" ? "Downtown (S)" : "";
  const boroughLabel = chosenBorough || "";
  const lines = Array.from(selectedLineSet);

  summaryEl.textContent =
    (dirLabel ? dirLabel + " • " : "") +
    (boroughLabel ? boroughLabel + " • " : "") +
    (baseLabel ? baseLabel : "") +
    (lines.length ? (" • " + lines.join(", ")) : "");
}

function resetAll(){
  chosenDir = "";
  chosenBorough = "";
  chosenStationId = "";
  selectedLineSet.clear();
  filteredStations = [];
  board.style.display = "none";
  refreshBtn.style.display = "none";
  editBtn.style.display = "none";
  statusEl.textContent = "Pick your direction to begin.";
  updateSummary();
  setActiveScreen(1);
}

async function loadStations(){
  statusEl.textContent = "Loading stations…";
  const r = await fetch("/api/stations");
  if(!r.ok){
    statusEl.textContent = "Missing stations-ui.json (generate it and restart).";
    return;
  }
  stations = await r.json();

  const boroughs = unique(stations.map(s => s.borough).filter(b => b && b !== "Unknown"));
  setOptions(boroughSel, boroughs.map(b => ({value:b, label:b})), "Choose borough");

  statusEl.textContent = "Pick your direction to begin.";
  setActiveScreen(1);
}

pickUptown.addEventListener("click", () => {
  chosenDir = "N";
  updateSummary();
  setActiveScreen(2);
  next2.disabled = !boroughSel.value;
});
pickDowntown.addEventListener("click", () => {
  chosenDir = "S";
  updateSummary();
  setActiveScreen(2);
  next2.disabled = !boroughSel.value;
});

back2.addEventListener("click", () => setActiveScreen(1));
back3.addEventListener("click", () => setActiveScreen(2));
back4.addEventListener("click", () => setActiveScreen(3));

boroughSel.addEventListener("change", () => {
  chosenBorough = boroughSel.value || "";
  next2.disabled = !chosenBorough;

  // reset downstream
  chosenStationId = "";
  selectedLineSet.clear();
  filteredStations = chosenBorough ? stations.filter(s => s.borough === chosenBorough) : [];
  setOptions(
    stationSel,
    filteredStations.map(s => ({ value: s.id, label: cleanStationLabel(s.displayName || s.name) })),
    "Choose stop"
  );
  next3.disabled = true;
  goBtn.disabled = true;
  lineChips.innerHTML = "";
  updateSummary();
});

next2.addEventListener("click", () => {
  if (!chosenBorough) return;
  setActiveScreen(3);
});

stationSel.addEventListener("change", () => {
  chosenStationId = stationSel.value || "";
  next3.disabled = !chosenStationId;

  selectedLineSet.clear();
  const s = selectedStationObj();
  renderLineChips(s?.lines || []);
  updateSummary();
});

next3.addEventListener("click", () => {
  if (!chosenStationId) return;
  setActiveScreen(4);
  goBtn.disabled = false;
});

clearLinesBtn.addEventListener("click", () => {
  selectedLineSet.clear();
  const s = selectedStationObj();
  renderLineChips(s?.lines || []);
  updateSummary();
});

editBtn.addEventListener("click", () => {
  board.style.display = "none";
  refreshBtn.style.display = "none";
  editBtn.style.display = "none";
  statusEl.textContent = "Edit your choices.";
  setActiveScreen(1);
});

goBtn.addEventListener("click", async () => {
  await refresh();
});

refreshBtn.addEventListener("click", async () => {
  await refresh();
});

function getSelectedLines(){
  return Array.from(selectedLineSet).filter(l => !String(l).toUpperCase().includes("X"));
}

async function refresh(){
  const s = selectedStationObj();
  if(!s){
    board.style.display = "none";
    return;
  }

  const baseLabel = cleanStationLabel(s.displayName || s.name);
  const dirText = chosenDir === "N" ? "Uptown" : chosenDir === "S" ? "Downtown" : "";
  subtitle.textContent =
    (chosenBorough ? chosenBorough + " • " : "") +
    baseLabel +
    (dirText ? " • " + dirText : "");

  const chosenStopId = pickStopIdForDirection(s, chosenDir);
  const chosenLines = getSelectedLines();

  statusEl.textContent = "Loading departures…";
  tbody.innerHTML = '<tr><td colspan="3">Loading…</td></tr>';

  const url = new URL(location.origin + "/mta");
  url.searchParams.append("stopId", chosenStopId);
  for (const l of chosenLines) url.searchParams.append("line", l);

  const r = await fetch(url.toString());
  const d = await r.json();

  const deps = (d.departures || []).slice(0, 5);
  tbody.innerHTML = "";

  for(const dep of deps){
    const tr = document.createElement("tr");
    tr.innerHTML = \`
      <td><span class="\${pill(dep.routeId)}">\${dep.routeId || "?"}</span></td>
      <td>\${dep.stopId}</td>
      <td>\${dep.etaMinutes} min</td>\`;
    tbody.appendChild(tr);
  }

  if(!deps.length){
    tbody.innerHTML = '<tr><td colspan="3">No upcoming trains found.</td></tr>';
  }

  board.style.display = "block";
  refreshBtn.style.display = "inline-flex";
  editBtn.style.display = "inline-flex";

  updated.textContent = "Last updated: " + new Date().toLocaleTimeString();
  statusEl.textContent = "Ready.";
}

// Boot
resetAll();
loadStations().catch(err => {
  console.error(err);
  statusEl.textContent = "Failed to load stations.";
});

// Auto refresh every 60s if board visible
setInterval(() => {
  if(board.style.display !== "none") refresh();
}, 60000);
</script>
</body>
</html>`);
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log("Server listening on port " + PORT);
  console.log("MTA GTFS-Realtime feeds: public access enabled");
});
