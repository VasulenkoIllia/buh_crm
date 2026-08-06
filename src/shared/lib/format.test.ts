import { beforeAll, describe, expect, it } from "vitest";
import { fmtBizDate, fmtBizDay, fmtDate, fmtDateTime, fmtTime, todayIso, todayPlus } from "./format";
import { firmToday, setFirmTimezone } from "./tz";

/**
 * Two kinds of time value: one moves with the firm's clock and the other must not. Getting that
 * backwards shifts a day — it did, on 2026-07-27, when a task saved with deadline 28.07 showed
 * 27.07 on the board for anyone west of UTC.
 *
 * Every fixture here deliberately sits where the firm's zone and UTC disagree about the date. A
 * case written at midday UTC passes under every zone on earth and therefore proves nothing — which
 * is exactly what the last assertion in the previous version of this file quietly became the
 * moment the firm moved west of UTC (2026-08-06).
 */
beforeAll(() => setFirmTimezone("America/New_York"));

describe("business dates never move — they are calendar days", () => {
  const deadline = "2026-07-28T00:00:00.000Z"; // what the API returns for the day 28.07.2026

  it("prints the stored calendar day whatever the firm's zone", () => {
    // in New York this instant is 20:00 on the 27th; the business formatter must ignore that
    expect(fmtBizDate(deadline)).toBe("28/07/2026");
    expect(fmtBizDay(deadline)).toBe("28/07");
  });

  it("agrees with the string the date input round-trips", () => {
    // the edit modal shows `deadline.slice(0, 10)`; the card must not disagree with it
    const [y, m, d] = deadline.slice(0, 10).split("-");
    expect(fmtBizDate(deadline)).toBe(`${d}/${m}/${y}`);
  });

  it("holds on both sides of a year boundary", () => {
    expect(fmtBizDate("2027-01-01T00:00:00.000Z")).toBe("01/01/2027");
    expect(fmtBizDate("2026-12-31T00:00:00.000Z")).toBe("31/12/2026");
  });

  it("stays put even when the firm's zone changes", () => {
    setFirmTimezone("Europe/Kyiv");
    expect(fmtBizDate(deadline)).toBe("28/07/2026");
    setFirmTimezone("America/New_York");
    expect(fmtBizDate(deadline)).toBe("28/07/2026");
  });
});

describe("instants are drawn on the FIRM's clock", () => {
  // 02:00 UTC on the 28th is 22:00 on the 27th in New York — the two disagree about the day,
  // which is the only kind of fixture that can tell the two formatters apart
  const lateEvening = "2026-07-28T02:00:00.000Z";

  it("shows the firm's day, not UTC's and not the viewer's", () => {
    expect(fmtDate(lateEvening)).toBe("27/07/2026");
    expect(fmtDateTime(lateEvening)).toBe("27/07/2026, 22:00");
    expect(fmtTime(lateEvening)).toBe("22:00");
  });

  it("follows the firm to another zone", () => {
    setFirmTimezone("Europe/Kyiv"); // +03:00 → the same instant is 05:00 on the 28th
    expect(fmtDate(lateEvening)).toBe("28/07/2026");
    expect(fmtTime(lateEvening)).toBe("05:00");
    setFirmTimezone("America/New_York");
  });

  it("does the opposite of the business formatter on the same value — deliberately", () => {
    const midnightUtc = "2026-07-28T00:00:00.000Z";
    expect(fmtBizDate(midnightUtc)).toBe("28/07/2026"); // the calendar day it stands for
    expect(fmtDate(midnightUtc)).toBe("27/07/2026"); // the instant, on the firm's clock
  });
});

describe("today, as the firm reckons it", () => {
  it("todayIso is the firm's day", () => {
    expect(todayIso()).toBe(firmToday());
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("todayPlus counts calendar days from it", () => {
    const [y, m, d] = todayIso().split("-").map(Number);
    const pad = (v: number) => String(v).padStart(2, "0");
    const expected = (n: number) => {
      const shifted = new Date(y, m - 1, d + n);
      return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`;
    };
    expect(todayPlus(0)).toBe(todayIso());
    expect(todayPlus(1)).toBe(expected(1));
    expect(todayPlus(7)).toBe(expected(7));
    expect(todayPlus(-1)).toBe(expected(-1));
  });

  it("crosses a month end without slipping", () => {
    // the deadline presets are the only place this arithmetic is user-visible
    const [y, m, d] = todayIso().split("-").map(Number);
    const daysLeftInMonth = new Date(y, m, 0).getDate() - d;
    expect(todayPlus(daysLeftInMonth + 1)).toMatch(/^\d{4}-\d{2}-01$/);
  });
});
