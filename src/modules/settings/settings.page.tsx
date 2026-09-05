import { Suspense, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import type { Priority, SourceOption } from "@shared/schema/settings";
import { useAuth } from "@/app/auth";
import { ApiError } from "@/shared/lib/api";
import { Button, IconButton } from "@/shared/ui/button";
import { firmZoneAbbr } from "@/shared/lib/tz";
import { FormField, Input, Select } from "@/shared/ui/field";
import { Tabs } from "@/shared/ui/tabs";
import {
  useCreateSource,
  useSettings,
  useSwapPriorities,
  useUpdateFirm,
  useUpdatePriority,
  useDeleteSource,
  useUpdateSource,
  useUploadLogo,
} from "./settings.api";
import { NotificationPolicySection } from "@/modules/notifications";

/**
 * Grouped by WHAT IS BEING CONFIGURED, not by which module owns the code.
 *
 * Six sections stacked in one column read as a pile — and the pile only got worse when the
 * sixteen notification triggers joined it (user, 2026-09-05). The grouping is deliberately
 * boring: the firm's own identity, the option lists every form offers, invoice numbering, and
 * notifications. Anyone looking for a setting can guess which of the four it is in.
 */
const TABS = [
  { value: "firm" as const, label: "Firm" },
  { value: "lists" as const, label: "Lists" },
  { value: "invoices" as const, label: "Invoices" },
  { value: "notifications" as const, label: "Notifications" },
];
type Tab = (typeof TABS)[number]["value"];

/**
 * One line each, and one line is the point — the same lesson `mailouts.page.tsx` records.
 *
 * These sit between the tabs and the panel, so a two-line blurb on a single tab would push that
 * tab's content down and no other's, and a screen that moves when you switch tabs reads as a
 * different screen each time.
 */
const BLURB: Record<Tab, string> = {
  firm: "The firm's name, logo and clock — what every screen and every letter is stamped with.",
  lists: "The options the forms offer: task priorities, and where a client or lead came from.",
  invoices: "How invoice numbers are built, and what the next one will look like.",
  notifications: "Which notifications the firm raises at all, and by which channel.",
};

export function SettingsPage() {
  const { user } = useAuth();
  const { data, isLoading, error } = useSettings();
  /**
   * The tab lives in the URL so it can be LINKED. Notifications point people at settings, and a
   * link that lands on the wrong tab is a link that has not arrived. It also survives a refresh,
   * which `useState` would not.
   */
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = TABS.some((t) => t.value === raw) ? (raw as Tab) : "firm";
  const setTab = (next: Tab) =>
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        out.set("tab", next);
        return out;
      },
      // replace, not push: eight tab clicks must not put eight entries between here and the
      // screen somebody actually came from
      { replace: true },
    );

  if (user?.role !== "admin") {
    return <p className="text-[13px] text-muted">Only admins can change settings.</p>;
  }
  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (error || !data)
    return <p className="text-[13px] text-danger-text">Failed to load settings.</p>;

  return (
    <div className="mx-auto max-w-[960px]">
      <div className="mb-3.5 flex min-h-9 flex-wrap items-center gap-3.5">
        <h1 className="text-[20px] font-semibold">Settings</h1>
        <span className="text-[13px] text-muted-400">{BLURB[tab]}</span>
      </div>

      <Tabs className="mb-4" value={tab} onChange={setTab} options={TABS} />

      {/* the forms stay in a narrow column — a name field the width of the screen is not a
          better name field. Notifications is the exception and takes the full width. */}
      {tab === "firm" && (
        <div className="max-w-2xl space-y-6">
          <FirmSection name={data.firm.name} hasLogo={!!data.firm.logoFileId} />
          <TimezoneSection timezone={data.firm.timezone} />
        </div>
      )}
      {tab === "lists" && (
        <div className="max-w-2xl space-y-6">
          <PrioritiesSection priorities={data.priorities} />
          <SourcesSection sources={data.sources} />
        </div>
      )}
      {tab === "invoices" && (
        <div className="max-w-2xl space-y-6">
          <NumberingSection
            prefix={data.firm.invoicePrefix}
            digits={data.firm.invoiceCounterDigits}
          />
        </div>
      )}
      {/*
        The global notification contour (S9). Still this screen and still the same admin gate —
        what changed is that it is no longer stacked under five unrelated forms. Lazy through the
        barrel, because that barrel is also the app shell's route to the bell.
      */}
      {tab === "notifications" && (
        // the tab is already called Notifications; a heading repeating it inside the panel is
        // the same word twice on one screen
        <div className="rounded-(--radius-panel) border border-border bg-surface p-5 shadow-(--shadow-card)">
          <Suspense fallback={<p className="text-[13px] text-muted">Loading…</p>}>
            <NotificationPolicySection />
          </Suspense>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-(--radius-panel) border border-border bg-surface p-5 shadow-(--shadow-card)">
      <h2 className="mb-4 text-[15px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

// ── Priorities: fixed 4, editable name/color/order/default ───────────────────

function PrioritiesSection({ priorities }: { priorities: Priority[] }) {
  const update = useUpdatePriority();
  const swap = useSwapPriorities(); // one transactional request — no half-applied reorder
  const busy = update.isPending || swap.isPending;

  const serverError =
    update.error instanceof ApiError
      ? update.error.message
      : swap.error instanceof ApiError
        ? swap.error.message
        : null;

  return (
    <Section title="Task priorities">
      <div className="space-y-2">
        {priorities.map((priority, index) => (
          <div key={priority.id} className="flex items-center gap-2.5">
            <input
              type="color"
              defaultValue={priority.color}
              disabled={busy}
              className="h-8 w-10 cursor-pointer rounded-(--radius-btn-sm) border border-border"
              onBlur={(e) => {
                if (e.target.value !== priority.color) {
                  update.mutate({ id: priority.id, input: { color: e.target.value } });
                }
              }}
            />
            <Input
              className="w-44"
              defaultValue={priority.name}
              disabled={busy}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name && name !== priority.name) {
                  update.mutate({ id: priority.id, input: { name } });
                }
              }}
            />
            <label className="flex items-center gap-1.5 text-[12px] text-muted">
              <input
                type="radio"
                name="default-priority"
                checked={priority.isDefault}
                disabled={busy}
                onChange={() => update.mutate({ id: priority.id, input: { isDefault: true } })}
              />
              default
            </label>
            <span className="ml-auto inline-flex gap-1">
              <button
                type="button"
                disabled={index === 0 || busy}
                className="rounded p-1 text-muted hover:bg-divider disabled:opacity-30"
                onClick={() => swap.mutate({ aId: priority.id, bId: priorities[index - 1].id })}
                aria-label="Move up"
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                disabled={index === priorities.length - 1 || busy}
                className="rounded p-1 text-muted hover:bg-divider disabled:opacity-30"
                onClick={() => swap.mutate({ aId: priority.id, bId: priorities[index + 1].id })}
                aria-label="Move down"
              >
                <ArrowDown size={14} />
              </button>
            </span>
          </div>
        ))}
      </div>
      {serverError && <p className="mt-2 text-[12px] text-danger-text">{serverError}</p>}
      <p className="mt-3 text-[12px] text-muted">
        Four fixed levels — rename, recolor, reorder, or move the default. Overdue is a red
        highlight, not a priority.
      </p>
    </Section>
  );
}

