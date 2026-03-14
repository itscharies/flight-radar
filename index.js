/**
 * Flight Radar — Node.js Server
 * --------------------------------
 * Fetches flight data from OpenSky, renders an HTML dashboard,
 * screenshots it with Puppeteer, converts to 4-bit grayscale bitmap,
 * and serves it for the ESP32 to fetch and display.
 *
 * Install:
 *   npm install express puppeteer sharp axios dotenv
 *
 * Run:
 *   node server.js
 */

require("dotenv").config();
const express = require("express");
const puppeteer = require("puppeteer");
const sharp = require("sharp");
const axios = require("axios");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const ejs = require("ejs");

const app = express();
const PORT = process.env.PORT || 8080;

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  location: {
    name: process.env.LOCATION_NAME || "Home",
    lat: parseFloat(process.env.LOCATION_LAT),
    lon: parseFloat(process.env.LOCATION_LON),
  },
  radiusKm: parseFloat(process.env.RADIUS_KM),
  altMinM: parseFloat(process.env.ALTITUDE_MIN_M),
  altMaxM: parseFloat(process.env.ALTITUDE_MAX_M ),
  baroAltMaxM: parseFloat(process.env.BARO_ALT_MAX_M),
  opensky: {
    clientId: process.env.OPENSKY_CLIENT_ID,
    clientSecret: process.env.OPENSKY_CLIENT_SECRET,
  },
};

// Display dimensions (final bitmap)
const EPD_W = 960;
const EPD_H = 540;
// Render at 2x then downscale for smoother edges
const RENDER_SCALE = 2;

// ─── OPENSKY TOKEN CACHE ──────────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiresAt = null;

