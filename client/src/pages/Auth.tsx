import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { label } from "@shared/domain";
import { Button, EmptyState, ErrorState, PasswordField, TextField } from "../components/ui";
import { useToast } from "../components/toast";
import { errorMessage, fieldErrors, formError, trpc } from "../lib/trpc";

function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-art">
        <div className="row">
          <span className="brand-mark" aria-hidden>
            F
          </span>
          <span className="brand-name">FLOWOS</span>
        </div>
        <h1>
          The operating system for how your company <em>actually</em> runs.
        </h1>
        <p className="loop">
          SEE → UNDERSTAND → DECIDE → <b>EXECUTE</b> → LEARN
        </p>
      </aside>
      <section className="auth-panel">{children}</section>
    </div>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // On success the /login route itself redirects to ?next= once `me` refreshes.
  const login = trpc.auth.login.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password });
  };
  return (
    <AuthLayout>
      <div className="stack" style={{ gap: 8 }}>
        <p className="eyebrow">Welcome back</p>
        <h2 className="display" style={{ fontSize: 32 }}>
          Sign in
        </h2>
      </div>
      <form onSubmit={submit} noValidate>
        {login.error ? (
          <div className="form-error" role="alert">
            {errorMessage(login.error)}
          </div>
        ) : null}
        <TextField
          label="Work email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <PasswordField
          label="Password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: -6 }}>
          <Link to="/forgot-password" state={{ email }} style={{ fontSize: 13 }}>
            Forgot password?
          </Link>
        </div>
        <Button variant="primary" type="submit" loading={login.isPending}>
          Sign in
        </Button>
      </form>
      <p className="muted">
        New to FLOWOS?{" "}
        <Link to={`/signup${params.get("next") ? `?next=${encodeURIComponent(params.get("next")!)}` : ""}`}>
          Create an account
        </Link>
      </p>
    </AuthLayout>
  );
}

export function SignupPage() {
  const utils = trpc.useUtils();
  const [params] = useSearchParams();
  const next = params.get("next");
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const signup = trpc.auth.signup.useMutation({ onSuccess: () => utils.auth.me.invalidate() });
  const errors = fieldErrors(signup.error);
  const topError = formError(signup.error, ["name", "email", "password"]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <AuthLayout>
      <div className="stack" style={{ gap: 8 }}>
        <p className="eyebrow">Get started</p>
        <h2 className="display" style={{ fontSize: 32 }}>
          Create your account
        </h2>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          signup.mutate(form);
        }}
        noValidate
      >
        {topError ? (
          <div className="form-error" role="alert">
            {topError}
          </div>
        ) : null}
        <TextField
          label="Full name"
          autoComplete="name"
          required
          value={form.name}
          onChange={set("name")}
          error={errors.name}
        />
        <TextField
          label="Work email"
          type="email"
          autoComplete="email"
          required
          value={form.email}
          onChange={set("email")}
          error={errors.email}
        />
        <PasswordField
          label="Password"
          autoComplete="new-password"
          required
          value={form.password}
          onChange={set("password")}
          error={errors.password}
          help="At least 10 characters, including a letter and a number."
        />
        <Button variant="primary" type="submit" loading={signup.isPending}>
          Create account
        </Button>
      </form>
      <p className="muted">
        Already have an account?{" "}
        <Link to={`/login${next ? `?next=${encodeURIComponent(next)}` : ""}`}>Sign in</Link>
      </p>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const location = useLocation();
  const initial = (location.state as { email?: unknown } | null)?.email;
  const [email, setEmail] = useState(typeof initial === "string" ? initial : "");
  const request = trpc.auth.requestPasswordReset.useMutation();
  const errors = fieldErrors(request.error);
  const topError = formError(request.error, ["email"]);
  return (
    <AuthLayout>
      <div className="stack" style={{ gap: 8 }}>
        <p className="eyebrow">Forgot password</p>
        <h2 className="display" style={{ fontSize: 32 }}>
          Reset your password
        </h2>
      </div>
      {request.data?.emailEnabled ? (
        <div className="stack" role="status">
          <p>
            If an account exists for <strong>{request.variables?.email}</strong>, we sent it a link to choose
            a new password. The link works once and expires in 1 hour.
          </p>
          <p className="muted">No email? Check your spam folder, or try again in a few minutes.</p>
        </div>
      ) : request.data ? (
        <div className="stack" role="status">
          <p>
            This FLOWOS server cannot send email yet, so it cannot email you a reset link. Ask the person who
            runs FLOWOS for your organization to create a reset link for you.
          </p>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            request.mutate({ email });
          }}
          noValidate
        >
          {topError ? (
            <div className="form-error" role="alert">
              {topError}
            </div>
          ) : null}
          <TextField
            label="Work email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={errors.email}
            help="We will send a link to choose a new password."
          />
          <Button variant="primary" type="submit" loading={request.isPending}>
            Send reset link
          </Button>
        </form>
      )}
      <p className="muted">
        Remembered it? <Link to="/login">Back to sign in</Link>
      </p>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const utils = trpc.useUtils();
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const reset = trpc.auth.resetPassword.useMutation({
    onSuccess: async () => {
      // Every session was signed out, including this browser's if it had one.
      await utils.auth.me.invalidate();
      toast.success("Password changed. Sign in with your new password.");
      navigate("/login", { replace: true });
    },
  });
  const errors = fieldErrors(reset.error);
  const topError = formError(reset.error, ["password"]);
  return (
    <AuthLayout>
      <div className="stack" style={{ gap: 8 }}>
        <p className="eyebrow">Reset password</p>
        <h2 className="display" style={{ fontSize: 32 }}>
          Choose a new password
        </h2>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (password !== repeat) {
            setMismatch(true);
            return;
          }
          setMismatch(false);
          reset.mutate({ token, password });
        }}
        noValidate
      >
        {topError ? (
          <div className="form-error" role="alert">
            {topError}
          </div>
        ) : null}
        <PasswordField
          label="New password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          help="At least 10 characters, including a letter and a number."
        />
        <PasswordField
          label="Repeat new password"
          autoComplete="new-password"
          required
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          error={mismatch ? "The passwords do not match." : undefined}
        />
        <Button variant="primary" type="submit" loading={reset.isPending}>
          Set new password
        </Button>
      </form>
      <p className="muted">
        Link expired? <Link to="/forgot-password">Request a new one</Link>
      </p>
    </AuthLayout>
  );
}

