import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, Trash2 } from "lucide-react";
import { useSettings } from "@/modules/settings";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { ClientFormModal } from "./client-form";
import {
  useArchiveClient,
  useClient,
  useClientFiles,
  useDeleteClientFile,
  useUploadClientFile,
} from "./clients.api";

const ROLLUPS = [
  { key: "tasks", label: "Tasks", stage: "S6" },
  { key: "invoices", label: "Invoices", stage: "S7" },
  { key: "meetings", label: "Meetings", stage: "S8" },
] as const;

export function ClientCardPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: client, isLoading, error } = useClient(id);
  const { data: settings } = useSettings();
  const archive = useArchiveClient();
  const [editOpen, setEditOpen] = useState(false);
  const [rollup, setRollup] = useState<(typeof ROLLUPS)[number]>(ROLLUPS[0]);

  if (isLoading) return <p className="text-[13px] text-muted">Loading…</p>;
  if (error || !client)
    return <p className="text-[13px] text-danger-text">Client not found.</p>;

  const sourceName = settings?.sources.find((s) => s.id === client.sourceId)?.name;

  const onArchive = async () => {
    if (!window.confirm("Archive this client? They will disappear from lists (restorable from Archive).")) {
      return;
    }
    await archive.mutateAsync(client.id);
    navigate("/clients");
  };

  return (
    <div className="max-w-4xl">
      <button
        type="button"
        onClick={() => navigate("/clients")}
        className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"
      >
        <ArrowLeft size={14} /> Clients
      </button>

      {/* header */}
      <div className="rounded-(--radius-panel) border border-border bg-surface p-5 shadow-(--shadow-card)">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-[20px] font-semibold">
              {client.firstName} {client.lastName}
              {client.isRegular && (
                <span className="rounded-(--radius-chip) bg-success-soft px-2 py-0.5 text-[12px] font-medium text-success">
                  Regular
                </span>
              )}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {client.companies.map((company) => (
                <span
                  key={company.id}
                  className="rounded-(--radius-chip) bg-divider px-2 py-0.5 text-[12px] font-medium"
                >
                  {company.name}
                </span>
              ))}
              {client.companies.length === 0 && (
                <span className="text-[12px] text-muted">Private individual</span>
              )}
              {sourceName && (
                <span className="text-[12px] text-muted">· Source: {sourceName}</span>
              )}
            </div>
            <div className="mt-2 space-x-4 text-[13px] text-muted">
              {client.phone && <span>{client.phone}</span>}
              {client.email && <span>{client.email}</span>}
              {client.address && <span>{client.address}</span>}
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}>
              Edit
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void onArchive()}>
              Archive
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* description */}
        <section className="rounded-(--radius-panel) border border-border bg-surface p-5 shadow-(--shadow-card)">
          <h2 className="mb-2 text-[15px] font-semibold">Description</h2>
          <p className="whitespace-pre-wrap text-[13px] text-ink-700">
            {client.description || <span className="text-muted">No description.</span>}
          </p>
          <p className="mt-3 text-[12px] text-muted">
            Created {new Date(client.createdAt).toLocaleDateString("en-US")}
          </p>
        </section>

        <FilesSection clientId={client.id} />
      </div>

      {/* rollups — fill in with Tasks/Payments/Calendar stages */}
      <div className="mt-4 rounded-(--radius-panel) border border-border bg-surface shadow-(--shadow-card)">
        <div className="flex gap-1 border-b border-divider px-3 pt-2">
          {ROLLUPS.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRollup(r)}
              className={cn(
                "rounded-t px-3 py-2 text-[13px] font-medium text-muted",
                rollup.key === r.key && "border-b-2 border-primary text-primary-link",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="px-5 py-8 text-center text-[13px] text-muted">
          {rollup.label} will appear here in stage {rollup.stage}.
        </div>
      </div>

      {editOpen && (
        <ClientFormModal open={editOpen} onClose={() => setEditOpen(false)} client={client} />
      )}
    </div>
  );
}

function FilesSection({ clientId }: { clientId: string }) {
  const { data: files } = useClientFiles(clientId);
  const upload = useUploadClientFile(clientId);
  const remove = useDeleteClientFile(clientId);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <section className="rounded-(--radius-panel) border border-border bg-surface p-5 shadow-(--shadow-card)">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">Files</h2>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload.mutateAsync(file);
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
              <button
                type="button"
                className="hover:text-danger"
                aria-label={`Delete ${file.name}`}
                onClick={() => void remove.mutateAsync(file.id)}
              >
                <Trash2 size={14} />
              </button>
            </span>
          </li>
        ))}
        {files?.length === 0 && (
          <li className="text-[12px] text-muted">No files yet. Up to 25 MB per file.</li>
        )}
      </ul>
    </section>
  );
}
