export type Cents = number & { readonly __brand: "cents" };

export function dollarsToCents(usd: number): Cents {
  return Math.round(usd * 100) as Cents;
}

export function centsToDollars(cents: Cents | number): number {
  return cents / 100;
}

export function formatUsd(cents: Cents | number | null | undefined): string {
  if (cents == null) return "";
  const whole = Math.trunc(cents / 100);
  const fraction = Math.abs(cents % 100);
  return `$${whole.toLocaleString("en-US")}.${fraction.toString().padStart(2, "0")}`;
}
