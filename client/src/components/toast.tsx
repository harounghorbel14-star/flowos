import { CheckCircle2, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = nextId++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  const api: ToastApi = {
    success: useCallback((text: string) => push("success", text), [push]),
    error: useCallback((err: unknown) => push("error", errorMessage(err)), [push]),
  };
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={t.kind === "error" ? "toast error" : "toast"}>
            {t.kind === "error" ? <XCircle size={16} aria-hidden /> : <CheckCircle2 size={16} aria-hidden />}
            <span>{t.text}</span>
          </div>
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
