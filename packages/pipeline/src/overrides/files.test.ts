import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PATHS } from "../lib/paths.ts";
import { readNotableCourses, readRegistrationHosts, readRemovals } from "./files.ts";

async function tmp(name: string, text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gof-ovr-"));
  const p = join(dir, name);
  await writeFile(p, text);
  return p;
}

describe("override files", () => {
  it("reads the committed files", async () => {
    expect(await readRemovals(PATHS.removals)).toEqual({ outing_ids: [], urls: [] });
    const hosts = await readRegistrationHosts(PATHS.registrationHosts);
    expect(hosts).toContain("qgiv.com");
    expect(hosts).toContain("networkforgood.com");
    expect(await readNotableCourses(PATHS.notable)).toEqual({ names: [], osmRefs: [] });
  });

  it("validates removals and notable entries", async () => {
    expect(
      await readRemovals(
        await tmp("r.yaml", "outing_ids: [s01-a]\nurls: ['https://x.example/a']\n"),
      ),
    ).toEqual({
      outing_ids: ["s01-a"],
      urls: ["https://x.example/a"],
    });
    await expect(readRemovals(await tmp("r.yaml", "urls: ['not a url']\n"))).rejects.toThrow();
    expect(
      await readNotableCourses(
        await tmp(
          "n.yaml",
          "courses:\n  - Winged Foot Golf Club\n  - way/1\n  - { osm_ref: way/2 }\n",
        ),
      ),
    ).toEqual({ names: ["Winged Foot Golf Club"], osmRefs: ["way/1", "way/2"] });
    await expect(
      readRegistrationHosts(await tmp("h.yaml", "hosts: ['https://bad/']\n")),
    ).rejects.toThrow();
  });
});
