import { Copy, Link2, Trash2, UserPlus } from "lucide-react";
import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { ROLES, label, type Role } from "@shared/domain";
import { ROLE_RANK } from "@shared/permissions";
import { useToast } from "../components/toast";
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Modal,
  PageHeader,
  Pagination,
  Panel,
  SelectField,
  SkeletonRows,
  TextField,
} from "../components/ui";
import { formatDateTime, timeAgo } from "../lib/format";
import { useOrg } from "../lib/session";
import { errorMessage, fieldErrors, trpc } from "../lib/trpc";

function SettingsTabs() {
  const { can } = useOrg();
  return (
    <nav className="tabs" aria-label="Settings sections">
      <NavLink to="/settings" end>
        Organization
      </NavLink>
      <NavLink to="/settings/members">Members</NavLink>
      {can("audit:read") ? <NavLink to="/settings/audit">Audit log</NavLink> : null}
    </nav>
  );
}

export function OrgSettingsPage() {
  const { org, can, organizations } = useOrg();
  const toast = useToast();
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const current = trpc.orgs.current.useQuery();
  const [name, setName] = useState<string | null>(null);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const save = trpc.orgs.update.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.orgs.current.invalidate(), utils.auth.me.invalidate()]);
      toast.success("Settings saved.");
      setName(null);
      setPrefix(null);
    },
  });
  const leave = trpc.orgs.leave.useMutation({
    onSuccess: async () => {
      await utils.auth.me.invalidate();
      toast.success(`You left ${org.name}.`);
      navigate("/");
    },
    onError: toast.error,
  });
  const errors = fieldErrors(save.error);
  const editable = can("org:update");

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title={org.name}
        lede={`You are ${label(org.role).toLowerCase() === "admin" ? "an admin" : `a ${label(org.role).toLowerCase()}`} of this organization.`}
      />
      <SettingsTabs />
      {current.error ? <ErrorState error={current.error} /> : null}
      {current.data ? (
        <div className="stack" style={{ maxWidth: 680 }}>
          <Panel title="General">
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate({
                  ...(name !== null ? { name } : {}),
                  ...(prefix !== null ? { taskPrefix: prefix.toUpperCase() } : {}),
                });
              }}
            >
              {save.error && Object.keys(errors).length === 0 ? (
                <div className="form-error">{errorMessage(save.error)}</div>
              ) : null}
              <TextField
                label="Organization name"
                value={name ?? current.data.name}
                onChange={(e) => setName(e.target.value)}
                disabled={!editable}
                error={errors.name}
              />
              <TextField
                label="Task key prefix"
                value={prefix ?? current.data.taskPrefix}
                onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                disabled={!editable}
                error={errors.taskPrefix}
                help={`Tasks are numbered ${prefix ?? current.data.taskPrefix}-1, ${prefix ?? current.data.taskPrefix}-2, …`}
                maxLength={6}
              />
              {editable ? (
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <Button
                    type="submit"
                    variant="primary"
                    loading={save.isPending}
                    disabled={name === null && prefix === null}
                  >
                    Save
                  </Button>
                </div>
              ) : (
                <span className="faint">Only owners and admins can change these settings.</span>
              )}
            </form>
          </Panel>
          <Panel title="Leave organization">
            <div className="spread" style={{ flexWrap: "wrap" }}>
              <span className="muted">
                You will lose access to everything in {org.name}.{" "}
                {organizations.length === 1 ? "You can create or join another organization afterwards." : ""}
              </span>
              <Button variant="danger" onClick={() => setConfirmLeave(true)}>
                Leave
              </Button>
            </div>
          </Panel>
        </div>
      ) : current.isLoading ? (
        <SkeletonRows />
      ) : null}
      <ConfirmDialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title={`Leave ${org.name}?`}
        body="An admin will need to invite you again to regain access."
        confirmLabel="Leave organization"
        danger
        loading={leave.isPending}
        onConfirm={() => leave.mutate()}
      />
    </>
  );
}

