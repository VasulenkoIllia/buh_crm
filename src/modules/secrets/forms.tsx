import { useEffect, useRef, useState } from "react";
import { Dices, Eye, EyeOff } from "lucide-react";
import {
  ID_DOCUMENT_TYPES,
  SECRET_TEMPLATES,
  TAX_AGENCIES,
  TEMPLATE_COPY,
  type SecretInput,
  type SecretTemplate,
} from "@shared/schema/secrets";
import { ApiError } from "@/shared/lib/api";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { FormField, Input, Textarea } from "@/shared/ui/field";
import { Modal } from "@/shared/ui/modal";
import { Generator } from "./generator";
import type { Openable } from "./entry";
import type { UiPlace } from "./places";
import { revealSecret, useSaveSecret } from "./secrets.api";
import { TemplateIcon, labelOfField } from "./template-bits";
import { UnlockModal, useVaultWindow } from "./unlock";

/**
 * **One form per template** (secrets.md §5). The server holds each template to its own shape and
 * refuses anything else, so this only decides what to ask for; the checks that matter — six digits,
 * nine digits, a card that passes Luhn, a CVV as long as its brand wants — answer from there, in
 * words, and this form shows them.
 */
type Field =
  | { key: string; kind: "text"; placeholder?: string; optional?: boolean }
  | { key: string; kind: "select"; options: readonly { value: string; label: string }[] }
  | { key: string; kind: "secret"; placeholder?: string }
  | { key: string; kind: "password" }
  | { key: string; kind: "multiline" };

const asOptions = (values: readonly string[]) => values.map((v) => ({ value: v, label: v }));

const FORM: Record<
  SecretTemplate,
  { open: Field[]; secret: Field[]; showOpen?: (open: Record<string, string>) => string[] }
> = {
  free_form: { open: [], secret: [{ key: "value", kind: "multiline" }] },
  login: {
    open: [{ key: "site", kind: "text", placeholder: "gusto.com" }],
    secret: [
      { key: "login", kind: "secret" },
      { key: "password", kind: "password" },
      { key: "recovery", kind: "multiline" },
      { key: "twofa", kind: "secret", placeholder: "Iryna's authenticator" },
      { key: "notes", kind: "multiline" },
    ],
  },
  tax_account: {
    open: [
      { key: "agency", kind: "select", options: asOptions(TAX_AGENCIES) },
      { key: "state", kind: "text", placeholder: "New Jersey" },
    ],
    // a state only for a state's tax department, which is the one agency that needs naming
    showOpen: (open) =>
      open.agency === "State tax department" ? ["agency", "state"] : ["agency"],
    secret: [
      { key: "idNumber", kind: "secret", placeholder: "EIN, SSN or the state's account" },
      { key: "login", kind: "secret" },
      { key: "password", kind: "password" },
      { key: "pin", kind: "secret" },
      { key: "notes", kind: "multiline" },
    ],
  },
  ip_pin: {
    open: [
      { key: "year", kind: "text", placeholder: String(new Date().getFullYear()) },
      {
        key: "who",
        kind: "select",
        options: [
          { value: "taxpayer", label: "Taxpayer" },
          { value: "spouse", label: "Spouse" },
          { value: "dependent", label: "Dependent" },
        ],
      },
      { key: "firstName", kind: "text", optional: true },
    ],
    secret: [{ key: "pin", kind: "secret", placeholder: "6 digits" }],
  },
  bank: {
    open: [{ key: "bank", kind: "text", placeholder: "Wells Fargo" }],
    secret: [
      { key: "routing", kind: "secret", placeholder: "9 digits" },
      { key: "account", kind: "secret" },
      { key: "login", kind: "secret" },
      { key: "password", kind: "password" },
      { key: "notes", kind: "multiline" },
    ],
  },
  id_document: {
    open: [
      { key: "docType", kind: "select", options: asOptions(ID_DOCUMENT_TYPES) },
      { key: "issuer", kind: "text", placeholder: "New York" },
    ],
    secret: [
      { key: "number", kind: "secret" },
      { key: "issued", kind: "secret", placeholder: "MM/DD/YYYY" },
      { key: "expires", kind: "secret", placeholder: "MM/DD/YYYY" },
    ],
  },
  device: {
    open: [{ key: "device", kind: "text", placeholder: "Office-5G" }],
    secret: [
      { key: "password", kind: "password" },
      { key: "adminLogin", kind: "secret" },
      { key: "adminPassword", kind: "password" },
      { key: "notes", kind: "multiline" },
    ],
  },
  payment_card: {
    // the brand and the last four are computed from the number, never typed (§5.3)
    open: [],
    secret: [
      { key: "number", kind: "secret" },
      { key: "holder", kind: "secret" },
      { key: "expiry", kind: "secret", placeholder: "MM/YY" },
      { key: "cvv", kind: "secret", placeholder: "3 digits, 4 on American Express" },
      { key: "notes", kind: "multiline" },
    ],
  },
};

