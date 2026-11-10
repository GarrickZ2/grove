import { useCallback, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { AnimatePresence, MotionConfig } from "framer-motion";
import {
  ArrowDownAZ, ArrowUpFromLine, ArrowUpDown, Check, ChevronLeft, ChevronRight, CircleAlert, Clock, Download, Edit3, Eye,
  FileArchive, Folder, FolderOpen, FolderSearch, HardDrive, House, LayoutGrid, Link as LinkIcon, Link2, List, Loader2, Minus, MoreHorizontal,
  RefreshCw, Search, SquareArrowOutUpRight, Trash2, Upload, X,
} from "lucide-react";
import type { Task } from "../../../data/types";
import { type ArtifactFile, type ArtifactWorkDirectoryEntry } from "../../../api";
import {
  AddLinkDialog, FileConflictDialog, FilePreviewDrawer, VSCodeIcon, formatSize, isLinkFile, linkDisplayName, hostnameOf,
} from "../../../components/ui";
import { useArtifactsPanel, type ArtifactPreviewRequest, type ArtifactsPanel, type PendingUpload, type SharedArtifacts } from "../../../components/Tasks/TaskInfoPanel/tabs/useArtifactsPanel";
import {
  dragCarriesGrovePath, dropContainsDirectory, parentPath,
} from "../../../components/Tasks/TaskInfoPanel/tabs/artifactsModel";
import { beginGroveFileDrag, endGroveFileDrag, setGroveFileDrag } from "../../../utils/groveFileDrag";
import {
  Button, HoldButton, LOCALE, PanelEmpty, PanelError, PanelHeaderActions, PanelHeaderContext, SearchField, formatDateTime,
  shortAgo, useInPanelShell, useNow, usePanelMenuItems, type PanelMenuItem,
} from "../../ui";
import { ActionMenu, type ActionItem } from "../../studio/ActionMenu";
import { useActionMenu } from "../../studio/useActionMenu";
import { useSignedUrl } from "../../studio/useSignedUrl";
import { extLabel, fileKind, hostFileActionsAvailable, revealLabel } from "../../studio/studioView";
import {
  artifactDragFiles,
  KIND_LABELS, arrangeEntries, breadcrumbTrail, defaultSource, existingFolder, fileCount, gridColumns, indexFolders,
  kindCounts, scopeEntries, totalsFor,
  type ArtifactEntry, type ArtifactSort, type FolderIndex, type ArtifactSource, type ArtifactView, type KindFilter,
} from "./artifactsView";
import { useScrollViewport, useWindowedRows } from "./useWindowedRows";
import "../../studio/orbit-studio.css";
import "./orbit-artifacts.css";

const ROW_HEIGHT = 44;
const TILE_HEIGHT = 140;
const TILE_GAP = 10;
const TILE_MIN = 132;
const LIST_PAD = 6;
const GRID_PAD = 12;
const SKELETON_ROWS = 7;
const CLOCK_MS = 60_000;
const PREFS_KEY = "grove.orbit.artifacts.prefs";
const RASTER = /\.(png|jpe?g|webp|gif|bmp|ico)$/i;

const SOURCE_ROOT: Record<Exclude<ArtifactSource, "linked">, string> = { output: "Outputs", input: "Uploads" };
const SORT_LABEL: Record<ArtifactSort, string> = { recent: "Recent", name: "Name", size: "Size" };

interface Props {
  projectId?: string;
  task: Task;
  previewRequest?: ArtifactPreviewRequest | null;
  lastChatIdleAt?: number;
  isChatBusy?: boolean;
  /** A Task someone shared: its output files, read only. */
  shared?: SharedArtifacts;
}

interface Prefs { view: ArtifactView; sort: ArtifactSort }

function readPrefs(): Prefs {
  const fallback: Prefs = { view: "list", sort: "recent" };
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      view: parsed.view === "grid" ? "grid" : "list",
      sort: parsed.sort === "name" || parsed.sort === "size" ? parsed.sort : "recent",
    };
  } catch {
    return fallback;
  }
}

