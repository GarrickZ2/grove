import { useCallback, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";
import { AnimatePresence, MotionConfig } from "framer-motion";
import {
  ArrowDownAZ, ArrowUpFromLine, ArrowUpDown, Check, ChevronLeft, ChevronRight, CircleAlert, Clock, Download, Edit3, Eye,
  Folder, FolderOpen, FolderSearch, HardDrive, House, LayoutGrid, Link as LinkIcon, Link2, List, Loader2, MoreHorizontal,
  RefreshCw, Search, SquareArrowOutUpRight, Trash2, Upload, X,
} from "lucide-react";
import type { Task } from "../../../data/types";
import { artifactDownloadUrl, type ArtifactFile, type ArtifactWorkDirectoryEntry } from "../../../api";
import {
  AddLinkDialog, FileConflictDialog, FilePreviewDrawer, VSCodeIcon, formatSize, isLinkFile, linkDisplayName, hostnameOf,
} from "../../../components/ui";
import { useArtifactsPanel, type ArtifactPreviewRequest, type ArtifactsPanel } from "../../../components/Tasks/TaskInfoPanel/tabs/useArtifactsPanel";
import {
  GROVE_FILE_DRAG_TYPE, dragCarriesGrovePath, dropContainsDirectory, parentPath,
} from "../../../components/Tasks/TaskInfoPanel/tabs/artifactsModel";
import {
  Button, LOCALE, PanelEmpty, PanelError, PanelHeaderActions, PanelHeaderContext, SearchField, formatDateTime,
  shortAgo, useInPanelShell, useNow, usePanelMenuItems, type PanelMenuItem,
} from "../../ui";
import { ActionMenu, type ActionItem } from "../../studio/ActionMenu";
import { useActionMenu } from "../../studio/useActionMenu";
import { useSignedUrl } from "../../studio/useSignedUrl";
import { extLabel, fileKind, hostFileActionsAvailable, revealLabel } from "../../studio/studioView";
import {
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

  const active: ArtifactSource = source ?? defaultSource({ input: inputFiles, output: outputFiles });
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
  const { setAddLinkOpen, handleAddWorkdir, handleOpenFolder } = panel;
  const revealDir = active === "linked" ? null : active;
  const menuItems = useMemo<PanelMenuItem[]>(() => [
    { id: "artifacts-add-link", label: "Add link to uploads…", icon: LinkIcon, onSelect: () => setAddLinkOpen(true) },
    { id: "artifacts-link-folder", label: "Link a folder…", icon: FolderOpen, onSelect: () => void handleAddWorkdir() },
    ...(revealDir ? [{
      id: "artifacts-reveal",
      label: revealLabel(),
      icon: FolderSearch,
      onSelect: () => handleOpenFolder(revealDir, folder || undefined),
    }] : []),
  ], [setAddLinkOpen, handleAddWorkdir, handleOpenFolder, revealDir, folder]);
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
      <div className="orbit-ui oar" style={{ overflow: previewFile ? "hidden" : undefined }} {...dropProps}>
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
          <Button variant="ghost" size="sm" iconOnly aria-label="Upload files" title="Upload to input/" disabled={panel.isUploading} onClick={openFilePicker}>
            {panel.isUploading ? <Loader2 className="oui-spin" /> : <Upload />}
          </Button>
          <Button variant="ghost" size="sm" iconOnly aria-label="Refresh" title="Refresh" disabled={refreshing} onClick={refresh}>
            <RefreshCw className={refreshing ? "oui-spin" : undefined} />
          </Button>
        </PanelHeaderActions>

        <div className="oar-src">
          <SourceSwitch
            value={active}
            onChange={pickSource}
            counts={{ output: fileCount(outputFiles), input: fileCount(inputFiles), linked: workdirs.length }}
            loading={isLoading}
          />
        </div>

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
            {inShell ? null : <SourceMenu panel={panel} source={active} folder={folder} onRefresh={refresh} />}
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
              onRefresh={() => panel.handlePreview(previewFile.file, true)}
              onCreatePreviewComment={(locator, comment, rendererId) =>
                panel.handleCreatePreviewComment(previewFile.file, locator, comment, rendererId)
              }
              onUpdatePreviewComment={panel.handleUpdatePreviewComment}
              onDeletePreviewComment={panel.removePreviewComment}
              previewCommentDrafts={panel.currentFilePreviewDrafts}
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

function SourceMenu({ panel, source, folder, onRefresh }: {
  panel: ArtifactsPanel;
  source: "output" | "input";
  folder: string;
  onRefresh: () => void;
}) {
  const menu = useActionMenu();
  const items: ActionItem[] = [
    ...(source === "input" ? [
      { id: "link", icon: LinkIcon, label: "Add link…", onSelect: () => panel.setAddLinkOpen(true) },
      { id: "linkdir", icon: FolderOpen, label: "Link a folder…", onSelect: () => void panel.handleAddWorkdir() },
    ] : []),
    { id: "reveal", icon: FolderSearch, label: revealLabel(), separated: source === "input", onSelect: () => panel.handleOpenFolder(source, folder || undefined) },
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

function KindChip({ label, count, on, onPick }: { label: string; count: number; on: boolean; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={`oar-chip${on ? " is-on" : ""}`} onClick={onPick}>
      {label}<small>{count.toLocaleString(LOCALE)}</small>
    </button>
  );
}

/* ── Folder listing ── */

function FolderView({
  panel, source, folder, index, entries, scopeSize, query, setQuery, kind, view, direction, onOpenFolder, onUpload,
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
}) {
  const now = useNow(CLOCK_MS);
  const pending = source === "input" && folder === "" && !query ? panel.pendingUploads : [];
  const previewKey = panel.previewFile ? `${panel.previewFile.file.directory}/${panel.previewFile.file.path}` : null;
  const folderName = folder ? folder.split("/").pop()! : SOURCE_ROOT[source];

  if (entries.length === 0 && pending.length === 0) {
    if (query) {
      return (
        <PanelEmpty icon={Search} title={`Nothing matches “${query.trim()}”`} action={<Button variant="secondary" size="sm" onClick={() => setQuery("")}>Clear search</Button>}>
          Searched every file in {folder ? <b>{folderName}</b> : "this list"} and its subfolders.
        </PanelEmpty>
      );
    }
    if (scopeSize > 0 && kind !== "all") {
      return <PanelEmpty icon={Search} title={`No ${KIND_LABELS[kind as Exclude<KindFilter, "all">].toLowerCase()} here`} />;
    }
    if (folder) {
      return <PanelEmpty icon={Folder} title="This folder is empty" />;
    }
    return source === "output" ? (
      <PanelEmpty icon={Download} title="Nothing from the agent yet">
        Files the agent writes to <span className="oui-mono">output/</span> show up here as it works.
      </PanelEmpty>
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
      >
        Drop files here or upload from disk. They land in <span className="oui-mono">input/</span> for every agent in this task.
      </PanelEmpty>
    );
  }

  const shared = { panel, source, now, index, previewKey, searching: Boolean(query.trim()), onOpenFolder };
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
}

interface WindowedProps extends RowShared {
  entries: ArtifactEntry[];
  pending: string[];
  direction: "in" | "out" | "none";
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
      rows.push(<PendingRow key={`up-${i}-${pending[i]}`} name={pending[i]} style={style} />);
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
      onKeyDown={(event) => moveFocus(event, (key) => (key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0), count, win.reveal)}
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
        tiles.push(<PendingTile key={`up-${i}-${pending[i]}`} name={pending[i]} style={style} />);
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
      onKeyDown={(event) => moveFocus(event, step, count, win.reveal, cols)}
    >
      <div className="oar-grid" role="list" style={{ height: Math.max(0, win.totalHeight - TILE_GAP) + GRID_PAD * 2 }}>
        <div className="oar-grid-inner">{tiles}</div>
      </div>
    </div>
  );
}

function useEntryActions({ entry, panel, source, onOpenFolder }: { entry: ArtifactEntry } & Pick<RowShared, "panel" | "source" | "onOpenFolder">) {
  const { file } = entry;
  const isLink = !file.is_dir && isLinkFile(file.name);
  const host = hostFileActionsAvailable();
  const activate = () => {
    if (file.is_dir) onOpenFolder(file.path);
    else if (isLink) void panel.handleOpenLink(file);
    else void panel.handlePreview(file);
  };
  let items: ActionItem[];
  if (file.is_dir) {
    items = [
      { id: "open", icon: FolderOpen, label: "Open", onSelect: () => onOpenFolder(file.path) },
      { id: "reveal", icon: FolderSearch, label: revealLabel(), onSelect: () => panel.handleOpenFolder(source, file.path) },
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
  if (source === "input" && !file.is_dir) {
    items.push({ id: "delete", icon: Trash2, label: "Delete", danger: true, separated: true, onSelect: () => void panel.handleDelete(file) });
  }
  const dragProps = file.is_dir ? {} : {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      // Same protocol as FileTree, so the chat composer turns it into a file chip.
      const path = `${file.directory}/${file.path}`;
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(GROVE_FILE_DRAG_TYPE, path);
      event.dataTransfer.setData("application/x-grove-file-is-dir", "false");
      event.dataTransfer.setData("text/plain", path);
    },
  };
  return { isLink, activate, items, dragProps };
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
  const sub = shared.searching && rel !== file.name ? parentPath(rel) : null;
  const name = displayName(file);
  return (
    <div
      role="listitem"
      tabIndex={0}
      data-index={indexAt}
      className={`oar-row${file.is_dir ? " is-dir" : ""}${selected ? " is-sel" : ""}${menu.open ? " is-menu" : ""}`}
      style={style}
      title={isLink ? file.url : rel}
      aria-label={file.is_dir ? `Folder ${name}` : name}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
      }}
      onContextMenu={menu.fromPoint}
      {...dragProps}
    >
      <FileGlyph file={file} projectId={shared.panel.projectId} taskId={shared.panel.taskId} />
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
  const name = displayName(file);
  return (
    <div
      role="listitem"
      tabIndex={0}
      data-index={indexAt}
      className={`oar-tile${selected ? " is-sel" : ""}${menu.open ? " is-menu" : ""}`}
      style={style}
      title={isLink ? file.url : rel}
      aria-label={file.is_dir ? `Folder ${name}` : name}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
      }}
      onContextMenu={menu.fromPoint}
      {...dragProps}
    >
      <TileThumb file={file} projectId={shared.panel.projectId} taskId={shared.panel.taskId} />
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

function PendingRow({ name, style }: { name: string; style: CSSProperties }) {
  return (
    <div role="listitem" className="oar-row is-pending" style={style} aria-label={`Uploading ${name}`}>
      <span className="oar-glyph"><VSCodeIcon filename={name} size={16} /></span>
      <span className="oar-name"><b>{name}</b></span>
      <span className="oar-meta"><Loader2 className="oui-spin" aria-hidden="true" />Uploading…</span>
    </div>
  );
}

function PendingTile({ name, style }: { name: string; style: CSSProperties }) {
  return (
    <div role="listitem" className="oar-tile is-pending" style={style} aria-label={`Uploading ${name}`}>
      <span className={`osd-thumb is-${fileKind(name)} oar-thumb`}>
        <span className="osd-thumb-icon"><Loader2 className="oui-spin" /></span>
      </span>
      <span className="oar-tile-meta"><b>{name}</b><small>Uploading…</small></span>
    </div>
  );
}

function useThumbUrl(file: ArtifactFile, projectId: string | undefined, taskId: string): string | null {
  const raster = !file.is_dir && !isLinkFile(file.name) && RASTER.test(file.name);
  return useSignedUrl(raster && projectId ? artifactDownloadUrl(projectId, taskId, file.directory, file.path) : null);
}

function FileGlyph({ file, projectId, taskId }: { file: ArtifactFile; projectId: string | undefined; taskId: string }) {
  const src = useThumbUrl(file, projectId, taskId);
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

function TileThumb({ file, projectId, taskId }: { file: ArtifactFile; projectId: string | undefined; taskId: string }) {
  const src = useThumbUrl(file, projectId, taskId);
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
      >
        Link a folder on this computer so the agent can read it in place, without copying files in.
      </PanelEmpty>
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
