import { useEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import {
  Check, ChevronRight, CircleAlert, CornerLeftUp, Download, Edit3, Eye, Folder, FolderOpen, FolderPlus,
  FolderSearch, Layers, Link as LinkIcon, Link2, MoreHorizontal, Pencil, Search, SquareArrowOutUpRight, Trash2, Upload, X,
} from "lucide-react";
import type { ResourceFile, WorkDirectoryEntry } from "../../api";
import { resourceDownloadUrl } from "../../api";
import { VSCodeIcon, formatSize, isLinkFile } from "../../components/ui";
import { DRAG_TYPE, breadcrumbTrail, canMoveInto, filterFiles, parentPath, resourceStats } from "../../components/Studio/resourceModel";
import type { ResourceLibrary } from "../../components/Studio/useResourceLibrary";
import { Button, Card, EmptyState, SearchField, agoText, formatDateTime, shortAgo, useNow } from "../ui";
import { ActionMenu, type ActionItem } from "./ActionMenu";
import { useActionMenu } from "./useActionMenu";
import { useSignedUrl } from "./useSignedUrl";
import { extLabel, fileKind, hostFileActionsAvailable, libraryCounts, linkHost, revealLabel, tileTitle } from "./studioView";

const CLOCK_MS = 60_000;
const SKELETON_TILES = 8;

interface SharedFilesCardProps {
  library: ResourceLibrary;
  openFilePicker: () => void;
}

function hasMoveDrag(event: DragEvent) {
  return event.dataTransfer.types.includes(DRAG_TYPE);
}

/** Drop-target props for moving a dragged resource into `folder`. */
function useMoveTarget(folder: string, onMove: (fromPath: string, toFolder: string) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!hasMoveDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!over) setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        if (!hasMoveDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const fromPath = event.dataTransfer.getData(DRAG_TYPE);
        if (canMoveInto(fromPath, folder)) onMove(fromPath, folder);
      },
    },
  };
}

function startMoveDrag(event: DragEvent, path: string) {
  event.dataTransfer.setData(DRAG_TYPE, path);
  event.dataTransfer.effectAllowed = "move";
}

