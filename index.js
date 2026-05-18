require("dotenv").config();
require("dns").setDefaultResultOrder("ipv4first");
const express = require("express");
const { warmup } = require("./render");

const app = express();
const PORT = process.env.PORT || 8080;

app.use("/",                     require("./screens/launcher"));
app.use("/screens/flight-radar", require("./screens/flight-radar"));
app.use("/screens/photo-album",  require("./screens/photo-album"));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  await warmup();
});
