import { useEffect, useState } from "react";

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

/** What each counter last showed, so revisiting a page or a refetch with the same value never replays. */
const lastShown = new Map<string, number>();

/**
 * A number that eases to `value` when it first appears and whenever it actually changes.
 * `key` identifies the counter across remounts. Integers only; reduced motion shows the value.
 */
export function useCountUp(value: number, key: string, durationMs = 560): number {
  const from = lastShown.get(key) ?? 0;
  const [shown, setShown] = useState(prefersReducedMotion() ? value : from);
  useEffect(() => {
    const start = lastShown.get(key) ?? 0;
    lastShown.set(key, value);
    if (start === value || prefersReducedMotion()) {
      setShown(value);
      return;
    }
    let frame = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - (1 - p) ** 3; // ease-out cubic, like --ease
      setShown(Math.round(start + (value - start) * eased));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      setShown(value);
    };
  }, [value, key, durationMs]);
  return shown;
}