async function getOpenSkyToken() {
  if (!CONFIG.opensky.clientId || !CONFIG.opensky.clientSecret) return null;
  if (cachedToken && tokenExpiresAt && Date.now() < tokenExpiresAt) return cachedToken;

  try {
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CONFIG.opensky.clientId,
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

// ─── OPENSKY FETCH ────────────────────────────────────────────────────────────

const MIN_RADIUS_KM = 1; // avoid degenerate bbox and tile math

function getBoundingBox(lat, lon, radiusKm) {
  const r = Math.max(radiusKm, MIN_RADIUS_KM);
  const dLat = r / 111.0;
  const dLon = r / (111.0 * Math.cos((lat * Math.PI) / 180));
  return { lamin: lat - dLat, lamax: lat + dLat, lomin: lon - dLon, lomax: lon + dLon };
}

// OSM tile math (Web Mercator)
function lonToTileX(lon, z) {
  const n = 2 ** z;
  return ((lon + 180) / 360) * n;
}
function latToTileY(lat, z) {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
}
function tileYToLat(ty, z) {
  const n = 2 ** z;
  return (180 / Math.PI) * (2 * Math.atan(Math.exp(Math.PI * (1 - (2 * ty) / n))) - Math.PI / 2);
}

function getTilesForMap(bbox, mapW, mapH) {
  const { lamin, lamax, lomin, lomax } = bbox;
  const lonSpan = lomax - lomin;
  const latSpan = lamax - lamin;
  // 256px tile at zoom z covers 360/2^z deg; we want bbox to fill map => 2^z = map*360/(256*span)
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
      const left = ((tileLonMin - lomin) / lonSpan) * mapW;
      const top = ((lamax - tileLatMax) / latSpan) * mapH;
      const width = ((tileLonMax - tileLonMin) / lonSpan) * mapW;
      const height = ((tileLatMax - tileLatMin) / latSpan) * mapH;
      tiles.push({
        url: `https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/${z}/${tx}/${ty}@2x.png`,
        left, top, width, height,
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

function msToKmph(ms) {
  return ms != null ? Math.round(ms * 3.6) : null;
}


async function fetchOpenSky() {
  const { lat, lon } = CONFIG.location;
  const bbox = getBoundingBox(lat, lon, CONFIG.radiusKm);
  const token = await getOpenSkyToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  const resp = await axios.get("https://opensky-network.org/api/states/all", {
    params: {
      lamin: bbox.lamin.toFixed(4), lamax: bbox.lamax.toFixed(4),
      lomin: bbox.lomin.toFixed(4), lomax: bbox.lomax.toFixed(4)
    },
    headers,
    timeout: 30000,
  });

  const states = resp.data.states || [];
  console.log(`OpenSky returned ${states.length} aircraft`);

  const aircraft = states.map(s => ({
    icao24: s[0],
    callsign: (s[1] || "").trim() || null,
    country: s[2],
    lon: s[5],
    lat: s[6],
    altM: s[13],   // WGS84 geometric (EGM96) altitude
    baroAltM: s[7],   // barometric altitude
    onGround: s[8],
    speedMs: s[9],
    heading: s[10],
    vertRate: s[11],
  }));

  // Filter: airborne + position; altitude: prefer geometric in [min,max], else barometric with no min, max baroAltMaxM
  const airborne = aircraft.filter(a => {
    if (a.onGround || a.lat == null || a.lon == null) return false;
    if (a.altM != null && a.altM >= CONFIG.altMinM && a.altM <= CONFIG.altMaxM) return true;
    if (a.altM == null && a.baroAltM != null && a.baroAltM <= CONFIG.baroAltMaxM) return true;
    return false;
  });

  console.log(`${airborne.length} aircraft after filtering`);

  // Sort by distance
  airborne.forEach(a => {
    a.distanceKm = Math.round(haversineKm(lat, lon, a.lat, a.lon) * 10) / 10;
  });
  airborne.sort((a, b) => a.distanceKm - b.distanceKm);

  const ac = airborne[0] || null;
  if (ac && ac.altM == null && ac.baroAltM != null) ac.altM = ac.baroAltM;
  return ac;
}

// ─── ENRICHMENT ───────────────────────────────────────────────────────────────

async function enrichAircraft(icao24, callsign) {
  const result = { airline: null, route: null, aircraftType: null, originName: null, destName: null };
  if (!callsign) return result;

  try {
    const routeResp = await axios.get(`https://api.adsbdb.com/v0/callsign/${callsign}`, { timeout: 5000 });
    const fr = routeResp.data?.response?.flightroute;
    if (fr) {
      result.route = `${fr.origin?.iata_code || "?"} ➡ ${fr.destination?.iata_code || "?"}`;
      result.originName = fr.origin?.name || null;
      result.destName = fr.destination?.name || null;
      result.airline = fr.airline?.name || null;
    }
  } catch (_) { }

  try {
    const acResp = await axios.get(`https://api.adsbdb.com/v0/aircraft/${icao24}`, { timeout: 5000 });
    result.aircraftType = acResp.data?.response?.aircraft?.type || null;
  } catch (_) { }

  return result;
}

// ─── HTML TEMPLATE ────────────────────────────────────────────────────────────

const TEMPLATES_DIR = path.join(__dirname, "templates");

function buildHtml(ac, enrichment, updatedAt) {
  if (!ac) {
    return ejs.render(
      fs.readFileSync(path.join(TEMPLATES_DIR, "empty.ejs"), "utf8"),
      { updatedAt },
      { filename: path.join(TEMPLATES_DIR, "empty.ejs") }
    );
  }

  const vstatus = verticalStatus(ac.vertRate);
  const altitude = ac.altM != null ? Math.round(ac.altM) + " m" : "N/A";
  const speed = msToKmph(ac.speedMs) != null ? msToKmph(ac.speedMs) + " km/h" : "N/A";
  const { lat, lon } = CONFIG.location;
  const bbox = getBoundingBox(lat, lon, CONFIG.radiusKm);
  const mapDisplaySize = 356;
  const mapW = mapDisplaySize * 2;
  const mapH = mapDisplaySize * 2;
  const lonSpan = bbox.lomax - bbox.lomin;
  const latSpan = bbox.lamax - bbox.lamin;
  const planeX = lonSpan ? ((ac.lon - bbox.lomin) / lonSpan) * mapW : mapW / 2;
  const planeY = latSpan ? ((bbox.lamax - ac.lat) / latSpan) * mapH : mapH / 2;
  const centerX = mapW / 2;
  const centerY = mapH / 2;
  const radiusPxX = lonSpan ? (CONFIG.radiusKm / (111 * Math.cos((lat * Math.PI) / 180)) / lonSpan) * mapW : mapW / 2;
  const radiusPxY = latSpan ? (CONFIG.radiusKm / 111 / latSpan) * mapH : mapH / 2;
  const planeHeading = ac.heading != null ? Math.round(ac.heading) : 0;
  const mapTiles = getTilesForMap(bbox, mapW, mapH);
  // Scale map so it fills body height (540 - header ~122 - footer ~46 ≈ 372)
  const bodyHeight = EPD_H - 122 - 46;
  const mapScale = (bodyHeight / mapH).toFixed(4);

  const locals = {
    ac,
    enrichment,
    updatedAt,
    vstatus,
    altitude,
    speed,
    locationName: CONFIG.location.name,
    mapW, mapH, mapScale, centerX, centerY, radiusPxX, radiusPxY, planeX, planeY, planeHeading,
    mapTiles,
  };
  return ejs.render(
    fs.readFileSync(path.join(TEMPLATES_DIR, "aircraft.ejs"), "utf8"),
    locals,
    { filename: path.join(TEMPLATES_DIR, "aircraft.ejs") }
  );
}

// ─── PUPPETEER + SHARP ────────────────────────────────────────────────────────

let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browser;
}

async function renderBitmap(html) {
  const b = await getBrowser();
  const page = await b.newPage();
  await page.setViewport({
    width: EPD_W,
    height: EPD_H,
    deviceScaleFactor: RENDER_SCALE,
  });
  await page.setUserAgent("FlightRadar/1.0 (https://github.com/flight-radar)");
  await page.setContent(html, { waitUntil: "networkidle0" });
  const png = await page.screenshot({ type: "png" });
  await page.close();

  // Flatten any transparency to white, then downscale and grayscale
  const raw = await sharp(png)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .resize(EPD_W, EPD_H, { kernel: sharp.kernel.lanczos3 })
    .grayscale()
    .raw()
    .toBuffer();

  // Pack to 4-bit: first pixel in low nibble, second in high (driver byte order)
  const packed = Buffer.alloc((EPD_W * EPD_H) / 2);
  for (let i = 0; i < EPD_W * EPD_H; i += 2) {
    const a = (raw[i] >> 4) & 0x0F;
    const b = (raw[i + 1] >> 4) & 0x0F;
    packed[i / 2] = a | (b << 4);
  }

  return packed;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Bitmap endpoint — ESP32 fetches this. Send If-None-Match: <last ETag> to get 304 when unchanged.
app.get("/bitmap", async (req, res) => {
  try {
    const updatedAt = new Date().toLocaleString("en-AU", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Australia/Sydney"
    });

    const ac = await fetchOpenSky();
    const enrichment = ac ? await enrichAircraft(ac.icao24, ac.callsign) : {};
    const html = buildHtml(ac, enrichment, updatedAt);
    const bitmap = await renderBitmap(html);

    const hash = crypto.createHash("md5").update(bitmap).digest("hex");
    const etag = `"${hash}"`;
    res.set("Content-Type", "application/octet-stream");
    res.set("ETag", etag);
    res.set("X-Bitmap-Hash", hash);
    res.set("X-Aircraft-Count", ac ? "1" : "0");

    const ifNoneMatch = (req.get("If-None-Match") || "").replace(/^"|"$/g, "").trim();
    if (ifNoneMatch && ifNoneMatch === hash) {
      res.status(304).end();
      console.log(`Bitmap unchanged — 304 (aircraft: ${ac?.callsign || "none"})`);
      return;
    }

    res.send(bitmap);
    console.log(`Served bitmap — aircraft: ${ac?.callsign || "none"}`);
  } catch (err) {
    console.error("Bitmap error:", err.message);
    res.status(503).send("Error generating bitmap");
  }
});

// Preview endpoint — view in browser during development
app.get("/preview", async (req, res) => {
  try {
    const updatedAt = new Date().toLocaleString("en-AU", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Australia/Sydney"
    });
    const ac = await fetchOpenSky();
    const enrichment = ac ? await enrichAircraft(ac.icao24, ac.callsign) : {};
    const html = buildHtml(ac, enrichment, updatedAt);
    res.set("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    res.status(503).send(`Error: ${err.message}`);
  }
});

// Test route — preview aircraft template with mock data (no OpenSky fetch)
app.get("/preview/aircraft", (req, res) => {
  try {
    const { lat, lon } = CONFIG.location;
    const updatedAt = new Date().toLocaleString("en-AU", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Australia/Sydney"
    });
    const ac = {
      icao24: "abc123",
      callsign: "QFA456",
      country: "AU",
      lat: lat + 0.002,
      lon: lon + 0.001,
      altM: 3200,
      speedMs: 220,
      heading: 135,
      vertRate: 2.1,
    };
    const enrichment = {
      route: "SYD ➡ MEL",
      originName: "Sydney Kingsford Smith",
      destName: "Melbourne",
      airline: "Qantas",
      aircraftType: "Boeing 737-800",
    };
    const html = buildHtml(ac, enrichment, updatedAt);
    res.set("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    res.status(503).send(`Error: ${err.message}`);
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));