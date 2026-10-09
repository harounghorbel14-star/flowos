import { useState } from "react";
import { APPROVAL_TYPES, LEAVE_TYPES, label, type ApprovalType } from "@shared/domain";
import { fieldErrors, formError, trpc } from "../../lib/trpc";
import { useToast } from "../toast";
import { Button, enumOptions, Modal, SelectField, TextAreaField, TextField } from "../ui";

const HELP: Record<ApprovalType, string> = {
  LEAVE: "Time off. Approved leave shows on the command center for people managers.",
  HR: "Anything HR needs to sign off — role changes, equipment, policy exceptions.",
  DOCUMENT: "Ask someone to approve a document by name.",
  PURCHASE: "Spending that needs a budget holder’s approval.",
  GENERAL: "Any other decision that needs a named approver.",
};

/** Client-side checks for the type-specific details, named after the fields the user sees. */
function validateDetails(type: ApprovalType, p: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {};
  const blank = (k: string) => !(p[k] ?? "").trim();
  if (type === "LEAVE") {
    if (blank("startDate")) errors.startDate = "Choose the first day of leave (From).";
    if (blank("endDate")) errors.endDate = "Choose the last day of leave (To).";
    if (!errors.startDate && !errors.endDate && p.endDate! < p.startDate!) {
      errors.endDate = "The To date cannot be before the From date.";
    }
  }
  if (type === "PURCHASE") {
    if (blank("vendor")) errors.vendor = "Enter the vendor.";
    if (!(Number(p.amount) > 0)) errors.amount = "Enter an amount greater than 0.";
    if (!/^[A-Za-z]{3}$/.test((p.currency ?? "").trim()))
      errors.currency = "Use a 3-letter ISO code, e.g. EUR.";
  }
  if (type === "HR" && blank("category")) errors.category = "Enter a category.";
  if (type === "DOCUMENT" && blank("documentName")) errors.documentName = "Enter the document name.";
  return errors;
}

export function ApprovalFormDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose(): void;
  onSaved?(id: string): void;
}) {
  return open ? <Inner onClose={onClose} onSaved={onSaved} /> : null;
}

function Inner({ onClose, onSaved }: { onClose(): void; onSaved?(id: string): void }) {
  const toast = useToast();
  const utils = trpc.useUtils();
  const approvers = trpc.approvals.approvers.useQuery();
  const [type, setType] = useState<ApprovalType>("LEAVE");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [approverUserId, setApprover] = useState("");
  const [p, setP] = useState<Record<string, string>>({ leaveType: "ANNUAL", currency: "EUR" });
  const create = trpc.approvals.create.useMutation({
    onSuccess: async (r) => {
      await Promise.all([utils.approvals.invalidate(), utils.dashboard.invalidate()]);
      toast.success("Request sent.");
      onClose();
      onSaved?.(r.id);
    },
  });
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const errors: Record<string, string | undefined> = { ...fieldErrors(create.error), ...detailErrors };
  const topError = formError(create.error, ["type", "title", "description", "approverUserId"]);
  const setField = (k: string) => (e: { target: { value: string } }) => {
    setP((s) => ({ ...s, [k]: e.target.value }));
    setDetailErrors((d) => {
      if (!(k in d)) return d;
      const rest = { ...d };
      delete rest[k];
      return rest;
    });
  };

  const payload = (): Record<string, unknown> => {
    switch (type) {
      case "LEAVE":
        return { leaveType: p.leaveType, startDate: p.startDate, endDate: p.endDate };
      case "PURCHASE":
        return { amount: Number(p.amount), currency: (p.currency ?? "").toUpperCase(), vendor: p.vendor };
      case "HR":
        return { category: p.category };
      case "DOCUMENT":
        return { documentName: p.documentName };
      default:
        return {};
    }
  };
  const submit = () => {
    const problems = validateDetails(type, p);
    setDetailErrors(problems);
    if (Object.keys(problems).length > 0) return;
    create.mutate({ type, title, description: description || null, approverUserId, payload: payload() });
  };
  const noApprovers = approvers.data && approvers.data.length === 0;

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="New approval request"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!title.trim() || !approverUserId}
            onClick={submit}
          >
            Send request
          </Button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {topError ? <div className="form-error">{topError}</div> : null}
        {noApprovers ? (
          <div className="form-error">
            Nobody else in this organization can approve requests yet. Ask an admin to make someone a manager.
          </div>
        ) : null}
        <div className="form-row">
          <SelectField
            label="Type"
            value={type}
            onChange={(e) => {
              setType(e.target.value as ApprovalType);
              setDetailErrors({});
            }}
            options={enumOptions(APPROVAL_TYPES)}
            help={HELP[type]}
          />
          <SelectField
            label="Approver"
            value={approverUserId}
            onChange={(e) => setApprover(e.target.value)}
            placeholder="Choose who decides"
            options={(approvers.data ?? []).map((a) => ({
              value: a.userId,
              label: `${a.name} · ${label(a.role)}`,
            }))}
            error={errors.approverUserId}
          />
        </div>
        <TextField
          label="Title"
          required
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          error={errors.title}
          placeholder={type === "LEAVE" ? "Summer holiday" : "What needs approving?"}
        />
        {type === "LEAVE" ? (
          <div className="form-row">
            <SelectField
              label="Leave type"
              value={p.leaveType ?? "ANNUAL"}
              onChange={setField("leaveType")}
              options={enumOptions(LEAVE_TYPES)}
            />
            <div className="form-row">
              <TextField
                label="From"
                type="date"
                required
                value={p.startDate ?? ""}
                onChange={setField("startDate")}
                error={errors.startDate}
              />
              <TextField
                label="To"
                type="date"
                required
                min={p.startDate || undefined}
                value={p.endDate ?? ""}
                onChange={setField("endDate")}
                error={errors.endDate}
              />
            </div>
          </div>
        ) : null}
        {type === "PURCHASE" ? (
          <div className="form-row">
            <TextField
              label="Vendor"
              required
              maxLength={120}
              value={p.vendor ?? ""}
              onChange={setField("vendor")}
              error={errors.vendor}
            />
            <div className="form-row">
              <TextField
                label="Amount"
                type="number"
                min="0"
                step="0.01"
                required
                value={p.amount ?? ""}
                onChange={setField("amount")}
                error={errors.amount}
              />
              <TextField
                label="Currency"
                maxLength={3}
                value={p.currency ?? ""}
                onChange={setField("currency")}
                error={errors.currency}
                help="ISO code, e.g. EUR"
              />
            </div>
          </div>
        ) : null}
        {type === "HR" ? (
          <TextField
            label="Category"
            required
            maxLength={80}
            value={p.category ?? ""}
            onChange={setField("category")}
            error={errors.category}
            placeholder="e.g. Equipment, Role change"
          />
        ) : null}
        {type === "DOCUMENT" ? (
          <TextField
            label="Document name"
            required
            maxLength={200}
            value={p.documentName ?? ""}
            onChange={setField("documentName")}
            error={errors.documentName}
          />
        ) : null}
        <TextAreaField
          label="Details"
          maxLength={5000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          error={errors.description}
          rows={3}
        />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
