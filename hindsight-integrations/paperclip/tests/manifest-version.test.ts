import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("manifest version", () => {
  it("equals package.json version (single source of truth — guards the BLO-7607 drift)", () => {
    expect(manifest.version).toBe(pkg.version);
  });
});
