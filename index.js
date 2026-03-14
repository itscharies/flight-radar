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
const express    = require("express");
const puppeteer  = require("puppeteer");
const sharp      = require("sharp");
const axios      = require("axios");
const path       = require("path");
const fs         = require("fs");

const app  = express();
const PORT = process.env.PORT || 8080;

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CONFIG = {
  location: {
    name: process.env.LOCATION_NAME || "Home",
    lat:  parseFloat(process.env.LOCATION_LAT),
    lon:  parseFloat(process.env.LOCATION_LON),
  },
  radiusKm:     parseFloat(process.env.RADIUS_KM     || 50),
  altMinM:      parseFloat(process.env.ALTITUDE_MIN_M || 50),
  altMaxM:      parseFloat(process.env.ALTITUDE_MAX_M || 400),
  opensky: {
    clientId:     process.env.OPENSKY_CLIENT_ID,
    clientSecret: process.env.OPENSKY_CLIENT_SECRET,
  },
};

// Display dimensions
const EPD_W = 960;
const EPD_H = 540;

// ─── OPENSKY TOKEN CACHE ──────────────────────────────────────────────────────

let cachedToken    = null;
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
    cachedToken    = resp.data.access_token;
    tokenExpiresAt = Date.now() + (resp.data.expires_in - 60) * 1000;
    console.log("OpenSky token acquired");
    return cachedToken;
  } catch (e) {
    console.warn("Token fetch failed, using anonymous:", e.message);
    return null;
  }
}

// ─── OPENSKY FETCH ────────────────────────────────────────────────────────────

function getBoundingBox(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.0;
  const dLon = radiusKm / (111.0 * Math.cos((lat * Math.PI) / 180));
  return { lamin: lat - dLat, lamax: lat + dLat, lomin: lon - dLon, lomax: lon + dLon };
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

function headingToCompass(deg) {
  if (deg == null) return "N/A";
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / (360 / dirs.length)) % dirs.length];
}

function verticalStatus(rate) {
  if (rate == null) return "Level";
  if (rate >  1.5)  return "Climbing";
  if (rate < -1.5)  return "Descending";
  return "Level";
}

function msToKts(ms) {
  return ms != null ? Math.round(ms * 1.94384) : null;
}

async function fetchOpenSky() {
  const { lat, lon } = CONFIG.location;
  const bbox  = getBoundingBox(lat, lon, CONFIG.radiusKm);
  const token = await getOpenSkyToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  const resp = await axios.get("https://opensky-network.org/api/states/all", {
    params:  { lamin: bbox.lamin.toFixed(4), lamax: bbox.lamax.toFixed(4),
               lomin: bbox.lomin.toFixed(4), lomax: bbox.lomax.toFixed(4) },
    headers,
    timeout: 30000,
  });

  const states = resp.data.states || [];
  console.log(`OpenSky returned ${states.length} aircraft`);

  const aircraft = states.map(s => ({
    icao24:   s[0],
    callsign: (s[1] || "").trim() || null,
    country:  s[2],
    lon:      s[5],
    lat:      s[6],
    altM:     s[13], // WGS84 geometric altitude
    onGround: s[8],
    speedMs:  s[9],
    heading:  s[10],
    vertRate: s[11],
  }));

  // Filter
  const airborne = aircraft.filter(a =>
    !a.onGround &&
    a.altM != null && a.altM >= CONFIG.altMinM && a.altM <= CONFIG.altMaxM &&
    a.lat != null && a.lon != null
  );

  console.log(`${airborne.length} aircraft after filtering`);

  // Sort by distance
  airborne.forEach(a => {
    a.distanceKm = Math.round(haversineKm(lat, lon, a.lat, a.lon) * 10) / 10;
  });
  airborne.sort((a, b) => a.distanceKm - b.distanceKm);

  return airborne[0] || null;
}

// ─── ENRICHMENT ───────────────────────────────────────────────────────────────

async function enrichAircraft(icao24, callsign) {
  const result = { airline: null, route: null, aircraftType: null, originName: null, destName: null };
  if (!callsign) return result;

  try {
    const routeResp = await axios.get(`https://api.adsbdb.com/v0/callsign/${callsign}`, { timeout: 5000 });
    const fr = routeResp.data?.response?.flightroute;
    if (fr) {
      result.route       = `${fr.origin?.iata_code || "?"} → ${fr.destination?.iata_code || "?"}`;
      result.originName  = fr.origin?.name || null;
      result.destName    = fr.destination?.name || null;
      result.airline     = fr.airline?.name || null;
    }
  } catch (_) {}

  try {
    const acResp = await axios.get(`https://api.adsbdb.com/v0/aircraft/${icao24}`, { timeout: 5000 });
    result.aircraftType = acResp.data?.response?.aircraft?.type || null;
  } catch (_) {}

  return result;
}

// ─── HTML TEMPLATE ────────────────────────────────────────────────────────────

