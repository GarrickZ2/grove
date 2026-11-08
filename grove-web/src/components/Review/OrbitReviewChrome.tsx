import { useMemo, useSyncExternalStore, type ReactNode } from 'react';
import type { ReviewHeaderDensity } from './reviewHeaderDensity';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Code,
  Columns2,
  Eye,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Send,
} from 'lucide-react';
import { Button } from '../../orbit/ui/Button';
import { Segmented } from '../../orbit/ui/Segmented';
import { PanelHeaderActions, PanelHeaderLeading } from '../../orbit/ui/PanelShell';
import { usePanelMenuItems, type PanelMenuItem } from '../../orbit/ui/panelSlots';
import { commandRegistry, effectiveBindings, formatKeyDisplay, userKeymapStore } from '../../keyboard';
import './orbit-review.css';

/*
 * Orbit chrome for Code Review (inside the workspace PanelShell).
 *
 * Everything sits in ONE row, the PanelShell header: the Project beside the
 * title (PanelHeaderLeading), the controls on the right (PanelHeaderActions).
 *   Code Review [project]    [Base → Latest] [Changes | All files] [Unified | Split] [↑ ↓] [comments] [refresh]  ⋯
 * As the panel narrows, the range arrow and Unified / Split go first, then
 * prev / next and the comments toggle fold into ⋯, then Changes / All files,
 * and the Project shrinks to its icon (see reviewHeaderDensity.ts).
 * The ⋯ menu otherwise holds only what isn't visible: find, file tree, focus
 * mode, and the preview mode when the current file can preview.
 * All state stays in DiffReviewPage; this only renders it.
 */

export type ReviewViewMode = 'diff' | 'full';
export type ReviewDisplayMode = 'code' | 'split' | 'preview';
/** The user's current binding for a command, for menu hints. */
function useCommandShortcut(id: string): string | undefined {
  useSyncExternalStore((cb) => userKeymapStore.subscribe(cb), () => userKeymapStore.getVersion());
  const cmd = commandRegistry.listCommands().find((c) => c.id === id);
  if (!cmd) return undefined;
  const binding = effectiveBindings(cmd, userKeymapStore.getAllOverrides().get(cmd.id))[0];
  return binding ? formatKeyDisplay(binding.key) : undefined;
}

const DISPLAY_NEXT: Record<ReviewDisplayMode, ReviewDisplayMode> = { code: 'split', split: 'preview', preview: 'code' };
const DISPLAY_LABEL: Record<ReviewDisplayMode, string> = {
  code: 'Preview: off',
  split: 'Preview: beside code',
  preview: 'Preview: only',
};
const DISPLAY_ICON = { code: Code, split: Columns2, preview: Eye } as const;

interface OrbitReviewHeaderProps {
  density: ReviewHeaderDensity;
  /** Linked-project switcher, when the task links Projects. */
  leading?: ReactNode;
  /** Version selectors (diff mode); null hides the range. */
  rangeFrom?: ReactNode;
  rangeTo?: ReactNode;
  isGitRepo?: boolean;
  viewMode: ReviewViewMode;
  onSetViewMode: (mode: ReviewViewMode) => void;
  viewType: 'unified' | 'split';
  onSetViewType: (type: 'unified' | 'split') => void;
  /** Split is unavailable on phones. */
  allowSplit: boolean;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  convSidebarVisible: boolean;
  onToggleConvSidebar: () => void;
  openComments: number;
  refreshing: boolean;
  onRefresh: () => void;
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  focusMode: boolean;
  onToggleFocusMode: () => void;
  /** The current file has a preview renderer; shows the preview row. */
  canPreview: boolean;
  displayMode: ReviewDisplayMode;
  onSetDisplayMode: (mode: ReviewDisplayMode) => void;
  onOpenSearch: () => void;
  /** Send all open comments to the active chat's agent (asks first). */
  canSendAll: boolean;
  sendAllTitle: string;
  onSendAll: () => void;
}

