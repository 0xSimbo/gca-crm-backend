import { describe, expect, it } from "bun:test";
import { CASH_BOUNTY_BY_APPLICATION_ID } from "../../src/pol/bounties/cashBountySeed";

describe("PoL cash bounties seed", () => {
  it("includes the Clean Grid Project bounty override", () => {
    expect(CASH_BOUNTY_BY_APPLICATION_ID["3c8a504d-64e1-4dca-b747-34fd438fa339"]).toBe(
      1200
    );
  });
});

