/**
 * Flight Radar — LilyGO T5 4.7" e-ink Display
 * ------------------------------------------------
 * Connects to WiFi, fetches flight data from middleware,
 * and renders a dashboard in landscape (960x540) orientation.
 *
 * Libraries required:
 *   - LilyGo-EPD47   (display driver)
 *   - ArduinoJson    (install via Library Manager)
 *   - WiFi           (bundled with ESP32 board package)
 *   - HTTPClient     (bundled with ESP32 board package)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include "epd_driver.h"
#include "firasans.h"

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const char* WIFI_SSID     = "LESS DELUXE NETWORK";
const char* WIFI_PASSWORD = "why?becauseisaidso";
const char* SERVER_URL    = "https://web-production-c0928.up.railway.app/display-data";

const int UPDATE_INTERVAL_MS = 30000;

// ─── DISPLAY ───────────────────────────────────────────────────────────────────
uint8_t* framebuffer = nullptr;

#define SCR_W  960
#define SCR_H  540
#define PAD    24
#define COL2   500

// ─── HELPERS ───────────────────────────────────────────────────────────────────

void fb_clear() {
    memset(framebuffer, 0xFF, EPD_WIDTH / 2 * EPD_HEIGHT);
}

void draw_rule(int y, int x1, int x2, uint8_t colour = 0) {
    epd_draw_hline(x1, y, x2 - x1, colour, framebuffer);
}

int draw_text(const char* text, int x, int y, const GFXfont* font, uint8_t colour = 0) {
    int cx = x, cy = y;
    writeln(font, text, &cx, &cy, framebuffer);
    return cy;
}

void draw_kv(const char* label, const char* value, int x, int y) {
    char buf[64];
    snprintf(buf, sizeof(buf), "%-6s  %s", label, value);
    draw_text(buf, x, y, (GFXfont*)&FiraSans);
}

// ─── WIFI ──────────────────────────────────────────────────────────────────────

bool wifi_connect() {
    Serial.printf("Connecting to SSID: %s\n", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 40) {
        delay(500);
        Serial.printf("  attempt %d — status: %d\n", attempts + 1, WiFi.status());
        attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("Connected! IP: %s\n", WiFi.localIP().toString().c_str());
        return true;
    }

    Serial.printf("Failed. Final status code: %d\n", WiFi.status());
    return false;
}

// ─── FETCH ─────────────────────────────────────────────────────────────────────

String fetch_data() {
    WiFiClientSecure client;
    client.setInsecure();
    HTTPClient http;
    http.begin(client, SERVER_URL);
    http.setTimeout(10000);
    int code = http.GET();
    if (code == HTTP_CODE_OK) {
        String payload = http.getString();
        http.end();
        return payload;
    }
    Serial.printf("HTTP error: %d\n", code);
    http.end();
    return "";
}

// ─── RENDER ────────────────────────────────────────────────────────────────────

void render_error(const char* msg) {
    fb_clear();
    draw_text("FLIGHT RADAR", PAD, 55, (GFXfont*)&FiraSans);
    draw_rule(68, PAD, SCR_W - PAD);
    draw_text(msg, PAD, 140, (GFXfont*)&FiraSans);
    epd_draw_grayscale_image(epd_full_screen(), framebuffer);
}

void render_no_aircraft(const char* updated_at) {
    fb_clear();
    draw_text("FLIGHT RADAR", PAD, 55, (GFXfont*)&FiraSans);
    draw_rule(68, PAD, SCR_W - PAD);
    draw_text("No aircraft overhead right now.", PAD, 160, (GFXfont*)&FiraSans);

    char footer[64];
    snprintf(footer, sizeof(footer), "Updated: %s", updated_at);
    draw_text(footer, PAD, SCR_H - PAD, (GFXfont*)&FiraSans);

    epd_draw_grayscale_image(epd_full_screen(), framebuffer);
}

void render_dashboard(JsonObject ac, int total, const char* updated_at) {
    fb_clear();

    // ── Header ────────────────────────────────────────────────────────────────
    const char* callsign = ac["callsign"] | "-------";
    const char* airline  = ac["airline"]  | "";
    char header[64];
    snprintf(header, sizeof(header), "%s  %s", callsign, airline);
    draw_text(header, PAD, 55, (GFXfont*)&FiraSans);
    draw_rule(68, PAD, SCR_W - PAD);

    // ── Route block ───────────────────────────────────────────────────────────
    const char* route    = ac["route"]            | "Route unknown";
    const char* org_name = ac["origin_name"]      | "";
    const char* dst_name = ac["destination_name"] | "";
    const char* ac_type  = ac["aircraft_type"]    | "Unknown type";

    draw_text(route,    PAD, 120, (GFXfont*)&FiraSans);
    draw_text(org_name, PAD, 155, (GFXfont*)&FiraSans);
    draw_text(dst_name, PAD, 190, (GFXfont*)&FiraSans);
    draw_text(ac_type,  PAD, 230, (GFXfont*)&FiraSans);

    // ── Column divider ────────────────────────────────────────────────────────
    epd_draw_vline(COL2 - 20, 80, SCR_H - 120, 0, framebuffer);

    // ── Stats block ───────────────────────────────────────────────────────────
    int   alt    = ac["altitude_ft"]  | 0;
    int   spd    = ac["speed_kts"]    | 0;
    int   hdg    = ac["heading_deg"]  | 0;
    float dist   = ac["distance_km"]  | 0.0;
    const char* compass = ac["heading_compass"] | "?";
    const char* vstatus = ac["vertical_status"] | "Level";

    char buf[32];

    snprintf(buf, sizeof(buf), "%d ft", alt);
    draw_kv("ALT",    buf,     COL2, 120);

    snprintf(buf, sizeof(buf), "%d kts", spd);
    draw_kv("SPD",    buf,     COL2, 160);

    snprintf(buf, sizeof(buf), "%d deg %s", hdg, compass);
    draw_kv("HDG",    buf,     COL2, 200);

    snprintf(buf, sizeof(buf), "%.1f km", dist);
    draw_kv("DIST",   buf,     COL2, 240);

    draw_kv("STATUS", vstatus, COL2, 280);

    // ── Footer ────────────────────────────────────────────────────────────────
    draw_rule(SCR_H - 80, PAD, SCR_W - PAD);

    char count_buf[48];
    snprintf(count_buf, sizeof(count_buf), "%d aircraft in range", total);
    draw_text(count_buf, PAD, SCR_H - 44, (GFXfont*)&FiraSans);

    char footer[64];
    snprintf(footer, sizeof(footer), "Updated: %s", updated_at);
    draw_text(footer, COL2, SCR_H - 44, (GFXfont*)&FiraSans);

    epd_draw_grayscale_image(epd_full_screen(), framebuffer);
}

// ─── SETUP ─────────────────────────────────────────────────────────────────────

void setup() {
    Serial.begin(115200);

    epd_init();
    framebuffer = (uint8_t*)ps_calloc(sizeof(uint8_t), EPD_WIDTH / 2 * EPD_HEIGHT);
    if (!framebuffer) {
        Serial.println("ERROR: framebuffer alloc failed — needs PSRAM");
        while (true) delay(1000);
    }

    epd_poweron();
    epd_clear();

    fb_clear();
    draw_text("FLIGHT RADAR", PAD, 55, (GFXfont*)&FiraSans);
    draw_rule(68, PAD, SCR_W - PAD);
    draw_text("Connecting to WiFi...", PAD, 140, (GFXfont*)&FiraSans);
    epd_draw_grayscale_image(epd_full_screen(), framebuffer);

    if (!wifi_connect()) {
        render_error("WiFi connection failed.\nCheck SSID and password.");
        epd_poweroff();
        return;
    }

    Serial.println("WiFi connected: " + WiFi.localIP().toString());
}

// ─── LOOP ──────────────────────────────────────────────────────────────────────

void loop() {
    epd_poweron();
    epd_clear();

    String payload = fetch_data();

    if (payload.isEmpty()) {
        render_error("Could not reach server.\nCheck URL and that server is running.");
    } else {
        StaticJsonDocument<8192> doc;
        DeserializationError err = deserializeJson(doc, payload);

        if (err) {
            render_error("JSON parse error.");
        } else {
            int total       = doc["aircraft_count"] | 0;
            const char* upd = doc["updated_at"]     | "unknown";

            if (total == 0) {
                render_no_aircraft(upd);
            } else {
                JsonObject ac = doc["aircraft"][0];
                render_dashboard(ac, total, upd);
            }
        }
    }

    epd_poweroff();
    delay(UPDATE_INTERVAL_MS);
}