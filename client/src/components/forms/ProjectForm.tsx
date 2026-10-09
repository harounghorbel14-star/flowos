import { useState } from "react";
import { PROJECT_STATUSES, type ProjectStatus } from "@shared/domain";
import { personName } from "../../lib/format";
import { fieldErrors, formError, trpc } from "../../lib/trpc";
import { useToast } from "../toast";
import { Button, enumOptions, Modal, SelectField, TextAreaField, TextField } from "../ui";

export interface ProjectFormValues {
  id?: string;
  name: string;
  description: string;
  status: ProjectStatus;
  ownerEmployeeId: string;
  startDate: string;
  dueDate: string;
  memberIds: string[];
}

/** Fields rendered with an inline error; any other field error shows at the top of the form. */
const SHOWN = ["name", "description", "status", "ownerEmployeeId", "startDate", "dueDate"];

const EMPTY: ProjectFormValues = {
  name: "",
  description: "",
  status: "PLANNED",
  ownerEmployeeId: "",
  startDate: "",
  dueDate: "",
  memberIds: [],
};

export function ProjectFormDialog(props: {
  open: boolean;
  onClose(): void;
  initial?: Partial<ProjectFormValues>;
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
  initial?: Partial<ProjectFormValues>;
  onSaved?(id: string): void;
}) {
  const [v, setV] = useState<ProjectFormValues>({ ...EMPTY, ...initial });
  const toast = useToast();
  const utils = trpc.useUtils();
  const employees = trpc.employees.options.useQuery();
  const editing = Boolean(v.id);
  const done = async (id: string) => {
    await Promise.all([utils.projects.invalidate(), utils.dashboard.invalidate()]);
    toast.success(editing ? "Project updated." : "Project created.");
    // Close first: closing rewrites the URL, and onSaved may navigate elsewhere.
    onClose();
    onSaved?.(id);
  };
  const create = trpc.projects.create.useMutation({ onSuccess: (p) => done(p.id) });
  const update = trpc.projects.update.useMutation({ onSuccess: (p) => done(p.id) });
  const mutation = editing ? update : create;
  const errors = fieldErrors(mutation.error);
  const topError = formError(mutation.error, SHOWN);
  const set =
    <K extends keyof ProjectFormValues>(k: K) =>
    (e: { target: { value: string } }) =>
      setV((s) => ({ ...s, [k]: e.target.value as ProjectFormValues[K] }));
  const submit = () => {
    const payload = {
      name: v.name,
      description: v.description || null,
      status: v.status,
      ownerEmployeeId: v.ownerEmployeeId || null,
      startDate: v.startDate || null,
      dueDate: v.dueDate || null,
      memberIds: v.memberIds,
    };
    if (v.id) update.mutate({ id: v.id, ...payload });
    else create.mutate(payload);
  };
  const toggleMember = (id: string) =>
    setV((s) => ({
      ...s,
      memberIds: s.memberIds.includes(id) ? s.memberIds.filter((m) => m !== id) : [...s.memberIds, id],
    }));

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={editing ? "Edit project" : "New project"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mutation.isPending} disabled={!v.name.trim()} onClick={submit}>
            {editing ? "Save changes" : "Create project"}
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
        <TextField
          label="Name"
          required
          autoFocus
          maxLength={120}
          value={v.name}
          onChange={set("name")}
          error={errors.name}
        />
        <TextAreaField
          label="Description"
          maxLength={5000}
          value={v.description}
          onChange={set("description")}
          error={errors.description}
          rows={3}
        />
        <div className="form-row">
          <SelectField
            label="Status"
            value={v.status}
            onChange={set("status")}
            error={errors.status}
            options={enumOptions(PROJECT_STATUSES)}
          />
          <SelectField
            label="Owner"
            value={v.ownerEmployeeId}
            onChange={set("ownerEmployeeId")}
            placeholder="No owner"
            error={errors.ownerEmployeeId}
            options={(employees.data ?? []).map((e) => ({
              value: e.id,
              label: personName(e.firstName, e.lastName),
            }))}
          />
        </div>
        <div className="form-row">
          <TextField
            label="Start date"
            type="date"
            value={v.startDate}
            onChange={set("startDate")}
            error={errors.startDate}
          />
          <TextField
            label="Due date"
            type="date"
            value={v.dueDate}
            onChange={set("dueDate")}
            error={errors.dueDate}
          />
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            Team members
          </legend>
          {(employees.data ?? []).length === 0 ? (
            <span className="faint">Add people to the directory to staff projects.</span>
          ) : (
            <div className="row" style={{ gap: 6 }}>
              {(employees.data ?? []).map((e) => (
                <button
                  type="button"
                  key={e.id}
                  className="chip-toggle"
                  aria-pressed={v.memberIds.includes(e.id)}
                  onClick={() => toggleMember(e.id)}
                >
                  {personName(e.firstName, e.lastName)}
                </button>
              ))}
            </div>
          )}
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