const START: Partial<Record<SecretTemplate, Record<string, string>>> = {
  tax_account: { agency: "IRS online account" },
  ip_pin: { year: String(new Date().getFullYear()), who: "taxpayer" },
  id_document: { docType: "Driver's license" },
};

/** The first step of a new entry: which kind of credential it is. Fixed once saved (§3.3). */
export function TemplatePicker({
  where,
  onPick,
  onClose,
}: {
  where: string;
  onPick: (template: SecretTemplate) => void;
  onClose: () => void;
}) {
  const order: SecretTemplate[] = [
    ...SECRET_TEMPLATES.filter((t) => t !== "free_form"),
    "free_form",
  ];
  return (
    <Modal title={`New secret in ${where}`} open size="lg" onClose={onClose}>
      <div className="grid gap-2 sm:grid-cols-2">
        {order.map((template) => (
          <button
            key={template}
            type="button"
            className="flex items-center gap-2.5 rounded-(--radius-card) border border-border p-2.5 text-left hover:border-[#c9d3f8] hover:bg-primary-soft"
            onClick={() => onPick(template)}
          >
            <TemplateIcon template={template} />
            <span>
              <b className="block text-[13px] font-semibold text-ink">
                {TEMPLATE_COPY[template].label}
              </b>
              <span className="block text-[11.5px] text-muted">
                {TEMPLATE_COPY[template].hint}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** A value only while it has something in it: an empty field is not a field that was filled. */
const filled = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ""));

export function SecretForm({
  place,
  where,
  template,
  secret,
  onClose,
}: {
  place: UiPlace;
  where: string;
  template: SecretTemplate;
  /** absent = a new entry */
  secret?: Openable;
  onClose: () => void;
}) {
  const form = FORM[template];
  const save = useSaveSecret(place);
  const { unlocked } = useVaultWindow();

  const [title, setTitle] = useState(secret?.label ?? "");
  const [description, setDescription] = useState(secret?.description ?? "");
  const [open, setOpen] = useState<Record<string, string>>(
    secret ? { ...secret.fields } : { ...(START[template] ?? {}) },
  );
  const [sealed, setSealed] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [generating, setGenerating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Editing shows the stored values, so it costs the same unlock as reading them, and they stay on
  // screen only while the vault is open, as in the entry window. Until they are back in the boxes a
  // save would send empty fields and WIPE them, so Save waits for `loaded`: before the unlock, after
  // a load that failed, and after the five minutes ran out mid-edit alike (review, 2026-09-16).
  const needsValues = !!secret?.hasValue;
  const [loaded, setLoaded] = useState(!needsValues);
  const [asking, setAsking] = useState(false);
  const unlockedHere = useRef(false);

  useEffect(() => {
    if (!needsValues) return;
    if (!unlocked) {
      // every ask needs its own answer: an unlock earlier in this form does not cover this one
      unlockedHere.current = false;
      setAsking(true);
      return;
    }
    setAsking(false);
    let alive = true;
    revealSecret(place, secret!.id)
      .then((res) => {
        if (!alive) return;
        setSealed(res.secret);
        setLoaded(true);
      })
      .catch(
        (e) =>
          alive && setError(e instanceof ApiError ? e.message : "Could not load the values"),
      );
    return () => {
      alive = false;
      // the plaintext dies with this form, and with the vault's five minutes
      setSealed({});
      setLoaded(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked]);

  const submit = async () => {
    setError(null);
    const openShown = form.showOpen ? form.showOpen(open) : form.open.map((f) => f.key);
    const openSent = filled(Object.fromEntries(openShown.map((k) => [k, open[k] ?? ""])));
    const secretSent = filled(sealed);
    try {
      await save.mutateAsync({
        id: secret?.id,
        // Cast: the boxes are plain strings keyed by the template's form, which no single member of
        // the union describes. The server's strict schema per template is what holds the shape.
        input: {
          template,
          label: title.trim(),
          description: description.trim() || null,
          open: template === "payment_card" ? {} : openSent,
          // every box empty means a pointer-only entry, deliberately (§5.1)
          secret: Object.keys(secretSent).length > 0 ? secretSent : null,
        } as SecretInput,
      });
      setSealed({});
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      // the mutation's variables CONTAIN the secret: reset lets go of them, a failed save's as much
      // as a good one's, and the hook's `gcTime: 0` then removes them from the cache at once
      save.reset();
    }
  };

  const openFields = form.showOpen
    ? form.open.filter((f) => form.showOpen!(open).includes(f.key))
    : form.open;

  return (
    <>
      <Modal
        title={
          secret ? `Edit ${secret.label}` : `New ${TEMPLATE_COPY[template].label.toLowerCase()}`
        }
        open
        size="lg"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!title.trim() || save.isPending || !loaded}
              onClick={() => void submit()}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2.5 text-[12.5px] text-muted">
            <TemplateIcon template={template} />
            <span>
              {TEMPLATE_COPY[template].label} · in {where}
            </span>
          </div>

          <FormField label="Title" htmlFor="secret-title">
            <Input
              id="secret-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </FormField>

          <FormField label="Description" htmlFor="secret-description">
            <Textarea
              id="secret-description"
              className="h-[60px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            {/* the one note this form needs: a description is open, so a password in it is not */}
            <p className="mt-1 text-[12px] text-muted">
              Everyone who sees this place reads it. Never put a password here.
            </p>
          </FormField>

          {openFields.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {openFields.map((field) => (
                <FormField
                  key={field.key}
                  label={labelOfField(field.key)}
                  htmlFor={`open-${field.key}`}
                >
                  {field.kind === "select" ? (
                    <select
                      id={`open-${field.key}`}
                      className="h-9 w-full rounded-(--radius-field) border border-[#d9dde3] bg-surface px-2 text-[13px]"
                      value={open[field.key] ?? field.options[0]?.value ?? ""}
                      onChange={(e) =>
                        setOpen((was) => ({ ...was, [field.key]: e.target.value }))
                      }
                    >
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={`open-${field.key}`}
                      placeholder={"placeholder" in field ? field.placeholder : undefined}
                      value={open[field.key] ?? ""}
                      onChange={(e) =>
                        setOpen((was) => ({ ...was, [field.key]: e.target.value }))
                      }
                    />
                  )}
                </FormField>
              ))}
            </div>
          )}

          <div className="space-y-3 border-t border-divider pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-[.04em] text-muted-400">
              Secret fields
            </p>
            {!loaded ? (
              <p className="text-[13px] text-muted">
                {error
                  ? "Without the stored values this edit cannot be saved."
                  : "Loading the stored values…"}
              </p>
            ) : (
              form.secret.map((field) => {
                const id = `sealed-${field.key}`;
                const value = sealed[field.key] ?? "";
                const set = (next: string) =>
                  setSealed((was) => ({ ...was, [field.key]: next }));
                if (field.kind === "multiline") {
                  return (
                    <FormField key={field.key} label={labelOfField(field.key)} htmlFor={id}>
                      <Textarea
                        id={id}
                        className="h-[70px] font-mono"
                        spellCheck={false}
                        autoComplete="off"
                        value={value}
                        onChange={(e) => set(e.target.value)}
                      />
                    </FormField>
                  );
                }
                const shown = visible.has(field.key);
                return (
                  <FormField key={field.key} label={labelOfField(field.key)} htmlFor={id}>
                    <div className="flex items-center gap-1.5">
                      <Input
                        id={id}
                        type={shown ? "text" : "password"}
                        className={cn("flex-1 font-mono", "bg-[#fdf8ee]")}
                        spellCheck={false}
                        autoComplete="off"
                        placeholder={"placeholder" in field ? field.placeholder : undefined}
                        value={value}
                        onChange={(e) => set(e.target.value)}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-label={
                          shown
                            ? `Hide ${labelOfField(field.key)}`
                            : `Show ${labelOfField(field.key)}`
                        }
                        onClick={() =>
                          setVisible((was) => {
                            const next = new Set(was);
                            if (shown) next.delete(field.key);
                            else next.add(field.key);
                            return next;
                          })
                        }
                      >
                        {shown ? <EyeOff size={14} /> : <Eye size={14} />}
                      </Button>
                      {field.kind === "password" && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            setGenerating(generating === field.key ? null : field.key)
                          }
                        >
                          <Dices size={14} />
                          Generate
                        </Button>
                      )}
                    </div>
                    {generating === field.key && (
                      <Generator
                        onClose={() => setGenerating(null)}
                        onUse={(generated) => {
                          set(generated);
                          setVisible((was) => new Set(was).add(field.key));
                          setGenerating(null);
                        }}
                      />
                    )}
                  </FormField>
                );
              })
            )}
            {loaded && (
              <p className="text-[12px] text-muted">
                Leave them empty to keep a reference only.
              </p>
            )}
          </div>

          {error && <p className="text-[12.5px] text-danger-text">{error}</p>}
        </div>
      </Modal>
      {asking && (
        <UnlockModal
          onDone={() => {
            // the grant refetches, `unlocked` turns true, and the effect above loads the values
            unlockedHere.current = true;
          }}
          onClose={() => {
            setAsking(false);
            // without the values the edit would wipe them, so no unlock means no edit
            if (!unlockedHere.current) onClose();
          }}
        />
      )}
    </>
  );
}
