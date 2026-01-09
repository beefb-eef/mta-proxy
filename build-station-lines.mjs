// build-station-lines.mjs
// Usage:
//   node build-station-lines.mjs --gtfs ./gtfs --out ./stations-lines.json
//
// Expects these GTFS files in the --gtfs folder:
//   stops.txt, routes.txt, trips.txt, stop_times.txt
//
// Output JSON shape:
//   [
//     { id: "635", name: "Times Sq - 42 St", lines: ["1","2","3","7","A","C","E","N","Q","R","W","S"] },
//     ...
//   ]

import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse";

function getArg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

const GTFS_DIR = getArg("--gtfs", "./gtfs");
const OUT_FILE = getArg("--out", "./stations-lines.json");
const ONLY_SUBWAY = process.argv.includes("--only-subway"); // optional: filter routes by route_type == 1

const required = ["stops.txt", "routes.txt", "trips.txt", "stop_times.txt"];
for (const f of required) {
  const p = path.join(GTFS_DIR, f);
  if (!fs.existsSync(p)) {
    console.error(`Missing ${f} at: ${p}`);
    process.exit(1);
  }
}

function streamCsv(filePath) {
  return fs
    .createReadStream(filePath)
    .pipe(
      parse({
        columns: true,
        relax_quotes: true,
        relax_column_count: true,
        trim: true,
      })
    );
}

async function loadStops() {
  // stop_id -> { name, parent_station }
  // and a helper map: stop_id -> station_id (parent if present else stop_id)
  const stopsPath = path.join(GTFS_DIR, "stops.txt");

  const stopInfo = new Map();
  const stopToStation = new Map();
  const stationName = new Map(); // station_id -> name (prefer parent station name)

  for await (const row of streamCsv(stopsPath)) {
    const stop_id = row.stop_id;
    if (!stop_id) continue;

    const name = row.stop_name || "";
    const parent = row.parent_station || "";

    stopInfo.set(stop_id, { name, parent_station: parent });

    const station_id = parent && parent.length ? parent : stop_id;
    stopToStation.set(stop_id, station_id);

    // Prefer station's own name if it's a parent station row, else set if not already present
    // Many feeds include a parent station row with stop_id == parent_station and parent_station empty.
    if (!stationName.has(station_id) || (!parent && name)) {
      // If this row is the station itself (no parent_station), it’s a good canonical name.
      stationName.set(station_id, name);
    }
  }

  return { stopToStation, stationName };
}

async function loadRoutes() {
  // route_id -> { shortName, longName, route_type }
  const routesPath = path.join(GTFS_DIR, "routes.txt");

  const routeMap = new Map();
  for await (const row of streamCsv(routesPath)) {
    const route_id = row.route_id;
    if (!route_id) continue;

    const shortName = row.route_short_name || route_id;
    const longName = row.route_long_name || "";
    const routeType = row.route_type != null ? String(row.route_type) : "";

    routeMap.set(route_id, { shortName, longName, routeType });
  }

  return routeMap;
}

async function loadTripsToRoute() {
  // trip_id -> route_id
  const tripsPath = path.join(GTFS_DIR, "trips.txt");

  const tripToRoute = new Map();
  let count = 0;

  for await (const row of streamCsv(tripsPath)) {
    const trip_id = row.trip_id;
    const route_id = row.route_id;
    if (!trip_id || !route_id) continue;
    tripToRoute.set(trip_id, route_id);
    count++;
    if (count % 200000 === 0) console.log(`Loaded trips: ${count.toLocaleString()}`);
  }

  console.log(`Loaded trips total: ${count.toLocaleString()}`);
  return tripToRoute;
}

async function buildStationLines({ stopToStation, stationName, routeMap, tripToRoute }) {
  const stopTimesPath = path.join(GTFS_DIR, "stop_times.txt");

  // station_id -> Set(route_id)
  const stationRoutes = new Map();

  let rows = 0;
  let missedTrips = 0;
  let missedStops = 0;

  for await (const row of streamCsv(stopTimesPath)) {
    rows++;
    const trip_id = row.trip_id;
    const stop_id = row.stop_id;

    if (!trip_id || !stop_id) continue;

    const route_id = tripToRoute.get(trip_id);
    if (!route_id) {
      missedTrips++;
      continue;
    }

    const station_id = stopToStation.get(stop_id);
    if (!station_id) {
      missedStops++;
      continue;
    }

    // Optional filter: keep only route_type == 1 (subway/metro) if present
    if (ONLY_SUBWAY) {
      const r = routeMap.get(route_id);
      if (r && r.routeType && r.routeType !== "1") continue;
    }

    let set = stationRoutes.get(station_id);
    if (!set) {
      set = new Set();
      stationRoutes.set(station_id, set);
    }
    set.add(route_id);

    if (rows % 1000000 === 0) {
      console.log(
        `Processed stop_times: ${rows.toLocaleString()} | stations: ${stationRoutes.size.toLocaleString()}`
      );
    }
  }

  console.log(`Processed stop_times total: ${rows.toLocaleString()}`);
  if (missedTrips) console.log(`Warning: stop_times rows with unknown trip_id: ${missedTrips.toLocaleString()}`);
  if (missedStops) console.log(`Warning: stop_times rows with unknown stop_id: ${missedStops.toLocaleString()}`);

  // Convert to output array
  const stations = [];
  for (const [station_id, routeIds] of stationRoutes.entries()) {
    const name = stationName.get(station_id) || station_id;

    const lines = Array.from(routeIds)
      .map((rid) => routeMap.get(rid)?.shortName || rid)
      .filter(Boolean);

    // Dedup + sort (numeric-friendly for 1/2/3/7 etc)
    const unique = Array.from(new Set(lines)).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );

    stations.push({ id: station_id, name, lines: unique });
  }

  // Sort stations by name
  stations.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return stations;
}

async function main() {
  console.log(`GTFS dir: ${GTFS_DIR}`);
  console.log(`Output:   ${OUT_FILE}`);
  if (ONLY_SUBWAY) console.log(`Filter:   only subway routes (route_type == 1)`);

  const { stopToStation, stationName } = await loadStops();
  console.log(`Loaded stops: ${stopToStation.size.toLocaleString()} (stop->station mappings)`);

  const routeMap = await loadRoutes();
  console.log(`Loaded routes: ${routeMap.size.toLocaleString()}`);

  const tripToRoute = await loadTripsToRoute();
  console.log(`Trip->route map size: ${tripToRoute.size.toLocaleString()}`);

  const stations = await buildStationLines({ stopToStation, stationName, routeMap, tripToRoute });

  fs.writeFileSync(OUT_FILE, JSON.stringify(stations, null, 2), "utf8");
  console.log(`✅ Wrote ${stations.length.toLocaleString()} stations to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
