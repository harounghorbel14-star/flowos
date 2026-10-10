import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { TASK_PRIORITIES } from "@shared/domain";
import {
  ACTION_LABELS,
  ASSIGNEE_LABELS,
  ASSIGNEE_RULES,
  CONDITION_OPS,
  OP_LABELS,
  RECIPIENT_LABELS,
  RECIPIENT_RULES,
  TRIGGER_TYPES,
  TRIGGERS,
  WORKFLOW_LIMITS,
  type Condition,
  type TriggerType,
  type WorkflowAction,
} from "@shared/workflows";
import { personName } from "../../lib/format";
import { errorMessage, trpc } from "../../lib/trpc";
import { useToast } from "../toast";
import { Button, enumOptions, Modal, SelectField, TextAreaField, TextField } from "../ui";
import { integrationById, MESSAGING_INTEGRATIONS } from "@shared/integrations";

export interface WorkflowFormValues {
  id?: string;
  name: string;
  description: string;
  trigger: TriggerType;
  conditions: Condition[];
  actions: WorkflowAction[];
}

const NEW_ACTION: Record<WorkflowAction["type"], WorkflowAction> = {
  create_task: {
    type: "create_task",
    title: "",
    description: "",
    priority: "MEDIUM",
    dueInDays: null,
    assignee: "none",
    employeeId: null,
  },
  notify: { type: "notify", title: "", body: "", recipient: "workflow_owner", userId: null },
  send_message: { type: "send_message", provider: "slack", text: "" },
};

export function WorkflowFormDialog(props: {
  open: boolean;
  onClose(): void;
  initial?: Partial<WorkflowFormValues>;
  onSaved?(id: string): void;
}) {
  return props.open ? <Inner {...props} /> : null;
}

