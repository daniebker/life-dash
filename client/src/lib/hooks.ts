import { useEffect, useRef, useState, type RefObject } from "react";

/* Width of an element, kept up to date as it resizes. Charts draw in pixel space from it. */
export function useWidth<T extends HTMLElement>(fallback = 600): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth || fallback);
    const ro = new ResizeObserver(entries => { const w = entries[0]?.contentRect.width; if (w) setWidth(w); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fallback]);
  return [ref, width];
}

/* A value remembered in localStorage (per browser); falls back silently when storage is unavailable. */
export function useStored<T>(key: string, initial: T, valid: (v: unknown) => v is T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); if (raw != null) { const v: unknown = JSON.parse(raw); if (valid(v)) return v; } } catch { /* ignore */ }
    return initial;
  });
  const set = (v: T) => { setValue(v); try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } };
  return [value, set];
}
