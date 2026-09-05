import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GATES, SWITCHABLE_GATES, type AccessState, type GateKey } from "@shared/access";
import { GATE_COPY } from "@shared/access-copy";
import type { AccessTable } from "@shared/schema/access";
import type { UserRole } from "@shared/schema/enums";
import { api } from "@/shared/lib/api";
import { ME_QUERY_KEY } from "@/app/auth";
import { cn } from "@/shared/lib/cn";
import { Chip } from "@/shared/ui/chip";
import { InfoHint } from "@/shared/ui/info-hint";
import { UserAvatar } from "@/shared/ui/avatar";

/**
 * **What each person may open, and what they may change.**
 *
 * Nothing else in the app decides access — the hook in `server/core/access.ts` reads exactly these
 * rows.
 *
 * ## Where the words go, and why the caveats are not simply a tooltip
 *
 * Each gate carries two different kinds of text, and the first version of this screen printed both
 * under every row. That was thirteen paragraphs of grey on a screen whose actual content is
 * twenty-six buttons: the wall made the controls hard to find and, worse, made the sentences that
 * matter invisible by being indistinguishable from the ones that do not (user, 2026-09-07).
 *
 * They are separated now, by what they are:
 *
 * - **The `hint`** — "The board, the table and Done." Pure reference, true whatever anybody
 *   chooses. It goes in the `(i)`, which is exactly what that control is documented for.
 * - **The `caveat`** — "Closing Clients does NOT hide client names." A CONSEQUENCE of a choice,
 *   and `InfoHint`'s own rules say a consequence must not be hidden. The module's §10 is blunter:
 *   the people using this screen must not discover that limit from a colleague.
 *
 The first fix printed the caveat **in place, but only under a gate that had been narrowed**. That
 * was much smaller, and it was still wrong: the rule is invisible from the outside, so a reader
 * meets four rows carrying grey paragraphs and ten that do not, and reads the difference as
 * accidental rather than as meaning (user, 2026-09-07). Consistency is itself information, and an
 * inconsistent screen spends it on nothing.
 *
 * **So every row now has exactly the same shape**: name, one `(i)`, two controls. The `(i)` holds
 * the hint and — where the gate has one — the caveat. What varies is the ONE thing that carries
 * meaning: the `(i)` turns amber the moment that gate is narrowed for somebody, so the rows whose
 * consequence has become real are the rows a reader's eye is taken to. `InfoHint`'s rule about
 * never hiding a consequence is answered by that, and only by that: a permanently quiet `(i)`
 * holding this text would be exactly the failure that rule exists to prevent.
 *
 * ## The per-person half
 *
 * It was a grid of thirteen `<select>`s per person, each about eight characters wide, reading
 * "Foll ⌄ / Fc ⌄ / I ⌄". Unreadable, and wrong in shape: an override is **sparse by design** — an
 * absent row means "follow the role" — so a dense matrix presents rarity as if it were the norm.
 * A person is now one line saying what differs from their role, opening into the same row-per-gate
 * list as the top half with "Follow role" as a fourth choice.
 */

const ACCESS_KEY = ["access"] as const;

const STATE_LABEL: Record<AccessState, string> = {
  open: "Open",
  read_only: "Read only",
  closed: "Closed",
};

/**
 * The app's existing chip tones, meaning what they already mean elsewhere: amber is "look at
 * this", blue is a plain fact, grey is a quieter one. There is no red in `CHIP_TONES`, and an
 * exception is not an error.
 */
const STATE_TONE = { open: "blue", read_only: "gray", closed: "amber" } as const;

/** `null` = no override row at all, which is the whole meaning of "follow the role". */
type Choice = AccessState | null;

function useAccessTable() {
  return useQuery({ queryKey: ACCESS_KEY, queryFn: () => api<AccessTable>("/api/access") });
}

/**
 * Every write answers with the whole table, so the screen never has to guess what changed — and
 * the session query is refetched too, because the person editing may have just changed their OWN
 * sidebar.
 */
function useAccessMutation<T>(fn: (input: T) => Promise<AccessTable>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (table) => {
      queryClient.setQueryData(ACCESS_KEY, table);
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    },
  });
}

