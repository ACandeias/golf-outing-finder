/**
 * Display text for an access opportunity (auction lot, member-for-a-day,
 * stay-and-play, ...). Plain text only: every value renders through Astro's
 * escaping, never as HTML.
 */
import type { AccessKind } from "@gof/db/schema";
import { formatUsd } from "@gof/shared/money";
import { shortDate, verifiedDate } from "./format.ts";

export const ACCESS_KIND_LABELS: Readonly<Record<AccessKind, string>> = {
  outing: "Charity outing",
  auction: "Auction lot",
  member_for_a_day: "Member for a day",
  stay_and_play: "Stay and play",
  resort_booking: "Resort booking",
  public_tee_time: "Public tee times",
  qualifier: "Qualifier",
  pro_am: "Pro-am",
  charity_dinner: "Charity dinner with golf",
  fundraiser_package: "Fundraiser package",
  other: "Other access",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  open: "Open",
  upcoming: "Upcoming",
  closed: "Closed",
  recurring: "Recurring",
  unknown: "Status unknown",
};

/** The link as an absolute http(s) URL, or null: a stored link never renders with another scheme. */
export function safeHttpUrl(u: string): string | null {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
  } catch {
    return null;
  }
}

/** True when a price is known (otherwise the price text is "See site"). */
export function hasPrice(v: { priceMinCents: number | null; priceMaxCents: number | null }): boolean {
  return v.priceMinCents !== null || v.priceMaxCents !== null;
}

export interface AccessViewInput {
  kind: AccessKind;
  status: string;
  priceKind: string | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
  dateStart: string | null;
  dateEnd: string | null;
  season: string | null;
  recurring: boolean;
  players: number | null;
  memberHosted: boolean | null;
  organizerName: string | null;
  eventName: string | null;
  platform: string;
  confirmed: "fetched" | "snippet";
  lastVerified: string;
}

function priceText(v: AccessViewInput): string {
  const min = v.priceMinCents;
  const max = v.priceMaxCents;
  if (min === null && max === null) return "See site";
  const amount = min !== null && max !== null && max > min ? `${formatUsd(min)} to ${formatUsd(max)}` : formatUsd(min ?? max);
  // A bid seen while a lot was open is not what it went for: once the lot is over, say so.
  const over = v.status === "closed" || v.status === "recurring";
  switch (v.priceKind) {
    case "sold":
      return `Sold for ${amount}`;
    case "current_bid":
      return over ? `Last bid seen ${amount}` : `Current bid ${amount}`;
    case "starting_bid":
      return over ? `Bidding started at ${amount}` : `Starting bid ${amount}`;
    case "buy_now":
      return over ? `Buy now was ${amount}` : `Buy now ${amount}`;
    case "green_fee":
      return `Green fees ${min !== null && max === null ? "from " : ""}${amount}`;
    case "package":
      return `Packages ${min !== null && max === null ? "from " : ""}${amount}`;
    case "donation":
      return `Donation ${amount}`;
    default:
      return amount;
  }
}

function whenText(v: AccessViewInput): string {
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  if (v.kind === "auction" && v.dateEnd) {
    return `${v.status === "closed" ? "Bidding closed" : "Bidding closes"} ${shortDate(v.dateEnd)}`;
  }
  const date = v.dateStart ?? v.dateEnd;
  if (date) return v.dateEnd && v.dateStart && v.dateEnd !== v.dateStart ? `${shortDate(v.dateStart)} to ${shortDate(v.dateEnd)}` : shortDate(date);
  if (v.season) return cap(v.season);
  return v.recurring ? "Recurring" : "Date not listed";
}

export function accessView(v: AccessViewInput) {
  const who = [v.eventName, v.organizerName].filter((x): x is string => Boolean(x)).join(", ");
  const party =
    v.players === null
      ? v.memberHosted
        ? "With a member"
        : ""
      : `${v.players} ${v.players === 1 ? "player" : "players"}${v.memberHosted ? " with a member" : ""}`;
  return {
    kindLabel: ACCESS_KIND_LABELS[v.kind],
    statusLabel: STATUS_LABELS[v.status] ?? "Status unknown",
    price: priceText(v),
    when: whenText(v),
    who,
    party,
    source: `On ${v.platform}. ${v.confirmed === "fetched" ? "Checked" : "Seen in search results"} ${verifiedDate(v.lastVerified)}`,
  };
}
