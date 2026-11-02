import { useCallback, useEffect, useState } from "react";
import { getInstructions, updateInstructions } from "../../api";
import { appendTemplate, countInstructionLines, errorMessage } from "./resourceModel";

/** Workspace Instructions (`instructions.md` in every Studio task): load, edit, save. */
export function useWorkspaceInstructions(projectId: string | undefined) {
  const [instructions, setInstructions] = useState("");
  const [savedInstructions, setSavedInstructions] = useState("");
  const [isLoadingInstructions, setIsLoadingInstructions] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  /** Grows on every successful save (drives Orbit's Saved chip). */
  const [saveCount, setSaveCount] = useState(0);
  const [isEditingInstructions, setIsEditingInstructions] = useState(false);

  const hasUnsaved = instructions !== savedInstructions;
  const instructionLineCount = countInstructionLines(instructions);

  const loadInstructions = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingInstructions(true);
    try {
      const data = await getInstructions(projectId);
      setInstructions(data.content);
      setSavedInstructions(data.content);
    } catch (err) {
      console.error('Failed to load instructions:', err);
      setInstructions("");
      setSavedInstructions("");
    }
    setIsLoadingInstructions(false);
  }, [projectId]);

  useEffect(() => { void Promise.resolve().then(loadInstructions); }, [loadInstructions]);

  // Auto-dismiss save messages with proper cleanup
  useEffect(() => {
    if (!saveMessage) return;
    const t = setTimeout(() => setSaveMessage(null), 2000);
    return () => clearTimeout(t);
  }, [saveMessage]);

  const handleSaveInstructions = useCallback(async () => {
    if (!projectId) return;
    setIsSaving(true);
    let caught: unknown = null;
    try {
      await updateInstructions(projectId, instructions);
      setSavedInstructions(instructions);
      setSaveMessage("Saved");
      setSaveCount((count) => count + 1);
      setIsEditingInstructions(false);
    } catch (err) {
      caught = err;
    }
    if (caught !== null) {
      setSaveMessage(errorMessage(caught, "Failed to save"));
    }
    setIsSaving(false);
  }, [projectId, instructions]);

  const cancelEditing = useCallback(() => {
    setInstructions(savedInstructions);
    setIsEditingInstructions(false);
  }, [savedInstructions]);

  const insertTemplate = useCallback((content: string) => {
    setInstructions((current) => appendTemplate(current, content));
  }, []);

  return {
    instructions, setInstructions, savedInstructions,
    isLoadingInstructions, isSaving, saveMessage, saveCount,
    isEditingInstructions, setIsEditingInstructions,
    hasUnsaved, instructionLineCount,
    loadInstructions, handleSaveInstructions, cancelEditing, insertTemplate,
  };
}

export type WorkspaceInstructions = ReturnType<typeof useWorkspaceInstructions>;