/** Shared files: folder strip (trail, subfolders, linked folders) over a tile grid. Drop files anywhere to upload. */
export function SharedFilesCard({ library, openFilePicker }: SharedFilesCardProps) {
  const now = useNow(CLOCK_MS);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const {
    files, workdirs, currentPath, searchQuery, setSearchQuery, isLoadingFiles, isLoadingWorkdirs,
    fileError, setFileError, workdirError, setWorkdirError, pendingUploads, isCreatingFolder,
  } = library;
  const atRoot = currentPath === "";
  const visible = filterFiles(files, searchQuery);
  const folders = visible.filter((file) => file.is_dir);
  const tiles = visible.filter((file) => !file.is_dir);
  const q = searchQuery.toLowerCase();
  const linked = atRoot ? workdirs.filter((entry) => entry.name.toLowerCase().includes(q)) : [];
  const loading = (isLoadingFiles && files.length === 0) || (atRoot && isLoadingWorkdirs && workdirs.length === 0 && files.length === 0);
  const stats = resourceStats(files);
  const nothingHere = files.length === 0 && (!atRoot || workdirs.length === 0);
  const showStrip = !atRoot || folders.length > 0 || linked.length > 0 || isCreatingFolder;
  const error = fileError ?? workdirError;
  const loadFailed = Boolean(error) && nothingHere;
  const previewPath = library.previewFile?.file.path ?? null;

  const resetDrag = () => { depth.current = 0; setDragging(false); };
  const dropProps = {
    onDragEnter: (event: DragEvent) => {
      if (hasMoveDrag(event)) return;
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (event: DragEvent) => { if (!hasMoveDrag(event)) event.preventDefault(); },
    onDragLeave: () => {
      if (depth.current === 0) return;
      depth.current -= 1;
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      resetDrag();
      library.uploadFromDrop(event.dataTransfer);
    },
  };

  const dismissError = () => { setFileError(null); setWorkdirError(null); };
  const retry = () => { dismissError(); library.refresh(); };
  const where = atRoot ? "resource/" : `resource/${currentPath}/`;

  let body;
  if (loading) {
    body = (
      <div className="osd-tiles" aria-hidden="true">
        {Array.from({ length: SKELETON_TILES }, (_, index) => (
          <div key={index} className="osd-tile is-skel"><span className="osd-thumb" /><span className="osd-meta"><span className="oui-skel" /><span className="oui-skel" /></span></div>
        ))}
      </div>
    );
  } else if (loadFailed) {
    body = (
      <EmptyState role="alert" icon={CircleAlert} tone="error" title="Couldn’t load shared files" action={<Button variant="secondary" size="sm" onClick={retry}>Try again</Button>}>
        {error}
      </EmptyState>
    );
  } else if (nothingHere && pendingUploads.length === 0 && !isCreatingFolder) {
    body = atRoot ? (
      <EmptyState
        size="lg"
        tone="hue"
        icon={Upload}
        title="Share files with every agent"
        action={(
          <>
            <Button variant="primary" size="sm" onClick={openFilePicker}><Upload />Upload files</Button>
            <Button variant="secondary" size="sm" disabled={library.isAddingWorkdir} onClick={() => void library.handleAddWorkdir()}><FolderOpen />Link a folder</Button>
          </>
        )}
      >
        Drop files here or upload from disk. Every task in this Studio sees them in <span className="oui-mono">resource/</span>; linked folders are shared read-only.
      </EmptyState>
    ) : (
      <EmptyState icon={Folder} title="This folder is empty" action={<Button variant="secondary" size="sm" onClick={openFilePicker}><Upload />Upload here</Button>}>
        Drop files here, or drag files from another folder onto its name above.
      </EmptyState>
    );
  } else if (tiles.length === 0 && pendingUploads.length === 0 && searchQuery) {
    body = folders.length > 0 || linked.length > 0 ? (
      <EmptyState icon={Search} title="Only folders match">Open one above, or clear the search.</EmptyState>
    ) : (
      <EmptyState icon={Search} title={`No files match “${searchQuery}”`} action={<Button variant="secondary" size="sm" onClick={() => setSearchQuery("")}>Clear search</Button>} />
    );
  } else if (tiles.length === 0 && pendingUploads.length === 0) {
    body = (
      <EmptyState icon={Upload} title="No files here yet" action={<Button variant="secondary" size="sm" onClick={openFilePicker}><Upload />Upload here</Button>}>
        Only folders at this level. Drop files to add them here.
      </EmptyState>
    );
  } else {
    body = (
      // Keyed by folder so each opened folder's tiles settle in again.
      <div key={currentPath} className="osd-tiles oui-scroll">
        {pendingUploads.map((name, index) => <PendingTile key={`up-${name}-${index}`} name={name} />)}
        {tiles.map((file, index) => (
          <FileTile
            key={file.path}
            file={file}
            index={index}
            now={now}
            selected={previewPath === file.path}
            library={library}
          />
        ))}
      </div>
    );
  }

  return (
    <Card
      className="osd-files"
      aria-label="Shared files"
      title="Shared files"
      hint={loading ? undefined : libraryCounts(files, workdirs, atRoot)}
      actions={(
        <SearchField
          className="osd-search"
          label="Search files"
          value={searchQuery}
          onChange={setSearchQuery}
          onKeyDown={(event) => {
            if (event.key === "Escape" && searchQuery) {
              event.stopPropagation();
              setSearchQuery("");
            }
          }}
        />
      )}
      {...dropProps}
    >
      {showStrip ? <FolderStrip library={library} folders={folders} linked={linked} /> : null}
      {error && !loadFailed ? (
        <p className="osd-notice" role="alert">
          <CircleAlert aria-hidden="true" /><span>{error}</span>
          <button type="button" onClick={dismissError}>Dismiss</button>
        </p>
      ) : null}
      <div className="osd-files-body">{body}</div>
      <div className="osd-hintbar">
        <Upload aria-hidden="true" />
        <span className="osd-hint-copy oui-truncate" title={`Every task sees these files in ${where}`}>
          {stats.fileCount > 0 ? (
            <>
              {formatSize(stats.totalBytes)}
              {stats.latestUpdate ? <> · updated <span title={formatDateTime(stats.latestUpdate)}>{agoText(new Date(stats.latestUpdate).getTime(), now)}</span></> : null}
            </>
          ) : "Drop files anywhere on this card"}
        </span>
        <span className="osd-sp" />
        <Button variant="ghost" size="sm" onClick={library.startCreateFolder}><FolderPlus />New folder</Button>
        <Button variant="ghost" size="sm" onClick={() => library.setAddLinkOpen(true)}><LinkIcon />Add link</Button>
        {atRoot ? (
          <Button variant="ghost" size="sm" disabled={library.isAddingWorkdir} onClick={() => void library.handleAddWorkdir()}>
            <FolderOpen className={library.isAddingWorkdir ? "oui-spin" : undefined} />Link a folder
          </Button>
        ) : null}
      </div>
      {dragging ? (
        <div className="osd-drop" aria-hidden="true">
          <Upload />
          <span>Drop to share with every agent</span>
          <small>{atRoot ? "Uploads to resource/" : `Uploads to resource/${currentPath}/`}</small>
        </div>
      ) : null}
    </Card>
  );
}

/* ── Folder strip ── */

function FolderStrip({ library, folders, linked }: { library: ResourceLibrary; folders: ResourceFile[]; linked: WorkDirectoryEntry[] }) {
  const { currentPath, navigateTo, handleMoveFile } = library;
  const trail = breadcrumbTrail(currentPath);
  const newFolderRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (library.isCreatingFolder) newFolderRef.current?.focus();
  }, [library.isCreatingFolder]);
  return (
    <div className="osd-strip" role="toolbar" aria-label="Folders">
      <TrailChip label="resource" folder="" current={currentPath === ""} root onOpen={navigateTo} onMove={handleMoveFile} />
      {trail.map((segment) => (
        <span key={segment.path} className="osd-trail-seg">
          <ChevronRight className="osd-trail-sep" aria-hidden="true" />
          <TrailChip label={segment.name} folder={segment.path} current={segment.path === currentPath} onOpen={navigateTo} onMove={handleMoveFile} />
        </span>
      ))}
      {folders.length > 0 || linked.length > 0 || library.isCreatingFolder ? <span className="osd-strip-rule" aria-hidden="true" /> : null}
      {library.isCreatingFolder ? (
        <span className="osd-chip is-edit">
          <FolderPlus aria-hidden="true" />
          <input
            ref={newFolderRef}
            value={library.newFolderName}
            aria-label="New folder name"
            placeholder="Folder name"
            onChange={(event) => library.setNewFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void library.handleCreateFolder();
              if (event.key === "Escape") { event.stopPropagation(); library.cancelCreateFolder(); }
            }}
          />
          <button type="button" aria-label="Create folder" onClick={() => void library.handleCreateFolder()}><Check /></button>
          <button type="button" aria-label="Cancel" onClick={library.cancelCreateFolder}><X /></button>
        </span>
      ) : null}
      {folders.map((folder) => <FolderChip key={folder.path} folder={folder} library={library} />)}
      {linked.map((entry) => <LinkedChip key={entry.name} entry={entry} library={library} />)}
    </div>
  );
}

