import esbuild from "esbuild";
import { readFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

// Single source of truth: the manifest version is injected from package.json at
// build time so dist/manifest.js can never drift from the published package
// version (the 0.2.0-vs-0.2.x defect that shipped twice in BLO-7607).
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const sharedConfig = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: ["@paperclipai/plugin-sdk"],
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkg.version),
  },
};

const builds = [
  { entryPoints: ["src/manifest.ts"], outfile: "dist/manifest.js" },
  { entryPoints: ["src/worker.ts"], outfile: "dist/worker.js" },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context({ ...sharedConfig, ...b })));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("Watching for changes…");
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...sharedConfig, ...b })));
  console.log("Build complete.");
}