export function MembersPage() {
  const { org, user, can } = useOrg();
  const toast = useToast();
  const utils = trpc.useUtils();
  const members = trpc.orgs.members.useQuery();
  const invitations = trpc.orgs.invitations.useQuery(undefined, { enabled: can("member:manage") });
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("MEMBER");
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ membershipId: string; name: string } | null>(null);
  const invite = trpc.orgs.invite.useMutation({
    onSuccess: async (res) => {
      await utils.orgs.invitations.invalidate();
      setCreatedLink(`${window.location.origin}/invite/${res.token}`);
    },
  });
  const revoke = trpc.orgs.revokeInvitation.useMutation({
    onSuccess: () => utils.orgs.invitations.invalidate(),
    onError: toast.error,
  });
  const changeRole = trpc.orgs.changeRole.useMutation({
    onSuccess: async () => {
      await utils.orgs.members.invalidate();
      toast.success("Role updated.");
    },
    onError: toast.error,
  });
  const remove = trpc.orgs.removeMember.useMutation({
    onSuccess: async () => {
      await utils.orgs.members.invalidate();
      toast.success("Member removed.");
      setRemoving(null);
    },
    onError: toast.error,
  });
  const manageable = (target: Role) =>
    can("member:manage") && (org.role === "OWNER" || ROLE_RANK[target] < ROLE_RANK[org.role]);
  const assignableRoles = ROLES.filter((r) => org.role === "OWNER" || ROLE_RANK[r] < ROLE_RANK[org.role]);
  const closeInvite = () => {
    setInviting(false);
    setCreatedLink(null);
    setEmail("");
    invite.reset();
  };

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Members"
        lede="People with access to this organization, and the role that decides what they can do."
        actions={
          can("member:manage") ? (
            <Button variant="primary" onClick={() => setInviting(true)}>
              <UserPlus aria-hidden /> Invite
            </Button>
          ) : null
        }
      />
      <SettingsTabs />
      <div className="stack">
        {members.error ? <ErrorState error={members.error} /> : null}
        <Panel title={`Members${members.data ? ` (${members.data.length})` : ""}`} flush>
          {members.isLoading ? <SkeletonRows /> : null}
          <ul className="list">
            {(members.data ?? []).map((m) => (
              <li key={m.membershipId} className="list-item" style={{ flexWrap: "wrap" }}>
                <Avatar name={m.name} />
                <div className="grow">
                  <div>
                    {m.name} {m.userId === user.id ? <span className="faint">(you)</span> : null}
                  </div>
                  <div className="faint truncate" style={{ fontSize: 12 }}>
                    {m.email} · joined {timeAgo(m.joinedAt)}
                    {m.employeeId ? "" : " · no directory profile"}
                  </div>
                </div>
                {m.userId !== user.id && manageable(m.role) ? (
                  <>
                    <select
                      className="select"
                      style={{ width: "auto", height: 30 }}
                      aria-label={`Role for ${m.name}`}
                      value={m.role}
                      disabled={changeRole.isPending}
                      onChange={(e) =>
                        changeRole.mutate({ membershipId: m.membershipId, role: e.target.value as Role })
                      }
                    >
                      {assignableRoles.concat(assignableRoles.includes(m.role) ? [] : [m.role]).map((r) => (
                        <option key={r} value={r}>
                          {label(r)}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon
                      aria-label={`Remove ${m.name}`}
                      onClick={() => setRemoving({ membershipId: m.membershipId, name: m.name })}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </>
                ) : (
                  <Badge tone={m.role === "OWNER" ? "teal" : undefined}>{label(m.role)}</Badge>
                )}
              </li>
            ))}
          </ul>
        </Panel>
        {can("member:manage") ? (
          <Panel title="Pending invitations" flush>
            {invitations.data && invitations.data.length === 0 ? (
              <EmptyState compact title="No pending invitations" />
            ) : null}
            <ul className="list">
              {(invitations.data ?? []).map((i) => (
                <li key={i.id} className="list-item">
                  <Link2 size={16} aria-hidden className="faint" />
                  <div className="grow">
                    <div>{i.email}</div>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {label(i.role)} · invited by {i.invitedBy ?? "—"} · expires{" "}
                      {formatDateTime(i.expiresAt)}
                    </div>
                  </div>
                  <Button size="sm" onClick={() => revoke.mutate({ invitationId: i.id })}>
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}
        <Panel title="What each role can do">
          <dl className="facts" style={{ gridTemplateColumns: "100px 1fr" }}>
            <dt>Owner</dt>
            <dd>Everything, including managing other owners.</dd>
            <dt>Admin</dt>
            <dd>Manage members below admin, organization settings, audit log, see all approvals.</dd>
            <dt>Manager</dt>
            <dd>Edit people, departments, projects and any task; decide approvals.</dd>
            <dt>Member</dt>
            <dd>Create tasks, update tasks they created or are assigned, comment, request approvals.</dd>
            <dt>Viewer</dt>
            <dd>Read-only access to people, projects and tasks.</dd>
          </dl>
        </Panel>
      </div>

      <Modal
        open={inviting}
        onClose={closeInvite}
        title={createdLink ? "Share this invitation link" : "Invite someone"}
        footer={
          createdLink ? (
            <Button variant="primary" onClick={closeInvite}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={closeInvite}>Cancel</Button>
              <Button
                variant="primary"
                loading={invite.isPending}
                disabled={!email.trim()}
                onClick={() => invite.mutate({ email, role })}
              >
                Create invitation
              </Button>
            </>
          )
        }
      >
        {createdLink ? (
          <div className="form">
            <p className="muted" style={{ margin: 0 }}>
              FLOWOS does not send email yet. Send this single-use link to <strong>{email}</strong> yourself.
              It works only for that email address and expires in 7 days. It will not be shown again.
            </p>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input
                className="input mono"
                readOnly
                value={createdLink}
                aria-label="Invitation link"
                onFocus={(e) => e.target.select()}
              />
              <Button
                icon
                aria-label="Copy link"
                onClick={() => {
                  void navigator.clipboard?.writeText(createdLink).then(
                    () => toast.success("Link copied."),
                    () => toast.error(new Error("Copy failed — select the link and copy it manually.")),
                  );
                }}
              >
                <Copy aria-hidden />
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              invite.mutate({ email, role });
            }}
          >
            {invite.error ? <div className="form-error">{errorMessage(invite.error)}</div> : null}
            <TextField
              label="Email"
              type="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <SelectField
              label="Role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              options={assignableRoles.map((r) => ({ value: r, label: label(r) }))}
            />
            <button type="submit" hidden />
          </form>
        )}
      </Modal>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.name ?? "member"}?`}
        body="They lose access immediately. Their directory profile, tasks and history are kept."
        confirmLabel="Remove member"
        danger
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate({ membershipId: removing.membershipId })}
      />
    </>
  );
}

const ENTITY_TYPES = [
  "task",
  "project",
  "employee",
  "department",
  "approval",
  "membership",
  "invitation",
  "organization",
];

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState("");
  const log = trpc.audit.list.useQuery(
    { page, pageSize: 50, entityType: entityType || undefined },
    { placeholderData: (prev) => prev },
  );
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Audit log"
        lede="An append-only record of every change. Entries cannot be edited or deleted — the database rejects it."
      />
      <SettingsTabs />
      <div className="toolbar">
        <select
          className="select"
          style={{ width: "auto" }}
          aria-label="Entity type"
          value={entityType}
          onChange={(e) => (setEntityType(e.target.value), setPage(1))}
        >
          <option value="">All records</option>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
      </div>
      {log.error ? <ErrorState error={log.error} /> : null}
      {log.isLoading ? <SkeletonRows /> : null}
      {log.data ? (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th className="hide-sm">Action</th>
                </tr>
              </thead>
              <tbody>
                {log.data.items.map((e) => (
                  <tr key={e.id}>
                    <td
                      className="num muted"
                      style={{ whiteSpace: "nowrap" }}
                      title={formatDateTime(e.createdAt)}
                    >
                      {timeAgo(e.createdAt)}
                    </td>
                    <td>{e.actorName ?? <span className="faint">System</span>}</td>
                    <td>{e.summary}</td>
                    <td className="hide-sm key">{e.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={log.data.page}
            pageCount={log.data.pageCount}
            total={log.data.total}
            noun="events"
            onPage={setPage}
          />
        </>
      ) : null}
    </>
  );
}