function writePrefs(prefs: Prefs) {
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* per-viewer convenience only */ }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString(LOCALE)} ${n === 1 ? one : many}`;

const NO_SELECTION: ReadonlySet<string> = new Set();

/** Multi-selection of the rows in the current folder view, keyed by artifact path. */
interface Selection {
  has: (path: string) => boolean;
  /** True once anything is selected: a plain click then toggles instead of opening. */
  active: boolean;
  /** Click / keyboard entry point: toggles, or with `range` selects from the anchor. */
  pick: (path: string, range: boolean) => void;
  /** The selected files, in view order (for multi-file drags). */
  files: readonly ArtifactFile[];
}

/** Ctrl/⌘+click toggles, Shift+click selects a range, and while a selection exists a plain click toggles too. */
function selectionGesture(event: MouseEvent, selection: Selection): "toggle" | "range" | null {
  if (event.shiftKey) return "range";
  if (event.metaKey || event.ctrlKey || selection.active) return "toggle";
  return null;
}

/**
 * Orbit body of the task Artifacts panel (no frame or title; the workspace
 * shell owns those). Three sources — what the agent wrote (`output/`), what
 * you gave it (`input/`) and linked host folders — each with folder
 * navigation, search across the folder's subtree, kind filter, sort, and a
 * windowed list or grid so thousands of files stay smooth.
 */
export function OrbitArtifactsPanel(props: Props) {
  const [source, setSource] = useState<ArtifactSource | null>(null);
  const [paths, setPaths] = useState<Record<"output" | "input", string>>({ output: "", input: "" });
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [prefs, setPrefsState] = useState<Prefs>(readPrefs);
  const [direction, setDirection] = useState<"in" | "out" | "none">("none");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const setPrefs = (next: Partial<Prefs>) => {
    setPrefsState((current) => {
      const merged = { ...current, ...next };
      writePrefs(merged);
      return merged;
    });
  };

  const revealTarget = useCallback((file: ArtifactFile) => {
    if (file.directory !== "input" && file.directory !== "output") return;
    const dir = file.directory;
    setSource(dir);
    setPaths((current) => ({ ...current, [dir]: parentPath(file.path) }));
    setQuery("");
    setKind("all");
  }, []);

  const panel = useArtifactsPanel({ ...props, onRevealTarget: revealTarget });
  const { inputFiles, outputFiles, workdirs, isLoading, error, setError, previewFile, syncConflict, editLink } = panel;

  const readOnly = panel.readOnly;
  const active: ArtifactSource = readOnly ? "output" : source ?? defaultSource({ input: inputFiles, output: outputFiles });
  const files = active === "input" ? inputFiles : outputFiles;
  const index = useMemo(() => indexFolders(files), [files]);
  const folder = active === "linked" ? "" : existingFolder(paths[active], index);
  const scope = useMemo(() => (active === "linked" ? [] : scopeEntries(files, folder, query)), [active, files, folder, query]);
  const kinds = useMemo(() => kindCounts(scope), [scope]);
  // A kind filter that no longer has files here falls back to everything.
  const effectiveKind: KindFilter = kind !== "all" && kinds.some((entry) => entry.kind === kind) ? kind : "all";
  const entries = useMemo(
    () => arrangeEntries(scope, { kind: effectiveKind, sort: prefs.sort }, index),
    [scope, effectiveKind, prefs.sort, index],
  );

  // Selection belongs to one folder view: moving elsewhere drops it.
  const scopeKey = `${active}/${folder}`;
  const [selectionState, setSelectionState] = useState<{ key: string; paths: Set<string>; anchor: string | null }>({ key: "", paths: new Set(), anchor: null });
  const selected = selectionState.key === scopeKey ? selectionState.paths : NO_SELECTION;
  const selectedEntries = useMemo(() => entries.filter((entry) => selected.has(entry.file.path)), [entries, selected]);
  const clearSelection = useCallback(() => setSelectionState({ key: "", paths: new Set(), anchor: null }), []);
  const pick = useCallback((path: string, range: boolean) => {
    setSelectionState((current) => {
      const same = current.key === scopeKey;
      const paths = new Set(same ? current.paths : []);
      const anchor = same ? current.anchor : null;
      const anchorAt = anchor ? entries.findIndex((entry) => entry.file.path === anchor) : -1;
      const at = entries.findIndex((entry) => entry.file.path === path);
      if (range && anchorAt >= 0 && at >= 0) {
        const [from, to] = anchorAt < at ? [anchorAt, at] : [at, anchorAt];
        for (let i = from; i <= to; i += 1) paths.add(entries[i].file.path);
        return { key: scopeKey, paths, anchor };
      }
      if (paths.has(path)) paths.delete(path);
      else paths.add(path);
      return { key: scopeKey, paths, anchor: path };
    });
  }, [entries, scopeKey]);
  const selectAll = useCallback(() => {
    setSelectionState({ key: scopeKey, paths: new Set(entries.map((entry) => entry.file.path)), anchor: entries[0]?.file.path ?? null });
  }, [entries, scopeKey]);
  const selection = useMemo<Selection>(() => ({
    has: (path) => selected.has(path),
    active: selectedEntries.length > 0,
    pick,
    files: selectedEntries.map((entry) => entry.file),
  }), [selected, selectedEntries, pick]);

  const navigate = (next: string, dir: "in" | "out") => {
    if (active === "linked") return;
    setDirection(dir);
    setPaths((current) => ({ ...current, [active]: next }));
    setQuery("");
    setKind("all");
  };

  const pickSource = (next: ArtifactSource) => {
    setDirection("none");
    setSource(next);
    setQuery("");
    setKind("all");
  };

  const openFilePicker = () => fileInputRef.current?.click();

  const upload = (list: FileList | File[]) => {
    if (list.length === 0) return;
    // Uploads land in input/ — show them arriving there.
    setSource("input");
    setPaths((current) => ({ ...current, input: "" }));
    setQuery("");
    setKind("all");
    void panel.handleUpload(list);
  };

  const resetDrag = () => { dragDepth.current = 0; setDragging(false); };
  const dropProps = {
    onDragEnter: (event: DragEvent) => {
      if (dragCarriesGrovePath(event.dataTransfer) || !event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent) => {
      if (dragCarriesGrovePath(event.dataTransfer)) return;
      event.preventDefault();
    },
    onDragLeave: (event: DragEvent) => {
      if (dragCarriesGrovePath(event.dataTransfer) || dragDepth.current === 0) return;
      dragDepth.current -= 1;
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (dragCarriesGrovePath(event.dataTransfer)) { resetDrag(); return; }
      event.preventDefault();
      resetDrag();
      if (dropContainsDirectory(event.dataTransfer)) {
        setError("Folders can’t be dropped. Link the folder instead, or drop the files inside it.");
        return;
      }
      if (event.dataTransfer.files.length > 0) upload(event.dataTransfer.files);
    },
  };

  const refresh = () => { void panel.loadFiles(); void panel.loadWorkdirs(); };
  const inShell = useInPanelShell();
  const { setAddLinkOpen, handleAddWorkdir, handleOpenFolder, handleDownloadZip } = panel;
  const revealDir = active === "linked" ? null : active;
  const folderHasFiles = revealDir !== null && totalsFor(index, folder).files > 0;
  const menuItems = useMemo<PanelMenuItem[]>(() => readOnly ? [] : [
    { id: "artifacts-add-link", label: "Add link to uploads…", icon: LinkIcon, onSelect: () => setAddLinkOpen(true) },
    { id: "artifacts-link-folder", label: "Link a folder…", icon: FolderOpen, onSelect: () => void handleAddWorkdir() },
    ...(revealDir ? [{
      id: "artifacts-reveal",
      label: revealLabel(),
      icon: FolderSearch,
      onSelect: () => handleOpenFolder(revealDir, folder || undefined),
    }] : []),
    ...(revealDir && folderHasFiles ? [{
      id: "artifacts-zip",
      label: "Download folder as .zip",
      icon: FileArchive,
      onSelect: () => handleDownloadZip(revealDir, folder ? [folder] : []),
    }] : []),
  ], [readOnly, setAddLinkOpen, handleAddWorkdir, handleOpenFolder, handleDownloadZip, revealDir, folder, folderHasFiles]);
  usePanelMenuItems(menuItems);
  const nothingLoaded = inputFiles.length === 0 && outputFiles.length === 0;
  const loadFailed = Boolean(error) && nothingLoaded && !isLoading;

  let body;
  if (isLoading) {
    body = <SkeletonRows />;
  } else if (loadFailed) {
    body = (
      <PanelError title="Couldn’t load this task’s files" onRetry={refresh}>{error}</PanelError>
    );
  } else if (active === "linked") {
    body = <LinkedFolders panel={panel} />;
  } else {
    body = (
      <FolderView
        panel={panel}
        source={active}
        folder={folder}
        index={index}
        entries={entries}
        scopeSize={scope.length}
        query={query}
        setQuery={setQuery}
        kind={effectiveKind}
        view={prefs.view}
        direction={direction}
        onOpenFolder={(path) => navigate(path, "in")}
        onUpload={openFilePicker}
        selection={selection}
        onSelectAll={selectAll}
        onClearSelection={clearSelection}
      />
    );
  }

  const totals = totalsFor(index, folder);
  const showFilters = !isLoading && !loadFailed && active !== "linked" && (scope.length > 0 || query !== "");
  const atRoot = folder === "";
  const sourceRoot = active === "linked" ? null : totalsFor(index, "");
  const refreshing = isLoading || panel.isLoadingWorkdirs;

  return (
    <MotionConfig reducedMotion="user">
      <div className="orbit-ui oar" style={{ overflow: previewFile ? "hidden" : undefined }} {...(readOnly ? {} : dropProps)}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          disabled={panel.isUploading}
          onChange={(event) => {
            if (event.target.files) upload(event.target.files);
            event.target.value = "";
          }}
        />

        <PanelHeaderContext>
          {isLoading ? "Loading…" : sourceRoot
            ? `${plural(sourceRoot.files, "file")}${sourceRoot.bytes > 0 ? ` · ${formatSize(sourceRoot.bytes)}` : ""}`
            : plural(workdirs.length, "linked folder")}
        </PanelHeaderContext>
        <PanelHeaderActions>
          {readOnly ? null : (
            <Button variant="ghost" size="sm" iconOnly aria-label="Upload files" title="Upload to input/" disabled={panel.isUploading} onClick={openFilePicker}>
              {panel.isUploading ? <Loader2 className="oui-spin" /> : <Upload />}
            </Button>
          )}
          <Button variant="ghost" size="sm" iconOnly aria-label="Refresh" title="Refresh" disabled={refreshing} onClick={refresh}>
            <RefreshCw className={refreshing ? "oui-spin" : undefined} />
          </Button>
        </PanelHeaderActions>

        {readOnly ? null : <div className="oar-src">
          <SourceSwitch
            value={active}
            onChange={pickSource}
            counts={{ output: fileCount(outputFiles), input: fileCount(inputFiles), linked: workdirs.length }}
            loading={isLoading}
          />
        </div>}

        {active !== "linked" ? (
          <div className="oar-bar">
            <nav className="oar-crumbs" aria-label="Folder path">
              {!atRoot ? (
                <Button variant="ghost" size="sm" iconOnly aria-label="Up one folder" title="Up one folder" onClick={() => navigate(parentPath(folder), "out")}>
                  <ChevronLeft />
                </Button>
              ) : null}
              <button
                type="button"
                className={`oar-crumb is-root${atRoot ? " is-cur" : ""}`}
                aria-current={atRoot ? "location" : undefined}
                title={`${active}/`}
                onClick={() => { if (!atRoot) navigate("", "out"); }}
              >
                <House aria-hidden="true" />{atRoot ? <span>{SOURCE_ROOT[active]}</span> : null}
              </button>
              {breadcrumbTrail(folder).map((crumb, i, trail) => {
                const current = i === trail.length - 1;
                return (
                  <span key={crumb.path} className="oar-crumb-seg">
                    <ChevronRight className="oar-crumb-sep" aria-hidden="true" />
                    <button
                      type="button"
                      className={`oar-crumb${current ? " is-cur" : ""}`}
                      aria-current={current ? "location" : undefined}
                      title={crumb.name}
                      onClick={() => { if (!current) navigate(crumb.path, "out"); }}
                    >{crumb.name}</button>
                  </span>
                );
              })}
            </nav>
            <span className="oar-sp" />
            {active === "input" ? (
              <Button variant="primary" size="sm" disabled={panel.isUploading} onClick={openFilePicker}>
                {panel.isUploading ? <Loader2 className="oui-spin" /> : <Upload />}{panel.isUploading ? "Uploading…" : "Upload"}
              </Button>
            ) : null}
            {/* In the workspace shell these live in the header's ⋯ menu and refresh button. */}
            {inShell || readOnly ? null : <SourceMenu panel={panel} source={active} folder={folder} canZip={folderHasFiles} onRefresh={refresh} />}
          </div>
        ) : (
          <div className="oar-bar">
            <p className="oar-bar-note" title="Folders on this computer, linked read-only into input/">Read-only, read in place</p>
            <span className="oar-sp" />
            <Button variant="secondary" size="sm" disabled={panel.isAddingWorkdir} onClick={() => void panel.handleAddWorkdir()}>
              {panel.isAddingWorkdir ? <Loader2 className="oui-spin" /> : <FolderOpen />}Link a folder
            </Button>
          </div>
        )}

        {showFilters ? (
          <div className="oar-filters">
            <SearchField
              className="oar-search"
              label={`Search ${atRoot ? (active === "output" ? "outputs" : "uploads") : folder.split("/").pop()}`}
              value={query}
              onChange={setQuery}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.stopPropagation();
                  setQuery("");
                }
              }}
            />
            <SortButton sort={prefs.sort} onChange={(sort) => setPrefs({ sort })} />
            <ViewSwitch view={prefs.view} onChange={(view) => setPrefs({ view })} />
          </div>
        ) : null}

        {showFilters && kinds.length > 1 ? (
          <div className="oar-chips" role="radiogroup" aria-label="File kind">
            <KindChip label="All" count={scope.length} on={effectiveKind === "all"} onPick={() => setKind("all")} />
            {kinds.map((entry) => (
              <KindChip key={entry.kind} label={KIND_LABELS[entry.kind]} count={entry.count} on={effectiveKind === entry.kind} onPick={() => setKind(entry.kind)} />
            ))}
          </div>
        ) : null}

        {!readOnly && active !== "linked" && selectedEntries.length > 0 && !isLoading && !loadFailed ? (
          <BatchBar
            panel={panel}
            source={active}
            selected={selectedEntries}
            total={entries.length}
            onSelectAll={selectAll}
            onClear={clearSelection}
          />
        ) : null}

        {error && !loadFailed ? (
          <p className="oar-notice" role="alert">
            <CircleAlert aria-hidden="true" /><span title={error}>{error}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setError(null)}><X /></button>
          </p>
        ) : null}

        <div className="oar-body">{body}</div>

        {!isLoading && !loadFailed ? (
          <div className="oar-foot">
            {active === "linked" ? (
              <span>{plural(workdirs.length, "linked folder")}</span>
            ) : (
              <span className="oui-truncate">
                {plural(totals.files, "file")}
                {totals.bytes > 0 ? ` · ${formatSize(totals.bytes)}` : ""}
                {query || effectiveKind !== "all" ? <> · <b>{entries.length.toLocaleString(LOCALE)}</b> shown</> : null}
              </span>
            )}
          </div>
        ) : null}

        <AnimatePresence>
          {previewFile ? (
            <FilePreviewDrawer
              fileName={previewFile.file.name}
              content={previewFile.content}
              downloadUrl={previewFile.downloadUrl}
              loading={panel.previewLoading}
              error={panel.previewError}
              isLive={!!props.isChatBusy}
              onClose={panel.closePreview}
              onDownload={() => panel.handleDownload(previewFile.file)}
              unpreviewable={previewFile.unpreviewable}
              fileSize={previewFile.file.size}
              onOpenFile={!readOnly && hostFileActionsAvailable() ? () => panel.handleOpenInApp(previewFile.file) : undefined}
              onRefresh={() => panel.handlePreview(previewFile.file, true)}
              onCreatePreviewComment={!panel.canComment ? undefined : (locator, comment) =>
                void panel.handleCreatePreviewComment(previewFile.file, locator, comment)
              }
              previewComments={panel.currentFileComments}
              onReplyPreviewComment={panel.canComment ? panel.replyPreviewComment : undefined}
              previewCommentsToAgent={!readOnly}
              onResolvePreviewComment={readOnly ? undefined : panel.resolvePreviewComment}
              previewCommentMarkers={panel.currentFilePreviewMarkers}
              sketchContext={props.projectId ? { projectId: props.projectId, taskId: props.task.id } : undefined}
              location={props.projectId ? {
                projectId: props.projectId,
                root: { kind: "task", taskId: props.task.id },
                path: `${previewFile.file.directory}/${previewFile.file.path}`,
              } : undefined}
            />
          ) : null}
        </AnimatePresence>

        {dragging ? (
          <div className="oar-drop" aria-hidden="true">
            <Upload />
            <b>Drop to upload</b>
            <span>Files go to <span className="oui-mono">input/</span>, where every agent in this task can read them.</span>
          </div>
        ) : null}

        {panel.toastMessage ? (
          <div key={panel.toastMessage} className="oar-toast" role="status"><Check aria-hidden="true" />{panel.toastMessage}</div>
        ) : null}

        {syncConflict ? (
          <FileConflictDialog
            fileName={syncConflict.file.name}
            newName={syncConflict.newName}
            existingNames={syncConflict.existingNames}
            onNewNameChange={(value) => panel.setSyncConflict({ ...syncConflict, newName: value })}
            onCancel={() => panel.setSyncConflict(null)}
            onOverwrite={panel.overwriteSyncConflict}
            onRename={panel.renameSyncConflict}
          />
        ) : null}
        <AddLinkDialog
          open={panel.addLinkOpen}
          title="Add Link to Uploads"
          onClose={() => panel.setAddLinkOpen(false)}
          onSubmit={panel.submitAddLink}
        />
        <AddLinkDialog
          open={!!editLink}
          title="Edit Link"
          submitLabel="Save"
          initial={editLink?.initial}
          onClose={() => panel.setEditLink(null)}
          onSubmit={panel.submitEditLink}
        />
        {panel.folderPicker}
      </div>
    </MotionConfig>
  );
}

/* ── Toolbar pieces ── */

function SourceSwitch({ value, onChange, counts, loading }: {
  value: ArtifactSource;
  onChange: (source: ArtifactSource) => void;
  counts: Record<ArtifactSource, number>;
  loading: boolean;
}) {
  const options: { value: ArtifactSource; label: string; title: string }[] = [
    { value: "output", label: "Outputs", title: "Files the agent wrote, in output/" },
    { value: "input", label: "Uploads", title: "Files you gave the agent, in input/" },
    { value: "linked", label: "Linked", title: "Folders on this computer, linked read-only into input/" },
  ];
  const index = options.findIndex((option) => option.value === value);
  const thumb = { width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(${index * 100}%)` } as CSSProperties;
  return (
    <div className="oui-seg is-block oar-seg" role="radiogroup" aria-label="Source">
      <span className="oui-seg-thumb" style={thumb} aria-hidden="true" />
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={option.title}
            className={`oui-seg-btn${selected ? " is-sel" : ""}`}
            onClick={() => { if (!selected) onChange(option.value); }}
          >
            <span className="oui-truncate">{option.label}</span>
            {loading ? null : <small key={counts[option.value]} className="oui-seg-n">{counts[option.value].toLocaleString(LOCALE)}</small>}
          </button>
        );
      })}
    </div>
  );
}

