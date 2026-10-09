import { Copy, Link2, Trash2, UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate, useSearchParams } from "react-router-dom";
import { ROLES, label, type Role } from "@shared/domain";
import { FEATURE_LABELS } from "@shared/billing";
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
import { errorMessage, fieldErrors, formError, trpc, type RouterOutputs } from "../lib/trpc";

function SettingsTabs() {
  const { can } = useOrg();
  const ref = useRef<HTMLElement>(null);
  // On narrow screens the tab row scrolls; keep the current section visible.
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);
  return (
    <nav className="tabs" aria-label="Settings sections" ref={ref}>
      <NavLink to="/settings" end>
        Organization
      </NavLink>
      <NavLink to="/settings/members">Members</NavLink>
      {can("audit:read") ? <NavLink to="/settings/audit">Audit log</NavLink> : null}
      <NavLink to="/settings/integrations">Integrations</NavLink>
      <NavLink to="/settings/billing">Billing</NavLink>
      <NavLink to="/settings/account">Account</NavLink>
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
  const topError = formError(save.error, ["name", "taskPrefix"]);
  const editable = can("org:update");
  const roleName = label(org.role).toLowerCase();

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title={org.name}
        lede={`You are ${/^[aeiou]/.test(roleName) ? "an" : "a"} ${roleName} of this organization.`}
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
              {topError ? <div className="form-error">{topError}</div> : null}
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
  const [revoking, setRevoking] = useState<{ invitationId: string; email: string } | null>(null);
  const invite = trpc.orgs.invite.useMutation({
    onSuccess: async (res) => {
      await utils.orgs.invitations.invalidate();
      setCreatedLink(`${window.location.origin}/invite/${res.token}`);
    },
  });
  const revoke = trpc.orgs.revokeInvitation.useMutation({
    onSuccess: async () => {
      await utils.orgs.invitations.invalidate();
      toast.success("Invitation revoked.");
      setRevoking(null);
    },
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
                  <Button
                    size="sm"
                    aria-label={`Revoke invitation for ${i.email}`}
                    onClick={() => setRevoking({ invitationId: i.id, email: i.email })}
                  >
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
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke this invitation?"
        body={`The link sent to ${revoking?.email ?? "this person"} stops working immediately. You can invite them again later.`}
        confirmLabel="Revoke invitation"
        danger
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate({ invitationId: revoking.invitationId })}
      />
    </>
  );
}

/**
 * Every entity type the server writes to an organization's audit log, with a readable label.
 * ("user" events — sign-ups, sign-ins, password changes — are account-level with no
 * organization, so they never appear here and are not offered as a filter.)
 */
