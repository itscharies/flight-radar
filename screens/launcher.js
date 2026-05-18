const express = require("express");
const path = require("path");
const fs = require("fs");
const ejs = require("ejs");
const { renderScreen } = require("../render");

const router = express.Router();
const TEMPLATES_DIR = path.join(__dirname, "../templates");

const APPS = [
  { label: "Flight Radar", icon: "✈️", url: "/screens/flight-radar" },
  { label: "Photo Album",  icon: "📸", url: "/screens/photo-album"  },
];

// Must match the absolute tile positions in templates/launcher.ejs
const TILE_BUTTON_DEFS = [
  { x: 24,  y: 24, width: 444, height: 492 },
  { x: 492, y: 24, width: 444, height: 492 },
];

function buildHtml() {
  return ejs.render(
    fs.readFileSync(path.join(TEMPLATES_DIR, "launcher.ejs"), "utf8"),
    { apps: APPS },
    { filename: path.join(TEMPLATES_DIR, "launcher.ejs") }
  );
}

router.get("/", async (req, res) => {
  try {
    const html = buildHtml();

    if (req.query.preview !== undefined) {
      return res.type("html").send(html);
    }

    const buttonDefs = TILE_BUTTON_DEFS.slice(0, APPS.length);
    const { bitmap, buttonCrops, hash } = await renderScreen(html, buttonDefs);

    const etag = `"${hash}"`;
    if (req.get("If-None-Match") === etag) {
      return res.status(304).end();
    }
    res.set("ETag", etag).json({
      bitmap: bitmap.toString("base64"),
      buttons: buttonDefs.map((def, i) => ({
        x: def.x,
        y: def.y,
        width: def.width,
        height: def.height,
        url: APPS[i].url,
        pressed_bitmap: buttonCrops[i].toString("base64"),
      })),
      timeout_ms: null,
      timeout_url: null,
    });
  } catch (err) {
    console.error("Launcher error:", err.stack || err.message);
    res.status(503).json({ error: err.message });
  }
});

module.exports = router;
