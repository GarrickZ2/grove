import type { ReactNode } from 'react';
import { useOrbitInterface } from '../../orbit/ui/interfaceContext';
import './diffTheme.css';
import './orbit-review.css';
import './review-comments.css';

/** Code Review's comment list and cards, outside the Review page. */
export function ReviewComments({ children }: { children: ReactNode }) {
  const orbit = useOrbitInterface();
  return <div className={`review-comments${orbit ? ' is-orbit orbit-ui' : ''}`}>{children}</div>;
}