function ViewSwitch({ view, onChange }: { view: ArtifactView; onChange: (view: ArtifactView) => void }) {
  const options: { value: ArtifactView; label: string; icon: typeof List }[] = [
    { value: "list", label: "List view", icon: List },
    { value: "grid", label: "Grid view", icon: LayoutGrid },
  ];
  const index = options.findIndex((option) => option.value === view);
  return (
    <div className="oui-seg is-sm oar-view" role="radiogroup" aria-label="View">
      <span className="oui-seg-thumb" style={{ width: "calc((100% - 4px) / 2)", transform: `translateX(${index * 100}%)` }} aria-hidden="true" />
      {options.map((option) => {
        const Icon = option.icon;
        const selected = option.value === view;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.label}
            title={option.label}
            className={`oui-seg-btn${selected ? " is-sel" : ""}`}
            onClick={() => { if (!selected) onChange(option.value); }}
          ><Icon aria-hidden="true" /></button>
        );
      })}
    </div>
  );
}

function SortButton({ sort, onChange }: { sort: ArtifactSort; onChange: (sort: ArtifactSort) => void }) {
  const menu = useActionMenu();
  const item = (value: ArtifactSort, icon: ActionItem["icon"], label: string): ActionItem => ({
    id: value, icon: sort === value ? Check : icon, label, onSelect: () => onChange(value),
  });
  const items = [
    item("recent", Clock, "Recently changed"),
    item("name", ArrowDownAZ, "Name"),
    item("size", HardDrive, "Size"),
  ];
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className={`oar-sort${menu.open ? " is-open" : ""}`}
        aria-label={`Sort: ${SORT_LABEL[sort]}`}
        title="Sort"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={(event) => menu.fromButton(event.currentTarget)}
      >
        <ArrowUpDown /><span className="oar-sort-label">{SORT_LABEL[sort]}</span>
      </Button>
      <ActionMenu at={menu.at} items={items} label="Sort files" onClose={menu.close} />
    </>
  );
}

