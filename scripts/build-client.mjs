import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

import { build } from "esbuild";

await mkdir("dist", { recursive: true });

const result = await build({
  entryPoints: ["src/main.tsx"],
  outfile: "dist/app.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: true,
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  metafile: true,
});

const index = (await readFile("index.html", "utf8")).replace(
  "/dist/app.js",
  "/app.js"
);

await Promise.all([
  writeFile("dist/index.html", index),
  copyFile("styles.css", "dist/styles.css"),
  copyFile("logoNoBG.png", "dist/logoNoBG.png"),
  copyFile("logoColoredBG.png", "dist/logoColoredBG.png"),
  copyFile(
    "logoPurpleFontWhiteBG.png",
    "dist/logoPurpleFontWhiteBG.png"
  ),
]);

const output = result.metafile.outputs["dist/app.js"];
const kilobytes = output ? (output.bytes / 1024).toFixed(1) : "unknown";
console.log(`Built dist/app.js (${kilobytes} kB).`);