// ── Sources: add + rename + activate/deactivate (never deleted) ──────────────

function SourcesSection({ sources }: { sources: SourceOption[] }) {
  const create = useCreateSource();
  const update = useUpdateSource();
  const remove = useDeleteSource();
  const [newName, setNewName] = useState("");

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await create.mutateAsync({ name });
      setNewName("");
    } catch {
      /* surfaced via create.error below */
    }
  };

  const createError = create.error instanceof ApiError ? create.error.message : null;
  const updateError = update.error instanceof ApiError ? update.error.message : null;

  return (
    <Section title="Source of origin">
      <div className="space-y-2">
        {sources.map((source) => (
          <div key={source.id} className="flex items-center gap-2.5">
            <Input
              className={`w-56 ${source.active ? "" : "opacity-50"}`}
              defaultValue={source.name}
              disabled={update.isPending}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (name && name !== source.name) {
                  update.mutate({ id: source.id, input: { name } });
                }
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={update.isPending}
              onClick={() =>
                update.mutate({ id: source.id, input: { active: !source.active } })
              }
            >
              {source.active ? "Deactivate" : "Activate"}
            </Button>
            {/* Offered on every source and refused by the server when it is recorded somewhere —
                the same shape the service catalog uses, and for the same reason: whether a delete
                is possible can change between drawing the button and pressing it. */}
            <IconButton
              label={`Delete ${source.name}`}
              disabled={remove.isPending}
              className="hover:text-danger"
              onClick={() => {
                if (
                  !window.confirm(
                    `Delete “${source.name}”? Possible only while no client or lead records it.`,
                  )
                )
                  return;
                remove
                  .mutateAsync(source.id)
                  .catch((e) => window.alert(e instanceof Error ? e.message : "Delete failed"));
              }}
            >
              <Trash2 size={15} />
            </IconButton>
            {!source.active && <span className="text-[12px] text-muted">inactive</span>}
          </div>
        ))}
      </div>
      {updateError && <p className="mt-1 text-[12px] text-danger-text">{updateError}</p>}
      <div className="mt-3 flex items-center gap-2">
        <Input
          className="w-56"
          placeholder="New source name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={create.isPending}
          onClick={() => void add()}
        >
          Add
        </Button>
      </div>
      {createError && <p className="mt-1 text-[12px] text-danger-text">{createError}</p>}
      <p className="mt-3 text-[12px] text-muted">
        Used by Clients and Leads. Deactivating hides a source from the forms and keeps it on
        existing records; deleting is possible only while nothing records it at all, the archive
        included.
      </p>
    </Section>
  );
}

