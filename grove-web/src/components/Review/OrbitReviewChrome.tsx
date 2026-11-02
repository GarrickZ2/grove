import { useMemo, type ReactNode } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Crosshair,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from '../../orbit/ui/Button';
import { Segmented } from '../../orbit/ui/Segmented';
import { PanelHeaderActions } from '../../orbit/ui/PanelShell';
import { usePanelMenuItems, type PanelMenuItem } from '../../orbit/ui/panelSlots';
import './orbit-review.css';

/*
 * Orbit chrome for Code Review (inside the workspace PanelShell).
 *
 * The legacy page header + toolbar are replaced by:
 *   - PanelShell header: Changes / All files + refresh (PanelHeaderActions),
 *     and the view options in the ⋯ menu (usePanelMenuItems).
 *   - A slim bar over the diff: version range, Unified / Split, prev / next
 *     file, the comments sidebar toggle.
 *   - A reviewed-progress summary at the top of the file tree.
 * All state stays in DiffReviewPage; these only render it.
 */

export type ReviewViewMode = 'diff' | 'full';
export type ReviewDisplayMode = 'code' | 'split' | 'preview';

interface OrbitReviewHeaderProps {
  isGitRepo?: boolean;
  viewMode: ReviewViewMode;
  onSetViewMode: (mode: ReviewViewMode) => void;
  refreshing: boolean;
  onRefresh: () => void;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  convSidebarVisible: boolean;
  onToggleConvSidebar: () => void;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  displayMode: ReviewDisplayMode;
  onSetDisplayMode: (mode: ReviewDisplayMode) => void;
  fontSize: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onOpenSearch: () => void;
}

const DISPLAY_LABEL: Record<ReviewDisplayMode, string> = {
  code: 'Show code',
  split: 'Show code and preview',
  preview: 'Show preview',
};

