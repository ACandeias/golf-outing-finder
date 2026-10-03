/**
 * PDF flyers (SPEC.md 8.3): text from pdfjs-dist for files of 2 MB or less.
 * No font loading, no XFA, no fetching; the bytes are already in memory.
 */

export const MAX_PDF_BYTES = 2 * 1024 * 1024;
const MAX_PAGES = 20;

export type PdfTextFn = (data: Uint8Array) => Promise<string>;

interface TextItemLike {
  str?: unknown;
  hasEOL?: unknown;
}

export const pdfText: PdfTextFn = async (data) => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    // pdfjs transfers the buffer to its worker; give it a copy.
    data: new Uint8Array(data),
    disableFontFace: true,
    useWorkerFetch: false,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = "";
      const lines: string[] = [];
      for (const raw of content.items as TextItemLike[]) {
        if (typeof raw.str !== "string") continue;
        line += raw.str;
        if (raw.hasEOL === true) {
          lines.push(line);
          line = "";
        } else if (raw.str !== "" && !line.endsWith(" ")) {
          line += " ";
        }
      }
      if (line.trim() !== "") lines.push(line);
      pages.push(
        lines
          .map((l) => l.replace(/\s+/g, " ").trim())
          .filter((l) => l !== "")
          .join("\n"),
      );
    }
    return pages.join("\n\n").trim();
  } finally {
    await task.destroy();
  }
};
