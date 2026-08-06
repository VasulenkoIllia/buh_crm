import { useEffect, useState } from "react";
import { useSettings } from "@/modules/settings";
import { firmZoneAbbr, setFirmTimezone } from "@/shared/lib/tz";

/**
 * The firm's date and time, in the header.
 *
 * Two jobs, and the second is the important one. It SHOWS the clock the whole product runs on —
 * every deadline, every sweep, every meeting — so nobody has to guess whose morning "09:00" means.
 * And it is where the firm's timezone, which arrives with the settings, is installed for the
 * formatters to use; a machine set to another zone changes nothing about what this reads.
 *
 * The zone comes from `TZ` in the environment, the same value the scheduler boots with, so the
 * header and the nightly jobs can never disagree.
 *
 * It lives in `app/` rather than `shared/ui/` because it reads a MODULE's data (settings), and
 * shared is depended upon, never depends — the app shell is the layer allowed to reach into
 * modules.
 */
export function FirmClock() {
  const { data: settings } = useSettings();
  const [now, setNow] = useState(() => new Date());
  const [, force] = useState(0);

  const tz = settings?.firm.timezone;
  useEffect(() => {
    // installing it may change how every already-rendered time reads, so nudge a repaint
    if (tz && setFirmTimezone(tz)) force((n) => n + 1);
  }, [tz]);

  useEffect(() => {
    // tick on the minute boundary rather than every 60s from mount, so the display never sits a
    // beat behind the real minute
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const ms = 60_000 - (Date.now() % 60_000);
      timer = setTimeout(() => {
        setNow(new Date());
        schedule();
      }, ms + 50);
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  if (!tz) return null;

  const date = now.toLocaleDateString("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
  const time = now.toLocaleTimeString("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      className="hidden items-baseline gap-2 text-[13px] text-muted sm:flex"
      title={`The firm's clock — ${tz}. Every deadline, sweep and meeting is reckoned on it.`}
    >
      <span>{date}</span>
      <span className="font-semibold tabular-nums text-ink-700">{time}</span>
      <span className="text-[11px] text-muted-400">{firmZoneAbbr(now)}</span>
    </div>
  );
}
