"""
Flight Radar Middleware Server
-------------------------------
Queries OpenSky Network for aircraft overhead, enriches with airline/route data,
and serves a compact payload for the ESP32 e-ink display.

Requirements:
    pip install fastapi uvicorn httpx

Run:
    uvicorn server:app --host 0.0.0.0 --port 8080 --reload
"""

import httpx
import math
import os
from datetime import datetime, timezone
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Flight Radar Middleware")

# ─── CONFIG ───────────────────────────────────────────────────────────────────

WATCH_LOCATION = {
    "name": os.getenv("LOCATION_NAME", "Home"),
    "lat": float(os.getenv("LOCATION_LAT")),
    "lon": float(os.getenv("LOCATION_LON")),
}

RADIUS_KM      = float(os.getenv("RADIUS_KM", 50))
ALTITUDE_MIN_M = float(os.getenv("ALTITUDE_MIN_M", 100))
MAX_AIRCRAFT   = int(os.getenv("MAX_AIRCRAFT", 5))

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
    """Convert a heading in degrees to a compass direction string."""
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

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()

    # OpenSky state vector indices:
    # 0=icao24, 1=callsign, 2=origin_country, 3=time_position,
    # 4=last_contact, 5=lon, 6=lat, 7=baro_alt, 8=on_ground,
    # 9=velocity, 10=heading, 11=vert_rate, 12=sensors,
    # 13=geo_alt, 14=squawk, 15=spi, 16=position_source

    states = data.get("states") or []
    aircraft = []
    for s in states:
        aircraft.append({
            "icao24":   s[0],
            "callsign": (s[1] or "").strip() or None,
            "country":  s[2],
            "lon":      s[5],
            "lat":      s[6],
            "alt_m":    s[7],   # barometric altitude in metres
            "on_ground": s[8],
            "speed_ms": s[9],
            "heading":  s[10],
            "vert_rate": s[11], # m/s — positive = climbing
        })
    return aircraft

# ─── ENRICHMENT ───────────────────────────────────────────────────────────────

async def enrich_aircraft(icao24: str, callsign: str | None) -> dict:
    """
    Fetch airline name and route from the free adsbdb.com API.
    Returns partial data gracefully if the lookup fails.
    """
    enriched = {"airline": None, "route": None, "aircraft_type": None}

    if not callsign:
        return enriched

    try:
        async with httpx.AsyncClient(timeout=5) as client:
            # Route lookup (origin → destination)
            route_resp = await client.get(
                f"https://api.adsbdb.com/v0/callsign/{callsign}"
            )
            if route_resp.status_code == 200:
                rd = route_resp.json().get("response", {})
                flightroute = rd.get("flightroute")
                if flightroute:
                    origin = flightroute.get("origin", {})
                    dest   = flightroute.get("destination", {})
                    airline = flightroute.get("airline", {})
                    enriched["route"] = (
                        f"{origin.get('iata_code','?')} → {dest.get('iata_code','?')}"
                    )
                    enriched["origin_name"]      = origin.get("name")
                    enriched["destination_name"] = dest.get("name")
                    enriched["airline"]          = airline.get("name")
                    enriched["airline_iata"]     = airline.get("iata")

            # Aircraft type lookup by ICAO24
            ac_resp = await client.get(
                f"https://api.adsbdb.com/v0/aircraft/{icao24}"
            )
            if ac_resp.status_code == 200:
                ad = ac_resp.json().get("response", {}).get("aircraft", {})
                enriched["aircraft_type"] = ad.get("type")

    except Exception:
        pass  # Enrichment is best-effort — never crash the main response

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
    """
    Main endpoint for the ESP32.
    Returns a filtered, enriched list of overhead aircraft ready to render.
    """
    loc = WATCH_LOCATION
    bbox = get_bounding_box(loc["lat"], loc["lon"], RADIUS_KM)

    raw = await fetch_opensky(bbox)

    # Filter: airborne only + above altitude threshold
    airborne = [
        a for a in raw
        if not a["on_ground"]
        and a["alt_m"] is not None
        and a["alt_m"] >= ALTITUDE_MIN_M
        and a["lat"] is not None
        and a["lon"] is not None
    ]

    # Calculate distance from watch point and sort nearest first
    for a in airborne:
        a["distance_km"] = round(
            haversine_km(loc["lat"], loc["lon"], a["lat"], a["lon"]), 1
        )
    airborne.sort(key=lambda x: x["distance_km"])

    # Enrich top N aircraft (limit API calls)
    results = []
    for a in airborne[:MAX_AIRCRAFT]:
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
            "altitude_ft":      m_to_ft(a["alt_m"]),
            "speed_kts":        ms_to_kts(a["speed_ms"]),
            "heading_deg":      round(a["heading"]) if a["heading"] else None,
            "heading_compass":  heading_to_compass(a["heading"]),
            "vertical_status":  vertical_status(a["vert_rate"]),
            "country":          a["country"],
        })

    return JSONResponse({
        "location":       loc["name"],
        "updated_at":     datetime.now(timezone.utc).isoformat(),
        "aircraft_count": len(results),
        "aircraft":       results,
    })


@app.get("/health")
async def health():
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat()}