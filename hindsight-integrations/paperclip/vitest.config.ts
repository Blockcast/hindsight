import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Mirror the esbuild `define` (esbuild.config.mjs) so the test runtime resolves
// the same package.json-injected manifest version the build does. Without this,
// importing src/manifest.ts under vitest throws ReferenceError: __PLUGIN_VERSION__.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
  define: {
    __PLUGIN_VERSION__: JSON.stringify(pkg.version),
  },
});
