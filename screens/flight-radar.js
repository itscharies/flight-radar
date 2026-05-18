const express = require("express");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const ejs = require("ejs");
const { renderScreen, EPD_W, EPD_H } = require("../render");

const router = express.Router();
const TEMPLATES_DIR = path.join(__dirname, "../templates");

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  location: {
    name: process.env.LOCATION_NAME || "Home",
    lat: parseFloat(process.env.LOCATION_LAT),
    lon: parseFloat(process.env.LOCATION_LON),
  },
  radiusKm:    parseFloat(process.env.RADIUS_KM),
  altMinM:     parseFloat(process.env.ALTITUDE_MIN_M),
  altMaxM:     parseFloat(process.env.ALTITUDE_MAX_M),
  baroAltMaxM: parseFloat(process.env.BARO_ALT_MAX_M),
  opensky: {
    clientId:     process.env.OPENSKY_CLIENT_ID,
    clientSecret: process.env.OPENSKY_CLIENT_SECRET,
  },
  curfew: {
    tz:        "Australia/Sydney",
    startHour: 23,
    endHour:   6,
  },
  cooldownMs: Number(process.env.OPENSKY_COOLDOWN_MS),
};

const TIMEOUT_MS  = 15000;

// ─── CURFEW + COOLDOWN ────────────────────────────────────────────────────────

function isSydneyCurfew() {
  const hour = parseInt(
    new Date().toLocaleString("en-AU", { timeZone: CONFIG.curfew.tz, hour: "numeric", hour12: false }),
    10
  );
  if (CONFIG.curfew.startHour > CONFIG.curfew.endHour) {
    return hour >= CONFIG.curfew.startHour || hour < CONFIG.curfew.endHour;
  }
  return hour >= CONFIG.curfew.startHour && hour < CONFIG.curfew.endHour;
}

let lastAircraftCached = null;
let cooldownUntil = 0;

function useCachedAircraft() {
  if (!lastAircraftCached || Date.now() >= cooldownUntil) return null;
  return lastAircraftCached;
}

function setCooldown(ac, enrichment) {
  if (ac) {
    lastAircraftCached = { ac, enrichment };
    cooldownUntil = Date.now() + CONFIG.cooldownMs;
  } else {
    lastAircraftCached = null;
    cooldownUntil = 0;
  }
}

// Bitmap cache: skip re-render when data unchanged
let bitmapCache = null; // { key, bitmap, hash }

function contentKey(ac, enrichment) {
  return crypto.createHash("md5").update(JSON.stringify({ ac, enrichment })).digest("hex");
}

// ─── OPENSKY TOKEN ────────────────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiresAt = null;

async function getOpenSkyToken() {
  if (!CONFIG.opensky.clientId || !CONFIG.opensky.clientSecret) return null;
  if (cachedToken && tokenExpiresAt && Date.now() < tokenExpiresAt) return cachedToken;

  try {
    const params = new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     CONFIG.opensky.clientId,
      client_secret: CONFIG.opensky.clientSecret,
    });
    const resp = await axios.post(
      "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
    );
    cachedToken = resp.data.access_token;
    tokenExpiresAt = Date.now() + (resp.data.expires_in - 60) * 1000;
    console.log("OpenSky token acquired");
    return cachedToken;
  } catch (e) {
    console.warn("Token fetch failed, using anonymous:", e.message);
    return null;
  }
}

// ─── MAP / GEO HELPERS ────────────────────────────────────────────────────────

const MIN_RADIUS_KM = 1;

function getBoundingBox(lat, lon, radiusKm) {
  const r = Math.max(radiusKm, MIN_RADIUS_KM);
  const dLat = r / 111.0;
  const dLon = r / (111.0 * Math.cos((lat * Math.PI) / 180));
  return { lamin: lat - dLat, lamax: lat + dLat, lomin: lon - dLon, lomax: lon + dLon };
}

function lonToTileX(lon, z) { return ((lon + 180) / 360) * 2 ** z; }
function latToTileY(lat, z) {
  const latRad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * 2 ** z;
}
function tileYToLat(ty, z) {
  return (180 / Math.PI) * (2 * Math.atan(Math.exp(Math.PI * (1 - (2 * ty) / 2 ** z))) - Math.PI / 2);
}