function TrailChip({ label, folder, current, root = false, onOpen, onMove }: {
  label: string;
  folder: string;
  current: boolean;
  root?: boolean;
  onOpen: (path: string) => void;
  onMove: (fromPath: string, toFolder: string) => void;
}) {
  const target = useMoveTarget(folder, onMove);
  return (
    <button
      type="button"
      className={`osd-chip is-trail${current ? " is-on" : ""}${target.over ? " is-drop" : ""}`}
      aria-current={current ? "location" : undefined}
      title={current ? undefined : `Open ${root ? "resource/" : folder}`}
      onClick={() => { if (!current) onOpen(folder); }}
      {...target.props}
    >
      {root ? <Layers aria-hidden="true" /> : null}{label}
    </button>
  );
}

function RenameInput({ value, onChange, onConfirm, onCancel, inputRef }: {
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <input
      ref={inputRef}
      className="osd-rename"
      value={value}
      aria-label="New name"
      onChange={(event) => onChange(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={onConfirm}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") onConfirm();
        if (event.key === "Escape") onCancel();
      }}
    />
  );
}

/** Rename-state wiring shared by folder chips and file tiles. */
function useRename(library: ResourceLibrary, file: ResourceFile) {
  const renaming = library.renamingPath === file.path;
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);
  // Enter confirms, then the input unmounts and blurs; confirm only once.
  const settled = useRef(false);
  useEffect(() => { if (renaming) settled.current = false; }, [renaming]);
  const confirm = () => {
    if (settled.current) return;
    settled.current = true;
    // A failed rename keeps the field open; let the next Enter retry.
    void library.handleRenameFile(file.path, library.renameValue).then(() => { settled.current = false; });
  };
  const cancel = () => {
    settled.current = true;
    library.setRenamingPath(null);
  };
  return {
    renaming,
    input: <RenameInput value={library.renameValue} onChange={library.setRenameValue} onConfirm={confirm} onCancel={cancel} inputRef={inputRef} />,
  };
}

