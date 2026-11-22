import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEEKLY_HOURS,
  effectiveAvailability,
  isValidTimeZone,
  isWithinBusinessHours,
  localDayAndMinute,
  parseTime,
  parseWeeklyHours,
  summarizeWeeklyHours,
  type WeeklyHours,
} from "@/lib/business-hours";

const NINE_TO_FIVE = DEFAULT_WEEKLY_HOURS; // Mon–Fri 09:00–17:00

describe("business hours", () => {
  it("reads the local weekday and minute in the member's time zone", () => {
    // Monday 2026-11-23 08:30 UTC = 09:30 in Amsterdam (CET, UTC+1).
    expect(localDayAndMinute(new Date("2026-11-23T08:30:00Z"), "Europe/Amsterdam")).toEqual({ day: 0, minute: 570 });
    // Same instant is Monday 00:30 in Los Angeles (PST, UTC-8).
    expect(localDayAndMinute(new Date("2026-11-23T08:30:00Z"), "America/Los_Angeles")).toEqual({ day: 0, minute: 30 });
    // Midnight is 0, never 24 * 60.
    expect(localDayAndMinute(new Date("2026-11-23T00:00:00Z"), "UTC")).toEqual({ day: 0, minute: 0 });
  });

  it("is inside hours from start up to (not including) end", () => {
    const tz = "Europe/Amsterdam";
    expect(isWithinBusinessHours(NINE_TO_FIVE, tz, new Date("2026-11-23T07:59:00Z"))).toBe(false); // 08:59
    expect(isWithinBusinessHours(NINE_TO_FIVE, tz, new Date("2026-11-23T08:00:00Z"))).toBe(true); // 09:00
    expect(isWithinBusinessHours(NINE_TO_FIVE, tz, new Date("2026-11-23T15:59:00Z"))).toBe(true); // 16:59
    expect(isWithinBusinessHours(NINE_TO_FIVE, tz, new Date("2026-11-23T16:00:00Z"))).toBe(false); // 17:00
    // Saturday is off.
    expect(isWithinBusinessHours(NINE_TO_FIVE, tz, new Date("2026-11-28T10:00:00Z"))).toBe(false);
  });

  it("follows daylight saving time", () => {
    // 1 July 2026 (CEST, UTC+2): 07:30 UTC is 09:30 local, a Wednesday.
    expect(isWithinBusinessHours(NINE_TO_FIVE, "Europe/Amsterdam", new Date("2026-07-01T07:30:00Z"))).toBe(true);
    expect(isWithinBusinessHours(NINE_TO_FIVE, "Europe/Amsterdam", new Date("2026-07-01T15:30:00Z"))).toBe(false);
  });

  it("runs an end before the start past midnight into the next day", () => {
    const nights: WeeklyHours = [null, null, null, null, { start: 22 * 60, end: 2 * 60 }, null, null]; // Fri 22–02
    const at = (iso: string) => isWithinBusinessHours(nights, "UTC", new Date(iso));
    expect(at("2026-11-27T21:59:00Z")).toBe(false); // Fri 21:59
    expect(at("2026-11-27T23:00:00Z")).toBe(true); // Fri 23:00
    expect(at("2026-11-28T01:59:00Z")).toBe(true); // Sat 01:59
    expect(at("2026-11-28T02:00:00Z")).toBe(false); // Sat 02:00
    expect(at("2026-11-26T23:00:00Z")).toBe(false); // Thu 23:00
  });

  it("treats equal start and end as the whole day", () => {
    const sundays: WeeklyHours = [null, null, null, null, null, null, { start: 0, end: 0 }];
    expect(isWithinBusinessHours(sundays, "UTC", new Date("2026-11-29T00:00:00Z"))).toBe(true);
    expect(isWithinBusinessHours(sundays, "UTC", new Date("2026-11-29T23:59:00Z"))).toBe(true);
    expect(isWithinBusinessHours(sundays, "UTC", new Date("2026-11-30T00:00:00Z"))).toBe(false);
    expect(summarizeWeeklyHours(sundays)).toBe("Sun all day");
  });

  it("treats a bad time zone or schedule as not available", () => {
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isWithinBusinessHours(NINE_TO_FIVE, "Mars/Olympus", new Date("2026-11-23T10:00:00Z"))).toBe(false);
    expect(parseWeeklyHours([{ start: 0, end: 60 }])).toBeNull();
    expect(parseWeeklyHours([...NINE_TO_FIVE.slice(0, 6), { start: 0, end: 1440 }])).toBeNull();
    expect(parseWeeklyHours("nope")).toBeNull();
    expect(parseWeeklyHours(NINE_TO_FIVE)).toEqual(NINE_TO_FIVE);
  });

  it("is Live on AUTO when any one member is in hours, Away when none are", () => {
    const monday10Utc = new Date("2026-11-23T10:00:00Z");
    const amsterdam = { timeZone: "Europe/Amsterdam", hours: NINE_TO_FIVE }; // 11:00, in
    const losAngeles = { timeZone: "America/Los_Angeles", hours: NINE_TO_FIVE }; // 02:00, out
    const unset = { timeZone: null, hours: null };
    expect(effectiveAvailability("AUTO", [losAngeles, unset], monday10Utc)).toBe("AWAY");
    expect(effectiveAvailability("AUTO", [losAngeles, amsterdam], monday10Utc)).toBe("LIVE");
    expect(effectiveAvailability("AUTO", [], monday10Utc)).toBe("AWAY");
    // Manual modes ignore the schedules.
    expect(effectiveAvailability("LIVE", [losAngeles], monday10Utc)).toBe("LIVE");
    expect(effectiveAvailability("AWAY", [amsterdam], monday10Utc)).toBe("AWAY");
  });

  it("parses times and summarises a week", () => {
    expect(parseTime("09:30")).toBe(570);
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("9:30")).toBeNull();
    expect(summarizeWeeklyHours(NINE_TO_FIVE)).toBe("Mon–Fri 09:00–17:00");
    const mixed: WeeklyHours = [
      { start: 540, end: 1020 },
      { start: 540, end: 1020 },
      null,
      { start: 540, end: 1020 },
      null,
      { start: 600, end: 840 },
      null,
    ];
    expect(summarizeWeeklyHours(mixed)).toBe("Mon–Tue 09:00–17:00, Thu 09:00–17:00, Sat 10:00–14:00");
    expect(summarizeWeeklyHours([null, null, null, null, null, null, null])).toBe("No days");
  });
});
