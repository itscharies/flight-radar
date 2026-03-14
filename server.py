"""
Flight Radar Middleware Server
-------------------------------
Queries OpenSky Network for aircraft overhead, enriches with airline/route data,
and serves a compact payload for the ESP32 e-ink display.

Requirements:
    pip install fastapi uvicorn httpx python-dotenv

Run:
    uvicorn server:app --host 0.0.0.0 --port 8080 --reload
"""

import httpx
import math
import os
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Flight Radar Middleware")

# ─── CONFIG ───────────────────────────────────────────────────────────────────

WATCH_LOCATION = {
    "name": os.getenv("LOCATION_NAME", "Home"),
    "lat":  float(os.getenv("LOCATION_LAT")),
    "lon":  float(os.getenv("LOCATION_LON")),
}

RADIUS_KM      = float(os.getenv("RADIUS_KM", 50))
ALTITUDE_MIN_M = float(os.getenv("ALTITUDE_MIN_M", 50))
ALTITUDE_MAX_M = float(os.getenv("ALTITUDE_MAX_M", 400))
MAX_AIRCRAFT   = int(os.getenv("MAX_AIRCRAFT", 5))

OPENSKY_CLIENT_ID     = os.getenv("OPENSKY_CLIENT_ID")
OPENSKY_CLIENT_SECRET = os.getenv("OPENSKY_CLIENT_SECRET")

# ─── TOKEN CACHE ──────────────────────────────────────────────────────────────

_token: str | None = None
_token_expires_at: datetime | None = None

async def get_opensky_token() -> str | None:
    """Exchange client credentials for a bearer token, caching until near expiry."""
    global _token, _token_expires_at

    if not OPENSKY_CLIENT_ID or not OPENSKY_CLIENT_SECRET:
        print("No credentials set, using anonymous access")
        return None

    # Return cached token if still valid (with 60s buffer)
    if _token and _token_expires_at and datetime.now(timezone.utc) < _token_expires_at:
        print("Using cached token")
        return _token

    print("Fetching new OpenSky token...")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
                data={
                    "grant_type":    "client_credentials",
                    "client_id":     OPENSKY_CLIENT_ID,
                    "client_secret": OPENSKY_CLIENT_SECRET,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            _token = data["access_token"]
            expires_in = data.get("expires_in", 1800)
            _token_expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in - 60)
            print(f"Token acquired, expires in {expires_in}s")
            return _token
    except httpx.ConnectTimeout:
        print("WARNING: Token fetch timed out, falling back to anonymous access")
        return None
    except Exception as e:
        print(f"WARNING: Token fetch failed ({e}), falling back to anonymous access")
        return None

# ─── OPENSKY ──────────────────────────────────────────────────────────────────

def get_bounding_box(lat: float, lon: float, radius_km: float) -> dict:
    """Convert a centre point + radius into a lat/lon bounding box."""
    delta_lat = radius_km / 111.0
    delta_lon = radius_km / (111.0 * math.cos(math.radians(lat)))
    return {
        "lamin": lat - delta_lat,
        "lamax": lat + delta_lat,
        "lomin": lon - delta_lon,
        "lomax": lon + delta_lon,
    }

def haversine_km(lat1, lon1, lat2, lon2) -> float:
    """Straight-line distance between two lat/lon points in kilometres."""
    R = 6371
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (math.sin(d_lat / 2) ** 2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
         math.sin(d_lon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

def heading_to_compass(degrees: float) -> str:
    if degrees is None:
        return "N/A"
    dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
            "S","SSW","SW","WSW","W","WNW","NW","NNW"]
    ix = round(degrees / (360 / len(dirs))) % len(dirs)
    return dirs[ix]

def m_to_ft(metres) -> int | None:
    return round(metres * 3.28084) if metres is not None else None

def ms_to_kts(ms) -> int | None:
    return round(ms * 1.94384) if ms is not None else None

async def fetch_opensky(bbox: dict) -> list:
    """Fetch live aircraft states from OpenSky within a bounding box."""
    url = "https://opensky-network.org/api/states/all"
    params = {k: round(v, 4) for k, v in bbox.items()}

    token = await get_opensky_token()
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    async with httpx.AsyncClient(timeout=30, headers=headers) as client:
        try:
            resp = await client.get(url, params=params)
            print(f"OpenSky status: {resp.status_code}")
            print(f"OpenSky headers: {dict(resp.headers)}")
            if resp.status_code != 200:
                print(f"OpenSky body: {resp.text}")
            resp.raise_for_status()
        except httpx.ConnectTimeout:
            raise RuntimeError("Timed out connecting to OpenSky")
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"OpenSky returned HTTP {e.response.status_code}")
        data = resp.json()
        print(f"OpenSky returned {len(data.get('states') or [])} aircraft")

    # OpenSky state vector indices:
    # 0=icao24, 1=callsign, 2=origin_country, 3=time_position,
    # 4=last_contact, 5=lon, 6=lat, 7=baro_alt, 8=on_ground,
    # 9=velocity, 10=heading, 11=vert_rate
    states = data.get("states") or []
    aircraft = []
    for s in states:
        aircraft.append({
            "icao24":    s[0],
            "callsign":  (s[1] or "").strip() or None,
            "country":   s[2],
            "lon":       s[5],
            "lat":       s[6],
            "alt_m":     s[7],
            "on_ground": s[8],
            "speed_ms":  s[9],
            "heading":   s[10],
            "vert_rate": s[11],
        })
    return aircraft