/** The whole Review toolbar, portalled into the PanelShell header, plus its ⋯ rows. */
export function OrbitReviewHeader(props: OrbitReviewHeaderProps) {
  const {
    density, leading, rangeFrom, rangeTo, isGitRepo, viewMode, onSetViewMode,
    viewType, onSetViewType, allowSplit, canPrev, canNext, onPrev, onNext,
    convSidebarVisible, onToggleConvSidebar, openComments, refreshing, onRefresh,
    sidebarVisible, onToggleSidebar, focusMode, onToggleFocusMode,
    canPreview, displayMode, onSetDisplayMode, onOpenSearch,
    canSendAll, onSendAll,
  } = props;
  const findKeys = useCommandShortcut('diffReview.openSearch');
  const treeKeys = useCommandShortcut('diffReview.toggleSidebar');
  const prevKeys = useCommandShortcut('diffReview.prevFile');
  const nextKeys = useCommandShortcut('diffReview.nextFile');

  const showLayoutInline = density === 'wide' && viewMode === 'diff' && allowSplit;
  const foldLayout = density !== 'wide' && viewMode === 'diff' && allowSplit;
  const foldNav = density === 'narrow' || density === 'compact';
  const foldFiles = density === 'compact' && isGitRepo !== false;
  const commentsLabel = convSidebarVisible ? 'Hide comments' : 'Show comments';

  const menu = useMemo<PanelMenuItem[]>(() => [
    {
      id: 'review-send-all',
      label: openComments > 0 ? `Send ${openComments} to agent` : 'Send comments to agent',
      icon: Send,
      disabled: !canSendAll,
      onSelect: onSendAll,
    },
    { id: 'review-find', label: 'Find in review', icon: Search, shortcut: findKeys, onSelect: onOpenSearch },
    {
      id: 'review-tree',
      label: sidebarVisible ? 'Hide file tree' : 'Show file tree',
      icon: sidebarVisible ? PanelLeftClose : PanelLeftOpen,
      shortcut: treeKeys,
      onSelect: onToggleSidebar,
    },
    // Focus mode has no other control in Orbit, so it keeps one toggle row.
    { id: 'review-focus', label: 'Focus on one file', icon: focusMode ? Check : undefined, onSelect: onToggleFocusMode },
    ...(canPreview ? [{
      id: 'review-display',
      label: DISPLAY_LABEL[displayMode],
      icon: DISPLAY_ICON[displayMode],
      onSelect: () => onSetDisplayMode(DISPLAY_NEXT[displayMode]),
    }] : []),
    // Folded from the header when the panel is narrow.
    ...(foldLayout ? [{
      id: 'review-layout',
      label: viewType === 'split' ? 'Unified view' : 'Split view',
      icon: viewType === 'split' ? Code : Columns2,
      onSelect: () => onSetViewType(viewType === 'split' ? 'unified' : 'split'),
    }] : []),
    ...(foldFiles ? [{
      id: 'review-files',
      label: viewMode === 'diff' ? 'Show all files' : 'Show only changes',
      onSelect: () => onSetViewMode(viewMode === 'diff' ? 'full' : 'diff'),
    }] : []),
    ...(foldNav ? [
      { id: 'review-prev', label: 'Previous file', icon: ChevronUp, shortcut: prevKeys, disabled: !canPrev, onSelect: onPrev },
      { id: 'review-next', label: 'Next file', icon: ChevronDown, shortcut: nextKeys, disabled: !canNext, onSelect: onNext },
      {
        id: 'review-comments',
        label: openComments > 0 ? `${commentsLabel} (${openComments} open)` : commentsLabel,
        icon: MessageSquare,
        onSelect: onToggleConvSidebar,
      },
    ] : []),
  ], [
    canSendAll, onSendAll,
    findKeys, onOpenSearch, sidebarVisible, treeKeys, onToggleSidebar, focusMode, onToggleFocusMode,
    canPreview, displayMode, onSetDisplayMode, foldLayout, viewType, onSetViewType,
    foldFiles, viewMode, onSetViewMode, foldNav, prevKeys, nextKeys, canPrev, canNext, onPrev, onNext, commentsLabel, openComments, onToggleConvSidebar,
  ]);
  usePanelMenuItems(menu);

  return (
    <>
      {leading ? <PanelHeaderLeading><span className={`orv-head-leading is-${density}`}>{leading}</span></PanelHeaderLeading> : null}
      <PanelHeaderActions>
        <span className={`orv-head is-${density}`}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-pressed={sidebarVisible}
            aria-label={sidebarVisible ? 'Hide file tree' : 'Show file tree'}
            title={treeKeys ? `${sidebarVisible ? 'Hide file tree' : 'Show file tree'} (${treeKeys})` : sidebarVisible ? 'Hide file tree' : 'Show file tree'}
            onClick={onToggleSidebar}
          >
            {sidebarVisible ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
          </Button>
          {rangeFrom && rangeTo ? (
            <span className="orv-range" role="group" aria-label="Compare versions">
              {rangeFrom}
              {density === 'wide' ? <span className="orv-range-arrow" aria-hidden="true">&rarr;</span> : null}
              {rangeTo}
            </span>
          ) : null}
          {isGitRepo !== false && !foldFiles ? (
            <Segmented
              size="sm"
              ariaLabel="Files to review"
              value={viewMode}
              onChange={onSetViewMode}
              options={[
                { value: 'diff', label: 'Changes', title: 'Only the files this task changed' },
                { value: 'full', label: 'All files', title: 'Every file in the worktree' },
              ]}
            />
          ) : null}
          {showLayoutInline ? (
            <Segmented
              size="sm"
              ariaLabel="Diff layout"
              value={viewType}
              onChange={onSetViewType}
              options={[{ value: 'unified', label: 'Unified' }, { value: 'split', label: 'Split' }]}
            />
          ) : null}
          {!foldNav ? (
            <>
              <span className="orv-head-group">
                <Button variant="ghost" size="sm" iconOnly aria-label="Previous file" title={prevKeys ? `Previous file (${prevKeys})` : 'Previous file'} disabled={!canPrev} onClick={onPrev}>
                  <ChevronUp aria-hidden="true" />
                </Button>
                <Button variant="ghost" size="sm" iconOnly aria-label="Next file" title={nextKeys ? `Next file (${nextKeys})` : 'Next file'} disabled={!canNext} onClick={onNext}>
                  <ChevronDown aria-hidden="true" />
                </Button>
              </span>
              <button
                type="button"
                className={`orv-comments-btn ${convSidebarVisible ? 'is-on' : ''}`}
                aria-pressed={convSidebarVisible}
                aria-label={commentsLabel}
                title={commentsLabel}
                onClick={onToggleConvSidebar}
              >
                <MessageSquare aria-hidden="true" />
                {openComments > 0 ? <span className="orv-comments-n" key={openComments}>{openComments}</span> : null}
              </button>
            </>
          ) : null}
          <Button variant="ghost" size="sm" iconOnly aria-label="Refresh review" title="Refresh review" disabled={refreshing} onClick={onRefresh}>
            <RefreshCw className={refreshing ? 'oui-spin' : undefined} aria-hidden="true" />
          </Button>
        </span>
      </PanelHeaderActions>
    </>
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
