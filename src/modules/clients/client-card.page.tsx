import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Download, Trash2 } from "lucide-react";
import type { Client } from "@shared/schema/client";
import { ServiceChip, useCatalog } from "@/modules/catalog";
import { EntityInvoices } from "@/modules/payments";
import { EntityTasks } from "@/modules/tasks";
import { useSettings } from "@/modules/settings";
import { ApiError } from "@/shared/lib/api";
import { fmtDate } from "@/shared/lib/format";
import { Button, IconButton } from "@/shared/ui/button";
import { Tabs } from "@/shared/ui/tabs";
import { ClientFormModal } from "./client-form";
import { CompaniesTab } from "./client-companies";
import { ClientPeopleModal } from "./client-people-modal";
import { SecretsTab } from "./client-secrets";
import { AddServiceModal, SubscriptionList } from "./client-services";
import {
  useArchiveClient,
  useClient,
  useClientFiles,
  useDeleteClientFile,
  useUploadClientFile,
} from "./clients.api";

const TABS = [
  { key: "profile", label: "Profile" },
  { key: "companies", label: "Companies" },
  { key: "people", label: "People" },
  { key: "secrets", label: "Secrets" },
  { key: "tasks", label: "Tasks" },
  { key: "invoices", label: "Invoices" },
  { key: "meetings", label: "Meetings" },
  { key: "services", label: "Services" },
  { key: "files", label: "Files" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const TAB_STAGE: Partial<Record<TabKey, string>> = {
  meetings: "S8",
};

export function ClientCardPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: client, isLoading, error } = useClient(id);
  const archive = useArchiveClient();
  const [editOpen, setEditOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [tab, setTab] = useState<TabKey>("profile");

  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (error || !client)
    return <p className="text-[13px] text-danger-text">Client not found.</p>;

  // the informational label, then the companies they actually hold
  const companiesLabel = client.companies.map((c) => c.name).join(", ") || "no companies";

  const onArchive = async () => {
    if (!window.confirm("Archive this client? They disappear from lists (restorable from Archive).")) {
      return;
    }
    try {
      await archive.mutateAsync(client.id);
      navigate("/clients");
    } catch {
      window.alert("Could not archive the client. Please try again.");
    }
  };

  return (
    <div className="mx-auto max-w-[940px]">
      <button
        type="button"
        onClick={() => navigate("/clients")}
        className="mb-3 text-[13px] text-primary-link hover:underline"
      >
        ← Clients
      </button>

      {/* header (design: name + badge · type · companies, bordered actions) */}
      <div className="mb-1 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[20px] font-semibold">{client.displayName}</h1>
            {client.isRegular && (
              <span className="rounded-(--radius-chip) bg-[#f0ebfb] px-2 py-0.5 text-[12px] font-medium text-[#7a4fd6]">
                regular
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[13px] text-muted-400">
            {[client.companyName, companiesLabel].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="rounded-(--radius-field) border border-[#d9dde3] px-[13px] py-[7px] text-[13px] text-ink-700 hover:bg-divider"
          >
            ✎ Edit
          </button>
          <button
            type="button"
            disabled={archive.isPending}
            onClick={() => void onArchive()}
            className="rounded-(--radius-field) border border-[#d9dde3] px-[13px] py-[7px] text-[13px] text-ink-700 hover:bg-divider disabled:opacity-50"
          >
            {archive.isPending ? "Archiving…" : "Archive"}
          </button>
        </div>
      </div>

      <Tabs
        className="mb-[18px] mt-3.5"
        value={tab}
        onChange={setTab}
        options={TABS.map((t) => ({ value: t.key, label: t.label }))}
      />

      {/* company view (multi-company clients) */}
      {tab === "profile" && <ProfileTab client={client} />}
      {tab === "companies" && (
        <CompaniesTab client={client} />
      )}
      {tab === "people" && <PeopleTab client={client} onManage={() => setPeopleOpen(true)} />}
      {tab === "secrets" && <SecretsTab clientId={client.id} />}
      {tab === "tasks" && (
        <EntityTasks target={{ kind: "client", id: client.id, label: client.displayName }} />
      )}
      {tab === "invoices" && <EntityInvoices client={client} />}
      {tab === "services" && <ServicesTab client={client} />}
      {tab === "files" && <FilesTab clientId={client.id} />}
      {TAB_STAGE[tab] && (
        <div className="rounded-(--radius-panel) border border-border bg-surface px-5 py-10 text-center text-[13px] text-muted">
          {TABS.find((t) => t.key === tab)?.label} will appear here in stage {TAB_STAGE[tab]}.
        </div>
      )}

      {editOpen && (
        <ClientFormModal open={editOpen} onClose={() => setEditOpen(false)} client={client} />
      )}
      {peopleOpen && (
        <ClientPeopleModal open={peopleOpen} onClose={() => setPeopleOpen(false)} client={client} />
      )}
    </div>
  );
}


function ServicesTab({ client }: { client: Client }) {
  const [addOpen, setAddOpen] = useState(false);
  return (
    <div className="rounded-(--radius-panel) border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">Services / subscriptions</h2>
        <Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>
          + Add service
        </Button>
      </div>
      <SubscriptionList client={client} />
      <p className="mt-3 text-[12px] text-faint">
        Tasks are generated from subscriptions with the Tasks stage (S6).
      </p>
      {addOpen && <AddServiceModal client={client} open onClose={() => setAddOpen(false)} />}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-[3px] text-[11px] uppercase tracking-[.4px] text-muted-400">
      {children}
    </div>
  );
}

function PeopleTab({ client, onManage }: { client: Client; onManage: () => void }) {
  const { data: services } = useCatalog();
  const serviceById = new Map((services ?? []).map((s) => [s.id, s]));
  return (
    <div className="rounded-(--radius-panel) border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-divider px-5 py-3">
        <h2 className="text-[15px] font-semibold">People</h2>
        <Button variant="secondary" size="sm" onClick={onManage}>
          Manage
        </Button>
      </div>
      {client.people.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-[13px] text-muted">
            No people yet. Add contacts and the service each of them handles.
          </p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={onManage}>
            + Add people
          </Button>
        </div>
      ) : (
        <ul>
          {client.people.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between border-b border-divider px-5 py-3 text-[13px] last:border-0"
            >
              <div>
                <div className="font-medium">{p.name}</div>
                <div className="text-[12px] text-muted">
                  {[p.phone, p.email].filter(Boolean).join(" · ") || "—"}
                </div>
              </div>
              {p.serviceId && serviceById.get(p.serviceId) ? (
                <ServiceChip
                  name={serviceById.get(p.serviceId)!.name}
                  color={serviceById.get(p.serviceId)!.color}
                />
              ) : p.serviceLabel ? (
                <span className="rounded-(--radius-chip) bg-divider px-2 py-0.5 text-[12px] font-medium text-muted">
                  {p.serviceLabel}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProfileTab({ client }: { client: Client }) {
  const { data: settings } = useSettings();
  const { data: services } = useCatalog();
  const sourceName = settings?.sources.find((s) => s.id === client.sourceId)?.name;
  const serviceById = new Map((services ?? []).map((s) => [s.id, s]));

  return (
    <>
      {/* profile grid (design: 2-col, uppercase labels) */}
      <div className="mb-4 grid grid-cols-1 gap-4 rounded-(--radius-panel) border border-border bg-surface p-5 sm:grid-cols-2 sm:gap-x-8">
        <div>
          <FieldLabel>Name</FieldLabel>
          <div className="text-[14px]">{client.displayName}</div>
        </div>
        <div>
          {/* the plain label on the client; the real companies are their own tab */}
          <FieldLabel>Company (label)</FieldLabel>
          <div className="text-[14px]">{client.companyName ?? "—"}</div>
        </div>
        <div className="sm:col-span-2">
          <FieldLabel>Companies</FieldLabel>
          <div className="text-[14px]">
            {client.companies.length > 0
              ? client.companies.map((c) => c.name).join(", ")
              : "— billed directly on the client"}
          </div>
        </div>
        <div>
          <FieldLabel>Email</FieldLabel>
          <div className="text-[14px]">{client.email ?? "—"}</div>
        </div>
        <div>
          <FieldLabel>Phone</FieldLabel>
          <div className="text-[14px]">{client.phone ?? "—"}</div>
        </div>
        <div className="sm:col-span-2">
          <FieldLabel>Address</FieldLabel>
          <div className="text-[14px]">{client.address ?? "—"}</div>
        </div>
        <div className="sm:col-span-2">
          {/* read-only: these ARE the client's active services (see the Services tab) */}
          <FieldLabel>Service category</FieldLabel>
          <div className="flex flex-wrap items-center gap-1.5">
            {client.categories.map((id) => {
              const svc = serviceById.get(id);
              return svc ? <ServiceChip key={id} name={svc.name} color={svc.color} /> : null;
            })}
            {client.categories.length === 0 && (
              <span className="text-[14px] text-muted">— no active services</span>
            )}
          </div>
        </div>
        <div className="sm:col-span-2">
          <FieldLabel>Description</FieldLabel>
          <div className="whitespace-pre-wrap text-[14px] leading-normal text-ink-700">
            {client.description || "—"}
          </div>
        </div>
        <div>
          <FieldLabel>Created</FieldLabel>
          <div className="text-[14px]">
            {fmtDate(client.createdAt)}
          </div>
        </div>
        <div>
          <FieldLabel>Reminders</FieldLabel>
          <div className="text-[13px] text-muted">Arrive with the Mailouts stage (S10).</div>
        </div>
        {sourceName && (
          <div>
            <FieldLabel>Source</FieldLabel>
            <div className="text-[14px]">{sourceName}</div>
          </div>
        )}
      </div>

      <p className="mb-4 text-[12px] text-faint">
        📎 Client files are in the “Files” tab (up to 25 MB per file).
      </p>

    </>
  );
}

function FilesTab({ clientId }: { clientId: string }) {
  const { data: files } = useClientFiles(clientId);
  const upload = useUploadClientFile(clientId);
  const remove = useDeleteClientFile(clientId);
  const inputRef = useRef<HTMLInputElement>(null);

  const serverError =
    upload.error instanceof ApiError
      ? upload.error.message
      : remove.error instanceof ApiError
        ? remove.error.message
        : null;

  return (
    <div className="rounded-(--radius-panel) border border-border bg-surface p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">Files</h2>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              upload.mutateAsync(file).catch(() => {
                /* surfaced via serverError below */
              });
            }
            e.target.value = "";
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={upload.isPending}
          onClick={() => inputRef.current?.click()}
        >
          {upload.isPending ? "Uploading…" : "Upload"}
        </Button>
      </div>
      <ul className="space-y-1.5">
        {(files ?? []).map((file) => (
          <li
            key={file.id}
            className="flex items-center justify-between rounded-(--radius-btn-sm) border border-divider px-2.5 py-1.5 text-[13px]"
          >
            <span className="truncate">{file.name}</span>
            <span className="ml-2 flex shrink-0 items-center gap-2 text-muted">
              <span className="text-[11px]">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
              <a
                href={`/api/clients/${clientId}/files/${file.id}`}
                className="hover:text-ink"
                aria-label={`Download ${file.name}`}
              >
                <Download size={14} />
              </a>
              <IconButton
                label={`Delete ${file.name}`}
                className="hover:text-danger"
                onClick={() => {
                  remove.mutateAsync(file.id).catch(() => {
                    /* surfaced via serverError below */
                  });
                }}
              >
                <Trash2 size={14} />
              </IconButton>
            </span>
          </li>
        ))}
        {files?.length === 0 && (
          <li className="text-[12px] text-muted">No files yet. Up to 25 MB per file.</li>
        )}
      </ul>
      {serverError && <p className="mt-2 text-[12px] text-danger-text">{serverError}</p>}
    </div>
  );
}
