import express from 'express';
import fetch from 'node-fetch';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const app = express();
const PORT = process.env.PORT || 3000;

// Three feeds: ACE + BDFM + 1/2/3 (main)
const FEED_URLS = [
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs'
];

// Station + stops
const STATION_NAME = '116 St';

const STOPS = [
  { id: 'A16S', label: 'C/B 116th South' },
  { id: '226S', label: '1/2 116th South' }
];

// Fetch + decode ALL feeds
async function fetchAllFeeds() {
  const results = await Promise.all(
    FEED_URLS.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`MTA feed error: ${res.status} ${res.statusText}`);
      const buffer = await res.arrayBuffer();
      return GtfsRealtimeBindings
        .transit_realtime
        .FeedMessage
        .decode(new Uint8Array(buffer));
    })
  );
  return results;
}

// Extract departures
function filterDeparturesForStops(feeds, stopIds) {
  const nowSec = Math.floor(Date.now() / 1000);
  const departures = [];

  feeds.forEach(feed => {
    feed.entity.forEach(entity => {
      if (!entity.tripUpdate || !entity.tripUpdate.stopTimeUpdate) return;

      const routeId = entity.tripUpdate.trip.routeId;
      entity.tripUpdate.stopTimeUpdate.forEach(stu => {
        if (!stopIds.includes(stu.stopId)) return;

        const t =
          stu.arrival?.time?.toNumber?.() ??
          stu.arrival?.time ??
          stu.departure?.time?.toNumber?.() ??
          stu.departure?.time;

        if (!t) return;

        const etaSec = t - nowSec;
        if (etaSec < 0) return;

        departures.push({
          routeId,
          stopId: stu.stopId,
          timestamp: t,
          etaMinutes: Math.round(etaSec / 60)
        });
      });
    });
  });

  departures.sort((a, b) => a.timestamp - b.timestamp);
  return departures;
}