const ENTITY_TYPES: { value: string; label: string }[] = [
  { value: "task", label: "Tasks" },
  { value: "project", label: "Projects" },
  { value: "employee", label: "Employees" },
  { value: "department", label: "Departments" },
  { value: "approval", label: "Approvals" },
  { value: "document", label: "Documents" },
  { value: "workflow", label: "Workflows" },
  { value: "ai_action", label: "Assistant actions" },
  { value: "membership", label: "Memberships" },
  { value: "invitation", label: "Invitations" },
  { value: "organization", label: "Organization" },
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
            <option key={t.value} value={t.value}>
              {t.label}
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

/** The signed-in user's own security settings (not organization-specific). */
export function AccountPage() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const change = trpc.auth.changePassword.useMutation({
    onSuccess: (r) => {
      setCurrent("");
      setNext("");
      setRepeat("");
      toast.success(
        r.otherSessionsSignedOut > 0
          ? `Password changed. Signed out ${r.otherSessionsSignedOut} other session${r.otherSessionsSignedOut === 1 ? "" : "s"}.`
          : "Password changed.",
      );
    },
  });
  const signOutOthers = trpc.auth.signOutOtherSessions.useMutation({
    onSuccess: (r) => {
      setConfirmSignOut(false);
      toast.success(
        r.otherSessionsSignedOut > 0
          ? `Signed out ${r.otherSessionsSignedOut} other session${r.otherSessionsSignedOut === 1 ? "" : "s"}.`
          : "No other sessions were signed in.",
      );
    },
    onError: (err) => {
      setConfirmSignOut(false);
      toast.error(err);
    },
  });
  const errors = fieldErrors(change.error);
  const topError = formError(change.error, ["newPassword"]);

  return (
    <>
      <PageHeader eyebrow="Settings" title="Your account" lede="Security settings for your sign-in." />
      <SettingsTabs />
      <div className="stack" style={{ maxWidth: 680 }}>
        <Panel title="Change password">
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              if (next !== repeat) {
                setMismatch(true);
                return;
              }
              setMismatch(false);
              change.mutate({ currentPassword: current, newPassword: next });
            }}
          >
            {topError ? <div className="form-error">{topError}</div> : null}
            <TextField
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              maxLength={200}
            />
            <TextField
              label="New password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={10}
              maxLength={200}
              error={errors.newPassword}
              help="At least 10 characters, including a letter and a number. Other devices will be signed out."
            />
            <TextField
              label="Repeat new password"
              type="password"
              autoComplete="new-password"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              required
              maxLength={200}
              error={mismatch ? "The passwords do not match." : undefined}
            />
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <Button type="submit" variant="primary" loading={change.isPending}>
                Change password
              </Button>
            </div>
          </form>
        </Panel>
        <Panel title="Other devices">
          <div className="spread" style={{ flexWrap: "wrap" }}>
            <span className="muted">Sign out every other browser and device where you are signed in.</span>
            <Button onClick={() => setConfirmSignOut(true)}>Sign out other devices</Button>
          </div>
        </Panel>
      </div>
      <ConfirmDialog
        open={confirmSignOut}
        title="Sign out other devices?"
        body="Every other session will need to sign in again. This device stays signed in."
        confirmLabel="Sign out others"
        loading={signOutOthers.isPending}
        onConfirm={() => signOutOthers.mutate()}
        onClose={() => setConfirmSignOut(false)}
      />
    </>
  );
}

const GB = 1024 ** 3;
const bytes = (n: number) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