export function AccessSection() {
  const { data, isLoading, error } = useAccessTable();
  const [showEveryone, setShowEveryone] = useState(false);
  const [openPerson, setOpenPerson] = useState<string | null>(null);

  const setPolicy = useAccessMutation(
    ({ gate, role, state }: { gate: GateKey; role: UserRole; state: AccessState }) =>
      api<AccessTable>(`/api/access/policies/${gate}/${role}`, { method: "PUT", body: { state } }),
  );
  const setOverride = useAccessMutation(
    ({ userId, gate, state }: { userId: string; gate: GateKey; state: AccessState }) =>
      api<AccessTable>(`/api/access/overrides/${userId}/${gate}`, {
        method: "PUT",
        body: { state },
      }),
  );
  const clearOverride = useAccessMutation(({ userId, gate }: { userId: string; gate: GateKey }) =>
    api<AccessTable>(`/api/access/overrides/${userId}/${gate}`, { method: "DELETE" }),
  );

  const policyOf = useMemo(() => {
    const byKey = new Map(data?.policies.map((p) => [`${p.gate}:${p.role}`, p.state]));
    return (gate: GateKey, role: UserRole): AccessState =>
      byKey.get(`${gate}:${role}`) ?? GATES[gate].defaults[role];
  }, [data]);

  const overrideOf = useMemo(() => {
    const byKey = new Map(data?.overrides.map((o) => [`${o.userId}:${o.gate}`, o.state]));
    return (userId: string, gate: GateKey): Choice => byKey.get(`${userId}:${gate}`) ?? null;
  }, [data]);

  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (error || !data) return <p className="text-[13px] text-danger-text">Failed to load access.</p>;

  /**
   * What this person actually gets: their own override where they have one, their role's answer
   * where they do not. The same resolution the server does in `core/access.ts`, and what the
   * marker on each row is asking about.
   */
  const effective = (person: { id: string; role: UserRole }, gate: GateKey): AccessState =>
    overrideOf(person.id, gate) ?? policyOf(gate, person.role);

  const exceptionsOf = (userId: string) =>
    SWITCHABLE_GATES.map((gate) => ({ gate, state: overrideOf(userId, gate) })).filter(
      (x): x is { gate: GateKey; state: AccessState } => x.state !== null,
    );

  const people = showEveryone
    ? data.people
    : data.people.filter((p) => exceptionsOf(p.id).length > 0);
  const busy = setPolicy.isPending || setOverride.isPending || clearOverride.isPending;

  return (
    <div className="space-y-5">
      <section className="rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)">
        <header className="border-b border-divider px-5 py-4">
          <h2 className="text-[15px] font-semibold">By role</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            What everybody with that role may open. A person can be given a different answer below.
          </p>
        </header>

        <div className="grid grid-cols-[1fr_200px_200px] items-center gap-x-6 border-b border-divider px-5 py-2 text-[11px] font-medium uppercase tracking-[.4px] text-muted-400">
          <span>Area</span>
          <span>Admin</span>
          <span>User</span>
        </div>

        {SWITCHABLE_GATES.map((gate) => {
          const states = { admin: policyOf(gate, "admin"), user: policyOf(gate, "user") };
          const narrowed = (["admin", "user"] as const).filter((r) => states[r] !== "open");
          return (
            <div
              key={gate}
              className="grid grid-cols-[1fr_200px_200px] items-center gap-x-6 border-b border-divider px-5 py-2.5 last:border-0"
            >
              <GateName gate={gate} narrowedFor={narrowed.map((r) => `${STATE_LABEL[states[r]]} for ${r}`)} />
              {(["admin", "user"] as const).map((role) => (
                <StatePicker
                  key={role}
                  gate={gate}
                  value={states[role]}
                  disabled={busy}
                  onChange={(state) => state !== null && setPolicy.mutate({ gate, role, state })}
                />
              ))}
            </div>
          );
        })}

        <div className="grid grid-cols-[1fr_200px_200px] items-center gap-x-6 border-t border-divider bg-[#fafbfc] px-5 py-2.5">
          <GateName gate="team" quiet />
          <span className="text-[13px] text-muted">Open</span>
          <span className="text-[13px] text-muted">Closed — never switchable</span>
        </div>
      </section>

      <section className="rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)">
        <header className="flex flex-wrap items-start gap-3 border-b border-divider px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">By person</h2>
            <p className="mt-0.5 text-[13px] text-muted">
              An exception to the role, in either direction. Most people have none.
            </p>
          </div>
          <button
            type="button"
            className="ml-auto text-[13px] font-medium text-primary-link hover:underline"
            onClick={() => setShowEveryone((v) => !v)}
          >
            {showEveryone ? "Only the exceptions" : `Show everyone (${data.people.length})`}
          </button>
        </header>

        {people.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-muted">
            Nobody differs from their role. Every answer comes from the table above.
          </p>
        ) : (
          people.map((person) => {
            const exceptions = exceptionsOf(person.id);
            const isOpen = openPerson === person.id;
            return (
              <div key={person.id} className="border-b border-divider last:border-0">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-divider/40"
                  onClick={() => setOpenPerson(isOpen ? null : person.id)}
                  aria-expanded={isOpen}
                >
                  <span
                    className={cn(
                      "text-[11px] text-muted transition-transform",
                      isOpen && "rotate-90",
                    )}
                  >
                    ▸
                  </span>
                  <UserAvatar user={person} size="sm" />
                  <span className="text-[13px] font-medium">
                    {person.firstName} {person.lastName}
                  </span>
                  <span className="text-[12px] text-faint">{person.role}</span>
                  <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                    {exceptions.length === 0 ? (
                      <span className="text-[12px] text-faint">Follows their role</span>
                    ) : (
                      exceptions.map(({ gate, state }) => (
                        <Chip key={gate} tone={STATE_TONE[state]} size="sm">
                          {GATE_COPY[gate].label} · {STATE_LABEL[state]}
                        </Chip>
                      ))
                    )}
                  </span>
                </button>

                {isOpen && (
                  <div className="border-t border-divider bg-[#fafbfc] px-5">
                    {SWITCHABLE_GATES.map((gate) => (
                      <div
                        key={gate}
                        className="flex items-center justify-between gap-6 border-b border-divider/60 py-2 last:border-0"
                      >
                        <GateName
                          gate={gate}
                          narrowedFor={
                            effective(person, gate) === "open"
                              ? []
                              : [`${STATE_LABEL[effective(person, gate)]} for them`]
                          }
                        />
                        <StatePicker
                          gate={gate}
                          value={overrideOf(person.id, gate)}
                          follows={policyOf(gate, person.role)}
                          disabled={busy}
                          onChange={(state) =>
                            state === null
                              ? clearOverride.mutate({ userId: person.id, gate })
                              : setOverride.mutate({ userId: person.id, gate, state })
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}

/**
 * The gate's name and its one `(i)` — the same shape on every row, which is the point.
 *
 * The panel holds what the area IS, and under it what narrowing it does and does not do. The icon
 * goes amber when `narrowedFor` is non-empty, i.e. when that second half has stopped being
 * hypothetical. See the file header for why that marker is what makes hiding a consequence
 * acceptable here.
 */
function GateName({
  gate,
  narrowedFor = [],
  quiet,
}: {
  gate: GateKey;
  /** how it is narrowed right now, e.g. ["Read only for user"]. Empty = wide open. */
  narrowedFor?: string[];
  quiet?: boolean;
}) {
  const caveat = GATE_COPY[gate].caveat;
  const flagged = narrowedFor.length > 0 && !!caveat;
  return (
    <span
      className={cn("flex items-center gap-1.5 text-[13px] font-medium", quiet && "text-muted")}
    >
      {GATE_COPY[gate].label}
      <InfoHint
        label={
          flagged
            ? `${GATE_COPY[gate].label} — ${narrowedFor.join(" and ")}. What that does`
            : `What ${GATE_COPY[gate].label} covers`
        }
        tone={flagged ? "attention" : "default"}
      >
        {GATE_COPY[gate].hint}
        {caveat && (
          <>
            <span className="mt-1.5 block border-t border-divider pt-1.5 font-medium">
              {flagged ? `${narrowedFor.join(" · ")}.` : "If it is narrowed"}
            </span>
            <span className="block">{caveat}</span>
          </>
        )}
      </InfoHint>
    </span>
  );
}

/**
 * Only the states this gate offers, so the screen never shows a switch that means nothing.
 * `read_only` appears where a screen can genuinely draw itself without its write controls — today
 * Services and Mailboxes; see the note in `shared/access.ts`.
 *
 * With `follows`, it grows a fourth choice: **Follow role**, which is what an absent override row
 * means. It sits first and is styled as the quiet option, because it is the answer for almost
 * everybody and choosing it is how an exception is removed.
 */
function StatePicker({
  gate,
  value,
  follows,
  disabled,
  onChange,
}: {
  gate: GateKey;
  value: Choice;
  /** the role's own answer, shown on the "Role" option. Omitted by the by-role table. */
  follows?: AccessState;
  disabled?: boolean;
  onChange: (state: Choice) => void;
}) {
  const offered = GATES[gate].states;
  /**
   * A state that is stored but no longer offered still gets a button, marked as the current one.
   *
   * A gate's menu can narrow between releases — `read_only` is offered only where a screen can
   * render without its write controls, and that list is meant to grow, but it could shrink. A row
   * left over from the wider menu would otherwise render with NOTHING selected, which reads as
   * "open" and is the one misreading this screen must never produce.
   */
  const orphan = value !== null && !offered.includes(value) ? value : null;
  const options: { value: Choice; label: string }[] = [
    ...(follows !== undefined ? [{ value: null, label: `Role · ${STATE_LABEL[follows]}` }] : []),
    ...offered.map((state) => ({ value: state as Choice, label: STATE_LABEL[state] })),
    ...(orphan ? [{ value: orphan as Choice, label: `${STATE_LABEL[orphan]} (kept)` }] : []),
  ];
  return (
    <div className="inline-flex rounded-(--radius-control) border border-border p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value ?? "follow"}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt.value)}
          className={cn(
            "whitespace-nowrap rounded-[5px] px-2.5 py-1 text-[12px] font-medium transition-colors",
            value === opt.value
              ? opt.value === null
                ? "bg-[#e7eaee] text-ink-700"
                : "bg-primary text-white"
              : "text-muted hover:bg-hover disabled:hover:bg-transparent",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
