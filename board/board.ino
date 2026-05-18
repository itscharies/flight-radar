/**
 * LilyGO T5 4.7" — Generic Screen Player
 * ----------------------------------------
 * Fetches JSON screens from the server and renders them.
 * All app logic lives on the server; the device is dumb.
 *
 * JSON response schema:
 *   {
 *     "bitmap":      "<base64 4-bit packed grayscale 960×540>",
 *     "buttons":     [{ x, y, width, height, url, pressed_bitmap }],
 *     "timeout_ms":  15000,   // null = wait indefinitely
 *     "timeout_url": "/path"  // null = re-fetch currentUrl
 *   }
 *
 * Required libraries (Library Manager):
 *   - ArduinoJson  ≥ 6.21
 *   - epdiy / LilyGo-EPD47 (display driver)
 *   - LVGL / TouchDrv (GT911 touch, SDA=18 SCL=17 INT=47)
 *
 * Board settings:
 *   ESP32S3 Dev Module, PSRAM: OPI, Flash: 16MB QIO 80MHz
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "epd_driver.h"
#include "TouchDrv.hpp"
#include "types.h"
#include "secrets.h"  // #define WIFI_SSID / WIFI_PASS — gitignored, never committed

// ─── USER CONFIG ──────────────────────────────────────────────────────────────
const char *BASE_URL  = "http://192.168.1.100:8080";  // LePotato IP

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
#define EPD_W         960
#define EPD_H         540
#define BITMAP_BYTES  (EPD_W * EPD_H / 2)   // 259 200 bytes, 4-bit packed
#define MAX_BUTTONS   8
#define HTTP_BUF_SIZE (900 * 1024)           // 900 KB for JSON response (launcher ~586 KB)
#define WIFI_MAX_ATTEMPTS 40
#define TOUCH_DEBOUNCE_MS 300

// GT911 I2C pins — LilyGO T5 4.7" ESP32-S3
#define TOUCH_SDA  18
#define TOUCH_SCL  17
#define TOUCH_INT  47


// ─── BASE64 DECODER ───────────────────────────────────────────────────────────
static const int8_t kB64[256] = {
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,
  52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
  -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
  15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
  -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
  41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1,
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
  -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
};

// Decode base64 string into dst. Returns number of decoded bytes.
size_t b64Decode(const char *src, size_t srcLen, uint8_t *dst) {
  size_t out = 0;
  uint32_t accum = 0;
  int bits = 0;
  for (size_t i = 0; i < srcLen; i++) {
    int8_t v = kB64[(uint8_t)src[i]];
    if (v < 0) continue;
    accum = (accum << 6) | (uint32_t)v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      dst[out++] = (accum >> bits) & 0xFF;
    }
  }
  return out;
}

// ─── STATE ────────────────────────────────────────────────────────────────────


static uint8_t  *framebuffer = nullptr;
static char     *httpBuf     = nullptr;
static ScreenButton buttons[MAX_BUTTONS];
static int       buttonCount  = 0;
static String    currentUrl   = "";
static String    timeoutUrl   = "";
static uint32_t  timeoutMs    = 0;
static uint32_t  lastFetchMs  = 0;
static bool      retryPending = false;
static uint32_t  retryAt      = 0;
static String    retryUrl     = "";
static String    currentEtag  = "";
static bool      screenIsBlank = true;  // suppress If-None-Match until a bitmap is drawn

static TouchDrvGT911 touch;
static bool touchOk = false;
static uint32_t lastTouchMs = 0;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

String resolveUrl(const String &url) {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return String(BASE_URL) + (url.startsWith("/") ? url : "/" + url);
}

void freeButtons() {
  for (int i = 0; i < buttonCount; i++) {
    if (buttons[i].pressedBitmap) {
      heap_caps_free(buttons[i].pressedBitmap);
      buttons[i].pressedBitmap = nullptr;
    }
  }
  buttonCount = 0;
}

// ─── DISPLAY ──────────────────────────────────────────────────────────────────


void showPressedState(const ScreenButton &btn) {
  // epd_draw_grayscale_image with a sub-rect expects a cropped buffer
  // (area.width/2 bytes per row), not the full framebuffer.
  // btn.pressedBitmap is already that exact cropped 4-bit packed region.
  Rect_t area = { btn.x, btn.y, btn.w, btn.h };
  epd_poweron();
  epd_draw_grayscale_image(area, btn.pressedBitmap);
  epd_poweroff();
}

void drawErrorScreen(const char *msg) {
  memset(framebuffer, 0xFF, BITMAP_BYTES); // white background
  epd_poweron();
  epd_clear();
  // Draw the error message as simple pixels — place text in top-left area
  // (full font rendering requires including a font; keeping it dependency-light here)
  epd_draw_grayscale_image(epd_full_screen(), framebuffer);
  epd_poweroff();
  Serial.printf("Error screen: %s\n", msg);
}

// ─── JSON FIELD HELPERS ───────────────────────────────────────────────────────

// Find "key":"<value>" in raw JSON; sets *len to value length, returns pointer to value.
const char *findBase64Field(const char *json, const char *key, size_t *len) {
  char needle[64];
  snprintf(needle, sizeof(needle), "\"%s\":\"", key);
  const char *p = strstr(json, needle);
  if (!p) return nullptr;
  p += strlen(needle);
  const char *end = strchr(p, '"');
  if (!end) return nullptr;
  *len = end - p;
  return p;
}

// Find the nth (0-based) occurrence of "key":"<value>" in raw JSON.
const char *findNthBase64Field(const char *json, const char *key, int n, size_t *len) {
  char needle[64];
  snprintf(needle, sizeof(needle), "\"%s\":\"", key);
  size_t nlen = strlen(needle);
  const char *p = json;
  for (int i = 0; i <= n; i++) {
    p = strstr(p, needle);
    if (!p) return nullptr;
    if (i < n) p += nlen;
  }
  p += nlen;
  const char *end = strchr(p, '"');
  if (!end) return nullptr;
  *len = end - p;
  return p;
}

// ─── FETCH AND DISPLAY ────────────────────────────────────────────────────────

void fetchAndDisplay(const String &url, bool clearFirst = false) {
  if (clearFirst) {
    epd_poweron();
    epd_clear();
    epd_poweroff();
  }

  String fullUrl = resolveUrl(url);
  Serial.printf("Fetching: %s\n", fullUrl.c_str());

  HTTPClient http;
  http.begin(fullUrl);
  http.setTimeout(30000);

  // Send ETag only when re-fetching the same URL and the screen is showing something
  if (!screenIsBlank && url == currentUrl && currentEtag.length() > 0) {
    http.addHeader("If-None-Match", currentEtag);
  }

  const char *etagHeader[] = {"ETag"};
  http.collectHeaders(etagHeader, 1);

  int httpCode = http.GET();

  if (httpCode == HTTP_CODE_NOT_MODIFIED) {
    Serial.println("304 Not Modified — skipping redraw");
    http.end();
    lastFetchMs = millis();
    return;
  }

  if (httpCode != HTTP_CODE_OK) {
    Serial.printf("HTTP error: %d\n", httpCode);
    http.end();
    drawErrorScreen("Connection error");
    screenIsBlank = true;
    retryPending = true;
    retryUrl = url;
    retryAt  = millis() + 30000;
    return;
  }

  // Store ETag for next request
  String etag = http.header("ETag");
  if (etag.length() > 0) currentEtag = etag;

  // Read response into PSRAM buffer
  WiFiClient *stream = http.getStreamPtr();
  int contentLen = http.getSize();
  size_t bytesRead = 0;
  const size_t maxBuf = HTTP_BUF_SIZE - 1;

  if (contentLen > 0) {
    while (bytesRead < (size_t)contentLen && bytesRead < maxBuf) {
      if (stream->available()) {
        size_t chunk = stream->readBytes(
          httpBuf + bytesRead,
          min((size_t)stream->available(), maxBuf - bytesRead)
        );
        bytesRead += chunk;
      } else {
        delay(10);
      }
    }
  } else {
    // Chunked transfer
    while ((stream->connected() || stream->available()) && bytesRead < maxBuf) {
      if (stream->available()) {
        size_t chunk = stream->readBytes(
          httpBuf + bytesRead,
          min((size_t)stream->available(), maxBuf - bytesRead)
        );
        bytesRead += chunk;
      } else {
        delay(5);
      }
    }
  }
  httpBuf[bytesRead] = '\0';
  http.end();
  Serial.printf("Read %zu bytes\n", bytesRead);

  // ── Step 1: decode bitmap directly from httpBuf (no ArduinoJson for large fields) ──
  // Find "bitmap":"<data>" in raw JSON and decode in place.
  size_t bmpB64Len = 0;
  const char *bmpB64 = findBase64Field(httpBuf, "bitmap", &bmpB64Len);
  if (!bmpB64) {
    Serial.println("bitmap field not found");
    drawErrorScreen("Bad server response");
    screenIsBlank = true;
    retryPending = true; retryUrl = url; retryAt = millis() + 30000;
    return;
  }
  size_t decoded = b64Decode(bmpB64, bmpB64Len, framebuffer);
  Serial.printf("Bitmap decoded: %zu bytes (expected %d)\n", decoded, BITMAP_BYTES);
  if (decoded < BITMAP_BYTES / 2) {
    Serial.println("Bitmap too small");
    drawErrorScreen("Bad bitmap");
    screenIsBlank = true;
    retryPending = true; retryUrl = url; retryAt = millis() + 30000;
    return;
  }

  // ── Step 2: parse small metadata with a filter (skips bitmap/pressed_bitmap) ──
  StaticJsonDocument<128> filter;
  filter["timeout_ms"]   = true;
  filter["timeout_url"]  = true;
  filter["buttons"][0]["x"]      = true;
  filter["buttons"][0]["y"]      = true;
  filter["buttons"][0]["width"]  = true;
  filter["buttons"][0]["height"] = true;
  filter["buttons"][0]["url"]    = true;

  StaticJsonDocument<4096> meta;
  DeserializationError err = deserializeJson(meta, httpBuf, bytesRead,
                                              DeserializationOption::Filter(filter));
  if (err) {
    Serial.printf("JSON meta parse error: %s\n", err.c_str());
    drawErrorScreen("Bad server response");
    screenIsBlank = true;
    retryPending = true; retryUrl = url; retryAt = millis() + 30000;
    return;
  }

  // ── Step 3: full-screen redraw ──
  epd_poweron();
  epd_clear();
  epd_draw_grayscale_image(epd_full_screen(), framebuffer);
  epd_poweroff();
  screenIsBlank = false;

  // ── Step 4: parse buttons; decode each pressed_bitmap from httpBuf ──
  freeButtons();
  JsonArray btnArr = meta["buttons"].as<JsonArray>();
  int btnIdx = 0;
  for (JsonObject btn : btnArr) {
    if (buttonCount >= MAX_BUTTONS) break;
    buttons[buttonCount].x = btn["x"] | 0;
    buttons[buttonCount].y = btn["y"] | 0;
    buttons[buttonCount].w = btn["width"]  | 0;
    buttons[buttonCount].h = btn["height"] | 0;
    strlcpy(buttons[buttonCount].url, btn["url"] | "", sizeof(buttons[buttonCount].url));

    size_t pbLen = 0;
    const char *pb64 = findNthBase64Field(httpBuf, "pressed_bitmap", btnIdx, &pbLen);
    if (pb64 && pbLen > 0) {
      size_t maxBytes = (pbLen * 3 / 4) + 4;
      buttons[buttonCount].pressedBitmap =
        (uint8_t *)heap_caps_malloc(maxBytes, MALLOC_CAP_SPIRAM);
      if (buttons[buttonCount].pressedBitmap) {
        buttons[buttonCount].pressedBitmapLen =
          b64Decode(pb64, pbLen, buttons[buttonCount].pressedBitmap);
      }
    } else {
      buttons[buttonCount].pressedBitmap    = nullptr;
      buttons[buttonCount].pressedBitmapLen = 0;
    }
    buttonCount++;
    btnIdx++;
  }

  // ── Step 5: update navigation state ──
  currentUrl  = url;
  timeoutMs   = meta["timeout_ms"] | 0;
  const char *tu = meta["timeout_url"] | "";
  timeoutUrl  = (strlen(tu) > 0) ? String(tu) : url;
  lastFetchMs = millis();
  retryPending = false;

  Serial.printf("Screen loaded — %d button(s), timeout %lu ms → %s\n",
                buttonCount, timeoutMs, timeoutUrl.c_str());
}

// ─── WIFI ─────────────────────────────────────────────────────────────────────

bool wifiConnect() {
  Serial.printf("Connecting to %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < WIFI_MAX_ATTEMPTS && WiFi.status() != WL_CONNECTED; i++) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("Connected — IP: %s\n", WiFi.localIP().toString().c_str());
    return true;
  }
  Serial.println("WiFi failed");
  return false;
}

// ─── TOUCH ────────────────────────────────────────────────────────────────────

void initTouch() {
  // GT911 requires INT driven HIGH before I2C init, otherwise it won't respond
  pinMode(TOUCH_INT, OUTPUT);
  digitalWrite(TOUCH_INT, HIGH);
  delay(10);

  Wire.begin(TOUCH_SDA, TOUCH_SCL);

  // GT911 address depends on INT pin state at power-on — probe both
  uint8_t touchAddr = 0;
  for (uint8_t addr : {0x14, 0x5D}) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) { touchAddr = addr; break; }
  }
  if (!touchAddr) {
    Serial.println("Touch: GT911 not found on I2C");
    return;
  }
  Serial.printf("Touch: GT911 found at 0x%02X\n", touchAddr);

  touch.setPins(-1, TOUCH_INT);
  touchOk = touch.begin(Wire, touchAddr, TOUCH_SDA, TOUCH_SCL);
  if (touchOk) {
    touch.setMaxCoordinates(EPD_W, EPD_H);
    touch.setSwapXY(true);
    touch.setMirrorXY(true, true);
    Serial.println("Touch initialised");
  } else {
    Serial.println("Touch begin() failed");
  }
}

int hitTest(int tx, int ty) {
  for (int i = 0; i < buttonCount; i++) {
    if (tx >= buttons[i].x && tx < buttons[i].x + buttons[i].w &&
        ty >= buttons[i].y && ty < buttons[i].y + buttons[i].h) {
      return i;
    }
  }
  return -1;
}

// ─── SETUP / LOOP ─────────────────────────────────────────────────────────────

void setup() {
  Serial.begin(115200);

  epd_init();

  framebuffer = (uint8_t *)ps_calloc(BITMAP_BYTES, 1);
  if (!framebuffer) { Serial.println("framebuffer alloc failed"); while (true) delay(1000); }

  httpBuf = (char *)heap_caps_malloc(HTTP_BUF_SIZE, MALLOC_CAP_SPIRAM);
  if (!httpBuf) { Serial.println("httpBuf alloc failed"); while (true) delay(1000); }

  epd_poweron();
  epd_clear();
  epd_poweroff();

  initTouch();

  if (!wifiConnect()) {
    drawErrorScreen("No WiFi");
    while (true) delay(5000);
  }

  fetchAndDisplay("/");
}

void loop() {
  uint32_t now = millis();

  // Scheduled retry after error
  if (retryPending && now >= retryAt) {
    retryPending = false;
    fetchAndDisplay(retryUrl);
    return;
  }

  // Auto-refresh timeout
  if (!retryPending && timeoutMs > 0 && (now - lastFetchMs) >= timeoutMs) {
    fetchAndDisplay(timeoutUrl);
    return;
  }

  // Touch handling
  if (touchOk && (now - lastTouchMs) > TOUCH_DEBOUNCE_MS) {
    int16_t tx, ty;
    if (touch.getPoint(&tx, &ty, 1) > 0) {
      tx = (int16_t)(EPD_W - 1 - tx);  // mirror X to match display orientation
      Serial.printf("Touch: (%d, %d)\n", tx, ty);
      int bi = hitTest(tx, ty);
      if (bi >= 0) {
        Serial.printf("  → button %d %s\n", bi, buttons[bi].url);
        lastTouchMs = now;
        if (buttons[bi].pressedBitmap) showPressedState(buttons[bi]);
        fetchAndDisplay(String(buttons[bi].url));
        return;
      }
      lastTouchMs = now;
    }
  }

  delay(50);
}
