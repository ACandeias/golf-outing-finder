import { emptyResult, irsRecordSchema, type IrsRecord, type IrsStage } from "./types.ts";

/**
 * SPEC.md 8.1 step 6, workstream D (monthly). Parses IRS Exempt Organizations
 * Business Master File CSV rows into IrsRecords. Columns are found by header
 * name, so a reordered or extended extract still parses; a header row may repeat
 * (one per regional file). Rows before any header, rows that fail validation
 * (bad EIN, no two-letter state, blank name) and repeated EINs are skipped. The
 * edge (src/irs/db.ts) streams the files through this in chunks and writes the
 * node:sqlite lookup in .cache/irs.
 */

/** The BMF header names the lookup keeps. */
export const BMF_KEPT_COLUMNS = {
  ein: "EIN",
  name: "NAME",
  city: "CITY",
  state: "STATE",
  subsection: "SUBSECTION",
  sort_name: "SORT_NAME",
} as const;

type ColumnIndex = Record<keyof typeof BMF_KEPT_COLUMNS, number>;

function headerIndex(row: readonly string[]): ColumnIndex | null {
  const names = row.map((c) => c.trim().toUpperCase());
  if (names[0] !== "EIN" && !names.includes("EIN")) return null;
  const out = {} as ColumnIndex;
  for (const [key, name] of Object.entries(BMF_KEPT_COLUMNS) as [keyof ColumnIndex, string][]) {
    out[key] = names.indexOf(name);
  }
  // SORT_NAME is optional; the rest must be present.
  if (out.ein < 0 || out.name < 0 || out.city < 0 || out.state < 0 || out.subsection < 0)
    return null;
  return out;
}

const clean = (v: string | undefined): string => (v ?? "").trim().replace(/\s+/g, " ");

/** One BMF row as an IrsRecord, or null when it doesn't validate. */
export function bmfRecord(row: readonly string[], col: ColumnIndex): IrsRecord | null {
  const einDigits = clean(row[col.ein]);
  if (!/^\d{1,9}$/.test(einDigits)) return null;
  const sub = clean(row[col.subsection]);
  const sortName = col.sort_name >= 0 ? clean(row[col.sort_name]) : "";
  const parsed = irsRecordSchema.safeParse({
    ein: einDigits.padStart(9, "0"),
    name: clean(row[col.name]),
    city: clean(row[col.city]),
    state: clean(row[col.state]).toUpperCase(),
    subsection: /^\d$/.test(sub) ? `0${sub}` : sub,
    sort_name: sortName === "" ? null : sortName,
  });
  return parsed.success ? parsed.data : null;
}

export const irs: IrsStage = (_ctx, input) => {
  const records: IrsRecord[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let col: ColumnIndex | null = null;
  for (const row of input.rows) {
    if (row.length === 0 || (row.length === 1 && row[0]?.trim() === "")) continue;
    const header = headerIndex(row);
    if (header) {
      col = header;
      continue;
    }
    const rec = col ? bmfRecord(row, col) : null;
    if (!rec || seen.has(rec.ein)) {
      skipped++;
      continue;
    }
    seen.add(rec.ein);
    records.push(rec);
  }
  const result = emptyResult();
  result.counters.irs_records = records.length;
  return { output: { records, skipped }, result };
};
