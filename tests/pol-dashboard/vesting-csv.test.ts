import { describe, expect, it } from "bun:test";
import { parseVestingScheduleCsv } from "../../src/pol/vesting/parseVestingCsv";

describe("PoL Dashboard: vesting CSV parser", () => {
  it("parses and normalizes rows", () => {
    const csv = [
      "date,unlocked",
      "2028-01-01,2000000",
      "2027-01-01,1000000.000",
      "2029-01-01,3000000",
    ].join("\n");

    const rows = parseVestingScheduleCsv(csv);
    expect(rows).toEqual([
      { date: "2027-01-01", unlocked: "1000000" },
      { date: "2028-01-01", unlocked: "2000000" },
      { date: "2029-01-01", unlocked: "3000000" },
    ]);
  });

  it("rejects bad header", () => {
    expect(() => parseVestingScheduleCsv("foo,bar\n2027-01-01,1")).toThrow();
  });

  it("rejects invalid ISO date", () => {
    expect(() =>
      parseVestingScheduleCsv("date,unlocked\n2027/01/01,1")
    ).toThrow();
  });
});

