import { useCallback, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { ArrowRight, Brain, Layers, RefreshCw, Upload } from "lucide-react";
import { useProject } from "../../context";
import { useBrowseFolder } from "../../components/Projects/useBrowseFolder";
import { AddLinkDialog, FileConflictDialog, FilePreviewDrawer } from "../../components/ui";
import { MarkdownRenderer } from "../../components/ui/MarkdownRenderer";
import { ConfirmDialog } from "../../components/Dialogs/ConfirmDialog";
import { useResourceLibrary } from "../../components/Studio/useResourceLibrary";
import { useWorkspaceInstructions } from "../../components/Studio/useWorkspaceInstructions";
import { useLegacyMemory } from "../../components/Studio/useLegacyMemory";
import { useStudioCommands } from "../../components/Studio/useStudioCommands";
import { Button, OrbitPage, OrbitPageHeader, OrbitPageMessage, Sheet, type PageHue } from "../ui";
import { SharedFilesCard } from "./SharedFilesCard";
import { InstructionsCard } from "./InstructionsCard";
import "./orbit-studio.css";

const HUE: PageHue = {
  from: "#f9a8d4",
  to: "#be185d",
  strong: "rgba(190,24,93,.75)",
  glow: "color-mix(in oklab, #ec4899 13%, transparent)",
};

export function OrbitStudioPage() {
  const { selectedProject } = useProject();
  if (!selectedProject || selectedProject.projectType !== "studio") {
    return <OrbitPageMessage className="osd">Studio is only available for Studio projects.</OrbitPageMessage>;
  }
  // Keyed so folder, search and edit state start fresh per project.
  return <ProjectStudio key={selectedProject.id} projectId={selectedProject.id} projectName={selectedProject.name} />;
}

function ProjectStudio({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { browseFolder, folderPicker } = useBrowseFolder("Select Resource Folder");
  const library = useResourceLibrary(projectId, browseFolder);
  const instructions = useWorkspaceInstructions(projectId);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const legacy = useLegacyMemory(projectId, { onMigrated: () => setLegacyOpen(false) });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openFilePicker = useCallback(() => fileInputRef.current?.click(), []);
  useStudioCommands({ library, instructions, openFilePicker });

  const refreshing = library.isLoadingFiles || library.isLoadingWorkdirs;
  const refresh = () => {
    library.refresh();
    void legacy.loadMemory();
  };
  const { moveConflict, previewFile, editLink } = library;

  const overlays = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        disabled={library.isUploading}
        onChange={(event) => {
          if (event.target.files) void library.handleUpload(event.target.files);
          event.target.value = "";
        }}
      />
      {moveConflict ? (
        <FileConflictDialog
          fileName={moveConflict.fromPath.split("/").pop()!}
          newName={moveConflict.newName}
          existingNames={moveConflict.existingNames}
          onNewNameChange={(value) => library.setMoveConflict({ ...moveConflict, newName: value })}
          onCancel={() => library.setMoveConflict(null)}
          onOverwrite={library.overwriteConflict}
          onRename={library.renameConflict}
        />
      ) : null}
      <AnimatePresence>
        {previewFile ? (
          <FilePreviewDrawer
            fileName={previewFile.file.name}
            content={previewFile.content}
            downloadUrl={previewFile.downloadUrl}
            loading={library.previewLoading}
            onClose={() => library.setPreviewFile(null)}
            onDownload={() => library.handleDownload(previewFile.file)}
            location={{ projectId, root: { kind: "resource" }, path: previewFile.file.path }}
          />
        ) : null}
      </AnimatePresence>
      <AddLinkDialog
        open={library.addLinkOpen}
        title="Add Link to Shared Files"
        onClose={() => library.setAddLinkOpen(false)}
        onSubmit={library.submitAddLink}
      />
      <AddLinkDialog
        open={!!editLink}
        title="Edit Link"
        submitLabel="Save"
        initial={editLink?.initial}
        onClose={() => library.setEditLink(null)}
        onSubmit={library.submitEditLink}
      />
      <Sheet
        open={legacyOpen}
        onClose={() => setLegacyOpen(false)}
        label="Legacy Project Memory"
        title="Legacy Project Memory"
        description={<>The older shared <span className="oui-mono">memory.md</span>. Migrate it to keep it as a Memory Log agents recall the current way.</>}
      >
        <div className="oui-sheet-body osd-legacy-body">
          <div className="osd-legacy-doc oui-scroll"><MarkdownRenderer content={legacy.memory} /></div>
          <div className="osd-legacy-acts">
            <Button variant="primary" disabled={legacy.isMigratingMemory} onClick={() => legacy.setMemoryMigrationOpen(true)}>
              {legacy.isMigratingMemory ? "Migrating…" : "Migrate to Memory"}
            </Button>
          </div>
        </div>
      </Sheet>
      <ConfirmDialog
        isOpen={legacy.memoryMigrationOpen}
        title="Migrate Legacy Project Memory?"
        message={(
          <div className="space-y-2">
            <p>
              Grove will preserve the current <span className="font-mono">memory.md</span> content as one Memory Log,
              then remove the legacy shared file from this Studio.
            </p>
            <p>
              Existing Studio tasks will remove their legacy <span className="font-mono">memory.md</span> entry and refresh
              <span className="font-mono"> AGENTS.md</span>, <span className="font-mono">CLAUDE.md</span>, and
              <span className="font-mono"> GEMINI.md</span> to the current task contract.
            </p>
          </div>
        )}
        confirmLabel={legacy.isMigratingMemory ? "Migrating..." : "Migrate"}
        variant="warning"
        actionsDisabled={legacy.isMigratingMemory}
        onConfirm={() => void legacy.handleMigrateMemory()}
        onCancel={() => {
          if (!legacy.isMigratingMemory) legacy.setMemoryMigrationOpen(false);
        }}
      />
      {folderPicker}
    </>
  );

  return (
    <OrbitPage className="osd" hue={HUE} overlays={overlays}>
      <OrbitPageHeader
        icon={Layers}
        title="Studio"
        subtitle={`Everything agents in ${projectName} can see: shared files, and how you want them to work.`}
        actions={(
          <>
            <Button variant="ghost" iconOnly aria-label="Refresh shared files" title="Refresh" disabled={refreshing} onClick={refresh}>
              <RefreshCw className={refreshing ? "oui-spin" : undefined} />
            </Button>
            <Button variant="primary" disabled={library.isUploading} onClick={openFilePicker}>
              <Upload className={library.isUploading ? "osd-uploading" : undefined} />{library.isUploading ? "Uploading…" : "Upload"}
            </Button>
          </>
        )}
      />

      {legacy.hasLegacyMemory ? (
        <section className="osd-legacy oui-rise" style={{ animationDelay: "40ms" }} aria-label="Legacy Project Memory">
          <span className="osd-legacy-ic" aria-hidden="true"><Brain /></span>
          <span className="osd-legacy-copy">
            <b>This Studio still has a legacy Project Memory</b>
            <span>Move its <span className="oui-mono">memory.md</span> into Memory so agents recall it the current way.</span>
          </span>
          <Button variant="ghost" size="sm" onClick={() => setLegacyOpen(true)}>Review</Button>
          <Button variant="secondary" size="sm" disabled={legacy.isMigratingMemory} onClick={() => legacy.setMemoryMigrationOpen(true)}>
            Migrate<ArrowRight />
          </Button>
        </section>
      ) : null}

      <div className="osd-grid">
        <div className="osd-col oui-rise" style={{ animationDelay: "60ms" }}>
          <SharedFilesCard library={library} openFilePicker={openFilePicker} />
        </div>
        <div className="osd-col oui-rise" style={{ animationDelay: "100ms" }}>
          <InstructionsCard state={instructions} />
        </div>
      </div>
    </OrbitPage>
  );
}
