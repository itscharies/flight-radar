/**
 * LilyGO T5 4.7" — Generic Screen Player
 * ----------------------------------------
 * Fetches JSON screens from the server and renders them.
 * All app logic lives on the server; the device is dumb.
 *
 * JSON response schema:
 *   {
 *     "bitmap":      "<base64 4-bit packed grayscale 960×540>",
 *     "buttons":     [{ "x","y","width","height","url","pressed_bitmap" }],
 *     "timeout_ms":  15000,   // null = wait indefinitely
 *     "timeout_url": "/path"  // null = re-fetch currentUrl
 *   }
 *
 * Required libraries (Library Manager):
 *   - ArduinoJson  ≥ 6.21
 *   - LilyGo-EPD47 (display driver)
 *   - SensorLib    (TouchDrvGT911)
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

// ─── USER CONFIG ──────────────────────────────────────────────────────────────
const char *WIFI_SSID = "LESS DELUXE NETWORK";
const char *WIFI_PASS = "why?becauseisaidso";
const char *BASE_URL  = "http://192.168.1.100:8080";  // LePotato IP

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
#define EPD_W         960
#define EPD_H         540
#define BITMAP_BYTES  (EPD_W * EPD_H / 2)   // 259 200 bytes, 4-bit packed
#define MAX_BUTTONS   8
#define HTTP_BUF_SIZE (900 * 1024)           // 900 KB for JSON response (launcher ~586 KB)
#define TOUCH_DEBOUNCE_MS 800
#define WIFI_MAX_ATTEMPTS 40

// GT911 I2C pins (LilyGO T5 4.7")
#define TOUCH_SDA  15
#define TOUCH_SCL  14
#define TOUCH_INT  -1
#define TOUCH_RST  -1

// ─── PSRAM ALLOCATOR FOR ARDUINOJSON ─────────────────────────────────────────
// Allocates the JSON document pool in PSRAM so large bitmaps fit.
struct PsramAllocator {
  void *allocate(size_t size)                   { return heap_caps_malloc(size, MALLOC_CAP_SPIRAM); }
  void  deallocate(void *ptr)                   { heap_caps_free(ptr); }
  void *reallocate(void *ptr, size_t new_size)  { return heap_caps_realloc(ptr, new_size, MALLOC_CAP_SPIRAM); }
};
using PsramJsonDocument = BasicJsonDocument<PsramAllocator>;

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

static TouchDrvGT911 touch;
static bool touchOk = false;
static uint32_t lastTouchMs = 0;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

String resolveUrl(const String &url) {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return String(BASE_URL) + (url.startsWith("/") ? url : "/" + url);
}

// Copy a packed 4-bit crop into framebuffer at (bx, by).
// src is srcW×srcH pixels, 4-bit packed (low nibble = pixel 0, high = pixel 1).
void blit4bit(const uint8_t *src, int srcW, int srcH, uint8_t *dst, int dstW, int bx, int by) {
  for (int row = 0; row < srcH; row++) {
    for (int col = 0; col < srcW; col++) {
      int si = row * srcW + col;
      uint8_t nibble = (si % 2 == 0) ? (src[si / 2] & 0x0F) : ((src[si / 2] >> 4) & 0x0F);
      int di = (by + row) * dstW + (bx + col);
      if (di % 2 == 0) dst[di / 2] = (dst[di / 2] & 0xF0) | nibble;
      else             dst[di / 2] = (dst[di / 2] & 0x0F) | (nibble << 4);
    }
  }
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

void showPressedState(const ScreenButton &btn) {
  blit4bit(btn.pressedBitmap, btn.w, btn.h, framebuffer, EPD_W, btn.x, btn.y);
  Rect_t area = { btn.x, btn.y, btn.w, btn.h };
  epd_poweron();
  epd_draw_grayscale_image(area, framebuffer);
  epd_poweroff();
  delay(200);
}

// ─── FETCH AND DISPLAY ────────────────────────────────────────────────────────

void fetchAndDisplay(const String &url) {
  String fullUrl = resolveUrl(url);
  Serial.printf("Fetching: %s\n", fullUrl.c_str());

  HTTPClient http;
  http.begin(fullUrl);
  http.setTimeout(30000);
  int httpCode = http.GET();

  if (httpCode != HTTP_CODE_OK) {
    Serial.printf("HTTP error: %d\n", httpCode);
    http.end();
    drawErrorScreen("Connection error");
    retryPending = true;
    retryUrl = url;
    retryAt  = millis() + 30000;
    return;
  }

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

  // Parse JSON from PSRAM-backed document (bitmap base64 is ~345 KB)
  PsramJsonDocument doc(800 * 1024);
  DeserializationError err = deserializeJson(doc, httpBuf, bytesRead);
  if (err) {
    Serial.printf("JSON parse error: %s\n", err.c_str());
    drawErrorScreen("Bad server response");
    retryPending = true;
    retryUrl = url;
    retryAt  = millis() + 30000;
    return;
  }

  // Decode main bitmap directly into framebuffer
  const char *bitmapB64 = doc["bitmap"] | "";
  size_t decoded = b64Decode(bitmapB64, strlen(bitmapB64), framebuffer);
  Serial.printf("Bitmap decoded: %zu bytes (expected %d)\n", decoded, BITMAP_BYTES);

  if (decoded < BITMAP_BYTES / 2) {
    Serial.println("Bitmap too small, aborting render");
    drawErrorScreen("Bad bitmap");
    retryPending = true;
    retryUrl = url;
    retryAt  = millis() + 30000;
    return;
  }

  // Full-screen redraw
  epd_poweron();
  epd_clear();
  epd_draw_grayscale_image(epd_full_screen(), framebuffer);
  epd_poweroff();

  // Parse buttons
  freeButtons();
  JsonArray btnArr = doc["buttons"].as<JsonArray>();
  for (JsonObject btn : btnArr) {
    if (buttonCount >= MAX_BUTTONS) break;
    buttons[buttonCount].x = btn["x"] | 0;
    buttons[buttonCount].y = btn["y"] | 0;
    buttons[buttonCount].w = btn["width"]  | 0;
    buttons[buttonCount].h = btn["height"] | 0;
    strlcpy(buttons[buttonCount].url, btn["url"] | "", sizeof(buttons[buttonCount].url));

    const char *pb64 = btn["pressed_bitmap"] | "";
    size_t pbLen = strlen(pb64);
    if (pbLen > 0) {
      size_t maxBytes = (pbLen * 3 / 4) + 4;
      buttons[buttonCount].pressedBitmap = (uint8_t *)heap_caps_malloc(maxBytes, MALLOC_CAP_SPIRAM);
      if (buttons[buttonCount].pressedBitmap) {
        buttons[buttonCount].pressedBitmapLen = b64Decode(pb64, pbLen, buttons[buttonCount].pressedBitmap);
      }
    } else {
      buttons[buttonCount].pressedBitmap    = nullptr;
      buttons[buttonCount].pressedBitmapLen = 0;
    }
    buttonCount++;
  }

  // Update navigation state
  currentUrl  = url;
  timeoutMs   = doc["timeout_ms"] | 0;
  const char *tu = doc["timeout_url"] | "";
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
  Wire.begin(TOUCH_SDA, TOUCH_SCL);
  touch.setPins(TOUCH_RST, TOUCH_INT);
  touchOk = touch.begin(Wire, GT911_SLAVE_ADDRESS_L);
  if (touchOk) {
    touch.setMaxCoordinates(EPD_W, EPD_H);
    touch.setMirrorXY(false, false);
    Serial.println("Touch initialised");
  } else {
    touchOk = touch.begin(Wire, GT911_SLAVE_ADDRESS_H);
    if (touchOk) {
      touch.setMaxCoordinates(EPD_W, EPD_H);
      touch.setMirrorXY(false, false);
      Serial.println("Touch initialised (addr H)");
    } else {
      Serial.println("Touch init failed — buttons won't work");
    }
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
    if (touch.isPressed()) {
      int16_t tx, ty;
      if (touch.getPoint(&tx, &ty, 1) > 0) {
        int bi = hitTest(tx, ty);
        if (bi >= 0) {
          lastTouchMs = now;
          if (buttons[bi].pressedBitmap) showPressedState(buttons[bi]);
          fetchAndDisplay(String(buttons[bi].url));
          return;
        }
      }
    }
  }

  delay(50);
}
