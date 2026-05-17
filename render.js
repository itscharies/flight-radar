const puppeteer = require("puppeteer");
const sharp = require("sharp");
const crypto = require("crypto");

const EPD_W = 960;
const EPD_H = 540;
const RENDER_SCALE = 2;

let browser = null;

async function getBrowser() {
  if (!browser) {
    const opts = {
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    browser = await puppeteer.launch(opts);
  }
  return browser;
}

// Pack 8-bit grayscale buffer into 4-bit nibble pairs.
// pixel i → low nibble of byte i/2 (even i) or high nibble (odd i).
function packNibbles(raw) {
  const len = raw.length % 2 === 0 ? raw.length : raw.length + 1;
  const packed = Buffer.alloc(len / 2, 0);
  for (let i = 0; i < raw.length; i += 2) {
    const a = (raw[i] >> 4) & 0x0f;
    const b = i + 1 < raw.length ? (raw[i + 1] >> 4) & 0x0f : 0;
    packed[i / 2] = a | (b << 4);
  }
  return packed;
}

// Extract a rectangular region from a flat 8-bit grayscale buffer (width × height).
function extractRegion(raw, srcW, x, y, w, h) {
  const region = Buffer.alloc(w * h);
  for (let row = 0; row < h; row++) {
    raw.copy(region, row * w, (y + row) * srcW + x, (y + row) * srcW + x + w);
  }
  return region;
}

/**
 * Render an HTML string to a 4-bit packed grayscale bitmap and optional button
 * pressed-state crops.
 *
 * buttonDefs: [{ x, y, width, height }, ...]
 *
 * Returns { bitmap: Buffer, buttonCrops: Buffer[], hash: string }
 * - bitmap:      4-bit packed, 960×540 (259 200 bytes)
 * - buttonCrops: one 4-bit packed crop per buttonDef, colours inverted for press feedback
 * - hash:        MD5 hex of bitmap (for change detection)
 */
async function renderScreen(html, buttonDefs = []) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: EPD_W, height: EPD_H, deviceScaleFactor: RENDER_SCALE });
    await page.setUserAgent("FlightRadar/1.0");
    await page.setContent(html, { waitUntil: "networkidle0" });
    const png = await page.screenshot({ type: "png" });

    const raw = await sharp(png)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize(EPD_W, EPD_H, { kernel: sharp.kernel.lanczos3 })
      .grayscale()
      .raw()
      .toBuffer();

    const bitmap = packNibbles(raw);
    const hash = crypto.createHash("md5").update(bitmap).digest("hex");

    const buttonCrops = buttonDefs.map(({ x, y, width, height }) => {
      const region = extractRegion(raw, EPD_W, x, y, width, height);
      // Invert for pressed visual feedback — no second render needed
      for (let i = 0; i < region.length; i++) region[i] = 255 - region[i];
      return packNibbles(region);
    });

    return { bitmap, buttonCrops, hash };
  } finally {
    await page.close();
  }
}

module.exports = { renderScreen, EPD_W, EPD_H };
