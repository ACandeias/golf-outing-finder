import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

/** Readers for the owner-edited override files (SPEC.md 7.2) the Phase 1 loaders use. */

async function readYaml(path: string): Promise<unknown> {
  return parse(await readFile(path, "utf8")) ?? {};
}

const removalsSchema = z
  .object({
    outing_ids: z.array(z.string().min(1)).nullable().default([]),
    urls: z.array(z.string().url()).nullable().default([]),
  })
  .passthrough();

export async function readRemovals(path: string): Promise<{ outing_ids: string[]; urls: string[] }> {
  const r = removalsSchema.parse(await readYaml(path));
  return { outing_ids: r.outing_ids ?? [], urls: r.urls ?? [] };
}

const hostSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "registration host must be a bare host name");
const hostsSchema = z.object({ hosts: z.array(hostSchema).nullable().default([]) }).passthrough();

export async function readRegistrationHosts(path: string): Promise<string[]> {
  return (hostsSchema.parse(await readYaml(path)).hosts ?? []).map((h) => h.toLowerCase());
}

const notableEntry = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1).optional(), osm_ref: z.string().min(1).optional() }).passthrough(),
]);
const notableSchema = z.object({ courses: z.array(notableEntry).nullable().default([]) }).passthrough();

/** notable-courses.yaml: course names or osm_refs, no ranks. */
export async function readNotableCourses(path: string): Promise<{ names: string[]; osmRefs: string[] }> {
  const names: string[] = [];
  const osmRefs: string[] = [];
  for (const e of notableSchema.parse(await readYaml(path)).courses ?? []) {
    if (typeof e === "string") {
      if (/^(node|way|relation)\/\d+$/.test(e)) osmRefs.push(e);
      else names.push(e);
    } else {
      if (e.name) names.push(e.name);
      if (e.osm_ref) osmRefs.push(e.osm_ref);
    }
  }
  return { names, osmRefs };
}
