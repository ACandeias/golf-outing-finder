/**
 * Incremental RFC 4180 CSV parser for the IRS Business Master File extracts,
 * which are too large to hold as one string (about 1.9 million rows across the
 * four regional files). Quoted fields may hold commas, doubled quotes and line
 * breaks; a chunk may end anywhere, including inside a quoted field.
 */
export class CsvStreamParser {
  private field = "";
  private row: string[] = [];
  private inQuotes = false;
  /** A quote seen at the end of a chunk inside a quoted field: closing or doubled. */
  private pendingQuote = false;
  /** A CR seen at the end of a chunk: swallow a following LF. */
  private pendingCr = false;

  push(chunk: string): string[][] {
    const out: string[][] = [];
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      if (this.pendingCr) {
        this.pendingCr = false;
        if (ch === "\n") continue;
      }
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (ch === '"') {
          this.field += '"';
          continue;
        }
        this.inQuotes = false;
      }
      if (this.inQuotes) {
        if (ch === '"') this.pendingQuote = true;
        else this.field += ch;
        continue;
      }
      if (ch === '"') this.inQuotes = true;
      else if (ch === ",") {
        this.row.push(this.field);
        this.field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r") this.pendingCr = true;
        this.row.push(this.field);
        out.push(this.row);
        this.row = [];
        this.field = "";
      } else this.field += ch;
    }
    return out;
  }

  /** Flushes the last row when the input doesn't end with a newline. */
  end(): string[][] {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.inQuotes = false;
    }
    if (this.field === "" && this.row.length === 0) return [];
    this.row.push(this.field);
    const last = this.row;
    this.row = [];
    this.field = "";
    return [last];
  }
}

/** Rows from a stream of text chunks, in batches of at most `batchSize`. */
export async function* csvRows(
  chunks: AsyncIterable<string>,
  batchSize = 5000,
): AsyncGenerator<string[][]> {
  const parser = new CsvStreamParser();
  let batch: string[][] = [];
  for await (const chunk of chunks) {
    for (const r of parser.push(chunk)) {
      batch.push(r);
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }
  }
  batch.push(...parser.end());
  if (batch.length > 0) yield batch;
}
