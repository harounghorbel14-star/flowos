import { useState } from "react";
import { APPROVAL_TYPES, LEAVE_TYPES, label, type ApprovalType } from "@shared/domain";
import { errorMessage, fieldErrors, trpc } from "../../lib/trpc";
import { useToast } from "../toast";
import { Button, enumOptions, Modal, SelectField, TextAreaField, TextField } from "../ui";

const HELP: Record<ApprovalType, string> = {
  LEAVE: "Time off. Approved leave shows on the command center for people managers.",
  HR: "Anything HR needs to sign off — role changes, equipment, policy exceptions.",
  DOCUMENT: "Ask someone to approve a document by name.",
  PURCHASE: "Spending that needs a budget holder’s approval.",
  GENERAL: "Any other decision that needs a named approver.",
};

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
  const errors = fieldErrors(create.error);
  const setField = (k: string) => (e: { target: { value: string } }) =>
    setP((s) => ({ ...s, [k]: e.target.value }));

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
  const submit = () =>
    create.mutate({ type, title, description: description || null, approverUserId, payload: payload() });
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
        {create.error && Object.keys(errors).length === 0 ? (
          <div className="form-error">{errorMessage(create.error)}</div>
        ) : null}
        {noApprovers ? (
          <div className="form-error">
            Nobody else in this organization can approve requests yet. Ask an admin to make someone a manager.
          </div>
        ) : null}
        <div className="form-row">
          <SelectField
            label="Type"
            value={type}
            onChange={(e) => setType(e.target.value as ApprovalType)}
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
              />
              <TextField
                label="To"
                type="date"
                required
                value={p.endDate ?? ""}
                onChange={setField("endDate")}
              />
            </div>
          </div>
        ) : null}
        {type === "PURCHASE" ? (
          <div className="form-row">
            <TextField label="Vendor" required value={p.vendor ?? ""} onChange={setField("vendor")} />
            <div className="form-row">
              <TextField
                label="Amount"
                type="number"
                min="0"
                step="0.01"
                required
                value={p.amount ?? ""}
                onChange={setField("amount")}
              />
              <TextField
                label="Currency"
                maxLength={3}
                value={p.currency ?? ""}
                onChange={setField("currency")}
                help="ISO code, e.g. EUR"
              />
            </div>
          </div>
        ) : null}
        {type === "HR" ? (
          <TextField
            label="Category"
            required
            value={p.category ?? ""}
            onChange={setField("category")}
            placeholder="e.g. Equipment, Role change"
          />
        ) : null}
        {type === "DOCUMENT" ? (
          <TextField
            label="Document name"
            required
            value={p.documentName ?? ""}
            onChange={setField("documentName")}
          />
        ) : null}
        <TextAreaField
          label="Details"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
