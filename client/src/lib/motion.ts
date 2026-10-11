/** Motion helpers. Durations and easings live in styles.css (--dur-*, --ease*). */

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Longest exit animation (--dur-base) plus slack: the fallback if animationend never fires. */
const EXIT_FALLBACK_MS = 260;

/**
 * Open or close a native <dialog> to match `open`, playing the `.closing` exit animation
 * before the dialog leaves the top layer. While it plays, the dialog is inert and hidden
 * from assistive technology, so nothing can interact with what is going away. With reduced
 * motion it closes at once. Returns a cleanup for useEffect (re-opening mid-exit is safe).
 */
export function syncDialog(dialog: HTMLDialogElement, open: boolean, onClosed?: () => void): () => void {
  const reset = () => {
    dialog.classList.remove("closing");
    dialog.removeAttribute("aria-hidden");
    dialog.inert = false;
  };
  if (open) {
    reset();
    if (!dialog.open) dialog.showModal();
    return () => {};
  }
  if (!dialog.open) {
    onClosed?.();
    return () => {};
  }
  let timer = 0;
  const finish = () => {
    window.clearTimeout(timer);
    dialog.removeEventListener("animationend", onEnd);
    reset();
    if (dialog.open) dialog.close();
    onClosed?.();
  };
  const onEnd = (e: AnimationEvent) => {
    if (e.target === dialog) finish();
  };
  if (prefersReducedMotion()) {
    finish();
    return () => {};
  }
  dialog.classList.add("closing");
  dialog.setAttribute("aria-hidden", "true");
  dialog.inert = true;
  dialog.addEventListener("animationend", onEnd);
  timer = window.setTimeout(finish, EXIT_FALLBACK_MS);
  return () => {
    window.clearTimeout(timer);
    dialog.removeEventListener("animationend", onEnd);
  };
}