function FolderChip({ folder, library }: { folder: ResourceFile; library: ResourceLibrary }) {
  const target = useMoveTarget(folder.path, library.handleMoveFile);
  const menu = useActionMenu();
  const rename = useRename(library, folder);
  const items: ActionItem[] = [
    { id: "open", icon: FolderOpen, label: "Open", onSelect: () => library.navigateTo(folder.path) },
    { id: "rename", icon: Pencil, label: "Rename", onSelect: () => library.startRename(folder) },
    ...(library.currentPath ? [{ id: "up", icon: CornerLeftUp, label: "Move to parent", onSelect: () => void library.handleMoveFile(folder.path, parentPath(library.currentPath)) }] : []),
    { id: "delete", icon: Trash2, label: "Delete", danger: true, separated: true, onSelect: () => void library.handleDelete(folder) },
  ];
  if (rename.renaming) {
    return <span className="osd-chip is-edit"><Folder aria-hidden="true" />{rename.input}</span>;
  }
  return (
    <>
      <button
        type="button"
        draggable
        className={`osd-chip${target.over ? " is-drop" : ""}${menu.open ? " is-menu" : ""}`}
        title="Open folder · drop files here to move them"
        onClick={() => library.navigateTo(folder.path)}
        onContextMenu={menu.fromPoint}
        onDragStart={(event) => startMoveDrag(event, folder.path)}
        {...target.props}
      >
        <Folder aria-hidden="true" />{folder.name}
        <span
          role="button"
          tabIndex={-1}
          className="osd-chip-more"
          aria-label={`${folder.name} actions`}
          onClick={(event) => { event.stopPropagation(); menu.fromButton(event.currentTarget); }}
        ><MoreHorizontal /></span>
      </button>
      <ActionMenu at={menu.at} items={items} label={`${folder.name} actions`} onClose={menu.close} />
    </>
  );
}

function LinkedChip({ entry, library }: { entry: WorkDirectoryEntry; library: ResourceLibrary }) {
  const menu = useActionMenu();
  const items: ActionItem[] = [
    { id: "open", icon: FolderSearch, label: "Open folder", onSelect: () => void library.handleOpenWorkdir(entry) },
    { id: "remove", icon: Trash2, label: "Remove link", danger: true, separated: true, onSelect: () => void library.handleDeleteWorkdir(entry) },
  ];
  return (
    <>
      <button
        type="button"
        className={`osd-chip is-linked${entry.exists ? "" : " is-missing"}${menu.open ? " is-menu" : ""}`}
        title={`${entry.target_path}\n${entry.exists ? "Linked read-only into every task" : "This folder no longer exists"}`}
        onClick={(event) => menu.fromButton(event.currentTarget)}
        onContextMenu={menu.fromPoint}
      >
        <Link2 aria-hidden="true" />{entry.name}
        <small>{entry.exists ? "read-only" : "missing"}</small>
      </button>
      <ActionMenu at={menu.at} items={items} label={`${entry.name} actions`} onClose={menu.close} />
    </>
  );
}

/* ── Tiles ── */

function PendingTile({ name }: { name: string }) {
  return (
    <div className="osd-tile is-pending" role="status" aria-label={`Uploading ${name}`}>
      <span className={`osd-thumb is-${fileKind(name)}`}>
        <span className="osd-thumb-icon"><VSCodeIcon filename={name} size={26} /></span>
        <span className="osd-prog" aria-hidden="true"><svg viewBox="0 0 36 36"><circle className="osd-prog-bg" cx="18" cy="18" r="15" /><circle className="osd-prog-fg" cx="18" cy="18" r="15" /></svg></span>
      </span>
      <span className="osd-meta"><b>{name}</b><small>Uploading…</small></span>
    </div>
  );
}

