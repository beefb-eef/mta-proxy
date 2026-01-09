import fs from "node:fs";

const inFile = process.argv[2] || "./stations-lines.json";
const outFile = process.argv[3] || "./stations-lines.csv";

const stations = JSON.parse(fs.readFileSync(inFile, "utf8"));

// CSV header
const rows = [["id", "name", "lines"]];

// Escape helper for CSV
function esc(v) {
  const s = String(v ?? "");
  if (/[,"\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

for (const s of stations) {
  rows.push([
    esc(s.id),
    esc(s.name),
    esc((s.lines || []).join(" ")), // space-separated lines; easy to read/edit
  ]);
}

fs.writeFileSync(outFile, rows.map(r => r.join(",")).join("\n"), "utf8");
console.log(`Wrote ${rows.length - 1} rows to ${outFile}`);
