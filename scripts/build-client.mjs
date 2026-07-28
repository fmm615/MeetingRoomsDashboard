import { mkdir } from "node:fs/promises";

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

const output = result.metafile.outputs["dist/app.js"];
const kilobytes = output ? (output.bytes / 1024).toFixed(1) : "unknown";
console.log(`Built dist/app.js (${kilobytes} kB).`);
