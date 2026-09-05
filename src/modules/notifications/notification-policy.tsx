import { useState } from "react";
import { Bell, ChevronDown, ChevronRight, Mail, Volume2 } from "lucide-react";
import {
  NOTIFICATION_GROUPS,
  NOTIFICATION_TRIGGERS,
  type NotificationGroup,
  type NotificationTriggerKey,
} from "@shared/notifications";
import { cn } from "@/shared/lib/cn";
import { ApiError } from "@/shared/lib/api";
import { InfoHint } from "@/shared/ui/info-hint";
import { chimeStatus, playChime, type ChimeResult } from "./chime";
import {
  useNotificationPolicies,
  useUpdateNotificationPolicy,
  type PolicyRow,
} from "./notifications.api";

/**
 * The GLOBAL contour — the half that makes the rollout plan possible.
 *
 * Everything ships enabled, and a trigger that proves noisy is switched off HERE, without a
 * deploy, because a policy row is data. That is the whole reason this screen exists at all, and it
 * is why its scope is deliberately small: the sixteen triggers, enable/disable, and which channels
 * they may use.
 *
 * Recipients, the custom user list and `mandatory` are NOT editable in this package. They stay at
 * their seeded values and are changed in the database if truly needed. The screen grows when there
 * is a reason — the first will be sending `invoice_overdue` to a named bookkeeper rather than to
 * every admin (docs/modules/notifications.md §6.3).
 */

const GROUP_ORDER = (Object.keys(NOTIFICATION_GROUPS) as NotificationGroup[]).sort(
  (a, b) => NOTIFICATION_GROUPS[a].order - NOTIFICATION_GROUPS[b].order,
);

