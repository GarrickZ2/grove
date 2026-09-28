import { useCallback, useRef, useState } from "react";
import { apiClient } from "../../api/client";
import { useConfig } from "../../context";
import { FolderTreePickerDialog } from "./FolderTreePickerDialog";

/** Opens the in-app picker when a native dialog cannot be shown reliably. */
export function useBrowseFolder(title = "Select Folder") {
  const { config } = useConfig();
  const [open, setOpen] = useState(false);
  const [pickerTitle, setPickerTitle] = useState(title);
  const resolveRef = useRef<((path: string | null) => void) | null>(null);
  const busyRef = useRef(false);

  const openWebPicker = useCallback((displayTitle: string) => new Promise<string | null>((resolve) => {
    if (resolveRef.current) {
      resolve(null);
      return;
    }
    resolveRef.current = resolve;
    setPickerTitle(displayTitle);
    setOpen(true);
  }), []);

  const browseFolder = useCallback(async (displayTitle = title): Promise<string | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    try {
      const remote = (window as unknown as Record<string, unknown>).__GROVE_REMOTE__ === true;
      if (remote || config?.platform === "windows") return await openWebPicker(displayTitle);
      try {
        const result = await apiClient.get<{ path: string | null; cancelled?: boolean }>("/api/v1/browse-folder");
        if (result.path || result.cancelled) return result.path;
      } catch (error) {
        console.error("Failed to open native folder picker:", error);
      }
      return await openWebPicker(displayTitle);
    } finally {
      busyRef.current = false;
    }
  }, [config?.platform, openWebPicker, title]);

  const finish = (path: string | null) => {
    setOpen(false);
    resolveRef.current?.(path);
    resolveRef.current = null;
  };

  const folderPicker = (
    <FolderTreePickerDialog
      isOpen={open}
      onClose={() => finish(null)}
      onSelect={finish}
      title={pickerTitle}
    />
  );
  return { browseFolder, folderPicker };
}
