/** Money is integer cents everywhere (CLAUDE.md). */
export type Cents = number & { readonly __brand: "cents" };

export const MAX_PRICE_CENTS = 2_500_000; // $25,000, SPEC.md 7.1 and 8.4

export function isCents(value: number): value is Cents {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Converts a dollar amount to integer cents, rounding half away from zero. */
export function dollarsToCents(usd: number): Cents {
  if (!Number.isFinite(usd)) throw new Error(`not a finite amount: ${usd}`);
  // toFixed avoids binary drift (150.005 * 100 = 15000.499999...).
  const cents = Math.round(Number((usd * 100).toFixed(6)));
  return cents as Cents;
}

export function centsToDollars(cents: Cents | number): number {
  return cents / 100;
}

/** "$1,500" for whole dollars, "$119.22" otherwise; empty for null. */
export function formatUsd(cents: Cents | number | null | undefined): string {
  if (cents == null) return "";
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const fraction = abs % 100;
  const body =
    fraction === 0
      ? whole.toLocaleString("en-US")
      : `${whole.toLocaleString("en-US")}.${fraction.toString().padStart(2, "0")}`;
  return `${negative ? "-" : ""}$${body}`;
}

/** Parses "$1,500", "1500.00" or "USD 125" to cents; null when it isn't a price. */
export function parseUsd(text: string): Cents | null {
  const m = /^\s*(?:usd\s*)?\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*$/i.exec(text);
  if (!m) return null;
  const whole = Number((m[1] ?? "0").replace(/,/g, ""));
  const frac = Number((m[2] ?? "0").padEnd(2, "0"));
  return (whole * 100 + frac) as Cents;
}

/** True when a price is inside the 0 to $25,000 range the schema allows. */
export function isPlausiblePrice(cents: number): boolean {
  return isCents(cents) && cents <= MAX_PRICE_CENTS;
}
