import { useCallback, useEffect, useRef, useState } from "react";
import { getMemory, migrateMemory } from "../../api";
import { useBanner } from "../../context";
import { errorMessage } from "./resourceModel";

/**
 * Legacy Project Memory (the old shared `memory.md`). Migration-only: its
 * content can be read and moved into a Memory Log, never edited, so the old
 * and new systems cannot diverge.
 */
export function useLegacyMemory(projectId: string | undefined, { onMigrated }: { onMigrated?: () => void } = {}) {
  const { showBanner } = useBanner();
  const [memory, setMemory] = useState("");
  const [isLoadingMemory, setIsLoadingMemory] = useState(true);
  const [isMigratingMemory, setIsMigratingMemory] = useState(false);
  const [memoryMigrationOpen, setMemoryMigrationOpen] = useState(false);
  const onMigratedRef = useRef(onMigrated);
  useEffect(() => { onMigratedRef.current = onMigrated; });

  const loadMemory = useCallback(async () => {
    if (!projectId) return;
    setIsLoadingMemory(true);
    try {
      const data = await getMemory(projectId);
      setMemory(data.content);
    } catch (err) {
      console.error('Failed to load memory:', err);
      setMemory("");
    }
    setIsLoadingMemory(false);
  }, [projectId]);

  useEffect(() => { void Promise.resolve().then(loadMemory); }, [loadMemory]);

  const handleMigrateMemory = useCallback(async () => {
    if (!projectId) return;
    setIsMigratingMemory(true);
    try {
      await migrateMemory(projectId);
      setMemory("");
      onMigratedRef.current?.();
      setMemoryMigrationOpen(false);
      showBanner("Legacy Project Memory migrated to a Memory Log.", "success");
    } catch (err) {
      showBanner(errorMessage(err, "Failed to migrate legacy Project Memory"), "error", 5000);
    }
    setIsMigratingMemory(false);
  }, [projectId, showBanner]);

  return {
    memory, isLoadingMemory, isMigratingMemory,
    memoryMigrationOpen, setMemoryMigrationOpen,
    hasLegacyMemory: memory.trim().length > 0,
    loadMemory, handleMigrateMemory,
  };
}