function SourceMenu({ panel, source, folder, canZip, onRefresh }: {
  panel: ArtifactsPanel;
  source: "output" | "input";
  folder: string;
  canZip: boolean;
  onRefresh: () => void;
}) {
  const menu = useActionMenu();
  const items: ActionItem[] = [
    ...(source === "input" ? [
      { id: "link", icon: LinkIcon, label: "Add link…", onSelect: () => panel.setAddLinkOpen(true) },
      { id: "linkdir", icon: FolderOpen, label: "Link a folder…", onSelect: () => void panel.handleAddWorkdir() },
    ] : []),
    { id: "reveal", icon: FolderSearch, label: revealLabel(), separated: source === "input", onSelect: () => panel.handleOpenFolder(source, folder || undefined) },
    ...(canZip ? [{ id: "zip", icon: FileArchive, label: "Download folder as .zip", onSelect: () => panel.handleDownloadZip(source, folder ? [folder] : []) }] : []),
    { id: "refresh", icon: RefreshCw, label: "Refresh", onSelect: onRefresh },
  ];
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={source === "input" ? "More upload actions" : "More actions"}
        title="More"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={(event) => menu.fromButton(event.currentTarget)}
      ><MoreHorizontal /></Button>
      <ActionMenu at={menu.at} items={items} label="Folder actions" onClose={menu.close} />
    </>
  );
}