export function NotificationPolicySection() {
  const { data, isLoading, error } = useNotificationPolicies();
  const update = useUpdateNotificationPolicy();
  const [openGroups, setOpenGroups] = useState<Set<NotificationGroup>>(new Set());
  const [chime, setChime] = useState<ChimeResult | null>(null);

  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (error || !data) {
    return (
      <p className="text-[13px] text-danger-text">Could not load notification settings.</p>
    );
  }

  const byTrigger = new Map(data.triggers.map((t) => [t.trigger, t]));
  const on = data.triggers.filter((t) => t.enabled).length;

  return (
    <div className="space-y-1.5">
      <p className="mb-3 text-[12.5px] text-muted">
        {on} of {data.triggers.length} notifications are switched on for the firm. Everyone can
        still turn their own off in their profile — except where a notification is marked as
        required.
      </p>
      <p className="mb-3 flex items-center gap-1.5 text-[12px] text-faint">
        <Volume2 size={12} aria-hidden />
        <b className="font-semibold text-muted">Sound</b>
        <InfoHint label="What the sound is">
          The chime people hear while they have the CRM open. An office is a shared room, so
          switching it off here silences it for everybody, whatever they have chosen.
        </InfoHint>
        <button
          type="button"
          className="font-semibold text-primary-link hover:underline"
          onClick={() => {
            // played synchronously — Safari will not start audio once the gesture is over — then
            // asked a moment later what the browser actually did. A preview button that is silent
            // whether it worked or was refused is a button nobody can debug.
            playChime();
            void chimeStatus().then(setChime);
          }}
        >
          Play it
        </button>
        {chime === "blocked" && (
          <span className="text-muted">
            — your browser blocked the sound. Click anywhere on the page, then try again; if it
            stays silent, check the tab is not muted.
          </span>
        )}
        {chime === "unsupported" && (
          <span className="text-muted">— this browser has no Web Audio.</span>
        )}
      </p>
      {update.error instanceof ApiError && (
        <p className="mb-2 text-[12px] text-danger-text">{update.error.message}</p>
      )}

      {GROUP_ORDER.map((group) => {
        const rows = (Object.keys(NOTIFICATION_TRIGGERS) as NotificationTriggerKey[])
          .filter((key) => NOTIFICATION_TRIGGERS[key].group === group)
          .map((key) => byTrigger.get(key))
          .filter((r): r is PolicyRow => !!r);
        if (rows.length === 0) return null;
        const open = openGroups.has(group);

        return (
          <div key={group} className="rounded-(--radius-card) border border-border">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left"
              aria-expanded={open}
              onClick={() =>
                setOpenGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(group)) next.delete(group);
                  else next.add(group);
                  return next;
                })
              }
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="text-[13px] font-semibold">
                {NOTIFICATION_GROUPS[group].label}
              </span>
              <span className="text-[11.5px] text-faint">
                {rows.filter((r) => r.enabled).length} of {rows.length} on
              </span>
            </button>

            {open && (
              <div className="border-t border-divider">
                {rows.map((row) => (
                  <PolicyLine
                    key={row.trigger}
                    row={row}
                    busy={update.isPending}
                    onChange={(patch) =>
                      void update
                        .mutateAsync({ trigger: row.trigger, ...patch })
                        .catch(() => {})
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

function PolicyLine({
  row,
  busy,
  onChange,
}: {
  row: PolicyRow;
  busy: boolean;
  onChange: (patch: {
    enabled?: boolean;
    inApp?: boolean;
    email?: boolean;
    sound?: boolean;
  }) => void;
}) {
  const spec = NOTIFICATION_TRIGGERS[row.trigger as NotificationTriggerKey];
  if (!spec) return null;

  return (
    <div className="flex items-start gap-3 border-b border-divider px-3 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className={cn("text-[12.5px] font-medium", row.enabled ? "text-ink" : "text-faint")}>
          {spec.when}
        </p>
        <p className="mt-[2px] text-[11px] text-faint">{spec.why}</p>
        <p className="mt-1 text-[11px] text-muted">
          Goes to: {row.roles.join(", ")}
          {row.mandatory && " · required, nobody can turn it off"}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {/*
          The two channel toggles say whether a channel is ALLOWED at all, not whether it is on by
          default — a disallowed channel cannot be turned on by anybody, which is the firm's lever
          on volume. They are dimmed with the trigger, because "email allowed" means nothing while
          the trigger is off.
        */}
        <ChannelAllow
          icon={Bell}
          label="Bell"
          on={row.inApp}
          disabled={busy || !row.enabled}
          onToggle={() => onChange({ inApp: !row.inApp })}
        />
        <ChannelAllow
          icon={Mail}
          label="Email"
          on={row.email}
          disabled={busy || !row.enabled}
          onToggle={() => onChange({ email: !row.email })}
        />
        {/* an office is a shared room: this is the firm's lever on whether anybody's machine may
            make a noise for this trigger at all */}
        <ChannelAllow
          icon={Volume2}
          label="Sound"
          on={row.sound}
          disabled={busy || !row.enabled || !row.inApp}
          onToggle={() => onChange({ sound: !row.sound })}
        />
        <button
          type="button"
          disabled={busy}
          className={cn(
            "rounded-(--radius-btn-sm) border px-2.5 py-[5px] text-[11px] font-semibold disabled:opacity-50",
            row.enabled
              ? "border-[#cdd7f7] bg-[#eef1fb] text-primary-link"
              : "border-border bg-surface text-muted",
          )}
          onClick={() => onChange({ enabled: !row.enabled })}
        >
          {row.enabled ? "On" : "Off"}
        </button>
      </div>
    </div>
  );
}

function ChannelAllow({
  icon: Icon,
  label,
  on,
  disabled,
  onToggle,
}: {
  icon: typeof Bell;
  label: string;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={on ? `${label} allowed` : `${label} not allowed for this notification`}
      className={cn(
        "flex items-center gap-1 rounded-(--radius-btn-sm) border px-2 py-[5px] text-[10.5px] font-medium disabled:opacity-50",
        on
          ? "border-border bg-surface text-ink"
          : "border-border bg-divider text-faint line-through",
      )}
      onClick={onToggle}
    >
      <Icon size={11} aria-hidden />
      {label}
    </button>
  );
}
