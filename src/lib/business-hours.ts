import { z } from "zod";

/**
 * Per-member business hours and the automatic Live/Away they drive.
 *
 * Each member may set a weekly schedule in their own time zone. When the
 * Workspace availability is AUTO, the widget of every Product shows Live
 * while at least one member is inside their hours and Away otherwise; a
 * member without hours never counts. Manual LIVE/AWAY ignore the schedules.
 *
 * Pure helpers only (no Prisma), so the widget path, the dashboard and the
 * settings form share one definition of "in hours".
 */

export type DayHours = { start: number; end: number } | null;
/** Seven entries, Monday first. */
export type WeeklyHours = DayHours[];

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MINUTES_PER_DAY = 24 * 60;

const minute = z.number().int().min(0).max(MINUTES_PER_DAY - 1);
const dayHours = z.object({ start: minute, end: minute }).nullable();
const weeklyHours = z.array(dayHours).length(7);

/** True for a time zone this runtime's Intl knows (IANA name). */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Parses a stored schedule; anything malformed counts as "not set". */
export function parseWeeklyHours(value: unknown): WeeklyHours | null {
  const parsed = weeklyHours.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** "09:30" → 570; null for anything else. */
export function parseTime(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** 570 → "09:30". */
export function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Weekday (0 = Monday) and minute of the day at `now` in `timeZone`. */
export function localDayAndMinute(now: Date, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = SHORT_DAYS.indexOf(get("weekday") as (typeof SHORT_DAYS)[number]);
  // Some runtimes still print midnight as "24" despite h23.
  const hour = Number(get("hour")) % 24;
  return { day: day < 0 ? 0 : day, minute: hour * 60 + Number(get("minute")) };
}

/**
 * Whether `now` falls inside the schedule. A day's interval is
 * [start, end). Equal start and end means the whole day. When end < start
 * the interval runs past midnight, so the remainder belongs to the next
 * calendar day (a Friday 22:00–02:00 shift covers Saturday 01:00).
 */
export function isWithinBusinessHours(hours: WeeklyHours, timeZone: string, now: Date): boolean {
  if (!isValidTimeZone(timeZone)) return false;
  const { day, minute: m } = localDayAndMinute(now, timeZone);
  const today = hours[day];
  if (today) {
    if (today.start === today.end) return true;
    if (today.end > today.start ? m >= today.start && m < today.end : m >= today.start) return true;
  }
  const yesterday = hours[(day + 6) % 7];
  return Boolean(yesterday && yesterday.end < yesterday.start && m < yesterday.end);
}

export type MemberHours = { timeZone: string | null; hours: unknown };

/** True when at least one member with hours set is inside them at `now`. */
export function anyMemberInBusinessHours(members: MemberHours[], now: Date): boolean {
  return members.some((member) => {
    const hours = parseWeeklyHours(member.hours);
    return Boolean(hours && member.timeZone && isWithinBusinessHours(hours, member.timeZone, now));
  });
}

export type AvailabilityMode = "LIVE" | "AWAY" | "AUTO";
export type EffectiveAvailability = "LIVE" | "AWAY";

/** What the widget shows for a Workspace availability mode at `now`. */
export function effectiveAvailability(
  mode: AvailabilityMode,
  members: MemberHours[],
  now: Date,
): EffectiveAvailability {
  if (mode !== "AUTO") return mode;
  return anyMemberInBusinessHours(members, now) ? "LIVE" : "AWAY";
}

/** "Mon–Fri 09:00–17:00, Sat 10:00–14:00" for the team list. */
export function summarizeWeeklyHours(hours: WeeklyHours): string {
  const groups: Array<{ from: number; to: number; label: string }> = [];
  hours.forEach((day, index) => {
    if (!day) return;
    const label = day.start === day.end ? "all day" : `${formatTime(day.start)}–${formatTime(day.end)}`;
    const last = groups[groups.length - 1];
    if (last && last.label === label && last.to === index - 1) last.to = index;
    else groups.push({ from: index, to: index, label });
  });
  if (groups.length === 0) return "No days";
  return groups
    .map((g) =>
      g.from === g.to
        ? `${SHORT_DAYS[g.from]} ${g.label}`
        : `${SHORT_DAYS[g.from]}–${SHORT_DAYS[g.to]} ${g.label}`,
    )
    .join(", ");
}

/** Monday–Friday 09:00–17:00: the form's starting point. */
export const DEFAULT_WEEKLY_HOURS: WeeklyHours = [
  ...Array.from({ length: 5 }, () => ({ start: 9 * 60, end: 17 * 60 })),
  null,
  null,
];
