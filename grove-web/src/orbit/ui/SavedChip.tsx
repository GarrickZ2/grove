import { useEffect, useState } from "react";

const VISIBLE_MS = 2000;

/** "Saved" confirmation that pops (and draws its check) each time `count` grows. */
export function SavedChip({ count }: { count: number }) {
  const [hiddenCount, setHiddenCount] = useState(0);
  useEffect(() => {
    if (count === 0) return;
    const timer = window.setTimeout(() => setHiddenCount(count), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [count]);
  if (count === 0 || hiddenCount === count) return null;
  return (
    <span key={count} className="oui-chipnote oui-saved" role="status">
      <DrawnCheck />
      Saved
    </span>
  );
}

/** Check mark whose stroke draws itself in (see `.oui-draw`). */
export function DrawnCheck() {
  return (
    <svg className="oui-draw" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
