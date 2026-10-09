import { Download, FileText, Pencil, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_VISIBILITIES,
  label,
  type DocumentCategory,
  type DocumentVisibility,
} from "@shared/domain";
import { useToast } from "../components/toast";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  enumOptions,
  ErrorState,
  Modal,
  PageHeader,
  Pagination,
  SelectField,
  SkeletonRows,
  TextAreaField,
  TextField,
} from "../components/ui";
import { formatDay, personName, timeAgo, todayISO } from "../lib/format";
import { useOrg } from "../lib/session";
import { errorMessage, trpc, type RouterOutputs } from "../lib/trpc";
import { downloadUrl, formatBytes, uploadDocument } from "../lib/upload";

type Doc = RouterOutputs["documents"]["list"]["items"][number];

interface MetaValues {
  title: string;
  description: string;
  category: DocumentCategory;
  visibility: DocumentVisibility;
  employeeId: string;
  expiresOn: string;
}

function ExpiryBadge({ expiresOn }: { expiresOn: string | null }) {
  if (!expiresOn) return <span className="faint">—</span>;
  const days = Math.round(
    (Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 86_400_000,
  );
  if (days < 0) return <Badge tone="critical">Expired {formatDay(expiresOn)}</Badge>;
  if (days <= 30) return <Badge tone="attention">Expires {formatDay(expiresOn)}</Badge>;
  return <span className="muted num">{formatDay(expiresOn)}</span>;
}

function MetaFields({
  v,
  set,
  employees,
}: {
  v: MetaValues;
  set: (patch: Partial<MetaValues>) => void;
  employees: { id: string; firstName: string; lastName: string }[];
}) {
  return (
    <>
      <TextField label="Title" required value={v.title} onChange={(e) => set({ title: e.target.value })} />
      <div className="form-row">
        <SelectField
          label="Category"
          value={v.category}
          onChange={(e) => set({ category: e.target.value as DocumentCategory })}
          options={enumOptions(DOCUMENT_CATEGORIES)}
        />
        <TextField
          label="Expires on"
          type="date"
          value={v.expiresOn}
          onChange={(e) => set({ expiresOn: e.target.value })}
          help="Owners are reminded 14 days before."
        />
      </div>
      <div className="form-row">
        <SelectField
          label="Concerns employee"
          value={v.employeeId}
          onChange={(e) => set({ employeeId: e.target.value })}
          placeholder="Nobody in particular"
          options={employees.map((e) => ({ value: e.id, label: personName(e.firstName, e.lastName) }))}
        />
        <SelectField
          label="Who can see it"
          value={v.visibility}
          onChange={(e) => set({ visibility: e.target.value as DocumentVisibility })}
          options={DOCUMENT_VISIBILITIES.map((x) => ({
            value: x,
            label: x === "RESTRICTED" ? "Restricted — managers, uploader, that employee" : label(x),
          }))}
        />
      </div>
      <TextAreaField
        label="Notes"
        rows={2}
        value={v.description}
        onChange={(e) => set({ description: e.target.value })}
      />
    </>
  );
}

const EMPTY: MetaValues = {
  title: "",
  description: "",
  category: "OTHER",
  visibility: "ORG",
  employeeId: "",
  expiresOn: "",
};

function UploadDialog({ onClose, defaultEmployeeId }: { onClose(): void; defaultEmployeeId?: string }) {
  const toast = useToast();
  const utils = trpc.useUtils();
  const employees = trpc.employees.options.useQuery();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [v, setV] = useState<MetaValues>({ ...EMPTY, employeeId: defaultEmployeeId ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError("Files can be at most 10 MB.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await uploadDocument(file, {
        title: v.title,
        fileName: file.name,
        description: v.description || null,
        category: v.category,
        visibility: v.visibility,
        employeeId: v.employeeId || null,
        expiresOn: v.expiresOn || null,
      });
      await Promise.all([utils.documents.invalidate(), utils.dashboard.invalidate()]);
      toast.success("Document uploaded.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Upload document"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!file || !v.title.trim()}
            onClick={() => void submit()}
          >
            Upload
          </Button>
        </>
      }
    >
      <div className="form">
        {error ? <div className="form-error">{error}</div> : null}
        <div className="field">
          <label htmlFor="doc-file">File</label>
          <input
            id="doc-file"
            ref={fileRef}
            className="input"
            style={{ paddingTop: 5 }}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.pptx,.txt,.csv,.md"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f && !v.title) setV((s) => ({ ...s, title: f.name.replace(/\.[^.]+$/, "") }));
            }}
          />
          <span className="help">
            PDF, PNG/JPEG, Word/Excel/PowerPoint or plain text, up to 10 MB. The type is checked from the
            file’s contents.
          </span>
        </div>
        <MetaFields
          v={v}
          set={(patch) => setV((s) => ({ ...s, ...patch }))}
          employees={employees.data ?? []}
        />
      </div>
    </Modal>
  );
}

