/**
 * Flight Radar — LilyGO T5 4.7" e-ink Display
 * ------------------------------------------------
 * Fetches a pre-rendered 4-bit grayscale bitmap from the Node server
 * and blits it directly to the e-ink display.
 *
 * Libraries required:
 *   - LilyGo-EPD47   (display driver)
 *   - WiFi           (bundled with ESP32 board package)
 *   - HTTPClient     (bundled with ESP32 board package)
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include "epd_driver.h"

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const char* WIFI_SSID     = "LESS DELUXE NETWORK";
const char* WIFI_PASSWORD = "why?becauseisaidso";
const char* SERVER_URL    = "http://192.168.1.104:8080/bitmap";

const int UPDATE_INTERVAL_MS = 10000;

// ─── DISPLAY ───────────────────────────────────────────────────────────────────
#define EPD_W 960
#define EPD_H 540
#define BITMAP_SIZE (EPD_W * EPD_H / 2) // 4-bit packed = 259200 bytes
#define HASH_LEN 32  // MD5 hex

uint8_t* framebuffer = nullptr;
char lastHash[HASH_LEN + 1] = {0};  // last X-Bitmap-Hash; if set, send If-None-Match to avoid redraw when unchanged

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

// ─── FETCH BITMAP ──────────────────────────────────────────────────────────────
// Returns: 0 = error, 1 = new bitmap (update display), 2 = unchanged (304, skip redraw)
int fetch_bitmap() {
    HTTPClient http;
    http.begin(SERVER_URL);
    http.setTimeout(30000); // rendering takes a moment

    if (lastHash[0] != '\0') {
        String ifNoneMatch = "\"";
        ifNoneMatch += lastHash;
        ifNoneMatch += "\"";
        http.addHeader("If-None-Match", ifNoneMatch);
    }

    const char* headerKeys[] = {"X-Bitmap-Hash"};
    http.collectHeaders(headerKeys, 1);

    int code = http.GET();
    Serial.printf("HTTP status: %d\n", code);

    if (code == 304) {
        http.end();
        Serial.println("Bitmap unchanged (304), skipping redraw");
        return 2;
    }

    if (code != HTTP_CODE_OK) {
        Serial.printf("HTTP error: %d\n", code);
        http.end();
        return 0;
    }

    // Store hash for next If-None-Match
    String newHash = http.header("X-Bitmap-Hash");
    if (newHash.length() >= (size_t)HASH_LEN) {
        newHash.substring(0, HASH_LEN).toCharArray(lastHash, HASH_LEN + 1);
    }

    int len = http.getSize();
    Serial.printf("Bitmap size: %d bytes (expected %d)\n", len, BITMAP_SIZE);

    if (len != BITMAP_SIZE) {
        Serial.println("Unexpected bitmap size, aborting");
        http.end();
        return 0;
    }

    // Stream directly into framebuffer
    WiFiClient* stream = http.getStreamPtr();
    int received = 0;
    while (received < BITMAP_SIZE) {
        int chunk = stream->readBytes(framebuffer + received, BITMAP_SIZE - received);
        if (chunk == 0) break;
        received += chunk;
    }

    http.end();
    Serial.printf("Received %d bytes\n", received);
    return (received == BITMAP_SIZE) ? 1 : 0;
}

// ─── SETUP ─────────────────────────────────────────────────────────────────────

void setup() {
    Serial.begin(115200);

    epd_init();
    framebuffer = (uint8_t*)ps_calloc(sizeof(uint8_t), BITMAP_SIZE);
    if (!framebuffer) {
        Serial.println("ERROR: framebuffer alloc failed — needs PSRAM");
        while (true) delay(1000);
    }

    epd_poweron();
    epd_clear();
    epd_poweroff();

    if (!wifi_connect()) {
        Serial.println("WiFi failed, halting");
        while (true) delay(1000);
    }
}

// ─── LOOP ──────────────────────────────────────────────────────────────────────

void loop() {
    Serial.println("Fetching bitmap...");

    int result = fetch_bitmap();
    if (result == 1) {
        epd_poweron();
        epd_clear();
        epd_draw_grayscale_image(epd_full_screen(), framebuffer);
        epd_poweroff();
        Serial.println("Display updated");
    } else if (result == 0) {
        Serial.println("Fetch failed, skipping render");
    }
    // result == 2: unchanged, no redraw (avoids flicker)

    delay(UPDATE_INTERVAL_MS);
}