function UsageRow({
  label,
  used,
  limit,
  format = String,
}: {
  label: string;
  used: number;
  limit: number | null;
  format?: (n: number) => string;
}) {
  if (limit === 0) {
    return (
      <div className="usage-row">
        <div className="spread">
          <span>{label}</span>
          <span className="muted">Not included in this plan</span>
        </div>
      </div>
    );
  }
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="usage-row">
      <div className="spread">
        <span>{label}</span>
        <span className="num muted">
          {format(used)} {limit === null ? "· no limit" : `of ${format(limit)}`}
        </span>
      </div>
      {limit !== null ? (
        <div
          className={pct >= 90 ? "meter full" : "meter"}
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(used, limit)}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** Plan, usage and Stripe checkout/portal. Prices are shown by Stripe at checkout, never invented here. */
export function BillingPage() {
  const toast = useToast();
  const [params] = useSearchParams();
  const status = trpc.billing.status.useQuery();
  const redirect = (r: { url: string }) => window.location.assign(r.url);
  const checkout = trpc.billing.checkout.useMutation({ onSuccess: redirect, onError: toast.error });
  const portal = trpc.billing.portal.useMutation({ onSuccess: redirect, onError: toast.error });
  const result = params.get("checkout");
  const d = status.data;

  return (
    <>
      <PageHeader eyebrow="Settings" title="Billing" lede="Your plan, what it includes, and current usage." />
      <SettingsTabs />
      {result === "success" ? (
        <div className="callout" role="status">
          You returned from Stripe Checkout. The plan below changes only when Stripe confirms the payment to
          FLOWOS, usually within a minute; reload to check.
        </div>
      ) : result === "cancelled" ? (
        <div className="callout" role="status">
          Checkout was cancelled; nothing was charged.
        </div>
      ) : null}
      {status.error ? <ErrorState error={status.error} onRetry={() => void status.refetch()} /> : null}
      {status.isLoading ? <SkeletonRows rows={4} /> : null}
      {d ? (
        <div className="stack" style={{ maxWidth: 760 }}>
          <Panel title="Current plan">
            <div className="spread" style={{ flexWrap: "wrap", gap: 12 }}>
              <div>
                <div className="display" style={{ fontSize: 28 }}>
                  {d.planName}
                </div>
                {d.subscription ? (
                  <span className="muted">
                    Subscription {d.subscription.status.replace("_", " ")}
                    {d.subscription.currentPeriodEnd
                      ? ` · ${d.subscription.cancelAtPeriodEnd ? "ends" : "renews"} ${formatDateTime(d.subscription.currentPeriodEnd)}`
                      : ""}
                  </span>
                ) : !d.billingEnabled ? (
                  <span className="muted">Billing is not enabled on this server: no limits apply.</span>
                ) : null}
              </div>
              {d.canManage && d.billingEnabled && d.subscription ? (
                <Button loading={portal.isPending} onClick={() => portal.mutate()}>
                  Manage billing
                </Button>
              ) : null}
            </div>
            <div className="stack" style={{ marginTop: 16, gap: 12 }}>
              <UsageRow
                label="Members and open invitations"
                used={d.usage.members + d.usage.pendingInvitations}
                limit={d.limits.members}
              />
              <UsageRow label="Workflows" used={d.usage.workflows} limit={d.limits.workflows} />
              <UsageRow
                label="Document storage"
                used={d.usage.storageBytes}
                limit={d.limits.storageBytes}
                format={bytes}
              />
              <UsageRow
                label="Assistant requests this month"
                used={d.usage.aiRequestsThisMonth}
                limit={d.limits.aiRequestsPerMonth}
              />
            </div>
            <p className="definition">
              Included features:{" "}
              {d.features.length
                ? d.features.map((f) => FEATURE_LABELS[f]).join(", ")
                : "none beyond the core product"}
              .
            </p>
          </Panel>
          {d.billingEnabled && d.purchasable.length > 0 && (!d.subscription || d.plan === "FREE") ? (
            <Panel title="Upgrade">
              <div className="grid two">
                {d.purchasable.map((p) => (
                  <div key={p.id} className="plan-card">
                    <h3>{p.name}</h3>
                    <ul className="plain">
                      <li>
                        {p.limits.members === null
                          ? "Unlimited members"
                          : `Up to ${p.limits.members} members`}
                      </li>
                      <li>
                        {p.limits.workflows === null
                          ? "Unlimited workflows"
                          : `Up to ${p.limits.workflows} workflows`}
                      </li>
                      <li>
                        {p.limits.storageBytes === null
                          ? "Unlimited storage"
                          : `${bytes(p.limits.storageBytes)} storage`}
                      </li>
                      <li>
                        {p.limits.aiRequestsPerMonth === null
                          ? "Unlimited assistant use"
                          : `${p.limits.aiRequestsPerMonth.toLocaleString()} assistant requests / month`}
                      </li>
                      {p.features.map((f) => (
                        <li key={f}>{FEATURE_LABELS[f]}</li>
                      ))}
                    </ul>
                    {d.canManage ? (
                      <Button
                        variant="primary"
                        loading={checkout.isPending && checkout.variables?.plan === p.id}
                        disabled={checkout.isPending}
                        onClick={() => checkout.mutate({ plan: p.id })}
                      >
                        Choose {p.name}
                      </Button>
                    ) : (
                      <span className="faint">Only owners can change the plan.</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="definition">
                The price is shown by Stripe before you pay. Payments are handled entirely by Stripe.
              </p>
            </Panel>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

type IntegrationRow = RouterOutputs["integrations"]["list"]["integrations"][number];

function IntegrationCard({
  item,
  canManage,
  usable,
}: {
  item: IntegrationRow;
  canManage: boolean;
  usable: boolean;
}) {
  const toast = useToast();
  const utils = trpc.useUtils();
  const [url, setUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const refresh = () => utils.integrations.list.invalidate();
  const connect = trpc.integrations.connect.useMutation({
    onSuccess: async () => {
      await refresh();
      setUrl("");
      setEditing(false);
      toast.success(`${item.name} connected. Send a test message to check it.`);
    },
  });
  const test = trpc.integrations.test.useMutation({
    onSuccess: async () => {
      await refresh();
      toast.success("Test message sent.");
    },
    onError: async (err) => {
      await refresh();
      toast.error(err);
    },
  });
  const disconnect = trpc.integrations.disconnect.useMutation({
    onSuccess: async () => {
      await refresh();
      setConfirmRemove(false);
      toast.success(`${item.name} disconnected.`);
    },
    onError: (err) => {
      setConfirmRemove(false);
      toast.error(err);
    },
  });
  const c = item.connection;
  const showForm = usable && canManage && item.availability === "available" && (!c || editing);

  return (
    <div className="plan-card">
      <div className="spread" style={{ flexWrap: "wrap", gap: 8 }}>
        <h3>{item.name}</h3>
        {item.availability === "planned" ? (
          <Badge tone="outline">Not available yet</Badge>
        ) : c ? (
          c.status === "active" ? (
            <Badge tone="good">Connected</Badge>
          ) : (
            <Badge tone="critical">Delivery failing</Badge>
          )
        ) : (
          <Badge>Not connected</Badge>
        )}
      </div>
      <span className="muted">{item.description}</span>
      {c ? (
        <div className="faint" style={{ fontSize: 13 }}>
          <span className="mono">{c.hint}</span>
          {c.lastDeliveryAt ? ` · last message ${timeAgo(c.lastDeliveryAt)}` : " · no messages sent yet"}
          {c.lastError ? <div style={{ color: "var(--critical)" }}>{c.lastError}</div> : null}
        </div>
      ) : null}
      {showForm ? (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            connect.mutate({ provider: item.id, webhookUrl: url });
          }}
        >
          <TextField
            label="Webhook URL"
            type="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            maxLength={2000}
            help={item.setupHelp}
            error={connect.error ? errorMessage(connect.error) : undefined}
          />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            {editing ? (
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            ) : null}
            <Button type="submit" variant="primary" loading={connect.isPending}>
              {c ? "Save" : "Connect"}
            </Button>
          </div>
        </form>
      ) : null}
      {c && canManage && !editing ? (
        <div className="row" style={{ flexWrap: "wrap" }}>
          <Button
            size="sm"
            loading={test.isPending}
            disabled={!usable}
            onClick={() => test.mutate({ provider: item.id })}
          >
            Send test message
          </Button>
          <Button size="sm" variant="ghost" disabled={!usable} onClick={() => setEditing(true)}>
            Replace URL
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
            Disconnect
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmRemove}
        title={`Disconnect ${item.name}?`}
        body="Workflows that post to it will fail until it is connected again."
        confirmLabel="Disconnect"
        danger
        loading={disconnect.isPending}
        onConfirm={() => disconnect.mutate({ provider: item.id })}
        onClose={() => setConfirmRemove(false)}
      />
    </div>
  );
}

export function IntegrationsPage() {
  const list = trpc.integrations.list.useQuery();
  const d = list.data;
  const usable = Boolean(d?.serverConfigured && d.includedInPlan);
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Integrations"
        lede="Connect messaging tools so workflows can post to your team's channels. Only what is listed as available works today."
      />
      <SettingsTabs />
      {list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
      {list.isLoading ? <SkeletonRows rows={4} /> : null}
      {d && !d.serverConfigured ? (
        <div className="callout" role="status">
          Integrations are not configured on this server: an administrator needs to set{" "}
          <span className="mono">INTEGRATIONS_ENCRYPTION_KEY</span>.
        </div>
      ) : d && !d.includedInPlan ? (
        <div className="callout" role="status">
          Integrations are not included in your plan. An owner can change it in{" "}
          <NavLink to="/settings/billing">Billing</NavLink>.
        </div>
      ) : null}
      {d ? (
        <>
          <div className="grid two" style={{ maxWidth: 960 }}>
            {d.integrations.map((item) => (
              <IntegrationCard key={item.id} item={item} canManage={d.canManage} usable={usable} />
            ))}
          </div>
          {!d.canManage ? <p className="faint">Only owners and admins can connect integrations.</p> : null}
        </>
      ) : null}
    </>
  );
}
