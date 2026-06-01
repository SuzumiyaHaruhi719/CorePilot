// Rasterize an SVG to PNG at a given width using @resvg/resvg-js.
// Usage: node render.mjs <input.svg> <output.png> [width]
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";

const [, , src, out, width] = process.argv;
if (!src || !out) {
  console.error("usage: node render.mjs <input.svg> <output.png> [width]");
  process.exit(1);
}

const svg = readFileSync(src, "utf8");
const resvg = new Resvg(svg, {
  fitTo: { mode: "width", value: Number(width) || 1024 },
  font: { loadSystemFonts: true },
  background: "rgba(0,0,0,0)",
});
const png = resvg.render().asPng();
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
