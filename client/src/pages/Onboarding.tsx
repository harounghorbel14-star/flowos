import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, TextField } from "../components/ui";
import { useToast } from "../components/toast";
import { useSession } from "../lib/session";
import { errorMessage, fieldErrors, trpc } from "../lib/trpc";

export function OnboardingPage() {
  const { organizations, user, switchOrg } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [addMe, setAddMe] = useState(true);
  const create = trpc.orgs.create.useMutation({
    onSuccess: async (org) => {
      await utils.auth.me.invalidate();
      switchOrg(org.id);
      toast.success(`${org.name} is ready.`);
      navigate("/", { replace: true });
    },
  });
  const errors = fieldErrors(create.error);
  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <p className="eyebrow">Set up · step 1 of 1</p>
      <h1 className="display" style={{ margin: "8px 0 12px" }}>
        {organizations.length ? "Create another organization" : `Welcome, ${user.name.split(" ")[0]}.`}
      </h1>
      <p className="muted" style={{ marginBottom: 24 }}>
        An organization is your company’s private workspace. Everything inside it — people, projects, tasks
        and approvals — is isolated from every other organization.
      </p>
      <form
        className="panel panel-body form"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ name, addMeAsEmployee: addMe, jobTitle: jobTitle || null });
        }}
      >
        {create.error && !errors.name ? <div className="form-error">{errorMessage(create.error)}</div> : null}
        <TextField
          label="Organization name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          placeholder="Northwind Studio"
        />
        <label className="checkbox">
          <input type="checkbox" checked={addMe} onChange={(e) => setAddMe(e.target.checked)} />
          Add me to the people directory so tasks can be assigned to me
        </label>
        {addMe ? (
          <TextField
            label="Your job title (optional)"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
          />
        ) : null}
        <div className="row" style={{ justifyContent: "space-between" }}>
          {organizations.length ? (
            <Link to="/">Back to workspace</Link>
          ) : (
            <span className="faint">You can invite your team next.</span>
          )}
          <Button variant="primary" type="submit" loading={create.isPending}>
            Create organization
          </Button>
        </div>
      </form>
      <p className="faint" style={{ marginTop: 16, fontSize: 13 }}>
        Joining an existing company? Ask an admin to invite <strong>{user.email}</strong> and open the link
        they send you.
      </p>
    </div>
  );
}
