import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const STORAGE_KEY = "grove:previewCommentDrafts";
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const WRITE_DEBOUNCE_MS = 300;

function loadFromStorage(): PreviewCommentDraft[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(
      (d): d is PreviewCommentDraft =>
        d && typeof d === "object"
        && typeof d.id === "string"
        && typeof d.comment === "string"
        && typeof d.createdAt === "number"
        && now - d.createdAt < MAX_AGE_MS,
    );
  } catch {
    return [];
  }
}

export interface PreviewCommentLocator {
  type: "dom";
  selector: string;
  xpath?: string;
  tagName: string;
  id?: string;
  className?: string;
  text?: string;
  html?: string;
  role?: string;
  rect?: { x: number; y: number; width: number; height: number };
  extraBlocks?: Array<{ selector: string; xpath: string }>;
}

export interface PreviewCommentDraft {
  id: string;
  source: "artifact" | "review" | "resource";
  projectId: string;
  taskId?: string;
  filePath: string;
  fileName: string;
  rendererId: string;
  locator: PreviewCommentLocator;
  comment: string;
  createdAt: number;
}

export type NewPreviewCommentDraft = Omit<PreviewCommentDraft, "id" | "createdAt">;

interface PreviewCommentContextValue {
  drafts: PreviewCommentDraft[];
  addDraft: (draft: NewPreviewCommentDraft) => PreviewCommentDraft;
  updateDraft: (id: string, patch: Partial<Pick<PreviewCommentDraft, "comment">>) => void;
  removeDraft: (id: string) => void;
  clearDrafts: (ids: string[]) => void;
}

const PreviewCommentContext = createContext<PreviewCommentContextValue | undefined>(undefined);

function makeDraftId() {
  return `pc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function PreviewCommentProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<PreviewCommentDraft[]>(() => loadFromStorage());

  // Debounced persistence — avoid thrashing localStorage during rapid edits
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
      } catch {
        // Quota/denied — silently skip; drafts still live in memory.
      }
    }, WRITE_DEBOUNCE_MS);
    return () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    };
  }, [drafts]);

  const addDraft = useCallback((draft: NewPreviewCommentDraft) => {
    const full: PreviewCommentDraft = {
      ...draft,
      id: makeDraftId(),
      createdAt: Date.now(),
    };
    setDrafts((prev) => [...prev, full]);
    return full;
  }, []);

  const updateDraft = useCallback((id: string, patch: Partial<Pick<PreviewCommentDraft, "comment">>) => {
    setDrafts((prev) => prev.map((draft) => draft.id === id ? { ...draft, ...patch } : draft));
  }, []);

  const removeDraft = useCallback((id: string) => {
    setDrafts((prev) => prev.filter((draft) => draft.id !== id));
  }, []);

  const clearDrafts = useCallback((ids: string[]) => {
    const idSet = new Set(ids);
    setDrafts((prev) => prev.filter((draft) => !idSet.has(draft.id)));
  }, []);

  const value = useMemo(
    () => ({ drafts, addDraft, updateDraft, removeDraft, clearDrafts }),
    [drafts, addDraft, updateDraft, removeDraft, clearDrafts],
  );

  return (
    <PreviewCommentContext.Provider value={value}>
      {children}
    </PreviewCommentContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePreviewComments() {
  const ctx = useContext(PreviewCommentContext);
  if (!ctx) {
    throw new Error("usePreviewComments must be used within PreviewCommentProvider");
  }
  return ctx;
}
