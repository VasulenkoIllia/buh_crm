import { useState } from "react";
import {
  Bell,
  ChevronDown,
  ChevronRight,
  Mail,
  SlidersHorizontal,
  Volume2,
} from "lucide-react";
import {
  NOTIFICATION_GROUPS,
  NOTIFICATION_TRIGGERS,
  type NotificationChannel,
  type NotificationGroup,
  type NotificationTriggerKey,
} from "@shared/notifications";
import type { PreferenceChange } from "@shared/schema/notification";
import { cn } from "@/shared/lib/cn";
import { InfoHint } from "@/shared/ui/info-hint";
import { playChime } from "./chime";
import {
  useMyNotificationPreferences,
  useSetNotificationPreferences,
  type PreferenceRow,
} from "./notifications.api";

/**
 * The PERSONAL contour, rendered from the REGISTRY rather than from a list of its own.
 *
 * That is the point of `shared/notifications.ts` being the source: a trigger cannot exist on this
 * screen and not in the code, or fire without appearing here. The server sends only what is
 * configurable per trigger — what is allowed, what the default is, what this person chose — and
 * the words come from the constant.
 *
 * Every switch is THREE-state: follow default / on / off. "Follow default" writes no row, which is
 * what lets the firm change a default later and have it reach everyone who never made a choice
 * (§4.3). A two-state switch would have to store something for everybody on the day their account
 * was made, freezing each of them at that day's defaults forever.
 */

const GROUP_ORDER = (Object.keys(NOTIFICATION_GROUPS) as NotificationGroup[]).sort(
  (a, b) => NOTIFICATION_GROUPS[a].order - NOTIFICATION_GROUPS[b].order,
);