/** Shown while rows are selected: zip download, delete (uploads only, hold to confirm), clear. */
function BatchBar({ panel, source, selected, total, onSelectAll, onClear }: {
  panel: ArtifactsPanel;
  source: "output" | "input";
  selected: ArtifactEntry[];
  total: number;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  // Same rule as the row menu: only your uploads' files can be deleted.
  const deletable = source === "input" ? selected.filter(({ file }) => !file.is_dir).map(({ file }) => file) : [];
  const all = selected.length === total;
  const remove = async () => {
    setDeleting(true);
    const result = await panel.handleDeleteMany(deletable);
    setDeleting(false);
    if (result.failed === 0) onClear();
  };
  return (
    <div className="oar-batch" role="toolbar" aria-label="Selected files">
      <button
        type="button"
        role="checkbox"
        aria-checked={all ? "true" : "mixed"}
        aria-label={all ? "Clear selection" : "Select all"}
        title={all ? "Clear selection" : "Select all"}
        className={`oar-check is-on${all ? "" : " is-mixed"}`}
        onClick={all ? onClear : onSelectAll}
      >{all ? <Check aria-hidden="true" /> : <Minus aria-hidden="true" />}</button>
      <b className="oar-batch-n" aria-live="polite">{plural(selected.length, "item")} selected</b>
      <span className="oar-sp" />
      <Button
        variant="secondary"
        size="sm"
        title="Download the selection as one .zip"
        onClick={() => panel.handleDownloadZip(source, selected.map(({ file }) => file.path))}
      ><FileArchive />Download</Button>
      {source === "input" ? (
        deletable.length === 0 ? (
          <Button variant="secondary" size="sm" danger disabled title="Folders can’t be deleted here"><Trash2 />Delete</Button>
        ) : (
          <HoldButton size="sm" disabled={deleting} onConfirm={() => void remove()} holdingLabel="Keep holding…">
            {deleting ? "Deleting…" : `Hold to delete ${deletable.length === 1 ? "1 file" : `${deletable.length} files`}`}
          </HoldButton>
        )
      ) : null}
      <Button variant="ghost" size="sm" iconOnly aria-label="Clear selection" title="Clear selection (Esc)" onClick={onClear}><X /></Button>
    </div>
  );
}

function KindChip({ label, count, on, onPick }: { label: string; count: number; on: boolean; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={`oar-chip${on ? " is-on" : ""}`} onClick={onPick}>
      {label}<small>{count.toLocaleString(LOCALE)}</small>
    </button>
  );
}

/* ── Folder listing ── */

function FolderView({
  panel, source, folder, index, entries, scopeSize, query, setQuery, kind, view, direction, onOpenFolder, onUpload, selection, onSelectAll, onClearSelection,
}: {
  panel: ArtifactsPanel;
  source: "output" | "input";
  folder: string;
  index: FolderIndex;
  entries: ArtifactEntry[];
  scopeSize: number;
  query: string;
  setQuery: (query: string) => void;
  kind: KindFilter;
  view: ArtifactView;
  direction: "in" | "out" | "none";
  onOpenFolder: (path: string) => void;
  onUpload: () => void;
  selection: Selection;
  onSelectAll: () => void;
  onClearSelection: () => void;
}) {
  const now = useNow(CLOCK_MS);
  const pending = source === "input" && folder === "" && !query ? pendingItems(panel) : [];
  const previewKey = panel.previewFile ? `${panel.previewFile.file.directory}/${panel.previewFile.file.path}` : null;

  if (entries.length === 0 && pending.length === 0) {
    if (query) {
      return (
        <PanelEmpty icon={Search} title={`Nothing matches “${query.trim()}”`} action={<Button variant="secondary" size="sm" onClick={() => setQuery("")}>Clear search</Button>} />
      );
    }
    if (scopeSize > 0 && kind !== "all") {
      return <PanelEmpty icon={Search} title={`No ${KIND_LABELS[kind as Exclude<KindFilter, "all">].toLowerCase()} here`} />;
    }
    if (folder) {
      return <PanelEmpty icon={Folder} title="This folder is empty" />;
    }
    return source === "output" ? (
      <PanelEmpty icon={Download} title="Nothing from the agent yet" />
    ) : (
      <PanelEmpty
        icon={Upload}
        title="Give the agent something to work from"
        action={(
          <>
            <Button variant="primary" size="sm" onClick={onUpload}><Upload />Upload files</Button>
            <Button variant="secondary" size="sm" onClick={() => panel.setAddLinkOpen(true)}><LinkIcon />Add link</Button>
          </>
        )}
      />
    );
  }

  const shared = { panel, source, now, index, previewKey, searching: Boolean(query.trim()), onOpenFolder, selection, onSelectAll, onClearSelection };
  const key = `${source}/${folder}/${view}`;
  return view === "grid" ? (
    <WindowedGrid key={key} entries={entries} pending={pending} direction={direction} {...shared} />
  ) : (
    <WindowedList key={key} entries={entries} pending={pending} direction={direction} {...shared} />
  );
}

interface RowShared {
  panel: ArtifactsPanel;
  source: "output" | "input";
  now: number;
  index: FolderIndex;
  previewKey: string | null;
  searching: boolean;
  onOpenFolder: (path: string) => void;
  selection: Selection;
}

interface WindowedProps extends RowShared {
  entries: ArtifactEntry[];
  pending: PendingUpload[];
  direction: "in" | "out" | "none";
  onSelectAll: () => void;
  onClearSelection: () => void;
}

/** The upload batch in flight: per-file progress when the hook tracks it, else names only. */
function pendingItems(panel: ArtifactsPanel): PendingUpload[] {
  if (panel.pendingUploadItems && panel.pendingUploadItems.length > 0) return panel.pendingUploadItems;
  return (panel.pendingUploads ?? []).map((name, i) => ({ id: `n-${i}-${name}`, name, progress: null }));
}

/**
 * Selection keys on a list/grid container: ⌘/Ctrl+A selects every row,
 * Esc clears, Space toggles the focused row, Shift+arrows extend.
 * Returns true when it handled the event.
 */
function selectionKeys(event: KeyboardEvent<HTMLDivElement>, entries: ArtifactEntry[], pendingCount: number, shared: Pick<WindowedProps, "selection" | "onSelectAll" | "onClearSelection">): boolean {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    shared.onSelectAll();
    return true;
  }
  if (event.key === "Escape" && shared.selection.active) {
    event.preventDefault();
    event.stopPropagation();
    shared.onClearSelection();
    return true;
  }
  const at = (event.target as HTMLElement).dataset.index;
  if (at === undefined) return false;
  const entry = entries[Number(at) - pendingCount];
  if (!entry) return false;
  if (event.key === " " && event.target === event.currentTarget.querySelector(`[data-index="${at}"]`)) {
    event.preventDefault();
    shared.selection.pick(entry.file.path, event.shiftKey);
    return true;
  }
  return false;
}

/** After a Shift+arrow focus move, add the newly focused row to the selection. */
function extendOnShiftArrow(event: KeyboardEvent<HTMLDivElement>, delta: number, entries: ArtifactEntry[], pendingCount: number, selection: Selection) {
  if (!event.shiftKey || delta === 0) return;
  const at = (event.target as HTMLElement).dataset.index;
  if (at === undefined) return;
  const from = entries[Number(at) - pendingCount];
  const to = entries[Math.max(0, Math.min(entries.length - 1, Number(at) + delta - pendingCount))];
  if (from && !selection.has(from.file.path)) selection.pick(from.file.path, false);
  if (to && to !== from) selection.pick(to.file.path, true);
}