function getTilesForMap(bbox, mapW, mapH) {
  const { lamin, lamax, lomin, lomax } = bbox;
  const lonSpan = lomax - lomin;
  const latSpan = lamax - lamin;
  const zFromLon = Math.log2((mapW * 360) / (256 * lonSpan));
  const zFromLat = Math.log2((mapH * 360) / (256 * latSpan * Math.cos((lamax * Math.PI) / 180)));
  const z = Math.min(14, Math.max(6, Math.floor(Math.min(zFromLon, zFromLat))));
  const n = 2 ** z;
  const xMin = Math.floor(lonToTileX(lomin, z));
  const xMax = Math.floor(lonToTileX(lomax, z));
  const yMin = Math.floor(latToTileY(lamax, z));
  const yMax = Math.floor(latToTileY(lamin, z));
  const tiles = [];
  for (let tx = xMin; tx <= xMax; tx++) {
    for (let ty = yMin; ty <= yMax; ty++) {
      const tileLonMin = (tx / n) * 360 - 180;
      const tileLonMax = ((tx + 1) / n) * 360 - 180;
      const tileLatMax = tileYToLat(ty, z);
      const tileLatMin = tileYToLat(ty + 1, z);
      tiles.push({
        url:    `https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/${z}/${tx}/${ty}@2x.png`,
        left:   ((tileLonMin - lomin) / lonSpan) * mapW,
        top:    ((lamax - tileLatMax) / latSpan) * mapH,
        width:  ((tileLonMax - tileLonMin) / lonSpan) * mapW,
        height: ((tileLatMax - tileLatMin) / latSpan) * mapH,
      });
    }
  }
  return tiles;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function verticalStatus(rate) {
  if (rate == null) return "Level";
  if (rate > 1.5) return "Climbing";
  if (rate < -1.5) return "Descending";
  return "Level";
}

function msToKmph(ms) { return ms != null ? Math.round(ms * 3.6) : null; }

function isHelicopter(ac, enrichment) {
  if (ac?.category === 8) return true;
  const t = (enrichment?.aircraftType || "").toLowerCase();
  return /helicopter|rotorcraft|helo\b|^h\d|^ec\d|^as\d|bell \d|robinson|^aw\d|^bk\d|ka-|mi-|s-76|s-92/i.test(t);
}

// ─── OPENSKY FETCH ────────────────────────────────────────────────────────────

async function fetchOpenSky() {
  const { lat, lon } = CONFIG.location;
  const bbox = getBoundingBox(lat, lon, CONFIG.radiusKm);
  const params = {
    lamin: bbox.lamin.toFixed(4), lamax: bbox.lamax.toFixed(4),
    lomin: bbox.lomin.toFixed(4), lomax: bbox.lomax.toFixed(4),
    extended: 1,
  };
  const token = await getOpenSkyToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  console.log(`OpenSky request (auth: ${!!token})`);

  let resp;
  try {
    resp = await axios.get("https://opensky-network.org/api/states/all", {
      params, headers, timeout: 30000, validateStatus: (s) => s < 500,
    });
  } catch (err) {
    console.error("OpenSky request failed:", err.message);
    return null;
  }

  if (resp.status === 429) { console.warn("OpenSky rate limited (429)"); return null; }
  if (resp.status !== 200) { console.error("OpenSky non-200:", resp.status); return null; }

  const ftToM = (v) => (v != null ? v * 0.3048 : null);
  const aircraft = (resp.data.states || []).map(s => ({
    icao24:   s[0],
    callsign: (s[1] || "").trim() || null,
    country:  s[2],
    lon:      s[5], lat: s[6],
    altM:     ftToM(s[13]),
    baroAltM: ftToM(s[7]),
    onGround: s[8],
    speedMs:  s[9],
    heading:  s[10],
    vertRate: s[11],
    category: s[17],
  }));

  function filterReason(a) {
    if (a.onGround) return "on_ground";
    if (a.lat == null || a.lon == null) return "no_position";
    if (a.altM != null && a.altM >= CONFIG.altMinM && a.altM <= CONFIG.altMaxM) return null;
    if (a.altM == null && a.baroAltM != null && a.baroAltM <= CONFIG.baroAltMaxM) return null;
    if (a.altM != null) return `geo_alt_out_of_range`;
    if (a.baroAltM != null) return `baro_alt_too_high`;
    return "no_altitude_data";
  }

  const airborne = aircraft.filter(a => filterReason(a) === null);
  const { lat: hlat, lon: hlon } = CONFIG.location;
  airborne.forEach(a => { a.distanceKm = Math.round(haversineKm(hlat, hlon, a.lat, a.lon) * 10) / 10; });
  airborne.sort((a, b) => a.distanceKm - b.distanceKm);
  console.log(`${airborne.length} aircraft after filtering`);

  const ac = airborne[0] || null;
  if (ac && ac.altM == null && ac.baroAltM != null) ac.altM = ac.baroAltM;
  return ac;
}

// ─── ENRICHMENT ───────────────────────────────────────────────────────────────

async function fetchOpenSkyRoute(icao24) {
  const token = await getOpenSkyToken();
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  try {
    const resp = await axios.get("https://opensky-network.org/api/flights/aircraft", {
      params: { icao24: icao24.toLowerCase(), begin: now - 2 * 24 * 3600, end: now },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000, validateStatus: (s) => s === 200 || s === 404,
    });
    if (resp.status === 404 || !Array.isArray(resp.data) || !resp.data.length) return null;
    const current = resp.data.find(f => f.firstSeen <= now && now <= f.lastSeen) || resp.data[resp.data.length - 1];
    const origin = current.estDepartureAirport || null;
    const dest   = current.estArrivalAirport   || null;
    return (origin && dest) ? { origin, dest } : null;
  } catch (_) { return null; }
}

async function enrichAircraft(icao24, callsign) {
  const result = { airline: null, route: null, aircraftType: null, originName: null, destName: null };
  if (!callsign) return result;

  const [openSkyRoute, routeResp, acResp] = await Promise.all([
    fetchOpenSkyRoute(icao24),
    axios.get(`https://api.adsbdb.com/v0/callsign/${callsign}`, { timeout: 5000 }).catch(() => null),
    axios.get(`https://api.adsbdb.com/v0/aircraft/${icao24}`, { timeout: 5000 }).catch(() => null),
  ]);

  if (openSkyRoute) result.route = `${openSkyRoute.origin} ➡ ${openSkyRoute.dest}`;

  if (routeResp?.data?.response?.flightroute) {
    const fr = routeResp.data.response.flightroute;
    if (!openSkyRoute) result.route = `${fr.origin?.iata_code || "?"} ➡ ${fr.destination?.iata_code || "?"}`;
    result.originName = fr.origin?.name || null;
    result.destName   = fr.destination?.name || null;
    result.airline    = fr.airline?.name || null;
  } else {
    console.log(`adsbdb callsign lookup: status=${routeResp?.status} body=${JSON.stringify(routeResp?.data).slice(0, 120)}`);
  }

  if (acResp?.data?.response?.aircraft?.type) result.aircraftType = acResp.data.response.aircraft.type;
  console.log(`Enrichment for ${callsign}: route=${result.route} airline=${result.airline} type=${result.aircraftType}`);

  return result;
}

async function getAircraftForRequest() {
  if (isSydneyCurfew()) { setCooldown(null, null); return { ac: null, enrichment: {} }; }
  const cached = useCachedAircraft();
  if (cached) {
    console.log(`OpenSky skipped (cooldown) — using cached ${cached.ac?.callsign || "?"}`);
    return cached;
  }
  const ac = await fetchOpenSky();
  const enrichment = ac ? await enrichAircraft(ac.icao24, ac.callsign) : {};
  setCooldown(ac, enrichment);
  return { ac, enrichment };
}

// ─── HTML BUILDER ─────────────────────────────────────────────────────────────

function buildHtml(ac, enrichment, updatedAt) {
  if (!ac) {
    return ejs.render(
      fs.readFileSync(path.join(TEMPLATES_DIR, "empty.ejs"), "utf8"),
      { updatedAt },
      { filename: path.join(TEMPLATES_DIR, "empty.ejs") }
    );
  }

  const vstatus  = verticalStatus(ac.vertRate);
  const altitude = ac.altM != null ? Math.round(ac.altM) + " m" : "N/A";
  const speed    = msToKmph(ac.speedMs) != null ? msToKmph(ac.speedMs) + " km/h" : "N/A";
  const { lat, lon } = CONFIG.location;
  const bbox = getBoundingBox(lat, lon, CONFIG.radiusKm);
  const mapDisplaySize = 356;
  const mapW = mapDisplaySize * 2;
  const mapH = mapDisplaySize * 2;
  const lonSpan = bbox.lomax - bbox.lomin;
  const latSpan = bbox.lamax - bbox.lamin;
  const bodyHeight = EPD_H - 120 - 51;

  return ejs.render(
    fs.readFileSync(path.join(TEMPLATES_DIR, "aircraft.ejs"), "utf8"),
    {
      ac, enrichment, updatedAt, vstatus, altitude, speed,
      locationName:  CONFIG.location.name,
      isHelicopter:  isHelicopter(ac, enrichment),
      mapW, mapH,
      mapScale:      (bodyHeight / mapH).toFixed(4),
      centerX:       mapW / 2,
      centerY:       mapH / 2,
      radiusPxX:     lonSpan ? (CONFIG.radiusKm / (111 * Math.cos((lat * Math.PI) / 180)) / lonSpan) * mapW : mapW / 2,
      radiusPxY:     latSpan ? (CONFIG.radiusKm / 111 / latSpan) * mapH : mapH / 2,
      planeX:        lonSpan ? ((ac.lon - bbox.lomin) / lonSpan) * mapW : mapW / 2,
      planeY:        latSpan ? ((bbox.lamax - ac.lat) / latSpan) * mapH : mapH / 2,
      planeHeading:  ac.heading != null ? Math.round(ac.heading) : 0,
      mapTiles:      getTilesForMap(bbox, mapW, mapH),
    },
    { filename: path.join(TEMPLATES_DIR, "aircraft.ejs") }
  );
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const updatedAt = new Date().toLocaleString("en-AU", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Australia/Sydney",
    });
    const { ac, enrichment } = await getAircraftForRequest();

    const html = buildHtml(ac, enrichment, updatedAt);

    if (req.query.preview !== undefined) {
      return res.type("html").send(html);
    }

    const key = contentKey(ac, enrichment);
    let bitmap, hash;
    if (bitmapCache && bitmapCache.key === key) {
      ({ bitmap, hash } = bitmapCache);
      console.log(`Bitmap cache hit (${ac?.callsign || "empty"})`);
    } else {
      ({ bitmap, hash } = await renderScreen(html, []));
      bitmapCache = { key, bitmap, hash };
    }

    const etag = `"${hash}"`;
    if (req.get("If-None-Match") === etag) {
      return res.status(304).end();
    }
    res.set("ETag", etag).json({
      bitmap:      bitmap.toString("base64"),
      buttons:     [],
      timeout_ms:  TIMEOUT_MS,
      timeout_url: null,
    });
    console.log(`Served radar screen — aircraft: ${ac?.callsign || "none"}`);
  } catch (err) {
    console.error("Flight radar error:", err.message);
    res.status(503).json({ error: err.message });
  }
});

// Debug: raw OpenSky diagnostics
router.get("/debug", async (req, res) => {
  const { lat, lon } = CONFIG.location;
  const bbox = getBoundingBox(lat, lon, CONFIG.radiusKm);
  const params = {
    lamin: bbox.lamin.toFixed(4), lamax: bbox.lamax.toFixed(4),
    lomin: bbox.lomin.toFixed(4), lomax: bbox.lomax.toFixed(4),
  };
  const token = await getOpenSkyToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const out = { bbox: params, radiusKm: Math.max(CONFIG.radiusKm, 1), authenticated: !!token };
  try {
    const resp = await axios.get("https://opensky-network.org/api/states/all", {
      params, headers, timeout: 15000, validateStatus: () => true,
    });
    out.httpStatus = resp.status;
    out.rateLimited = resp.status === 429;
    const states = resp.data.states || [];
    const withPos  = states.filter(s => s[6] != null && s[5] != null);
    const airborne = withPos.filter(s => !s[8]);
    out.statesReturned = states.length;
    out.withPosition   = withPos.length;
    out.airborne       = airborne.length;
    return res.json(out);
  } catch (err) {
    out.error = err.message;
    return res.status(500).json(out);
  }
});

module.exports = router;