// ── Invoice numbering: PREFIX-YEAR-NNNN, yearly counter ──────────────────────

function NumberingSection({ prefix, digits }: { prefix: string; digits: number }) {
  const update = useUpdateFirm();
  const [localPrefix, setLocalPrefix] = useState(prefix);
  const [localDigits, setLocalDigits] = useState(digits);

  const preview = `${localPrefix}-${new Date().getFullYear()}-${"1".padStart(localDigits, "0")}`;
  const dirty = localPrefix !== prefix || localDigits !== digits;
  const serverError = update.error instanceof ApiError ? update.error.message : null;

  return (
    <Section title="Invoice numbering">
      <div className="flex items-end gap-3">
        <FormField label="Prefix" htmlFor="inv-prefix">
          <Input
            id="inv-prefix"
            className="w-28"
            value={localPrefix}
            placeholder="INV"
            maxLength={10}
            onChange={(e) =>
              setLocalPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
            }
          />
        </FormField>
        <FormField label="Counter digits" htmlFor="inv-digits">
          <Select
            id="inv-digits"
            className="w-24"
            value={localDigits}
            onChange={(e) => setLocalDigits(Number(e.target.value))}
          >
            {[3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </FormField>
        <Button
          disabled={!dirty || !localPrefix || update.isPending}
          onClick={() =>
            update.mutate({ invoicePrefix: localPrefix, invoiceCounterDigits: localDigits })
          }
        >
          Save
        </Button>
      </div>
      {serverError && <p className="mt-1 text-[12px] text-danger-text">{serverError}</p>}
      <p className="mt-3 text-[12px] text-muted">
        Preview: <span className="font-medium text-ink">{preview}</span> — the counter resets
        every year.
      </p>
    </Section>
  );
}

// ── Timezone: shown, not edited ──────────────────────────────────────────────

/**
 * The firm's clock, displayed rather than editable.
 *
 * It comes from `TZ` in the environment because the SCHEDULER reads the same value when it boots —
 * the nightly sweeps decide what "today" means before any request arrives, so a value stored in
 * the database would have to be fetched by every one of the twelve places that ask, including
 * background jobs. One source, set at deploy, is both simpler and impossible to get out of step.
 *
 * The panel states the fact and nothing else; the reasoning belongs in docs/modules/settings.md
 * rather than on a screen someone opens to check a value (user, 2026-08-06).
 */
function TimezoneSection({ timezone }: { timezone: string }) {
  const now = new Date();
  return (
    <Section title="Timezone">
      <div className="text-[13px]">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-medium text-ink-700">{timezone}</span>
          <span className="text-muted">
            {now.toLocaleString("en-GB", {
              timeZone: timezone,
              weekday: "long",
              day: "2-digit",
              month: "long",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="rounded-(--radius-chip) bg-divider px-2 py-0.5 text-[11px] text-muted">
            {firmZoneAbbr(now)}
          </span>
        </div>
      </div>
    </Section>
  );
}

// ── Firm profile: name + logo (shown in the sidebar) ─────────────────────────

function FirmSection({ name, hasLogo }: { name: string; hasLogo: boolean }) {
  const update = useUpdateFirm();
  const uploadLogo = useUploadLogo();
  const fileRef = useRef<HTMLInputElement>(null);
  const [version, setVersion] = useState(0);

  const logoError = uploadLogo.error instanceof ApiError ? uploadLogo.error.message : null;
  const nameError = update.error instanceof ApiError ? update.error.message : null;

  return (
    <Section title="Firm profile">
      <div className="flex items-end gap-3">
        <FormField label="Firm name" htmlFor="firm-name">
          <Input
            id="firm-name"
            className="w-64"
            defaultValue={name}
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value && value !== name) update.mutate({ name: value });
            }}
          />
        </FormField>
      </div>
      {nameError && <p className="mt-1 text-[12px] text-danger-text">{nameError}</p>}
      <div className="mt-4 flex items-center gap-4">
        {hasLogo ? (
          <img
            src={`/api/settings/firm/logo?v=${version}`}
            alt="Firm logo"
            className="h-12 max-w-40 rounded-(--radius-btn-sm) object-contain"
          />
        ) : (
          <span className="text-[12px] text-muted">No logo yet</span>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            try {
              await uploadLogo.mutateAsync(file);
              setVersion((v) => v + 1);
            } catch {
              /* surfaced via logoError below */
            }
          }}
        />
        <Button
          variant="secondary"
          disabled={uploadLogo.isPending}
          onClick={() => fileRef.current?.click()}
        >
          {uploadLogo.isPending ? "Uploading…" : hasLogo ? "Replace logo" : "Upload logo"}
        </Button>
      </div>
      {logoError && <p className="mt-1 text-[12px] text-danger-text">{logoError}</p>}
      <p className="mt-3 text-[12px] text-muted">The logo is shown in the sidebar.</p>
    </Section>
  );
}
