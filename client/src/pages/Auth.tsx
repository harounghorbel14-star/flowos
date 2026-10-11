import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { label } from "@shared/domain";
import { LogoMark, Wordmark } from "../components/brand";
import { Button, EmptyState, ErrorState, PasswordField, TextField } from "../components/ui";
import { useToast } from "../components/toast";
import {
  INTRO_MS,
  INTRO_SCALE,
  markIntroPlayed,
  readIntroMode,
  readMotionPaused,
  writeMotionPaused,
} from "../lib/brand";
import { prefersReducedMotion } from "../lib/motion";
import { errorMessage, fieldErrors, formError, trpc } from "../lib/trpc";

const LOOP = ["SEE", "UNDERSTAND", "DECIDE", "EXECUTE", "LEARN"];

/**
 * The branded entry. The intro plays in the art panel only (full on a first visit, short for a
 * returning visitor, never twice in a session, never under reduced motion); the form beside it
 * works from the first frame. Skip with the button or Escape; afterwards the same control
 * pauses the ambient motion. `busy` reflects a real request in flight.
 */
function AuthLayout({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  const [reduced] = useState(prefersReducedMotion);
  const [mode] = useState(() => readIntroMode(reduced));
  const [phase, setPhase] = useState<"intro" | "idle">(mode === "none" ? "idle" : "intro");
  const [paused, setPaused] = useState(readMotionPaused);
  const artRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // The mark performs at the centre of the panel, then settles where it rests: measure that
  // offset (layout positions, unaffected by transforms) before the first frame paints.
  useLayoutEffect(() => {
    const art = artRef.current;
    const stage = stageRef.current;
    if (mode === "none" || !art || !stage) return;
    const dx = art.clientWidth / 2 - (stage.offsetLeft + stage.offsetWidth / 2);
    const dy = art.clientHeight / 2 - (stage.offsetTop + stage.offsetHeight / 2);
    art.style.setProperty("--stage-x", `${Math.round(dx)}px`);
    art.style.setProperty("--stage-y", `${Math.round(dy)}px`);
  }, [mode]);

  useEffect(() => {
    if (mode === "none") return;
    markIntroPlayed();
    const timer = window.setTimeout(() => setPhase("idle"), INTRO_MS[mode]);
    return () => window.clearTimeout(timer);
  }, [mode]);

  useEffect(() => {
    if (phase !== "intro") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPhase("idle");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [phase]);

  const toggleMotion = () => {
    const next = !paused;
    setPaused(next);
    writeMotionPaused(next);
  };

  return (
    <div className="auth">
      <aside
        ref={artRef}
        className="auth-art"
        data-intro={mode}
        data-phase={phase}
        data-ambient={paused ? "paused" : "on"}
        style={{ "--t": INTRO_SCALE[mode] || 1 } as CSSProperties}
      >
        {reduced ? null : phase === "intro" ? (
          <button type="button" className="intro-control" onClick={() => setPhase("idle")}>
            Skip intro
          </button>
        ) : (
          <button type="button" className="intro-control" onClick={toggleMotion}>
            {paused ? "Play animation" : "Pause animation"}
          </button>
        )}
        <div className="auth-stage" ref={stageRef}>
          <div className="auth-emblem">
            <span className="brand-aura" aria-hidden />
            <LogoMark
              size={104}
              tone="on-dark"
              reveal={phase === "intro"}
              glint={!reduced}
              state={busy ? "working" : "idle"}
            />
          </div>
          <Wordmark className="auth-wordmark" height={22} />
        </div>
        <h1>
          The operating system for how your company <em>actually</em> runs.
        </h1>
        <p className="loop">
          {LOOP.map((word, i) => (
            <Fragment key={word}>
              {i > 0 ? " " : null}
              <span style={{ "--i": i } as CSSProperties}>
                {word === "EXECUTE" ? <b>{word}</b> : word}
                {i < LOOP.length - 1 ? "\u00a0→" : null}
              </span>
            </Fragment>
          ))}
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
    <AuthLayout busy={login.isPending}>
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
    <AuthLayout busy={signup.isPending}>
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
    <AuthLayout busy={request.isPending}>
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
    <AuthLayout busy={reset.isPending}>
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
    <AuthLayout busy={accept.isPending}>
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
