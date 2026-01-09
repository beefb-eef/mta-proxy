// merge-boroughs-into-stations-ui.mjs
// Usage:
//   node merge-boroughs-into-stations-ui.mjs --in ./stations-ui.json --csv ./stations-lines.csv --out ./stations-ui.json

import fs from "node:fs";
import { parse } from "csv-parse/sync";

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

const IN_FILE = getArg("--in", "./stations-ui.json");
const CSV_FILE = getArg("--csv", "./stations-lines.csv");
const OUT_FILE = getArg("--out", "./stations-ui.json");

if (!fs.existsSync(IN_FILE)) {
  console.error(`Missing input JSON: ${IN_FILE}`);
  process.exit(1);
}
if (!fs.existsSync(CSV_FILE)) {
  console.error(`Missing borough CSV: ${CSV_FILE}`);
  process.exit(1);
}

const stations = JSON.parse(fs.readFileSync(IN_FILE, "utf8"));

// Read CSV, handle BOM + weird header casing
const csvText = fs.readFileSync(CSV_FILE, "utf8").replace(/^\uFEFF/, "");
const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });

// Build header-insensitive accessor
function getField(row, candidates) {
  const keys = Object.keys(row);
  for (const c of candidates) {
    const hit = keys.find(k => k.toLowerCase() === c.toLowerCase());
    if (hit) return row[hit];
  }
  return "";
}

function cleanId(x) {
  return String(x ?? "").trim().replace(/^"|"$/g, "");
}
function cleanBorough(x) {
  return String(x ?? "").trim().replace(/^"|"$/g, "");
}

const idToBorough = new Map();
for (const r of rows) {
  const id = cleanId(getField(r, ["id", "stop_id", "station_id"]));
  const borough = cleanBorough(getField(r, ["Borough", "borough"]));
  if (id && borough) idToBorough.set(id, borough);
}

let matched = 0;
let missing = 0;

for (const s of stations) {
  const id = cleanId(s.id);
  const b = idToBorough.get(id);
  if (b) {
    s.borough = b;
    matched++;
  } else {
    // keep existing if present, else Unknown
    s.borough = s.borough && s.borough !== "Unknown" ? s.borough : "Unknown";
    missing++;
  }
}

fs.writeFileSync(OUT_FILE, JSON.stringify(stations, null, 2), "utf8");
console.log(`✅ Borough rows loaded: ${idToBorough.size}`);
console.log(`✅ Stations updated: ${stations.length}`);
console.log(`✅ Matched boroughs: ${matched}`);
console.log(`⚠️ Still Unknown: ${missing}`);
console.log(`Wrote: ${OUT_FILE}`);
