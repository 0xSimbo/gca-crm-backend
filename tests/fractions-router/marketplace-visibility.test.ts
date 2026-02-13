import { describe, expect, it } from "bun:test";
import {
  getMarketplaceVisibleAtFromCreatedAt,
  hasMarketplaceVisibilityWindow,
  isFractionVisibleOnMarketplace,
} from "../../src/utils/fractions/marketplaceVisibility";

describe("marketplace listing visibility schedule", () => {
  it("releases on next Tuesday at 1 PM ET for non-Tuesday listings", () => {
    // Friday Jan 9, 2026 10:00 ET (15:00 UTC)
    const createdAt = new Date("2026-01-09T15:00:00.000Z");
    // Tuesday Jan 13, 2026 13:00 ET (18:00 UTC, EST)
    const expectedRelease = new Date("2026-01-13T18:00:00.000Z");

    expect(getMarketplaceVisibleAtFromCreatedAt(createdAt).toISOString()).toBe(
      expectedRelease.toISOString()
    );
  });

  it("releases same Tuesday at 1 PM ET when created before 1 PM ET", () => {
    // Tuesday Jan 13, 2026 12:59 ET (17:59 UTC)
    const createdAt = new Date("2026-01-13T17:59:00.000Z");
    const expectedRelease = new Date("2026-01-13T18:00:00.000Z");

    expect(getMarketplaceVisibleAtFromCreatedAt(createdAt).toISOString()).toBe(
      expectedRelease.toISOString()
    );
  });

  it("releases next Tuesday when created after 1 PM ET on Tuesday", () => {
    // Tuesday Jan 13, 2026 13:01 ET (18:01 UTC)
    const createdAt = new Date("2026-01-13T18:01:00.000Z");
    // Next Tuesday Jan 20, 2026 13:00 ET (18:00 UTC, EST)
    const expectedRelease = new Date("2026-01-20T18:00:00.000Z");

    expect(getMarketplaceVisibleAtFromCreatedAt(createdAt).toISOString()).toBe(
      expectedRelease.toISOString()
    );
  });

  it("keeps same-day release when created exactly at 1 PM ET on Tuesday", () => {
    // Tuesday Jan 13, 2026 13:00 ET (18:00 UTC)
    const createdAt = new Date("2026-01-13T18:00:00.000Z");
    const expectedRelease = new Date("2026-01-13T18:00:00.000Z");

    expect(getMarketplaceVisibleAtFromCreatedAt(createdAt).toISOString()).toBe(
      expectedRelease.toISOString()
    );
  });

  it("handles DST correctly for Tuesday 1 PM ET", () => {
    // Tuesday Jul 7, 2026 12:30 ET (16:30 UTC, EDT)
    const createdAt = new Date("2026-07-07T16:30:00.000Z");
    // Same day 13:00 ET (17:00 UTC, EDT)
    const expectedRelease = new Date("2026-07-07T17:00:00.000Z");

    expect(getMarketplaceVisibleAtFromCreatedAt(createdAt).toISOString()).toBe(
      expectedRelease.toISOString()
    );
  });

  it("marks visibility only at or after release time", () => {
    const createdAt = new Date("2026-01-09T15:00:00.000Z");

    expect(
      isFractionVisibleOnMarketplace(
        createdAt,
        new Date("2026-01-13T17:59:59.999Z")
      )
    ).toBe(false);
    expect(
      isFractionVisibleOnMarketplace(createdAt, new Date("2026-01-13T18:00:00.000Z"))
    ).toBe(true);
  });

  it("detects when expiration is before marketplace release (invalid window)", () => {
    // Wednesday Jan 14, 2026 11:00 ET -> release Tuesday Jan 20, 2026 13:00 ET
    const createdAt = new Date("2026-01-14T16:00:00.000Z");
    // Saturday Jan 17, 2026 14:00 ET
    const expirationAt = new Date("2026-01-17T19:00:00.000Z");

    expect(hasMarketplaceVisibilityWindow(createdAt, expirationAt)).toBe(false);
  });

  it("accepts expiration after marketplace release (valid window)", () => {
    // Monday Jan 12, 2026 10:00 ET -> release Tuesday Jan 13, 2026 13:00 ET
    const createdAt = new Date("2026-01-12T15:00:00.000Z");
    // Saturday Jan 17, 2026 14:00 ET
    const expirationAt = new Date("2026-01-17T19:00:00.000Z");

    expect(hasMarketplaceVisibilityWindow(createdAt, expirationAt)).toBe(true);
  });
});