/** Header actions + ⋯ rows. Renders nothing in place; it portals into the shell. */
export function OrbitReviewHeader(props: OrbitReviewHeaderProps) {
  const {
    isGitRepo, viewMode, onSetViewMode, refreshing, onRefresh,
    sidebarVisible, onToggleSidebar, convSidebarVisible, onToggleConvSidebar,
    focusMode, onToggleFocusMode, displayMode, onSetDisplayMode,
    fontSize, onZoomIn, onZoomOut, onZoomReset, onOpenSearch,
  } = props;

  const menu = useMemo<PanelMenuItem[]>(() => [
    { id: 'review-find', label: 'Find in review', icon: Search, onSelect: onOpenSearch },
    {
      id: 'review-tree',
      label: sidebarVisible ? 'Hide file tree' : 'Show file tree',
      icon: sidebarVisible ? PanelLeftClose : PanelLeftOpen,
      onSelect: onToggleSidebar,
    },
    {
      id: 'review-comments',
      label: convSidebarVisible ? 'Hide comments' : 'Show comments',
      icon: MessageSquare,
      onSelect: onToggleConvSidebar,
    },
    {
      id: 'review-focus',
      label: focusMode ? 'Scroll through every file' : 'Focus on one file',
      icon: Crosshair,
      onSelect: onToggleFocusMode,
    },
    ...(['code', 'split', 'preview'] as const).map((mode) => ({
      id: `review-display-${mode}`,
      label: DISPLAY_LABEL[mode],
      icon: displayMode === mode ? Check : undefined,
      onSelect: () => onSetDisplayMode(mode),
    })),
    { id: 'review-zoom-in', label: 'Larger text', icon: ZoomIn, onSelect: onZoomIn },
    { id: 'review-zoom-out', label: 'Smaller text', icon: ZoomOut, onSelect: onZoomOut },
    { id: 'review-zoom-reset', label: `Reset text size (${fontSize}px)`, onSelect: onZoomReset },
  ], [
    onOpenSearch, sidebarVisible, onToggleSidebar, convSidebarVisible, onToggleConvSidebar,
    focusMode, onToggleFocusMode, displayMode, onSetDisplayMode, fontSize, onZoomIn, onZoomOut, onZoomReset,
  ]);
  usePanelMenuItems(menu);

  return (
    <PanelHeaderActions>
      {isGitRepo !== false ? (
        <Segmented
          size="sm"
          ariaLabel="Files to review"
          value={viewMode}
          onChange={onSetViewMode}
          options={[
            { value: 'diff', label: 'Changes', title: 'Only the files this task changed' },
            { value: 'full', label: 'All files', title: 'Every file in the worktree' },
          ]}
          className="orv-scope"
        />
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label="Refresh review"
        title="Refresh review"
        disabled={refreshing}
        onClick={onRefresh}
      >
        <RefreshCw className={refreshing ? 'oui-spin' : undefined} aria-hidden="true" />
      </Button>
    </PanelHeaderActions>
  );
}

interface OrbitReviewBarProps {
  /** Linked-project switcher, when the task links Projects. */
  leading?: ReactNode;
  /** Version range selectors (diff mode only). */
  range?: ReactNode;
  showLayout: boolean;
  viewType: 'unified' | 'split';
  onSetViewType: (type: 'unified' | 'split') => void;
  /** Split is hidden on phones. */
  allowSplit: boolean;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  convSidebarVisible: boolean;
  onToggleConvSidebar: () => void;
  openComments: number;
  warning?: string | null;
  onDismissWarning?: () => void;
}

/** The slim bar over the diff. */
export function OrbitReviewBar({
  leading, range, showLayout, viewType, onSetViewType, allowSplit,
  canPrev, canNext, onPrev, onNext,
  convSidebarVisible, onToggleConvSidebar, openComments,
  warning, onDismissWarning,
}: OrbitReviewBarProps) {
  return (
    <div className="orv-bar">
      {leading ? <div className="orv-bar-leading">{leading}</div> : null}
      {range ? <div className="orv-range" aria-label="Compare versions">{range}</div> : null}
      {warning ? (
        <span className="orv-warn" role="status">
          <span className="orv-warn-text">{warning}</span>
          {onDismissWarning ? (
            <button type="button" className="orv-warn-x" aria-label="Dismiss" onClick={onDismissWarning}><X aria-hidden="true" /></button>
          ) : null}
        </span>
      ) : null}
      <span className="orv-bar-spacer" />
      {showLayout ? (
        allowSplit ? (
          <Segmented
            size="sm"
            ariaLabel="Diff layout"
            value={viewType}
            onChange={onSetViewType}
            options={[{ value: 'unified', label: 'Unified' }, { value: 'split', label: 'Split' }]}
            className="orv-layout"
          />
        ) : null
      ) : null}
      <span className="orv-bar-group">
        <Button variant="ghost" size="sm" iconOnly aria-label="Previous file" title="Previous file" disabled={!canPrev} onClick={onPrev}>
          <ChevronUp aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="sm" iconOnly aria-label="Next file" title="Next file" disabled={!canNext} onClick={onNext}>
          <ChevronDown aria-hidden="true" />
        </Button>
      </span>
      <button
        type="button"
        className={`orv-comments-btn ${convSidebarVisible ? 'is-on' : ''}`}
        aria-pressed={convSidebarVisible}
        aria-label={convSidebarVisible ? 'Hide comments' : 'Show comments'}
        title={convSidebarVisible ? 'Hide comments' : 'Show comments'}
        onClick={onToggleConvSidebar}
      >
        <MessageSquare aria-hidden="true" />
        {openComments > 0 ? <span className="orv-comments-n" key={openComments}>{openComments}</span> : null}
      </button>
    </div>
  );
}

interface OrbitReviewSummaryProps {
  viewed: number;
  total: number;
  /** Diff totals; omitted in All files. */
  additions?: number;
  deletions?: number;
}

/** Reviewed-progress ring at the top of the file tree. */
export function OrbitReviewSummary({ viewed, total, additions, deletions }: OrbitReviewSummaryProps) {
  const radius = 13;
  const circumference = 2 * Math.PI * radius;
  const progress = total > 0 ? viewed / total : 0;
  const done = total > 0 && viewed === total;
  const files = `${total} ${total === 1 ? 'file' : 'files'}`;
  return (
    <div className={`orv-summary ${done ? 'is-done' : ''}`}>
      <svg className="orv-ring" viewBox="0 0 30 30" aria-hidden="true">
        <circle className="orv-ring-bg" cx="15" cy="15" r={radius} />
        <circle
          className="orv-ring-fg"
          cx="15"
          cy="15"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
        />
      </svg>
      <span className="orv-summary-copy">
        <b>{done ? 'All reviewed' : `${viewed} of ${total} reviewed`}</b>
        <span>
          {additions !== undefined && deletions !== undefined ? (
            <>
              <span className="orv-add">+{additions}</span> <span className="orv-del">−{deletions}</span> across {files}
            </>
          ) : files}
        </span>
      </span>
    </div>
  );
}
