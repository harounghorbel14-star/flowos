import { Building2, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useToast } from "../components/toast";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  SkeletonRows,
  TextAreaField,
  TextField,
} from "../components/ui";
import { useOrg } from "../lib/session";
import { errorMessage, fieldErrors, trpc } from "../lib/trpc";

interface Editing {
  id?: string;
  name: string;
  description: string;
}

export function DepartmentsPage() {
  const { can } = useOrg();
  const toast = useToast();
  const utils = trpc.useUtils();
  const list = trpc.departments.list.useQuery();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string; count: number } | null>(null);
  const refresh = () => Promise.all([utils.departments.invalidate(), utils.employees.invalidate()]);
  const create = trpc.departments.create.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("Department created.");
      setEditing(null);
    },
  });
  const update = trpc.departments.update.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("Department updated.");
      setEditing(null);
    },
  });
  const remove = trpc.departments.delete.useMutation({
    onSuccess: async (res) => {
      await refresh();
      toast.success(
        res.unassignedEmployees
          ? `Department deleted; ${res.unassignedEmployees} people unassigned.`
          : "Department deleted.",
      );
      setDeleting(null);
    },
    onError: toast.error,
  });
  const mutation = editing?.id ? update : create;
  const errors = fieldErrors(mutation.error);
  const save = () => {
    if (!editing) return;
    const payload = { name: editing.name, description: editing.description || null };
    if (editing.id) update.mutate({ id: editing.id, ...payload });
    else create.mutate(payload);
  };
  const open = (value: Editing) => {
    create.reset();
    update.reset();
    setEditing(value);
  };

  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link to="/people">People</Link> / Departments
          </>
        }
        title="Departments"
        lede="Teams people belong to. Headcount excludes terminated employees."
        actions={
          can("department:write") ? (
            <Button variant="primary" onClick={() => open({ name: "", description: "" })}>
              <Plus aria-hidden /> New department
            </Button>
          ) : null
        }
      />
      {list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.isLoading ? (
        <div className="panel">
          <SkeletonRows />
        </div>
      ) : null}
      {list.data && list.data.length === 0 ? (
        <div className="panel">
          <EmptyState icon={<Building2 size={18} />} title="No departments yet">
            Create departments to group people and filter the directory.
          </EmptyState>
        </div>
      ) : null}
      {list.data && list.data.length > 0 ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Department</th>
                <th className="hide-sm">Description</th>
                <th>Headcount</th>
                {can("department:write") ? <th style={{ width: 90 }} /> : null}
              </tr>
            </thead>
            <tbody>
              {list.data.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link className="row-link" to={`/people?department=${d.id}`}>
                      {d.name}
                    </Link>
                  </td>
                  <td className="hide-sm muted">{d.description ?? "—"}</td>
                  <td className="num">{d.employeeCount}</td>
                  {can("department:write") ? (
                    <td>
                      <span className="row" style={{ flexWrap: "nowrap", gap: 2 }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon
                          aria-label={`Edit ${d.name}`}
                          onClick={() => open({ id: d.id, name: d.name, description: d.description ?? "" })}
                        >
                          <Pencil aria-hidden />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon
                          aria-label={`Delete ${d.name}`}
                          onClick={() => setDeleting({ id: d.id, name: d.name, count: d.employeeCount })}
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </span>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? "Edit department" : "New department"}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={mutation.isPending}
              disabled={!editing?.name.trim()}
              onClick={save}
            >
              Save
            </Button>
          </>
        }
      >
        {editing ? (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            {mutation.error && !errors.name ? (
              <div className="form-error">{errorMessage(mutation.error)}</div>
            ) : null}
            <TextField
              label="Name"
              autoFocus
              required
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              error={errors.name}
            />
            <TextAreaField
              label="Description"
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              rows={3}
            />
            <button type="submit" hidden />
          </form>
        ) : null}
      </Modal>
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? "department"}?`}
        body={
          deleting?.count
            ? `${deleting.count} people will be left without a department. Their profiles are kept.`
            : "No one is in this department."
        }
        confirmLabel="Delete department"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate({ id: deleting.id })}
      />
    </>
  );
}
