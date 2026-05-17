const express = require("express");
const path = require("path");
const fs = require("fs");
const ejs = require("ejs");
const { renderScreen } = require("../render");

const router = express.Router();
const TEMPLATES_DIR = path.join(__dirname, "../templates");
const PHOTO_TIMEOUT_MS = 30000;

const SUPPORTED_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

function getPhotosDir() {
  return process.env.PHOTOS_DIR || path.join(__dirname, "../photos");
}

function listPhotos() {
  const dir = getPhotosDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
    .sort()
    .map(f => path.join(dir, f));
}

function photoToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const mimeMap = { jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", bmp: "bmp" };
  const mime = `image/${mimeMap[ext] || ext}`;
  const data = fs.readFileSync(filePath).toString("base64");
  return `data:${mime};base64,${data}`;
}

router.get("/", async (req, res) => {
  try {
    const photos = listPhotos();

    if (photos.length === 0) {
      const html = "<html><body style='width:960px;height:540px;display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:32px;background:#fff'>No photos found in photos/ folder</body></html>";
      if (req.query.preview !== undefined) return res.type("html").send(html);
      const { bitmap } = await renderScreen(html, []);
      return res.json({ bitmap: bitmap.toString("base64"), buttons: [], timeout_ms: 60000, timeout_url: null });
    }

    const index = Math.abs(parseInt(req.query.index || "0", 10)) % photos.length;
    const nextIndex = (index + 1) % photos.length;
    const filePath = photos[index];
    const caption = path.basename(filePath, path.extname(filePath));

    const html = ejs.render(
      fs.readFileSync(path.join(TEMPLATES_DIR, "photo.ejs"), "utf8"),
      { dataUrl: photoToDataUrl(filePath), caption },
      { filename: path.join(TEMPLATES_DIR, "photo.ejs") }
    );

    if (req.query.preview !== undefined) {
      return res.type("html").send(html);
    }

    const { bitmap } = await renderScreen(html, []);

    res.json({
      bitmap:      bitmap.toString("base64"),
      buttons:     [],
      timeout_ms:  PHOTO_TIMEOUT_MS,
      timeout_url: `/screens/photo-album?index=${nextIndex}`,
    });
    console.log(`Served photo ${index + 1}/${photos.length}: ${path.basename(filePath)}`);
  } catch (err) {
    console.error("Photo album error:", err.message);
    res.status(503).json({ error: err.message });
  }
});

module.exports = router;
