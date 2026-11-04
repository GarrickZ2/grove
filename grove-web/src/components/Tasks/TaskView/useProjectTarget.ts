import { useState } from "react";

/** One Project a panel can show: the task's own, or a linked Project's. */
export interface ProjectTarget {
  projectId: string;
  taskId: string;
  name: string;
  isGitRepo?: boolean;
  linked: boolean;
}

function readSelection(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSelection(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage unavailable — selection just won't survive a reload.
  }
}

/** The panel's Project, remembered per task and per panel for this tab. */
export function useProjectTarget(storageKey: string, targets: ProjectTarget[]) {
  const [selectedId, setSelectedId] = useState<string | null>(() => readSelection(storageKey));
  const select = (id: string) => {
    setSelectedId(id);
    writeSelection(storageKey, id);
  };
  return { active: targets.find((t) => t.projectId === selectedId) ?? targets[0], select };
}