/** Arrow keys move focus between rendered items; the window keeps the neighbours mounted. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>, step: (key: string) => number, count: number, reveal: (i: number) => void, perRow = 1) {
  const target = event.target as HTMLElement;
  const at = target.dataset.index;
  if (at === undefined) return;
  const delta = step(event.key);
  if (delta === 0) return;
  event.preventDefault();
  const container = event.currentTarget;
  const next = Math.max(0, Math.min(count - 1, Number(at) + delta));
  reveal(Math.floor(next / perRow));
  requestAnimationFrame(() => {
    container.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
  });
}

function WindowedList({ entries, pending, direction, ...shared }: WindowedProps) {
  const count = pending.length + entries.length;
  const { attach, onScroll, scroller, scrollTop, viewport } = useScrollViewport();
  const win = useWindowedRows({ scroller, scrollTop, viewport }, count, ROW_HEIGHT);
  const rows = [];
  for (let i = win.start; i < win.end; i += 1) {
    const style = { transform: `translateY(${i * ROW_HEIGHT}px)` };
    if (i < pending.length) {
      rows.push(<PendingRow key={pending[i].id} item={pending[i]} style={style} />);
    } else {
      const entry = entries[i - pending.length];
      rows.push(<EntryRow key={entry.file.path} entry={entry} indexAt={i} style={style} {...shared} />);
    }
  }
  return (
    <div
      ref={attach}
      className={`oar-scroll oui-scroll is-${direction}`}
      onScroll={onScroll}
      onKeyDown={(event) => {
        if (selectionKeys(event, entries, pending.length, shared)) return;
        const step = (key: string) => (key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0);
        extendOnShiftArrow(event, step(event.key), entries, pending.length, shared.selection);
        moveFocus(event, step, count, win.reveal);
      }}
    >
      <div className="oar-list" role="list" style={{ height: win.totalHeight + LIST_PAD * 2 }}>
        {rows}
      </div>
    </div>
  );
}

function WindowedGrid({ entries, pending, direction, ...shared }: WindowedProps) {
  const count = pending.length + entries.length;
  const { attach, onScroll, scroller, scrollTop, viewport, width } = useScrollViewport();
  const cols = gridColumns(width - GRID_PAD * 2, TILE_MIN, TILE_GAP);
  const win = useWindowedRows({ scroller, scrollTop, viewport }, Math.ceil(count / cols), TILE_HEIGHT + TILE_GAP, 3);
  const tiles = [];
  for (let row = win.start; row < win.end; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const i = row * cols + col;
      if (i >= count) break;
      const style = {
        transform: `translate(calc(${col} * (100% + ${TILE_GAP}px)), ${row * (TILE_HEIGHT + TILE_GAP)}px)`,
        width: `calc((100% - ${(cols - 1) * TILE_GAP}px) / ${cols})`,
      };
      if (i < pending.length) {
        tiles.push(<PendingTile key={pending[i].id} item={pending[i]} style={style} />);
      } else {
        const entry = entries[i - pending.length];
        tiles.push(<EntryTile key={entry.file.path} entry={entry} indexAt={i} style={style} {...shared} />);
      }
    }
  }
  const step = (key: string) => (key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : key === "ArrowDown" ? cols : key === "ArrowUp" ? -cols : 0);
  return (
    <div
      ref={attach}
      className={`oar-scroll oui-scroll is-${direction}`}
      onScroll={onScroll}
      onKeyDown={(event) => {
        if (selectionKeys(event, entries, pending.length, shared)) return;
        extendOnShiftArrow(event, step(event.key), entries, pending.length, shared.selection);
        moveFocus(event, step, count, win.reveal, cols);
      }}
    >
      <div className="oar-grid" role="list" style={{ height: Math.max(0, win.totalHeight - TILE_GAP) + GRID_PAD * 2 }}>
        <div className="oar-grid-inner">{tiles}</div>
      </div>
    </div>
  );
}

function useEntryActions({ entry, panel, source, onOpenFolder, selection }: { entry: ArtifactEntry } & Pick<RowShared, "panel" | "source" | "onOpenFolder" | "selection">) {
  const { file } = entry;
  const isLink = !file.is_dir && isLinkFile(file.name);
  const host = hostFileActionsAvailable();
  const activate = () => {
    if (file.is_dir) onOpenFolder(file.path);
    else if (isLink) void panel.handleOpenLink(file);
    else void panel.handlePreview(file);
  };
  let items: ActionItem[];
  if (panel.readOnly) {
    // A shared Task: look at it and take a copy.
    items = file.is_dir
      ? [{ id: "open", icon: FolderOpen, label: "Open", onSelect: () => onOpenFolder(file.path) }]
      : isLink
        ? [{ id: "open", icon: SquareArrowOutUpRight, label: "Open in browser", onSelect: () => void panel.handleOpenLink(file) }]
        : [
            { id: "preview", icon: Eye, label: "Preview", onSelect: () => void panel.handlePreview(file) },
            { id: "download", icon: Download, label: "Download", onSelect: () => panel.handleDownload(file) },
          ];
  } else if (file.is_dir) {
    items = [
      { id: "open", icon: FolderOpen, label: "Open", onSelect: () => onOpenFolder(file.path) },
      { id: "reveal", icon: FolderSearch, label: revealLabel(), onSelect: () => panel.handleOpenFolder(source, file.path) },
      { id: "zip", icon: FileArchive, label: "Download as .zip", onSelect: () => panel.handleDownloadZip(source, [file.path]) },
    ];
  } else if (isLink) {
    items = [
      { id: "open", icon: SquareArrowOutUpRight, label: "Open in browser", onSelect: () => void panel.handleOpenLink(file) },
      { id: "edit", icon: Edit3, label: "Edit link", onSelect: () => void panel.handleEditLink(file) },
      { id: "sync", icon: ArrowUpFromLine, label: "Sync to Shared Assets", onSelect: () => void panel.handleSyncToResource(file) },
    ];
  } else {
    items = [
      { id: "preview", icon: Eye, label: "Preview", onSelect: () => void panel.handlePreview(file) },
      { id: "download", icon: Download, label: "Download", onSelect: () => panel.handleDownload(file) },
      ...(host ? [
        { id: "app", icon: SquareArrowOutUpRight, label: "Open", onSelect: () => panel.handleOpenInApp(file) },
        { id: "reveal", icon: FolderSearch, label: revealLabel(), onSelect: () => panel.handleRevealInFileManager(file) },
      ] : []),
      { id: "sync", icon: ArrowUpFromLine, label: "Sync to Shared Assets", onSelect: () => void panel.handleSyncToResource(file) },
    ];
  }
  // Only your uploads can be deleted; the agent's output stays as written.
  if (!panel.readOnly && source === "input" && !file.is_dir) {
    items.push({ id: "delete", icon: Trash2, label: "Delete", danger: true, separated: true, onSelect: () => void panel.handleDelete(file) });
  }
  const dragProps = file.is_dir || panel.readOnly ? {} : {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      // Same protocol as FileTree, so the chat composer turns it into file
      // chips. Dragging a row of the selection carries every selected file
      // (folders stay out, as they do for a single drag).
      const files = artifactDragFiles(file, selection);
      const paths = setGroveFileDrag(event.dataTransfer, files.map((item) => `${item.directory}/${item.path}`));
      event.dataTransfer.effectAllowed = "copy";
      beginGroveFileDrag(paths.length);
      if (paths.length > 1) setCountDragImage(event.dataTransfer, displayName(file), paths.length);
    },
    onDragEnd: () => endGroveFileDrag(),
  };
  return { isLink, activate, items, dragProps };
}

/** A drag image naming the dragged row with a count badge: "report.md  3 files". */
function setCountDragImage(dataTransfer: DataTransfer, name: string, count: number) {
  if (typeof dataTransfer.setDragImage !== "function") return;
  const ghost = document.createElement("div");
  ghost.className = "oar-drag-ghost";
  const label = document.createElement("span");
  label.className = "oar-drag-ghost-name";
  label.textContent = name;
  const badge = document.createElement("span");
  badge.className = "oar-drag-ghost-count";
  badge.textContent = `${count} files`;
  ghost.append(label, badge);
  document.body.appendChild(ghost);
  dataTransfer.setDragImage(ghost, 14, 14);
  // The browser snapshots the element during dragstart; it can go next frame.
  window.setTimeout(() => ghost.remove(), 0);
}

