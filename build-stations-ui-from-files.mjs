// build-stations-ui-from-files.mjs
// Usage:
//   node build-stations-ui-from-files.mjs --gtfs ./gtfs --json ./stations-lines.json --csv ./stations-lines.csv --out ./stations-ui.json

import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

const GTFS_DIR = getArg("--gtfs", "./gtfs");
const JSON_FILE = getArg("--json", "./stations-lines.json");
const CSV_FILE  = getArg("--csv", "./stations-lines.csv");
const OUT_FILE  = getArg("--out", "./stations-ui.json");

for (const p of [
  path.join(GTFS_DIR, "stops.txt"),
  JSON_FILE,
  CSV_FILE
]) {
  if (!fs.existsSync(p)) {
    console.error(`Missing: ${p}`);
    process.exit(1);
  }
}

// --- helpers ---
function inferDirFromStopId(stopId) {
  const last = stopId?.slice(-1)?.toUpperCase();
  if (last === "N" || last === "S") return last;
  return null;
}
function normName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// --- load your existing stations-lines.json ---
const stationsBase = JSON.parse(fs.readFileSync(JSON_FILE, "utf8")); 
// expecting array like [{id,name,lines}] from your previous work

const byId = new Map(stationsBase.map(s => [String(s.id), { ...s }]));

// --- load borough CSV (id -> borough) ---
const csvText = fs.readFileSync(CSV_FILE, "utf8");
const records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });

const boroughById = new Map();
for (const r of records) {
  const id = String(r.id ?? "").trim();
  const borough = String(r.Borough ?? r.borough ?? "").trim();
  if (id && borough) boroughById.set(id, borough);
}

// --- parse GTFS stops.txt to find N/S platform variants for each parent station id ---
const stopsText = fs.readFileSync(path.join(GTFS_DIR, "stops.txt"), "utf8");
const stopRows = parse(stopsText, { columns: true, skip_empty_lines: true, trim: true });

// station_id -> { N: stopId, S: stopId }
const dirStopsByStation = new Map();

for (const row of stopRows) {
  const stopId = row.stop_id;
  if (!stopId) continue;

  const parent = (row.parent_station || "").trim();
  // If parent_station exists, that’s the station_id. Otherwise this row itself is a station row.
  const stationId = parent || stopId;

  // Only care about stations we actually have in stations-lines.json
  if (!byId.has(stationId)) continue;

  const dir = inferDirFromStopId(stopId);
  if (!dir) continue;

  let m = dirStopsByStation.get(stationId);
  if (!m) {
    m = new Map();
    dirStopsByStation.set(stationId, m);
  }
  if (!m.has(dir)) m.set(dir, stopId); // keep first if duplicates
}

// --- attach borough + directions ---
for (const [id, s] of byId.entries()) {
  s.borough = boroughById.get(id) || "Unknown";

  const dirMap = dirStopsByStation.get(id);
  const directions = [];
  if (dirMap?.has("N")) directions.push({ dir: "N", stopId: dirMap.get("N") });
  if (dirMap?.has("S")) directions.push({ dir: "S", stopId: dirMap.get("S") });
  s.directions = directions;
}

// --- duplicate-name rule: if same name occurs, append (lines...) ---
const nameCounts = new Map();
for (const s of byId.values()) {
  const k = normName(s.name);
  nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
}
for (const s of byId.values()) {
  const isDup = (nameCounts.get(normName(s.name)) || 0) > 1;
  s.displayName = isDup ? `${s.name} (${(s.lines || []).join(", ")})` : s.name;
}

// --- output array sorted for dropdown friendliness ---
const out = Array.from(byId.values()).sort((a, b) => {
  const bc = a.borough.localeCompare(b.borough, undefined, { sensitivity: "base" });
  if (bc !== 0) return bc;
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
});

fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf8");
console.log(`✅ Wrote ${out.length} stations to ${OUT_FILE}`);