function Thumb({ file, projectId }: { file: ResourceFile; projectId: string | undefined }) {
  const kind = fileKind(file.name);
  const src = useSignedUrl(kind === "image" && projectId ? resourceDownloadUrl(projectId, file.path) : null);
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const ext = extLabel(file.name);
  return (
    <span className={`osd-thumb is-${kind}`}>
      {kind === "link" ? (
        <span className="osd-thumb-icon is-link">
          {file.favicon && !broken ? <img src={file.favicon} alt="" onError={() => setBroken(true)} /> : <LinkIcon />}
        </span>
      ) : src && !broken ? (
        <img className={`osd-thumb-img${loaded ? " is-loaded" : ""}`} src={src} alt="" loading="lazy" draggable={false} onLoad={() => setLoaded(true)} onError={() => setBroken(true)} />
      ) : (
        <span className="osd-thumb-icon"><VSCodeIcon filename={file.name} size={26} /></span>
      )}
      {ext ? <span className="osd-ext">{ext}</span> : null}
    </span>
  );
}

function FileTile({ file, index, now, selected, library }: {
  file: ResourceFile;
  index: number;
  now: number;
  selected: boolean;
  library: ResourceLibrary;
}) {
  const menu = useActionMenu();
  const rename = useRename(library, file);
  const isLink = isLinkFile(file.name);
  const host = hostFileActionsAvailable();
  const activate = () => {
    if (rename.renaming) return;
    if (isLink) void library.handleOpenLink(file);
    else void library.handlePreview(file);
  };
  const items: ActionItem[] = isLink
    ? [
        { id: "open", icon: SquareArrowOutUpRight, label: "Open in browser", onSelect: () => void library.handleOpenLink(file) },
        { id: "edit", icon: Edit3, label: "Edit link", onSelect: () => void library.handleEditLink(file) },
      ]
    : [
        { id: "preview", icon: Eye, label: "Preview", onSelect: () => void library.handlePreview(file) },
        { id: "download", icon: Download, label: "Download", onSelect: () => library.handleDownload(file) },
        ...(host ? [
          { id: "app", icon: SquareArrowOutUpRight, label: "Open", onSelect: () => library.handleOpenInApp(file) },
          { id: "reveal", icon: FolderSearch, label: revealLabel(), onSelect: () => library.handleRevealInFileManager(file) },
        ] : []),
        { id: "rename", icon: Pencil, label: "Rename", onSelect: () => library.startRename(file) },
      ];
  if (library.currentPath) {
    items.push({ id: "up", icon: CornerLeftUp, label: "Move to parent", onSelect: () => void library.handleMoveFile(file.path, parentPath(library.currentPath)) });
  }
  items.push({ id: "delete", icon: Trash2, label: "Delete", danger: true, separated: true, onSelect: () => void library.handleDelete(file) });
  const at = new Date(file.modified_at).getTime();
  return (
    <>
    <div
      role="button"
      tabIndex={0}
      draggable={!rename.renaming}
      className={`osd-tile${selected ? " is-sel" : ""}${menu.open ? " is-menu" : ""}`}
      style={{ animationDelay: `${Math.min(index, 12) * 30 + 40}ms` }}
      title={isLink ? file.url : file.name}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
      }}
      onContextMenu={menu.fromPoint}
      onDragStart={(event) => startMoveDrag(event, file.path)}
    >
      <Thumb file={file} projectId={library.projectId} />
      <button
        type="button"
        className="osd-tile-more"
        aria-label={`${tileTitle(file)} actions`}
        onClick={(event) => { event.stopPropagation(); menu.fromButton(event.currentTarget); }}
      ><MoreHorizontal /></button>
      <span className="osd-meta">
        {rename.renaming ? rename.input : <b>{tileTitle(file)}</b>}
        <small>
          {isLink ? linkHost(file) : (
            <>
              {formatSize(file.size)} · <span title={formatDateTime(file.modified_at)}>{Number.isNaN(at) ? "—" : shortAgo(at, now)}</span>
            </>
          )}
        </small>
      </span>
    </div>
    <ActionMenu at={menu.at} items={items} label={`${tileTitle(file)} actions`} onClose={menu.close} />
    </>
  );
}
