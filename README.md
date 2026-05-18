# flight-radar

A server-driven e-ink display platform for the LilyGO T5 4.7" ESP32-S3. The ESP32 is a dumb screen player — it fetches a URL, draws whatever bitmap the server returns, and calls back URLs on touch or timeout. All app logic lives on the server.

Ships with two apps:
- **Flight Radar** — shows the nearest aircraft overhead using OpenSky Network
- **Photo Album** — cycles through a folder of photos on a timer

## Hardware

- **Display**: LilyGO T5 4.7" e-ink (ESP32-S3, GT911 touch)
- **Server**: LibreComputer LePotato (Ubuntu ARM64) or any Linux box on the same network

## How it works

The device GETs a URL. The server returns JSON:

```json
{
  "bitmap": "<base64 4-bit grayscale 960×540>",
  "buttons": [
    {
      "x": 24, "y": 24, "width": 444, "height": 492,
      "url": "/screens/flight-radar",
      "pressed_bitmap": "<base64 cropped bitmap for pressed state>"
    }
  ],
  "timeout_ms": 15000,
  "timeout_url": null
}
```

- `buttons` — touch regions; tapping one does a partial refresh with `pressed_bitmap` then fetches `url`
- `timeout_ms` — auto-advance after this many ms; `null` = wait indefinitely
- `timeout_url` — URL to fetch on timeout; `null` = re-fetch the current URL

## Server

### Routes

| Route | Description |
|-------|-------------|
| `GET /` | Launcher — app selection grid |
| `GET /screens/flight-radar` | Flight radar screen (refreshes every 15s) |
| `GET /screens/photo-album?index=N` | Photo album (advances every 30s) |
| `GET /health` | Health check |
| Add `?preview` to any route | Returns raw HTML for browser debugging |

### Setup (LePotato)

```bash
# Clone the repo and copy your .env into place, then:
sudo bash setup.sh
```

`setup.sh` installs Node.js, Chromium (via snap), npm deps, writes the systemd service, and starts it.

### .env

```env
LOCATION_NAME="Home"
LOCATION_LAT=-33.9
LOCATION_LON=151.2

RADIUS_KM=3
ALTITUDE_MIN_M=20
ALTITUDE_MAX_M=1000
BARO_ALT_MAX_M=1250

OPENSKY_CLIENT_ID=your-client-id
OPENSKY_CLIENT_SECRET=your-client-secret
OPENSKY_COOLDOWN_MS=91000

PHOTOS_DIR=/srv/flight-radar/photos
```

OpenSky credentials are optional but recommended — unauthenticated requests are rate-limited. Get them at [opensky-network.org](https://opensky-network.org).

### Logs

```bash
journalctl -u flight-radar -f
```

## Photos

Sync photos from your Mac to the LePotato:

```bash
bash sync-photos.sh [user@host]
```

Converts HEIC/PNG/WebP to JPEG using `sips`, then rsyncs to the `PHOTOS_DIR` on the remote host. The photo album hot-reloads — drop files in and they appear on the next cycle.

## Firmware

Open `board/board.ino` in Arduino IDE. Set `BASE_URL` to your server's address:

```cpp
const char* BASE_URL = "http://192.168.1.100:8080";
```

Required libraries: `epdiy`, `ArduinoJson`, `LVGL` (GT911 touch).

## File layout

```
index.js                  Express entry point
render.js                 Puppeteer → Sharp → 4-bit bitmap pipeline
screens/
  launcher.js             GET /
  flight-radar.js         GET /screens/flight-radar
  photo-album.js          GET /screens/photo-album
templates/
  launcher.ejs            App grid (+ pressed states in sprite zone below fold)
  aircraft.ejs            Flight radar display
  photo.ejs               Full-screen photo
  empty.ejs               No aircraft in range
board/
  board.ino               ESP32-S3 firmware
sync-photos.sh            Mac → LePotato photo sync
setup.sh                  LePotato server setup script
flight-radar.service      systemd unit (reference copy)
```