function EditDialog({ doc, onClose }: { doc: Doc; onClose(): void }) {
  const toast = useToast();
  const utils = trpc.useUtils();
  const employees = trpc.employees.options.useQuery({ includeTerminated: true });
  const [v, setV] = useState<MetaValues>({
    title: doc.title,
    description: doc.description ?? "",
    category: doc.category,
    visibility: doc.visibility,
    employeeId: doc.employeeId ?? "",
    expiresOn: doc.expiresOn ?? "",
  });
  const update = trpc.documents.update.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.documents.invalidate(), utils.dashboard.invalidate()]);
      toast.success("Document updated.");
      onClose();
    },
  });
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Edit document details"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={update.isPending}
            disabled={!v.title.trim()}
            onClick={() =>
              update.mutate({
                id: doc.id,
                title: v.title,
                description: v.description || null,
                category: v.category,
                visibility: v.visibility,
                employeeId: v.employeeId || null,
                expiresOn: v.expiresOn || null,
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        {update.error ? <div className="form-error">{errorMessage(update.error)}</div> : null}
        <MetaFields
          v={v}
          set={(patch) => setV((s) => ({ ...s, ...patch }))}
          employees={employees.data ?? []}
        />
      </div>
    </Modal>
  );
}

/** Reusable documents table, also used on employee profiles. */
export function DocumentTable({ docs }: { docs: Doc[] }) {
  const toast = useToast();
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState<Doc | null>(null);
  const [deleting, setDeleting] = useState<Doc | null>(null);
  const remove = trpc.documents.delete.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.documents.invalidate(), utils.dashboard.invalidate()]);
      toast.success("Document deleted.");
      setDeleting(null);
    },
    onError: toast.error,
  });
  return (
    <>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Document</th>
              <th className="hide-sm">Category</th>
              <th className="hide-sm">Concerns</th>
              <th>Expiry</th>
              <th style={{ width: 120 }} />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td style={{ minWidth: 220 }}>
                  <div style={{ fontWeight: 500 }}>
                    {d.title}{" "}
                    {d.visibility === "RESTRICTED" ? <Badge tone="outline">Restricted</Badge> : null}
                  </div>
                  <div className="faint truncate" style={{ fontSize: 12 }}>
                    {d.fileName} · {formatBytes(d.sizeBytes)} · {d.uploadedByName ?? "—"} ·{" "}
                    {timeAgo(d.createdAt)}
                  </div>
                </td>
                <td className="hide-sm">{label(d.category)}</td>
                <td className="hide-sm">
                  {d.employeeId ? (
                    <Link to={`/people/${d.employeeId}`}>
                      {personName(d.employeeFirstName, d.employeeLastName)}
                    </Link>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td>
                  <ExpiryBadge expiresOn={d.expiresOn} />
                </td>
                <td>
                  <span className="row" style={{ flexWrap: "nowrap", gap: 2, justifyContent: "flex-end" }}>
                    <a
                      className="btn sm icon ghost"
                      href={downloadUrl(d.id)}
                      aria-label={`Download ${d.title}`}
                    >
                      <Download aria-hidden />
                    </a>
                    {d.canEdit ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon
                          aria-label={`Edit ${d.title}`}
                          onClick={() => setEditing(d)}
                        >
                          <Pencil aria-hidden />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon
                          aria-label={`Delete ${d.title}`}
                          onClick={() => setDeleting(d)}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </>
                    ) : null}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing ? <EditDialog doc={editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete “${deleting?.title ?? ""}”?`}
        body="The file is permanently removed from storage. The audit log keeps a record of the upload and deletion."
        confirmLabel="Delete document"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate({ id: deleting.id })}
      />
    </>
  );
}

export function UploadButton({ employeeId }: { employeeId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Upload aria-hidden /> Upload
      </Button>
      {open ? <UploadDialog onClose={() => setOpen(false)} defaultEmployeeId={employeeId} /> : null}
    </>
  );
}

export function DocumentsPage() {
  const { can } = useOrg();
  const [params, setParams] = useSearchParams();
  const [searchText, setSearchText] = useState(params.get("q") ?? "");
  const update = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    if (resetPage) next.delete("page");
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get("q") ?? "") !== searchText) update({ q: searchText || null });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);
  const category = params.get("category") as DocumentCategory | null;
  const expiring = params.get("expiring") === "1";
  const list = trpc.documents.list.useQuery(
    {
      page: Number(params.get("page") ?? 1) || 1,
      pageSize: 25,
      search: params.get("q") || undefined,
      category:
        category && (DOCUMENT_CATEGORIES as readonly string[]).includes(category) ? category : undefined,
      expiring: expiring || undefined,
    },
    { placeholderData: (prev) => prev },
  );
  const filtered = Boolean(params.get("q") || category || expiring);

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title="Documents"
        lede="Contracts, policies and certificates in private storage. Every download is permission-checked and logged."
        actions={can("document:upload") ? <UploadButton /> : null}
      />
      <div className="toolbar">
        <div className="search">
          <Search aria-hidden />
          <input
            className="input"
            placeholder="Search title or file name"
            aria-label="Search documents"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>
        <select
          className="select"
          style={{ width: "auto" }}
          aria-label="Category"
          value={category ?? ""}
          onChange={(e) => update({ category: e.target.value || null })}
        >
          <option value="">All categories</option>
          {DOCUMENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {label(c)}
            </option>
          ))}
        </select>
        <button
          className="chip-toggle"
          aria-pressed={expiring}
          onClick={() => update({ expiring: expiring ? null : "1" })}
        >
          Expiring within 30 days
        </button>
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.isLoading ? (
        <div className="panel">
          <SkeletonRows />
        </div>
      ) : null}
      {list.data && list.data.total === 0 ? (
        <div className="panel">
          <EmptyState
            icon={<FileText size={18} />}
            title={filtered ? "No documents match" : "No documents yet"}
            action={!filtered && can("document:upload") ? <UploadButton /> : null}
          >
            {filtered
              ? "Try a different search or filter."
              : "Upload contracts, policies and certificates. Set an expiry date to get reminders."}
          </EmptyState>
        </div>
      ) : null}
      {list.data && list.data.total > 0 ? (
        <>
          <DocumentTable docs={list.data.items} />
          <Pagination
            page={list.data.page}
            pageCount={list.data.pageCount}
            total={list.data.total}
            noun="documents"
            onPage={(p) => update({ page: String(p) }, false)}
          />
        </>
      ) : null}
    </>
  );
}
