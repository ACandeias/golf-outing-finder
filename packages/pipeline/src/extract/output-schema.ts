import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";

/**
 * The extraction output schema (SPEC.md 8.4, amendment A1), built with `zod/v4` as the
 * SDK's `zodOutputFormat` helper requires. It mirrors `extractionResultSchema`
 * in @gof/shared, which stays the validator of record; a test keeps
 * the two in step. Constraints structured outputs can't enforce (string length,
 * number range, array size) are moved into descriptions by the helper and
 * enforced again by extract-collect.
 */
const nullableString = z.string().nullable();

export const extractionEventSchemaV4 = z
  .object({
    is_outing: z.boolean(),
    reject_reason: z
      .enum(["not_golf", "past", "members_only", "resort_package", "qualifier", "no_date", "other"])
      .nullable(),
    title: z.string(),
    organizer_name: nullableString,
    organizer_ein: nullableString,
    beneficiary: nullableString,
    course_name: nullableString,
    venue_address: nullableString,
    venue_city: nullableString,
    venue_state: z.string().length(2).nullable(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    shotgun_time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
    format: z.enum(["scramble", "best_ball", "shamble", "stroke", "other"]).nullable(),
    single_price_usd: z.number().min(0).max(25000).nullable(),
    foursome_price_usd: z.number().min(0).max(25000).nullable(),
    sponsor_only: z.boolean(),
    includes: z.array(
      z.enum(["lunch", "breakfast", "dinner", "cart", "caddie", "range", "gift", "contests"]),
    ),
    handicap_required: z.boolean().nullable(),
    status: z.enum(["open", "waitlist", "sold_out", "cancelled", "unknown"]),
    registration_url: nullableString,
    outing_type_hint: z.enum([
      "charity",
      "school_fundraiser",
      "business_association",
      "access_day",
      "open_tournament",
      "pro_am",
      "other",
    ]),
    audience: z.enum(["open", "aimed_at_group"]),
    audience_note: nullableString,
    lodging_required: z.boolean(),
    summary: z.string().max(300),
    evidence: z.object({ date: nullableString, price: nullableString, venue: nullableString }),
  })
  .strict();

export const extractionResultSchemaV4 = z
  .object({ events: z.array(extractionEventSchemaV4).max(25) })
  .strict();

const ENUM_DESCRIPTION = /^\{enum: (\[[^\]]*\])\}$/;

/**
 * The SDK helper (0.131.0) moves `enum` into the description along with the
 * constraints structured outputs can't enforce. Enums are in the supported
 * subset, so put them back: the model is then held to the allowed values
 * instead of having an off-list value rejected by post-validation.
 */
function restoreEnums(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(restoreEnums);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = restoreEnums(v);
  const desc = out["description"];
  if (out["type"] === "string" && typeof desc === "string") {
    const m = ENUM_DESCRIPTION.exec(desc);
    if (m?.[1]) {
      out["enum"] = JSON.parse(m[1]) as string[];
      delete out["description"];
    }
  }
  return out;
}

const DEF_REF = /^#\/\$defs\/(.+)$/;

/**
 * zod 4.6 emits a schema used more than once as a `$defs` entry and `$ref`s to
 * it. The request carries one flat schema (the shape the prompt cache and the
 * recorded fixtures were made with), so each `$ref` is replaced by its
 * definition and `$defs` is dropped. The schema has no recursive types.
 */
function inlineDefs(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const defs = (schema as Record<string, unknown>)["$defs"];
  const table = defs && typeof defs === "object" ? (defs as Record<string, unknown>) : {};
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const rec = node as Record<string, unknown>;
    const ref = rec["$ref"];
    if (typeof ref === "string") {
      const name = DEF_REF.exec(ref)?.[1];
      if (name === undefined || !(name in table)) throw new Error(`output schema: unresolved ${ref}`);
      const { $ref: _ref, ...rest } = rec;
      return { ...(walk(table[name]) as Record<string, unknown>), ...(walk(rest) as Record<string, unknown>) };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) if (k !== "$defs") out[k] = walk(v);
    return out;
  };
  return walk(schema);
}

/**
 * `output_config.format` for the request: the JSON-schema half of
 * `zodOutputFormat` (its `parse` function can't travel in a batch request),
 * with `$ref`s inlined and enums restored.
 */
export function extractionOutputFormat(): { type: "json_schema"; schema: Record<string, unknown> } {
  const f = zodOutputFormat(extractionResultSchemaV4);
  return { type: "json_schema", schema: restoreEnums(inlineDefs(f.schema)) as Record<string, unknown> };
}
