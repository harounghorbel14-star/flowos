import { CheckCircle2, X, XCircle } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { prefersReducedMotion } from "../lib/motion";
import { errorMessage } from "../lib/trpc";

interface Toast {
  id: number;
  kind: "success" | "error";
  text: string;
}

interface ToastApi {
  success(text: string): void;
  error(err: unknown): void;
}

const ToastContext = createContext<ToastApi | null>(null);
let nextId = 1;
/** Errors stay longer: they usually need reading. Hover or focus pauses the countdown. */
const LIFETIME = { success: 3500, error: 7000 } as const;
/** --dur-base, the exit animation. */
const EXIT_MS = 180;

function ToastItem({ toast, onGone }: { toast: Toast; onGone(id: number): void }) {
  const [leaving, setLeaving] = useState(false);
  const [paused, setPaused] = useState(false);
  const remaining = useRef<number>(LIFETIME[toast.kind]);

  const dismiss = useCallback(() => {
    if (prefersReducedMotion()) onGone(toast.id);
    else setLeaving(true);
  }, [onGone, toast.id]);

  useEffect(() => {
    if (leaving || paused) return;
    const started = Date.now();
    const timer = window.setTimeout(dismiss, remaining.current);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(1000, remaining.current - (Date.now() - started));
    };
  }, [leaving, paused, dismiss]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => onGone(toast.id), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving, onGone, toast.id]);

  const error = toast.kind === "error";
  return (
    <div
      className={["toast", error && "error", leaving && "leaving"].filter(Boolean).join(" ")}
      // Errors interrupt (assertive); confirmations wait their turn (the polite region below).
      role={error ? "alert" : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {error ? <XCircle size={16} aria-hidden /> : <CheckCircle2 size={16} aria-hidden />}
      <span className="toast-text">{toast.text}</span>
      <button type="button" className="toast-close" onClick={dismiss} aria-label="Dismiss notification">
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = nextId++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
  }, []);
  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const api = useMemo<ToastApi>(
    () => ({
      success: (text: string) => push("success", text),
      error: (err: unknown) => push("error", errorMessage(err)),
    }),
    [push],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onGone={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}
