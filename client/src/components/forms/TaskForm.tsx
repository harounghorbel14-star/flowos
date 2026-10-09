import { useState } from "react";
import { TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from "@shared/domain";
import { personName } from "../../lib/format";
import { errorMessage, fieldErrors, trpc } from "../../lib/trpc";
import { useToast } from "../toast";
import { Button, enumOptions, Modal, SelectField, TextAreaField, TextField } from "../ui";

export interface TaskFormValues {
  id?: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  projectId: string;
  assigneeEmployeeId: string;
  dueDate: string;
}

const EMPTY: TaskFormValues = {
  title: "",
  description: "",
  status: "TODO",
  priority: "MEDIUM",
  projectId: "",
  assigneeEmployeeId: "",
  dueDate: "",
};

export function TaskFormDialog({
  open,
  onClose,
  initial,
  onSaved,
}: {
  open: boolean;
  onClose(): void;
  initial?: Partial<TaskFormValues>;
  onSaved?(id: string): void;
}) {
  return open ? <TaskFormInner onClose={onClose} initial={initial} onSaved={onSaved} /> : null;
}

function TaskFormInner({
  onClose,
  initial,
  onSaved,
}: {
  onClose(): void;
  initial?: Partial<TaskFormValues>;
  onSaved?(id: string): void;
}) {
  const [v, setV] = useState<TaskFormValues>({ ...EMPTY, ...initial });
  const toast = useToast();
  const utils = trpc.useUtils();
  const employees = trpc.employees.options.useQuery();
  const projects = trpc.projects.options.useQuery();
  const editing = Boolean(v.id);
  const done = async (id: string) => {
    await Promise.all([utils.tasks.invalidate(), utils.projects.invalidate(), utils.dashboard.invalidate()]);
    toast.success(editing ? "Task updated." : "Task created.");
    // Close first: closing rewrites the URL, and onSaved may navigate elsewhere.
    onClose();
    onSaved?.(id);
  };
  const create = trpc.tasks.create.useMutation({ onSuccess: (t) => done(t.id) });
  const update = trpc.tasks.update.useMutation({ onSuccess: (t) => done(t.id) });
  const mutation = editing ? update : create;
  const errors = fieldErrors(mutation.error);
  const set =
    <K extends keyof TaskFormValues>(k: K) =>
    (e: { target: { value: string } }) =>
      setV((s) => ({ ...s, [k]: e.target.value as TaskFormValues[K] }));

  const submit = () => {
    const payload = {
      title: v.title,
      description: v.description || null,
      status: v.status,
      priority: v.priority,
      projectId: v.projectId || null,
      assigneeEmployeeId: v.assigneeEmployeeId || null,
      dueDate: v.dueDate || null,
    };
    if (v.id) update.mutate({ id: v.id, ...payload });
    else create.mutate(payload);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? "Edit task" : "New task"}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mutation.isPending} onClick={submit} disabled={!v.title.trim()}>
            {editing ? "Save changes" : "Create task"}
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
        {mutation.error && Object.keys(errors).length === 0 ? (
          <div className="form-error">{errorMessage(mutation.error)}</div>
        ) : null}
        <TextField
          label="Title"
          required
          autoFocus
          value={v.title}
          onChange={set("title")}
          error={errors.title}
          maxLength={200}
        />
        <TextAreaField
          label="Description"
          value={v.description}
          onChange={set("description")}
          error={errors.description}
          rows={4}
        />
        <div className="form-row">
          <SelectField
            label="Status"
            value={v.status}
            onChange={set("status")}
            options={enumOptions(TASK_STATUSES)}
          />
          <SelectField
            label="Priority"
            value={v.priority}
            onChange={set("priority")}
            options={enumOptions(TASK_PRIORITIES)}
          />
        </div>
        <div className="form-row">
          <SelectField
            label="Assignee"
            value={v.assigneeEmployeeId}
            onChange={set("assigneeEmployeeId")}
            placeholder="Unassigned"
            options={(employees.data ?? []).map((e) => ({
              value: e.id,
              label: `${personName(e.firstName, e.lastName)}${e.jobTitle ? ` — ${e.jobTitle}` : ""}`,
            }))}
            error={errors.assigneeEmployeeId}
          />
          <SelectField
            label="Project"
            value={v.projectId}
            onChange={set("projectId")}
            placeholder="No project"
            options={(projects.data ?? [])
              .filter((p) => p.status !== "CANCELLED" || p.id === v.projectId)
              .map((p) => ({ value: p.id, label: p.name }))}
            error={errors.projectId}
          />
        </div>
        <div className="form-row">
          <TextField
            label="Due date"
            type="date"
            value={v.dueDate}
            onChange={set("dueDate")}
            error={errors.dueDate}
          />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