function displayName(file: ArtifactFile): string {
  return isLinkFile(file.name) ? linkDisplayName(file.name) : file.name;
}

function metaText(file: ArtifactFile, index: FolderIndex, now: number): string {
  if (file.is_dir) {
    const totals = totalsFor(index, file.path);
    return totals.files === 0 ? "Empty" : plural(totals.files, "file");
  }
  if (isLinkFile(file.name)) return file.url ? hostnameOf(file.url) : "External link";
  const at = new Date(file.modified_at).getTime();
  return `${formatSize(file.size)} · ${Number.isNaN(at) ? "—" : shortAgo(at, now)}`;
}

function EntryRow({ entry, indexAt, style, ...shared }: RowShared & { entry: ArtifactEntry; indexAt: number; style: CSSProperties }) {
  const { file, rel } = entry;
  const menu = useActionMenu();
  const { isLink, activate, items, dragProps } = useEntryActions({ entry, ...shared });
  const selected = shared.previewKey === `${file.directory}/${file.path}`;
  const checked = shared.selection.has(file.path);
  const sub = shared.searching && rel !== file.name ? parentPath(rel) : null;
  const name = displayName(file);
  return (
    <div
      role="listitem"
      tabIndex={0}
      data-index={indexAt}
      aria-selected={shared.selection.active ? checked : undefined}
      className={`oar-row${file.is_dir ? " is-dir" : ""}${selected ? " is-sel" : ""}${checked ? " is-checked" : ""}${shared.selection.active ? " is-selecting" : ""}${menu.open ? " is-menu" : ""}`}
      style={style}
      title={isLink ? file.url : rel}
      aria-label={file.is_dir ? `Folder ${name}` : name}
      onClick={(event) => onEntryClick(event, file.path, shared.selection, activate)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") { event.preventDefault(); activate(); }
      }}
      onContextMenu={menu.fromPoint}
      {...dragProps}
    >
      <span className="oar-lead">
        <FileGlyph file={file} fileUrl={shared.panel.fileUrl} />
        <SelectBox name={name} path={file.path} selection={shared.selection} />
      </span>
      <span className="oar-name">
        <b>{name}</b>
        {sub ? <small className="oui-mono">{sub}/</small> : null}
      </span>
      <span className="oar-meta" title={file.is_dir ? undefined : formatDateTime(file.modified_at)}>{metaText(file, shared.index, shared.now)}</span>
      <span className="oar-acts">
        {!file.is_dir && !isLink ? (
          <button
            type="button"
            className="oar-ib"
            aria-label={`Download ${name}`}
            title="Download"
            onClick={(event) => { event.stopPropagation(); shared.panel.handleDownload(file); }}
          ><Download /></button>
        ) : null}
        <button
          type="button"
          className="oar-ib"
          aria-label={`${name} actions`}
          title="More"
          onClick={(event) => { event.stopPropagation(); menu.fromButton(event.currentTarget); }}
        ><MoreHorizontal /></button>
      </span>
      {file.is_dir ? <ChevronRight className="oar-chev" aria-hidden="true" /> : null}
      <ActionMenu at={menu.at} items={items} label={`${name} actions`} onClose={menu.close} />
    </div>
  );
}

function EntryTile({ entry, indexAt, style, ...shared }: RowShared & { entry: ArtifactEntry; indexAt: number; style: CSSProperties }) {
  const { file, rel } = entry;
  const menu = useActionMenu();
  const { isLink, activate, items, dragProps } = useEntryActions({ entry, ...shared });
  const selected = shared.previewKey === `${file.directory}/${file.path}`;
  const checked = shared.selection.has(file.path);
  const name = displayName(file);
  return (
    <div
      role="listitem"
      tabIndex={0}
      data-index={indexAt}
      aria-selected={shared.selection.active ? checked : undefined}
      className={`oar-tile${selected ? " is-sel" : ""}${checked ? " is-checked" : ""}${shared.selection.active ? " is-selecting" : ""}${menu.open ? " is-menu" : ""}`}
      style={style}
      title={isLink ? file.url : rel}
      aria-label={file.is_dir ? `Folder ${name}` : name}
      onClick={(event) => onEntryClick(event, file.path, shared.selection, activate)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") { event.preventDefault(); activate(); }
      }}
      onContextMenu={menu.fromPoint}
      {...dragProps}
    >
      <TileThumb file={file} fileUrl={shared.panel.fileUrl} />
      <SelectBox name={name} path={file.path} selection={shared.selection} tile />
      <button
        type="button"
        className="oar-tile-more"
        aria-label={`${name} actions`}
        onClick={(event) => { event.stopPropagation(); menu.fromButton(event.currentTarget); }}
      ><MoreHorizontal /></button>
      <span className="oar-tile-meta">
        <b>{name}</b>
        <small>{metaText(file, shared.index, shared.now)}</small>
      </span>
      <ActionMenu at={menu.at} items={items} label={`${name} actions`} onClose={menu.close} />
    </div>
  );
}

function pendingLabel(item: PendingUpload): string {
  if (item.failed) return "Failed";
  if (item.queued) return "Queued";
  if (item.progress === null) return "Uploading…";
  if (item.progress >= 1) return "Processing…";
  return `${Math.round(item.progress * 100)}%`;
}