function buildHtml(ac, enrichment, updatedAt) {
  if (!ac) return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          width: 960px; height: 540px; overflow: hidden;
          background: #fff; font-family: 'Arial', sans-serif;
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
        }
        h1 { font-size: 36px; color: #333; margin-bottom: 12px; }
        p  { font-size: 20px; color: #999; }
      </style>
    </head>
    <body>
      <h1>✈ No Aircraft Overhead</h1>
      <p>Updated ${updatedAt}</p>
    </body>
    </html>
  `;

  const vstatus = verticalStatus(ac.vertRate);
  const vArrow  = vstatus === "Climbing" ? "↑" : vstatus === "Descending" ? "↓" : "→";

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          width: 960px; height: 540px; overflow: hidden;
          background: #fff; font-family: 'Arial', sans-serif;
          color: #111;
        }

        /* ── Header ── */
        .header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 18px 28px 14px;
          border-bottom: 2px solid #111;
        }
        .callsign  { font-size: 42px; font-weight: bold; letter-spacing: 2px; }
        .airline   { font-size: 22px; color: #555; margin-top: 4px; }
        .ac-type   { font-size: 18px; color: #888; text-align: right; }

        /* ── Body ── */
        .body {
          display: flex; height: 390px;
        }

        /* Left column */
        .left {
          flex: 1; padding: 24px 28px;
          border-right: 1px solid #ddd;
          display: flex; flex-direction: column; gap: 16px;
        }
        .route {
          font-size: 32px; font-weight: bold;
        }
        .airport-name {
          font-size: 16px; color: #666; margin-top: -10px;
        }
        .status-badge {
          display: inline-block;
          font-size: 18px; font-weight: bold;
          padding: 6px 16px;
          border: 2px solid #111;
          border-radius: 4px;
          margin-top: 8px;
        }

        /* Right column */
        .right {
          width: 340px; padding: 24px 28px;
          display: flex; flex-direction: column; gap: 18px;
        }
        .stat { display: flex; flex-direction: column; }
        .stat-label {
          font-size: 12px; text-transform: uppercase;
          letter-spacing: 1px; color: #999;
        }
        .stat-value {
          font-size: 28px; font-weight: bold;
        }
        .stat-grid {
          display: grid; grid-template-columns: 1fr 1fr; gap: 18px;
        }

        /* ── Footer ── */
        .footer {
          border-top: 1px solid #ddd;
          padding: 10px 28px;
          display: flex; justify-content: space-between;
          font-size: 14px; color: #999;
        }
      </style>
    </head>
    <body>

      <div class="header">
        <div>
          <div class="callsign">✈ ${ac.callsign || "Unknown"}</div>
          <div class="airline">${enrichment.airline || ac.country || ""}</div>
        </div>
        <div class="ac-type">${enrichment.aircraftType || ""}</div>
      </div>

      <div class="body">
        <div class="left">
          <div class="route">${enrichment.route || "Route unknown"}</div>
          <div class="airport-name">${enrichment.originName || ""}</div>
          <div class="airport-name">${enrichment.destName || ""}</div>
          <div class="status-badge">${vArrow} ${vstatus}</div>
        </div>

        <div class="right">
          <div class="stat-grid">
            <div class="stat">
              <span class="stat-label">Altitude</span>
              <span class="stat-value">${ac.altM != null ? Math.round(ac.altM) + " m" : "N/A"}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Speed</span>
              <span class="stat-value">${msToKts(ac.speedMs) != null ? msToKts(ac.speedMs) + " kts" : "N/A"}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Heading</span>
              <span class="stat-value">${ac.heading != null ? Math.round(ac.heading) + "° " + headingToCompass(ac.heading) : "N/A"}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Distance</span>
              <span class="stat-value">${ac.distanceKm} km</span>
            </div>
          </div>
        </div>
      </div>

      <div class="footer">
        <span>${CONFIG.location.name}</span>
        <span>Updated ${updatedAt}</span>
      </div>

    </body>
    </html>
  `;
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
  const b    = await getBrowser();
  const page = await b.newPage();
  await page.setViewport({ width: EPD_W, height: EPD_H });
  await page.setContent(html, { waitUntil: "networkidle0" });
  const png = await page.screenshot({ type: "png" });
  await page.close();

  // Convert PNG → 960x540 grayscale raw buffer (1 byte per pixel, 0=black 255=white)
  const raw = await sharp(png)
    .resize(EPD_W, EPD_H)
    .grayscale()
    .raw()
    .toBuffer();

  // Pack to 4-bit (2 pixels per byte) as expected by epd_draw_grayscale_image
  const packed = Buffer.alloc((EPD_W * EPD_H) / 2);
  for (let i = 0; i < EPD_W * EPD_H; i += 2) {
    const hi = raw[i]     >> 4; // high nibble
    const lo = raw[i + 1] >> 4; // low nibble
    packed[i / 2] = (hi << 4) | lo;
  }

  return packed;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Bitmap endpoint — ESP32 fetches this
app.get("/bitmap", async (req, res) => {
  try {
    const updatedAt = new Date().toLocaleDateString("en-AU", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC"
    }) + " UTC";

    const ac         = await fetchOpenSky();
    const enrichment = ac ? await enrichAircraft(ac.icao24, ac.callsign) : {};
    const html       = buildHtml(ac, enrichment, updatedAt);
    const bitmap     = await renderBitmap(html);

    res.set("Content-Type", "application/octet-stream");
    res.set("X-Aircraft-Count", ac ? "1" : "0");
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
    const updatedAt = new Date().toLocaleTimeString();
    const ac         = await fetchOpenSky();
    const enrichment = ac ? await enrichAircraft(ac.icao24, ac.callsign) : {};
    const html       = buildHtml(ac, enrichment, updatedAt);
    res.set("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    res.status(503).send(`Error: ${err.message}`);
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));