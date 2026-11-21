import { describe, expect, it } from "vitest";
import { stateCities, TOP_CITY_CHIPS } from "./listing.ts";

const at = (...cities: (string | null)[]) => cities.map((city) => ({ course: { city } }));

describe("stateCities", () => {
  it("lists every city alphabetically with its count", () => {
    const { all } = stateCities(at("White Plains", "Mamaroneck", "Mamaroneck", "Albany", null));
    expect(all).toEqual([
      { city: "Albany", count: 1 },
      { city: "Mamaroneck", count: 2 },
      { city: "White Plains", count: 1 },
    ]);
  });

  it("picks the six busiest cities for the chips, most outings first, ties by name", () => {
    const outings = at(
      "Rye", "Rye", "Rye",
      "Bronx", "Bronx",
      "Purchase", "Purchase",
      "Albany", "Buffalo", "Elmira", "Ithaca", "Utica",
    );
    const { all, top } = stateCities(outings);
    expect(TOP_CITY_CHIPS).toBe(6);
    expect(all).toHaveLength(8);
    expect(top.map((c) => c.city)).toEqual(["Rye", "Bronx", "Purchase", "Albany", "Buffalo", "Elmira"]);
  });

  it("returns every city as chips when there are six or fewer", () => {
    const { all, top } = stateCities(at("B", "A", "A"));
    expect(top.map((c) => c.city)).toEqual(["A", "B"]);
    expect(all).toHaveLength(2);
  });
});