export function NotificationPreferences() {
  const { data, isLoading, error } = useMyNotificationPreferences();
  const save = useSetNotificationPreferences();
  const [openGroups, setOpenGroups] = useState<Set<NotificationGroup>>(new Set());

  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (error || !data) {
    return <p className="text-[13px] text-danger-text">Could not load your notifications.</p>;
  }

  const byTrigger = new Map(data.triggers.map((t) => [t.trigger, t]));
  const rowsIn = (group: NotificationGroup) =>
    (Object.keys(NOTIFICATION_TRIGGERS) as NotificationTriggerKey[])
      .filter((key) => NOTIFICATION_TRIGGERS[key].group === group)
      .map((key) => byTrigger.get(key))
      .filter((r): r is PreferenceRow => !!r);

  const apply = (changes: PreferenceChange[]) => {
    if (changes.length > 0) void save.mutateAsync({ changes }).catch(() => {});
  };

  return (
    <div className="space-y-1.5">
      <p className="mb-3 text-[12.5px] text-muted">
        The firm decides which of these exist and who they go to. Here you choose which of them
        reach you, and whether by email as well as the bell.
      </p>

      {/*
        One compact row of legends, each with its explanation behind an (i) rather than in front
        of it (user, 2026-09-06). Two paragraphs of grey prose above sixteen collapsed groups made
        the screen read as documentation with controls at the bottom.
        Both hints are the kind `InfoHint`'s own note allows: reference, plus a rule the CONTROL
        already enforces — "Default" is a state of the switch you are looking at, and a chime is
        greyed out wherever the bell is off. The icon sits exactly where the reader meets the
        control it explains, which is the mitigation for hiding it at all.
      */}
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px] text-faint">
        <span className="flex items-center gap-1.5">
          <SlidersHorizontal size={12} aria-hidden />
          <b className="font-semibold text-muted">Default</b>
          <InfoHint label="What Default means">
            Follows the firm&rsquo;s setting — if they change it later, yours changes with it.
            <b className="font-semibold"> On</b> and <b className="font-semibold">Off</b> are
            your own choice and stay put whatever the firm does.
          </InfoHint>
        </span>
        <span className="flex items-center gap-1.5">
          <Volume2 size={12} aria-hidden />
          <b className="font-semibold text-muted">Sound</b>
          <InfoHint label="What the sound is">
            A short chime when something arrives, so you notice it without watching the bell. It
            plays only while you have the CRM open.
          </InfoHint>
          {/* Nobody can choose a sound setting without having heard the sound — and the click is
              also what lets the browser start an AudioContext at all. */}
          <button
            type="button"
            className="font-semibold text-primary-link hover:underline"
            onClick={() => playChime()}
          >
            Play it
          </button>
        </span>
      </div>

      {GROUP_ORDER.map((group) => {
        const rows = rowsIn(group);
        if (rows.length === 0) return null;
        const open = openGroups.has(group);
        // "on" for the group means at least one of its triggers still reaches you somehow —
        // an off group is one you have silenced entirely.
        const anyOn = rows.some((r) => effective(r, "in_app") || effective(r, "email"));

        return (
          <div key={group} className="rounded-(--radius-card) border border-border">
            <div className="flex items-center gap-2 px-3 py-2.5">
              <button
                type="button"
                className="flex flex-1 items-center gap-1.5 text-left"
                onClick={() =>
                  setOpenGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(group)) next.delete(group);
                    else next.add(group);
                    return next;
                  })
                }
                aria-expanded={open}
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="text-[13px] font-semibold">
                  {NOTIFICATION_GROUPS[group].label}
                </span>
                <span className="text-[11.5px] text-faint">
                  {rows.filter((r) => effective(r, "in_app") || effective(r, "email")).length}{" "}
                  of {rows.length} on
                </span>
              </button>
              {/*
                The master toggle. Off writes an explicit `false` for every channel of every
                trigger here; on CLEARS them all, which puts the group back on the firm's
                defaults rather than on whatever this person last picked. "Back to normal" is
                what people mean by turning a muted group on again.
              */}
              <button
                type="button"
                className="text-[11.5px] text-primary-link hover:underline disabled:opacity-50"
                disabled={save.isPending}
                onClick={() =>
                  apply(
                    rows.flatMap((r) =>
                      r.mandatory
                        ? []
                        : (["in_app", "email", "sound"] as NotificationChannel[]).map(
                            (channel) => ({
                              trigger: r.trigger,
                              channel,
                              enabled: anyOn ? false : null,
                            }),
                          ),
                    ) as PreferenceChange[],
                  )
                }
              >
                {anyOn ? "Mute all" : "Use defaults"}
              </button>
            </div>

            {open && (
              <div className="border-t border-divider">
                {rows.map((row) => (
                  <TriggerRow
                    key={row.trigger}
                    row={row}
                    busy={save.isPending}
                    onChange={(channel, enabled) =>
                      apply([{ trigger: row.trigger, channel, enabled }] as PreferenceChange[])
                    }
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** What this person actually gets today, once the default has been folded in. */
function effective(row: PreferenceRow, channel: NotificationChannel): boolean {
  if (!row.enabled) return false; // the firm switched the trigger off for everybody
  const inApp = row.allowedInApp && (row.mandatory || (row.inApp ?? row.defaultInApp));
  if (channel === "in_app") return inApp;
  if (channel === "email") {
    if (!row.allowedEmail) return false;
    return row.mandatory || (row.email ?? row.defaultEmail);
  }
  // a chime rides on the bell — mirrors `decide()` in server/core/notify.ts, and the two must
  // not be allowed to disagree about it
  if (!row.allowedSound) return false;
  return inApp && (row.mandatory || (row.sound ?? row.defaultSound));
}

function TriggerRow({
  row,
  busy,
  onChange,
}: {
  row: PreferenceRow;
  busy: boolean;
  onChange: (channel: NotificationChannel, enabled: boolean | null) => void;
}) {
  const spec = NOTIFICATION_TRIGGERS[row.trigger as NotificationTriggerKey];
  if (!spec) return null;

  return (
    <div className="flex flex-wrap items-start gap-3 border-b border-divider px-3 py-2.5 last:border-b-0">
      <div className="min-w-[220px] flex-1">
        <p className="text-[12.5px] font-medium text-ink">{spec.when}</p>
        <p className="mt-[2px] text-[11px] text-faint">{spec.why}</p>
        {!row.enabled && (
          <p className="mt-1 text-[11px] text-muted">Switched off for the whole firm.</p>
        )}
        {row.mandatory && (
          <p className="mt-1 text-[11px] text-muted">Always on — the firm requires this one.</p>
        )}
      </div>
      {/* wraps under the description when the panel is narrow: three switches beside a
          sentence squeezed it to one word per line at 800px (seen in testing) */}
      <div className="flex shrink-0 flex-wrap justify-end gap-x-3 gap-y-2">
        <ChannelSwitch
          icon={Bell}
          label="Bell"
          value={row.inApp}
          fallback={row.defaultInApp}
          disabled={busy || row.mandatory || !row.enabled || !row.allowedInApp}
          onChange={(v) => onChange("in_app", v)}
        />
        <ChannelSwitch
          icon={Mail}
          label="Email"
          value={row.email}
          fallback={row.defaultEmail}
          disabled={busy || row.mandatory || !row.enabled || !row.allowedEmail}
          onChange={(v) => onChange("email", v)}
        />
        {/* the chime can only be on where the bell is — the same rule the server applies, said
            here by disabling the control rather than by letting somebody set a sound they would
            never hear */}
        <ChannelSwitch
          icon={Volume2}
          label="Sound"
          value={row.sound}
          fallback={row.defaultSound}
          disabled={
            busy ||
            row.mandatory ||
            !row.enabled ||
            !row.allowedSound ||
            !effective(row, "in_app")
          }
          onChange={(v) => onChange("sound", v)}
        />
      </div>
    </div>
  );
}

/**
 * Three states, shown as three: Default · On · Off.
 *
 * A two-state switch cannot express "whatever the firm decides", and that is the state most
 * people should be in — the only one that keeps up when the firm changes a default. On and Off
 * are a permanent opt-out of that: they store a row, and a later change to the firm's default
 * will not reach anybody who has one.
 *
 * The Default button says what it currently RESOLVES TO — "Default · on" — because a control
 * whose selected state cannot be read is a control nobody trusts. That lived in a `title`
 * tooltip until somebody asked what Default meant (user, 2026-09-05), which is the question a
 * tooltip always fails to answer.
 */
function ChannelSwitch({
  icon: Icon,
  label,
  value,
  fallback,
  disabled,
  onChange,
}: {
  icon: typeof Bell;
  label: string;
  value: boolean | null;
  fallback: boolean;
  disabled: boolean;
  onChange: (v: boolean | null) => void;
}) {
  const options: Array<{ v: boolean | null; label: string; title: string }> = [
    {
      v: null,
      label: `Default \u00b7 ${fallback ? "on" : "off"}`,
      title: `Follow the firm's setting, which is ${fallback ? "on" : "off"} today. If the firm changes it, yours changes with it.`,
    },
    { v: true, label: "On", title: "Always send this, whatever the firm's default becomes." },
    { v: false, label: "Off", title: "Never send this, whatever the firm's default becomes." },
  ];
  return (
    <div className={cn("text-center", disabled && "opacity-50")}>
      <div className="mb-1 flex items-center justify-center gap-1 text-[10.5px] text-faint">
        <Icon size={11} aria-hidden />
        {label}
      </div>
      <div className="inline-flex overflow-hidden rounded-(--radius-btn-sm) border border-border">
        {options.map((o) => (
          <button
            key={String(o.v)}
            type="button"
            disabled={disabled}
            title={o.title}
            className={cn(
              "px-2 py-[3px] text-[10.5px] font-medium whitespace-nowrap",
              value === o.v
                ? "bg-primary text-white"
                : "bg-surface text-muted hover:bg-divider",
            )}
            onClick={() => onChange(o.v)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
