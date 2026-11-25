import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

/* One shared tooltip. Any element with a data-tip attribute gets it: lines are separated by "\n" and
   the first line is bold. Mouse users see it on hover, touch users on tap. */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const find = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>("[data-tip]") : null);
    const at = (el: HTMLElement | null, x: number, y: number) => setTip(el?.dataset.tip ? { text: el.dataset.tip, x, y } : null);
    const move = (e: PointerEvent) => { if (e.pointerType === "mouse") at(find(e.target), e.clientX, e.clientY); };
    const click = (e: MouseEvent) => at(find(e.target), e.clientX, e.clientY);
    const hide = () => setTip(null);
    document.addEventListener("pointermove", move);
    document.addEventListener("click", click);
    document.addEventListener("scroll", hide, { passive: true });
    return () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("click", click);
      document.removeEventListener("scroll", hide);
    };
  }, []);

  // keep it on screen
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const r = el.getBoundingClientRect();
    let left = tip.x + 12, top = tip.y + 14;
    if (left + r.width > innerWidth - 8) left = tip.x - r.width - 12;
    if (top + r.height > innerHeight - 8) top = tip.y - r.height - 12;
    el.style.left = Math.max(8, left) + "px";
    el.style.top = Math.max(8, top) + "px";
  }, [tip]);

  if (!tip) return null;
  const [first, ...rest] = tip.text.split("\n");
  return (
    <div id="tip" ref={ref} role="tooltip">
      <b>{first}</b>
      {rest.map((line, i) => <Fragment key={i}><br />{line}</Fragment>)}
    </div>
  );
}