export function AcceptInvitePage({ signedIn }: { signedIn: boolean }) {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const utils = trpc.useUtils();
  const preview = trpc.orgs.previewInvitation.useQuery({ token }, { retry: false });
  const accept = trpc.orgs.acceptInvitation.useMutation({
    onSuccess: async (res) => {
      try {
        localStorage.setItem("flowos.activeOrg", res.orgId);
      } catch {
        /* ignore */
      }
      await utils.auth.me.invalidate();
      toast.success("Welcome aboard.");
      navigate("/", { replace: true });
    },
  });
  const next = encodeURIComponent(`/invite/${token}`);
  return (
    <AuthLayout>
      {preview.isLoading ? <span className="eyebrow">Checking invitation…</span> : null}
      {preview.error ? (
        <EmptyState title="Invitation not found">
          This link is invalid. Ask your admin for a new invitation.
        </EmptyState>
      ) : null}
      {preview.data ? (
        <div className="stack">
          <div className="stack" style={{ gap: 8 }}>
            <p className="eyebrow">Invitation</p>
            <h2 className="display" style={{ fontSize: 32 }}>
              Join {preview.data.orgName}
            </h2>
            <p className="muted">
              You were invited as <strong>{label(preview.data.role)}</strong> using{" "}
              <strong>{preview.data.email}</strong>.
            </p>
          </div>
          {preview.data.state !== "PENDING" ? (
            <div className="form-error">This invitation is {preview.data.state.toLowerCase()}.</div>
          ) : signedIn ? (
            <>
              {accept.error ? <ErrorState error={accept.error} /> : null}
              <Button variant="primary" loading={accept.isPending} onClick={() => accept.mutate({ token })}>
                Accept invitation
              </Button>
            </>
          ) : (
            <div className="row">
              <Link className="btn primary" to={`/signup?next=${next}`}>
                Create account
              </Link>
              <Link className="btn" to={`/login?next=${next}`}>
                Sign in
              </Link>
            </div>
          )}
        </div>
      ) : null}
    </AuthLayout>
  );
}
