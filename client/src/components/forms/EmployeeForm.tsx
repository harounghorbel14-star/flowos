import { useState } from "react";
import {
  EMPLOYEE_STATUSES,
  EMPLOYMENT_TYPES,
  type EmployeeStatus,
  type EmploymentType,
} from "@shared/domain";
import { personName } from "../../lib/format";
import { useOrg } from "../../lib/session";
import { errorMessage, fieldErrors, trpc } from "../../lib/trpc";
import { useToast } from "../toast";
import { Button, enumOptions, Modal, SelectField, TextField } from "../ui";

export interface EmployeeFormValues {
  id?: string;
  firstName: string;
  lastName: string;
  email: string;
  jobTitle: string;
  phone: string;
  location: string;
  departmentId: string;
  managerId: string;
  userId: string;
  status: EmployeeStatus;
  employmentType: EmploymentType;
  startDate: string;
  endDate: string;
}

const EMPTY: EmployeeFormValues = {
  firstName: "",
  lastName: "",
  email: "",
  jobTitle: "",
  phone: "",
  location: "",
  departmentId: "",
  managerId: "",
  userId: "",
  status: "ACTIVE",
  employmentType: "FULL_TIME",
  startDate: "",
  endDate: "",
};

export function EmployeeFormDialog(props: {
  open: boolean;
  onClose(): void;
  initial?: Partial<EmployeeFormValues>;
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
  initial?: Partial<EmployeeFormValues>;
  onSaved?(id: string): void;
}) {
  const [v, setV] = useState<EmployeeFormValues>({ ...EMPTY, ...initial });
  const { can } = useOrg();
  const toast = useToast();
  const utils = trpc.useUtils();
  const departments = trpc.departments.list.useQuery();
  const managers = trpc.employees.options.useQuery();
  const members = trpc.orgs.members.useQuery(undefined, { enabled: can("member:read") });
  const editing = Boolean(v.id);
  const done = async (id: string) => {
    await Promise.all([
      utils.employees.invalidate(),
      utils.departments.invalidate(),
      utils.orgs.members.invalidate(),
      utils.dashboard.invalidate(),
    ]);
    toast.success(editing ? "Profile updated." : "Employee added.");
    // Close first: closing rewrites the URL, and onSaved may navigate elsewhere.
    onClose();
    onSaved?.(id);
  };
  const create = trpc.employees.create.useMutation({ onSuccess: (e) => done(e.id) });
  const update = trpc.employees.update.useMutation({ onSuccess: (e) => done(e.id) });
  const mutation = editing ? update : create;
  const errors = fieldErrors(mutation.error);
  const set =
    <K extends keyof EmployeeFormValues>(k: K) =>
    (e: { target: { value: string } }) =>
      setV((s) => ({ ...s, [k]: e.target.value as EmployeeFormValues[K] }));

  const linkable = (members.data ?? []).filter((m) => !m.employeeId || m.userId === initial?.userId);
  const submit = () => {
    const payload = {
      firstName: v.firstName,
      lastName: v.lastName,
      email: v.email,
      jobTitle: v.jobTitle || null,
      phone: v.phone || null,
      location: v.location || null,
      departmentId: v.departmentId || null,
      managerId: v.managerId || null,
      userId: v.userId || null,
      status: v.status,
      employmentType: v.employmentType,
      startDate: v.startDate || null,
      endDate: v.endDate || null,
    };
    if (v.id) update.mutate({ id: v.id, ...payload });
    else create.mutate(payload);
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={editing ? "Edit profile" : "Add employee"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={mutation.isPending}
            onClick={submit}
            disabled={!v.firstName.trim() || !v.lastName.trim() || !v.email.trim()}
          >
            {editing ? "Save changes" : "Add employee"}
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
        <div className="form-row">
          <TextField
            label="First name"
            required
            autoFocus
            value={v.firstName}
            onChange={set("firstName")}
            error={errors.firstName}
          />
          <TextField
            label="Last name"
            required
            value={v.lastName}
            onChange={set("lastName")}
            error={errors.lastName}
          />
        </div>
        <div className="form-row">
          <TextField
            label="Work email"
            type="email"
            required
            value={v.email}
            onChange={set("email")}
            error={errors.email}
          />
          <TextField label="Job title" value={v.jobTitle} onChange={set("jobTitle")} />
        </div>
        <div className="form-row">
          <SelectField
            label="Department"
            value={v.departmentId}
            onChange={set("departmentId")}
            placeholder="No department"
            options={(departments.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
          />
          <SelectField
            label="Manager"
            value={v.managerId}
            onChange={set("managerId")}
            placeholder="No manager"
            options={(managers.data ?? [])
              .filter((m) => m.id !== v.id)
              .map((m) => ({ value: m.id, label: personName(m.firstName, m.lastName) }))}
          />
        </div>
        <div className="form-row">
          <SelectField
            label="Status"
            value={v.status}
            onChange={set("status")}
            options={enumOptions(EMPLOYEE_STATUSES)}
          />
          <SelectField
            label="Employment type"
            value={v.employmentType}
            onChange={set("employmentType")}
            options={enumOptions(EMPLOYMENT_TYPES)}
          />
        </div>
        <div className="form-row">
          <TextField label="Start date" type="date" value={v.startDate} onChange={set("startDate")} />
          <TextField
            label="End date"
            type="date"
            value={v.endDate}
            onChange={set("endDate")}
            error={errors.endDate}
          />
        </div>
        <div className="form-row">
          <TextField label="Phone" value={v.phone} onChange={set("phone")} />
          <TextField label="Location" value={v.location} onChange={set("location")} />
        </div>
        {can("member:read") ? (
          <SelectField
            label="Linked FLOWOS account"
            value={v.userId}
            onChange={set("userId")}
            placeholder="Not linked"
            help="Linking lets this person see work assigned to them. Invitations accepted with a matching email link automatically."
            options={linkable.map((m) => ({ value: m.userId, label: `${m.name} (${m.email})` }))}
          />
        ) : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