/** Determinate bar for one uploading file; indeterminate (no bar) when progress isn't tracked. */
function UploadBar({ item }: { item: PendingUpload }) {
  if ((item.progress === null || item.queued) && !item.failed) return null;
  const pct = item.failed ? 100 : Math.round((item.progress ?? 0) * 100);
  return (
    <span
      className={`oar-prog${item.failed ? " is-failed" : ""}`}
      role="progressbar"
      aria-label={`Uploading ${item.name}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    ><i style={{ transform: `scaleX(${pct / 100})` }} /></span>
  );
}

function PendingRow({ item, style }: { item: PendingUpload; style: CSSProperties }) {
  const { name } = item;
  return (
    <div role="listitem" className={`oar-row is-pending${item.failed ? " is-failed" : ""}`} style={style} aria-label={`Uploading ${name}`}>
      <span className="oar-glyph"><VSCodeIcon filename={name} size={16} /></span>
      <span className="oar-name"><b>{name}</b></span>
      <span className="oar-meta">
        {item.failed ? <CircleAlert aria-hidden="true" /> : <Loader2 className="oui-spin" aria-hidden="true" />}
        {pendingLabel(item)}
      </span>
      <UploadBar item={item} />
    </div>
  );
}

function PendingTile({ item, style }: { item: PendingUpload; style: CSSProperties }) {
  const { name } = item;
  return (
    <div role="listitem" className={`oar-tile is-pending${item.failed ? " is-failed" : ""}`} style={style} aria-label={`Uploading ${name}`}>
      <span className={`osd-thumb is-${fileKind(name)} oar-thumb`}>
        <span className="osd-thumb-icon">{item.failed ? <CircleAlert /> : <Loader2 className="oui-spin" />}</span>
      </span>
      <span className="oar-tile-meta"><b>{name}</b><small>{pendingLabel(item)}</small></span>
      <UploadBar item={item} />
    </div>
  );
}

/** Row click: a selection gesture selects; otherwise the row opens as before. */
function onEntryClick(event: MouseEvent, path: string, selection: Selection, activate: () => void) {
  const gesture = selectionGesture(event, selection);
  if (gesture === null) { activate(); return; }
  event.preventDefault();
  selection.pick(path, gesture === "range");
}

/** Checkbox over the row glyph / tile corner. Shift+click selects a range. */
function SelectBox({ name, path, selection, tile = false }: { name: string; path: string; selection: Selection; tile?: boolean }) {
  const checked = selection.has(path);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={`Select ${name}`}
      tabIndex={-1}
      className={`oar-check${tile ? " is-tile" : ""}${checked ? " is-on" : ""}`}
      onClick={(event) => { event.stopPropagation(); selection.pick(path, event.shiftKey); }}
    >{checked ? <Check aria-hidden="true" /> : null}</button>
  );
}

type FileUrl = ((file: ArtifactFile) => string) | null;

function useThumbUrl(file: ArtifactFile, fileUrl: FileUrl): string | null {
  const raster = !file.is_dir && !isLinkFile(file.name) && RASTER.test(file.name);
  return useSignedUrl(raster && fileUrl ? fileUrl(file) : null);
}

function FileGlyph({ file, fileUrl }: { file: ArtifactFile; fileUrl: FileUrl }) {
  const src = useThumbUrl(file, fileUrl);
  const [broken, setBroken] = useState(false);
  if (file.is_dir) return <span className="oar-glyph is-dir"><Folder /></span>;
  if (isLinkFile(file.name)) {
    return (
      <span className="oar-glyph is-link">
        {file.favicon && !broken ? <img src={file.favicon} alt="" onError={() => setBroken(true)} /> : <Link2 />}
      </span>
    );
  }
  if (src && !broken) {
    return <span className="oar-glyph is-img"><img src={src} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} /></span>;
  }
  return <span className="oar-glyph"><VSCodeIcon filename={file.name} size={16} /></span>;
}

function TileThumb({ file, fileUrl }: { file: ArtifactFile; fileUrl: FileUrl }) {
  const src = useThumbUrl(file, fileUrl);
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (file.is_dir) {
    return <span className="osd-thumb oar-thumb is-dir"><span className="osd-thumb-icon"><Folder /></span></span>;
  }
  const kind = fileKind(file.name);
  const ext = extLabel(file.name);
  return (
    <span className={`osd-thumb is-${kind} oar-thumb`}>
      {kind === "link" ? (
        <span className="osd-thumb-icon is-link">
          {file.favicon && !broken ? <img src={file.favicon} alt="" onError={() => setBroken(true)} /> : <LinkIcon />}
        </span>
      ) : src && !broken ? (
        <img className={`osd-thumb-img${loaded ? " is-loaded" : ""}`} src={src} alt="" loading="lazy" draggable={false} onLoad={() => setLoaded(true)} onError={() => setBroken(true)} />
      ) : (
        <span className="osd-thumb-icon"><VSCodeIcon filename={file.name} size={22} /></span>
      )}
      {ext ? <span className="osd-ext">{ext}</span> : null}
    </span>
  );
}

/* ── Linked folders ── */

function LinkedFolders({ panel }: { panel: ArtifactsPanel }) {
  const { workdirs, isLoadingWorkdirs } = panel;
  if (isLoadingWorkdirs && workdirs.length === 0) return <SkeletonRows count={2} />;
  if (workdirs.length === 0) {
    return (
      <PanelEmpty
        icon={FolderOpen}
        title="No linked folders"
        action={<Button variant="secondary" size="sm" disabled={panel.isAddingWorkdir} onClick={() => void panel.handleAddWorkdir()}><FolderOpen />Link a folder</Button>}
      />
    );
  }
  return (
    <div className="oar-scroll oui-scroll">
      <div className="oar-linked" role="list">
        {workdirs.map((entry, i) => <LinkedRow key={entry.name} entry={entry} panel={panel} delay={i} />)}
      </div>
    </div>
  );
}

function LinkedRow({ entry, panel, delay }: { entry: ArtifactWorkDirectoryEntry; panel: ArtifactsPanel; delay: number }) {
  return (
    <div role="listitem" className={`oar-lrow${entry.exists ? "" : " is-missing"}`} style={{ animationDelay: `${Math.min(delay, 10) * 40}ms` }}>
      <span className="oar-glyph is-dir"><Link2 /></span>
      <span className="oar-name">
        <b>{entry.name}<em>{entry.exists ? "read-only" : "missing"}</em></b>
        <small className="oui-mono" title={entry.target_path}>{entry.target_path}</small>
      </span>
      <Button variant="secondary" size="sm" disabled={!entry.exists} onClick={() => void panel.handleOpenWorkdir(entry)}>Open</Button>
      <Button variant="ghost" size="sm" iconOnly danger aria-label={`Unlink ${entry.name}`} title="Unlink" onClick={() => void panel.handleDeleteWorkdir(entry)}><X /></Button>
    </div>
  );
}

function SkeletonRows({ count = SKELETON_ROWS }: { count?: number }) {
  return (
    <div className="oar-skel" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="oar-skel-row">
          <span className="oar-skel-ic" />
          <span className="oar-skel-copy"><span className="oui-skel" style={{ width: `${48 + ((i * 17) % 38)}%` }} /></span>
          <span className="oui-skel oar-skel-meta" />
        </div>
      ))}
    </div>
  );
}