// JSON API
app.get('/mta', async (req, res) => {
  try {
    const stopIds = Array.isArray(req.query.stopId)
      ? req.query.stopId
      : req.query.stopId
        ? [req.query.stopId]
        : [];

    if (!stopIds.length) return res.status(400).json({ error: 'Provide stopId' });

    const feeds = await fetchAllFeeds();
    const departures = filterDeparturesForStops(feeds, stopIds);

    res.json({
      stops: stopIds,
      lastUpdated: new Date().toISOString(),
      departures
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


//
// ========= MODERN DARK BOARD =========
//
app.get('/station/116', (req, res) => {
  const stopsJson = JSON.stringify(STOPS);
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Your next train</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  background:#05060a; color:#f0f6fc;
  font-family: system-ui, -apple-system, BlinkMacSystemFont;
  margin:0; padding:12px;
  display:flex; justify-content:center; min-height:100vh;
}
.container { max-width:1000px; width:100%; display:flex; flex-direction:column; gap:12px; }
.top-header h1 { margin:0; font-size:2rem; letter-spacing:.03em; }
.station-label { color:#8b949e; font-size:.9rem; }
.layout { display:grid; grid-template-columns:1fr; gap:10px; }
@media(min-width:700px){ .layout{grid-template-columns:1fr 1fr;} }
.board {
  background:#11151d; border-radius:16px; padding:16px 18px;
  box-shadow:0 14px 35px rgba(0,0,0,.65);
}
.subtitle{margin:0 0 8px;font-size:1.1rem;font-weight:600;}
.updated{color:#8b949e;font-size:.75rem;}
table{width:100%;border-collapse:collapse;}
th,td{padding:6px 2px;font-size:1rem;}
th{color:#8b949e;border-bottom:1px solid #30363d;}
tr+tr td{border-top:1px solid #21262d;}
.route-pill{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:28px;height:28px;border-radius:999px;
  font-size:.9rem;font-weight:700;color:#fff;padding:0 10px;
}
.route-blue{background:#0039A6;}
.route-orange{background:#FF6319;}
.route-red{background:#EE352E;}
</style>
</head>
<body>
<div class="container">
  <div class="top-header">
    <h1>Your next train</h1>
    <div class="station-label">${STATION_NAME}</div>
  </div>
  <div class="layout">
    ${STOPS.map(s=>`
      <div class="board">
        <p class="subtitle">${s.label}</p>
        <div class="updated" id="updated-${s.id}">Loading…</div>
        <table>
          <thead><tr><th>Route</th><th>ETA</th></tr></thead>
          <tbody id="tbody-${s.id}">
            <tr><td colspan="2">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    `).join('')}
  </div>
</div>

<script>
const STOPS=${stopsJson};

function cls(route){
  route=String(route||'').toUpperCase();
  if(['A','C'].includes(route))return'route-pill route-blue';
  if(['B','D'].includes(route))return'route-pill route-orange';
  if(['1','2','3'].includes(route))return'route-pill route-red';
  return'route-pill';
}

async function load(stop){
  const r=await fetch('/mta?stopId='+stop.id);
  const d=await r.json();
  const b=document.getElementById('tbody-'+stop.id);
  const u=document.getElementById('updated-'+stop.id);
  b.innerHTML='';
  (d.departures||[]).slice(0,3).forEach(dep=>{
    const tr=document.createElement('tr');
    tr.innerHTML=\`
      <td><span class="\${cls(dep.routeId)}">\${dep.routeId||'?'}</span></td>
      <td>\${dep.etaMinutes} min</td>\`;
    b.appendChild(tr);
  });
  if(!b.innerHTML) b.innerHTML='<tr><td colspan="2">No trains</td></tr>';
  u.textContent='Last updated: '+new Date().toLocaleTimeString();
}

function all(){ STOPS.forEach(load); }
all(); setInterval(all,60000);
</script>
</body>
</html>`);
});


//
// ========= RETRO MOODY BOARD =========
//
app.get('/station/116/retro', (req,res)=>{
  const stopsJson = JSON.stringify(STOPS);
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Your next train</title>
<style>
:root{color-scheme:dark;}
*{box-sizing:border-box;}
body{
  margin:0;padding:14px;
  font-family:system-ui,-apple-system,BlinkMacSystemFont;
  background:
    radial-gradient(circle at top left,#3b2533 0,transparent 55%),
    radial-gradient(circle at bottom right,#10272f 0,transparent 55%),
    #07060a;
  color:#f7f3eb;
  display:flex;justify-content:center;min-height:100vh;
}
.container{max-width:1000px;width:100%;display:flex;flex-direction:column;gap:12px;}
.top-header h1{margin:0;font-size:2rem;letter-spacing:.18em;text-transform:uppercase;}
.station-label{color:#d1c4aa;text-transform:uppercase;font-size:.9rem;letter-spacing:.08em;}
.layout{display:grid;grid-template-columns:1fr;gap:12px;}
@media(min-width:720px){.layout{grid-template-columns:1fr 1fr;}}
.board{
  background:linear-gradient(135deg,#171219,#121a22);
  border-radius:18px;
  padding:16px;
  box-shadow:0 18px 45px rgba(0,0,0,.7);
}
.subtitle{text-transform:uppercase;letter-spacing:.06em;margin:0 0 6px;}
.route-pill{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:30px;height:30px;border-radius:999px;
  color:#fff;font-weight:800;padding:0 12px;
}
.route-blue{background:#0039A6;}
.route-orange{background:#FF6319;}
.route-red{background:#EE352E;}
</style>
</head>
<body>
<div class="container">
  <div class="top-header">
    <h1>Your next train</h1>
    <div class="station-label">${STATION_NAME}</div>
  </div>
  <div class="layout">
    ${STOPS.map(s=>`
      <div class="board">
        <p class="subtitle">${s.label}</p>
        <div id="updated-${s.id}">Loading…</div>
        <table width="100%">
          <thead><tr><th>Route</th><th>ETA</th></tr></thead>
          <tbody id="tbody-${s.id}">
            <tr><td colspan="2">Loading…</td></tr>
          </tbody>
        </table>
      </div>
    `).join('')}
  </div>
</div>

<script>
const STOPS=${stopsJson};

function cls(route){
  route=String(route||'').toUpperCase();
  if(['A','C'].includes(route))return'route-pill route-blue';
  if(['B','D'].includes(route))return'route-pill route-orange';
  if(['1','2','3'].includes(route))return'route-pill route-red';
  return'route-pill';
}

async function load(stop){
  const r=await fetch('/mta?stopId='+stop.id);
  const d=await r.json();
  const b=document.getElementById('tbody-'+stop.id);
  const u=document.getElementById('updated-'+stop.id);
  b.innerHTML='';
  (d.departures||[]).slice(0,3).forEach(dep=>{
    const tr=document.createElement('tr');
    tr.innerHTML=\`
      <td><span class="\${cls(dep.routeId)}">\${dep.routeId||'?'}</span></td>
      <td>\${dep.etaMinutes} min</td>\`;
    b.appendChild(tr);
  });
  if(!b.innerHTML) b.innerHTML='<tr><td colspan="2">No trains</td></tr>';
  u.textContent='Last updated: '+new Date().toLocaleTimeString();
}

function all(){ STOPS.forEach(load); }
all(); setInterval(all,60000);
</script>
</body>
</html>`);
});


// HOME
app.get('/',(req,res)=>{
  res.send('Try /station/116 or /station/116/retro');
});

app.listen(PORT,()=>{
  console.log('Server listening on port '+PORT);
});