# ─── ENRICHMENT ───────────────────────────────────────────────────────────────

async def enrich_aircraft(icao24: str, callsign: str | None) -> dict:
    """Fetch airline name and route from adsbdb.com. Best-effort, never crashes."""
    enriched = {"airline": None, "route": None, "aircraft_type": None}

    if not callsign:
        return enriched

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            route_resp = await client.get(
                f"https://api.adsbdb.com/v0/callsign/{callsign}"
            )
            if route_resp.status_code == 200:
                rd = route_resp.json().get("response", {})
                flightroute = rd.get("flightroute")
                if flightroute:
                    origin  = flightroute.get("origin", {})
                    dest    = flightroute.get("destination", {})
                    airline = flightroute.get("airline", {})
                    enriched["route"]            = f"{origin.get('iata_code','?')} → {dest.get('iata_code','?')}"
                    enriched["origin_name"]      = origin.get("name")
                    enriched["destination_name"] = dest.get("name")
                    enriched["airline"]          = airline.get("name")
                    enriched["airline_iata"]     = airline.get("iata")

            ac_resp = await client.get(
                f"https://api.adsbdb.com/v0/aircraft/{icao24}"
            )
            if ac_resp.status_code == 200:
                ad = ac_resp.json().get("response", {}).get("aircraft", {})
                enriched["aircraft_type"] = ad.get("type")

    except Exception:
        pass

    return enriched

# ─── VERTICAL STATUS ──────────────────────────────────────────────────────────

def vertical_status(vert_rate) -> str:
    if vert_rate is None:
        return "Level"
    if vert_rate > 1.5:
        return "Climbing"
    if vert_rate < -1.5:
        return "Descending"
    return "Level"

# ─── ROUTES ───────────────────────────────────────────────────────────────────

@app.get("/display-data")
async def display_data():
    loc  = WATCH_LOCATION
    bbox = get_bounding_box(loc["lat"], loc["lon"], RADIUS_KM)

    try:
        raw = await fetch_opensky(bbox)
    except RuntimeError as e:
        return JSONResponse({"error": str(e), "aircraft_count": 0, "aircraft": []}, status_code=503)

    # Filter: airborne only + above altitude threshold
    airborne = []
    for a in raw:
        if a["on_ground"]:
            print(f"  SKIP {a['callsign']} — on ground")
        elif a["alt_m"] is None:
            print(f"  SKIP {a['callsign']} — no altitude data")
        elif a["alt_m"] < ALTITUDE_MIN_M or a["alt_m"] > ALTITUDE_MAX_M:
            print(f"  SKIP {a['callsign']} — altitude {a['alt_m']}m outside range {ALTITUDE_MIN_M}-{ALTITUDE_MAX_M}m")
        elif a["lat"] is None or a["lon"] is None:
            print(f"  SKIP {a['callsign']} — no position data")
        else:
            print(f"  PASS {a['callsign']} — alt {a['alt_m']}m")
            airborne.append(a)

    # Sort nearest first
    for a in airborne:
        a["distance_km"] = round(
            haversine_km(loc["lat"], loc["lon"], a["lat"], a["lon"]), 1
        )
    airborne.sort(key=lambda x: x["distance_km"])

    # Enrich only the single closest aircraft
    results = []
    for a in airborne[:1]:
        enrichment = await enrich_aircraft(a["icao24"], a["callsign"])
        results.append({
            "icao24":           a["icao24"],
            "callsign":         a["callsign"] or "Unknown",
            "airline":          enrichment.get("airline"),
            "aircraft_type":    enrichment.get("aircraft_type"),
            "route":            enrichment.get("route"),
            "origin_name":      enrichment.get("origin_name"),
            "destination_name": enrichment.get("destination_name"),
            "distance_km":      a["distance_km"],
            "altitude_m":      a["alt_m"],
            "speed_kts":        ms_to_kts(a["speed_ms"]),
            "heading_deg":      round(a["heading"]) if a["heading"] else None,
            "heading_compass":  heading_to_compass(a["heading"]),
            "vertical_status":  vertical_status(a["vert_rate"]),
            "country":          a["country"],
        })

    return JSONResponse({
        "location":       loc["name"],
        "updated_at":     datetime.now(timezone.utc).strftime("%-d %b %H:%M UTC"),
        "aircraft_count": len(results),
        "aircraft":       results,
    })


@app.get("/health")
async def health():
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}