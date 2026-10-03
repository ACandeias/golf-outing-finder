import { describe, expect, it, vi } from "vitest";
import { PATHS } from "./lib/paths.ts";
import { readSeedFile } from "./seed/seed-file.ts";
import {
  containsSecret,
  estimateCostCents,
  LLM_DIR,
  loadFixturePages,
  PAGES_DIR,
  runLiveExtract,
  toRecording,
} from "./live-extract.ts";
import { llmRecordingSchema } from "./llm/recording.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("live-extract (never calls the API in tests)", () => {
  it("exits 1 without ANTHROPIC_API_KEY before reading anything", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runLiveExtract([])).toBe(1);
      expect(err).toHaveBeenCalledWith(expect.stringContaining("ANTHROPIC_API_KEY is not set"));
    } finally {
      err.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("loads one page per fixture id, synthetic stand-ins first", async () => {
    const seed = await readSeedFile(PATHS.seed);
    const pages = loadFixturePages(PAGES_DIR, seed.outings);
    expect(pages).toHaveLength(15);
    const gc5 = pages.find((p) => p.id === "s12-grady-rocky-point")!;
    expect(gc5.page.text).toContain("$150");
    expect(gc5.page.directory_host).toBe("scramblehunter.com");
    expect(pages.find((p) => p.id === "s15-synthetic-oakmont-glendale")?.page.url).toBe(
      "https://fixtures.invalid/s15-synthetic-oakmont-glendale",
    );
  });

  it("estimates cost from the token estimate at batch prices", () => {
    const req = { custom_id: "a", page_url: "https://e.org", est_input_tokens: 4000, params: {} };
    // 4,000 in at $0.50/M = 0.2 cents; 500 out at $2.50/M = 0.125 cents; rounded up.
    expect(estimateCostCents([req])).toEqual({ typical: 1, ceiling: 1 });
    expect(estimateCostCents(Array.from({ length: 500 }, () => req))).toEqual({ typical: 163, ceiling: 350 });
  });

  it("refuses to write anything that looks like a key", () => {
    expect(containsSecret('{"text":"sk-ant-api03-abcdefghijklmnop"}', undefined)).toBe(true);
    expect(containsSecret('{"text":"my-secret-value"}', "my-secret-value")).toBe(true);
    expect(containsSecret('{"text":"Fordham Golf Classic"}', "my-secret-value")).toBe(false);
  });

  it("writes recordings in the replay shape with recorded: true", () => {
    const hand = llmRecordingSchema.parse(
      JSON.parse(readFileSync(join(LLM_DIR, "s04-fordham-winged-foot.json"), "utf8")),
    );
    expect(hand.recorded).toBe(false);
    const rec = toRecording("s04-fordham-winged-foot", hand.batch_result, new Date("2026-10-04T00:00:00Z"));
    expect(rec).toMatchObject({ recorded: true, model: "claude-haiku-4-5", extractor_version: "extract-v1" });
    expect(rec.note).toBeUndefined();
  });
});
