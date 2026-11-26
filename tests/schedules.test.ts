import { describe, expect, it } from "vitest";
import { nextDue } from "@/lib/schedules";

describe("schedule cadence", () => {
  it("advances weekly by exactly seven days", () => {
    expect(nextDue(new Date("2026-11-25T09:00:00Z"), "weekly").toISOString()).toBe("2026-12-02T09:00:00.000Z");
  });

  it("advances monthly keeping the day and the time", () => {
    expect(nextDue(new Date("2026-11-25T09:00:00Z"), "monthly").toISOString()).toBe("2026-12-25T09:00:00.000Z");
  });

  it("clamps the 31st to the last day of a shorter month", () => {
    expect(nextDue(new Date("2026-01-31T08:30:00Z"), "monthly").toISOString()).toBe("2026-02-28T08:30:00.000Z");
    expect(nextDue(new Date("2026-03-31T08:30:00Z"), "monthly").toISOString()).toBe("2026-04-30T08:30:00.000Z");
  });

  it("crosses a year boundary", () => {
    expect(nextDue(new Date("2026-12-28T10:00:00Z"), "weekly").toISOString()).toBe("2027-01-04T10:00:00.000Z");
  });
});