function Inner({
  onClose,
  initial,
  onSaved,
}: {
  onClose(): void;
  initial?: Partial<WorkflowFormValues>;
  onSaved?(id: string): void;
}) {
  const [v, setV] = useState<WorkflowFormValues>({
    name: "",
    description: "",
    trigger: "employee.created",
    conditions: [],
    actions: [NEW_ACTION.create_task],
    ...initial,
  });
  const toast = useToast();
  const utils = trpc.useUtils();
  const employees = trpc.employees.options.useQuery();
  const members = trpc.orgs.members.useQuery();
  const editing = Boolean(v.id);
  const done = async (id: string) => {
    await utils.workflows.invalidate();
    toast.success(editing ? "Workflow saved." : "Workflow created.");
    onClose();
    onSaved?.(id);
  };
  const create = trpc.workflows.create.useMutation({ onSuccess: (w) => done(w.id) });
  const update = trpc.workflows.update.useMutation({ onSuccess: (w) => done(w.id) });
  const mutation = editing ? update : create;
  const fields = TRIGGERS[v.trigger].fields;
  const placeholders = fields.map((f) => `{{${f.key}}}`).join("  ");

  const setCondition = (i: number, patch: Partial<Condition>) =>
    setV((s) => ({ ...s, conditions: s.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const setAction = (i: number, patch: Partial<WorkflowAction>) =>
    setV((s) => ({
      ...s,
      actions: s.actions.map((a, j) => (j === i ? ({ ...a, ...patch } as WorkflowAction) : a)),
    }));

  const submit = () => {
    const payload = {
      name: v.name,
      description: v.description || null,
      trigger: v.trigger,
      conditions: v.conditions,
      actions: v.actions,
    };
    if (v.id) update.mutate({ id: v.id, ...payload });
    else create.mutate(payload);
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={editing ? "Edit workflow" : "New workflow"}
      footer={
        <>
          <span className="faint" style={{ marginRight: "auto", fontSize: 12 }}>
            Actions run with your permissions.
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mutation.isPending} disabled={!v.name.trim()} onClick={submit}>
            {editing ? "Save workflow" : "Create workflow"}
          </Button>
        </>
      }
    >
      <div className="form">
        {mutation.error ? <div className="form-error">{errorMessage(mutation.error)}</div> : null}
        <TextField
          label="Name"
          autoFocus
          value={v.name}
          onChange={(e) => setV({ ...v, name: e.target.value })}
        />
        <TextAreaField
          label="Description"
          rows={2}
          value={v.description}
          onChange={(e) => setV({ ...v, description: e.target.value })}
        />

        <p className="eyebrow">When</p>
        <SelectField
          label="Trigger"
          value={v.trigger}
          onChange={(e) => setV({ ...v, trigger: e.target.value as TriggerType, conditions: [] })}
          options={TRIGGER_TYPES.map((t) => ({ value: t, label: TRIGGERS[t].label }))}
        />

        <p className="eyebrow">If — all conditions must match</p>
        {v.conditions.length === 0 ? (
          <span className="faint">No conditions: runs on every event.</span>
        ) : null}
        {v.conditions.map((c, i) => {
          const field = fields.find((f) => f.key === c.field);
          const values = field && "values" in field ? (field.values as readonly string[]) : undefined;
          const needsValue = c.op !== "is_set" && c.op !== "is_empty";
          return (
            <div key={i} className="row" style={{ flexWrap: "nowrap", alignItems: "flex-end" }}>
              <SelectField
                label="Field"
                value={c.field}
                onChange={(e) => setCondition(i, { field: e.target.value, value: "" })}
                options={fields.map((f) => ({ value: f.key, label: f.label }))}
              />
              <SelectField
                label="Operator"
                value={c.op}
                onChange={(e) => setCondition(i, { op: e.target.value as Condition["op"] })}
                options={CONDITION_OPS.map((o) => ({ value: o, label: OP_LABELS[o] }))}
              />
              {needsValue ? (
                values && (c.op === "eq" || c.op === "neq") ? (
                  <SelectField
                    label="Value"
                    value={c.value}
                    onChange={(e) => setCondition(i, { value: e.target.value })}
                    placeholder="Choose…"
                    options={enumOptions(values)}
                  />
                ) : (
                  <TextField
                    label="Value"
                    value={c.value}
                    onChange={(e) => setCondition(i, { value: e.target.value })}
                  />
                )
              ) : null}
              <Button
                icon
                variant="ghost"
                aria-label="Remove condition"
                onClick={() => setV({ ...v, conditions: v.conditions.filter((_, j) => j !== i) })}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          );
        })}
        {v.conditions.length < WORKFLOW_LIMITS.conditions ? (
          <div>
            <Button
              size="sm"
              onClick={() =>
                setV({ ...v, conditions: [...v.conditions, { field: fields[0]!.key, op: "eq", value: "" }] })
              }
            >
              <Plus aria-hidden /> Add condition
            </Button>
          </div>
        ) : null}

        <p className="eyebrow">Then — in order</p>
        <span className="help faint" style={{ fontSize: 12 }}>
          Text can include: <span className="mono">{placeholders}</span>
        </span>
        {v.actions.map((a, i) => (
          <div key={i} className="panel panel-body form" style={{ boxShadow: "none" }}>
            <div className="spread">
              <strong>
                {i + 1}. {ACTION_LABELS[a.type]}
              </strong>
              <span className="row">
                <select
                  className="select"
                  style={{ width: "auto", height: 30 }}
                  aria-label={`Action ${i + 1} type`}
                  value={a.type}
                  onChange={(e) =>
                    setV({
                      ...v,
                      actions: v.actions.map((x, j) =>
                        j === i ? NEW_ACTION[e.target.value as WorkflowAction["type"]] : x,
                      ),
                    })
                  }
                >
                  {Object.entries(ACTION_LABELS).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
                <Button
                  icon
                  size="sm"
                  variant="ghost"
                  aria-label="Remove action"
                  disabled={v.actions.length === 1}
                  onClick={() => setV({ ...v, actions: v.actions.filter((_, j) => j !== i) })}
                >
                  <Trash2 aria-hidden />
                </Button>
              </span>
            </div>
            {a.type === "create_task" ? (
              <>
                <TextField
                  label="Task title"
                  value={a.title}
                  onChange={(e) => setAction(i, { title: e.target.value })}
                />
                <TextAreaField
                  label="Description"
                  rows={2}
                  value={a.description}
                  onChange={(e) => setAction(i, { description: e.target.value })}
                />
                <div className="form-row">
                  <SelectField
                    label="Priority"
                    value={a.priority}
                    onChange={(e) => setAction(i, { priority: e.target.value as typeof a.priority })}
                    options={enumOptions(TASK_PRIORITIES)}
                  />
                  <TextField
                    label="Due in (days)"
                    type="number"
                    min={0}
                    max={365}
                    value={a.dueInDays ?? ""}
                    onChange={(e) =>
                      setAction(i, {
                        dueInDays:
                          e.target.value === "" ? null : Math.max(0, Math.min(365, Number(e.target.value))),
                      })
                    }
                    help="Leave empty for no due date."
                  />
                </div>
                <div className="form-row">
                  <SelectField
                    label="Assign to"
                    value={a.assignee}
                    onChange={(e) => setAction(i, { assignee: e.target.value as typeof a.assignee })}
                    options={ASSIGNEE_RULES.map((r) => ({ value: r, label: ASSIGNEE_LABELS[r] }))}
                  />
                  {a.assignee === "fixed_employee" ? (
                    <SelectField
                      label="Employee"
                      value={a.employeeId ?? ""}
                      onChange={(e) => setAction(i, { employeeId: e.target.value || null })}
                      placeholder="Choose…"
                      options={(employees.data ?? []).map((emp) => ({
                        value: emp.id,
                        label: personName(emp.firstName, emp.lastName),
                      }))}
                    />
                  ) : null}
                </div>
              </>
            ) : a.type === "send_message" ? (
              <>
                <SelectField
                  label="Send to"
                  value={a.provider}
                  onChange={(e) => setAction(i, { provider: e.target.value as typeof a.provider })}
                  options={MESSAGING_INTEGRATIONS.map((p) => ({ value: p, label: integrationById(p)!.name }))}
                  help="The integration must be connected in Settings → Integrations."
                />
                <TextAreaField
                  label="Message"
                  rows={3}
                  maxLength={1000}
                  value={a.text}
                  onChange={(e) => setAction(i, { text: e.target.value })}
                />
              </>
            ) : (
              <>
                <TextField
                  label="Notification title"
                  value={a.title}
                  onChange={(e) => setAction(i, { title: e.target.value })}
                />
                <TextField
                  label="Message"
                  value={a.body}
                  onChange={(e) => setAction(i, { body: e.target.value })}
                />
                <div className="form-row">
                  <SelectField
                    label="Recipient"
                    value={a.recipient}
                    onChange={(e) => setAction(i, { recipient: e.target.value as typeof a.recipient })}
                    options={RECIPIENT_RULES.map((r) => ({ value: r, label: RECIPIENT_LABELS[r] }))}
                  />
                  {a.recipient === "fixed_user" ? (
                    <SelectField
                      label="Member"
                      value={a.userId ?? ""}
                      onChange={(e) => setAction(i, { userId: e.target.value || null })}
                      placeholder="Choose…"
                      options={(members.data ?? []).map((m) => ({ value: m.userId, label: m.name }))}
                    />
                  ) : null}
                </div>
              </>
            )}
          </div>
        ))}
        {v.actions.length < WORKFLOW_LIMITS.actions ? (
          <div className="row">
            <Button size="sm" onClick={() => setV({ ...v, actions: [...v.actions, NEW_ACTION.create_task] })}>
              <Plus aria-hidden /> Add task action
            </Button>
            <Button size="sm" onClick={() => setV({ ...v, actions: [...v.actions, NEW_ACTION.notify] })}>
              <Plus aria-hidden /> Add notification
            </Button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
