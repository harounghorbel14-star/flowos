import { AlertTriangle, ChevronLeft, ChevronRight, Inbox, RotateCw, X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { label as labelOf } from "@shared/domain";
import { errorMessage } from "../lib/trpc";
import { initials } from "../lib/format";

type ButtonVariant = "default" | "primary" | "accent" | "ghost" | "danger";

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: "sm" | "md";
    icon?: boolean;
    loading?: boolean;
  }
>(function Button(
  { variant = "default", size = "md", icon, loading, className, children, disabled, ...rest },
  ref,
) {
  const cls = ["btn", variant !== "default" && variant, size === "sm" && "sm", icon && "icon", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      ref={ref}
      className={cls}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <RotateCw className="spin" aria-hidden /> : null}
      {children}
    </button>
  );
});

export function PageHeader({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="titles">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 className="display">{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}

export function Panel({
  title,
  action,
  children,
  flush,
  className,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={["panel", className].filter(Boolean).join(" ")}>
      {title ? (
        <div className="panel-head">
          {typeof title === "string" ? <h2 className="section-title">{title}</h2> : title}
          {action}
        </div>
      ) : null}
      <div className={flush ? "panel-body flush" : "panel-body"}>{children}</div>
    </section>
  );
}

interface FieldProps {
  label: string;
  error?: string;
  help?: ReactNode;
}

function useFieldIds(error?: string, help?: ReactNode) {
  const id = useId();
  return {
    id,
    describedBy: [error && `${id}-err`, help && `${id}-help`].filter(Boolean).join(" ") || undefined,
  };
}

function FieldShell({ id, label, error, help, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {help ? (
        <span className="help" id={`${id}-help`}>
          {help}
        </span>
      ) : null}
      {error ? (
        <span className="error" id={`${id}-err`} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  error,
  help,
  ...rest
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const { id, describedBy } = useFieldIds(error, help);
  return (
    <FieldShell id={id} label={label} error={error} help={help}>
      <input
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  error,
  help,
  ...rest
}: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { id, describedBy } = useFieldIds(error, help);
  return (
    <FieldShell id={id} label={label} error={error} help={help}>
      <textarea
        id={id}
        className="textarea"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
    </FieldShell>
  );
}

export function SelectField({
  label,
  error,
  help,
  options,
  placeholder,
  ...rest
}: FieldProps &
  SelectHTMLAttributes<HTMLSelectElement> & {
    options: { value: string; label: string }[];
    placeholder?: string;
  }) {
  const { id, describedBy } = useFieldIds(error, help);
  return (
    <FieldShell id={id} label={label} error={error} help={help}>
      <select
        id={id}
        className="select"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export const enumOptions = (values: readonly string[]) =>
  values.map((v) => ({ value: v, label: labelOf(v) }));

const TONES: Record<string, string> = {
  // tasks
  TODO: "",
  IN_PROGRESS: "info",
  BLOCKED: "critical",
  REVIEW: "attention",
  DONE: "good",
  // priorities
  LOW: "outline",
  MEDIUM: "",
  HIGH: "attention",
  URGENT: "critical",
  // projects
  PLANNED: "",
  ACTIVE: "teal",
  ON_HOLD: "attention",
  COMPLETED: "good",
  CANCELLED: "outline",
  // employees
  ON_LEAVE: "attention",
  TERMINATED: "outline",
  // approvals
  PENDING: "attention",
  APPROVED: "good",
  REJECTED: "critical",
};

export function StatusBadge({ value, dot = true }: { value: string; dot?: boolean }) {
  const tone = TONES[value] ?? "";
  return <span className={["badge", tone, dot && "dot"].filter(Boolean).join(" ")}>{labelOf(value)}</span>;
}

export function Badge({ tone, children }: { tone?: string; children: ReactNode }) {
  return <span className={["badge", tone].filter(Boolean).join(" ")}>{children}</span>;
}

export function Avatar({ name, large }: { name: string; large?: boolean }) {
  return (
    <span className={large ? "avatar lg" : "avatar"} aria-hidden>
      {initials(name) || "?"}
    </span>
  );
}

export function Progress({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "empty compact" : "empty"}>
      <div className="empty-icon" aria-hidden>
        {icon ?? <Inbox size={18} />}
      </div>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <span className="row">
        <AlertTriangle size={16} aria-hidden /> {errorMessage(error)}
      </span>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          <RotateCw aria-hidden /> Retry
        </Button>
      ) : null}
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="stack" style={{ gap: 12, padding: 18 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - ((i * 13) % 40)}%` }} />
      ))}
    </div>
  );
}

export function Pagination({
  page,
  pageCount,
  total,
  onPage,
  noun = "items",
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage(page: number): void;
  noun?: string;
}) {
  if (total === 0) return null;
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="num">
        {total} {total === 1 ? noun.replace(/s$/, "") : noun} · page {page} of {pageCount}
      </span>
      <span className="row">
        <Button
          size="sm"
          icon
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft aria-hidden />
        </Button>
        <Button
          size="sm"
          icon
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight aria-hidden />
        </Button>
      </span>
    </nav>
  );
}

/**
 * Accessible modal built on the native <dialog> element: focus is trapped
 * and restored by the browser, and Escape closes it.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={wide ? "modal wide" : "modal"}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open ? (
        <>
          <div className="modal-head">
            <h2 className="section-title" id={titleId}>
              {title}
            </h2>
            <Button variant="ghost" icon size="sm" onClick={onClose} aria-label="Close">
              <X aria-hidden />
            </Button>
          </div>
          <div className="modal-body">{children}</div>
          {footer ? <div className="modal-foot">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  loading,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm(): void;
  onClose(): void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? "danger" : "primary"}
            className={danger ? "solid" : undefined}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="muted">{body}</div>
    </Modal>
  );
}
