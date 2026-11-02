import { useEffect, useRef, useState } from "react";

// Caps & validation. Mirrors what the backend would accept; rejecting
// here gives the user immediate feedback instead of an opaque 500.
export const MAX_PROJECT_NAME_LEN = 128;

export function validateProjectName(name: string): string | null {
  if (!name) return "Name cannot be empty.";
  if (name.length > MAX_PROJECT_NAME_LEN) return `Name must be ${MAX_PROJECT_NAME_LEN} characters or fewer.`;
  // Reject path separators, NUL, and control chars — anything that
  // would confuse downstream filesystem / display code.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f/\\]/.test(name)) {
    return "Name cannot contain slashes or control characters.";
  }
  return null;
}

/** Inline rename of a project name: edit state, validation, submit on Enter / blur, cancel on Escape. */
export function useProjectRename(name: string, onRename: (newName: string) => Promise<void>) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(name);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  // Set when the user clicks a destructive button while editing — prevents
  // the input's onBlur from accidentally committing a rename when the
  // user's actual intent was something else (e.g. delete the project).
  const skipBlurSubmitRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const beginEditing = () => {
    setEditName(name);
    setRenameError(null);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditName(name);
    setRenameError(null);
  };

  const changeName = (value: string) => {
    setEditName(value);
    if (renameError) setRenameError(null);
  };

  const submitRename = async () => {
    if (isRenaming) return;
    const trimmed = editName.trim();
    if (!trimmed || trimmed === name) {
      cancelEditing();
      return;
    }
    const validationError = validateProjectName(trimmed);
    if (validationError) {
      setRenameError(validationError);
      return;
    }
    setIsRenaming(true);
    setRenameError(null);
    try {
      await onRename(trimmed);
      setIsEditing(false);
    } catch (err) {
      // Surface the error inline instead of silently reverting; the
      // user just lost their edit otherwise.
      const msg =
        err instanceof Error
          ? err.message
          : (typeof err === "string" ? err : "Rename failed.");
      setRenameError(msg);
      // Keep the edited name visible so the user can adjust.
    } finally {
      setIsRenaming(false);
    }
  };

  const handleBlur = () => {
    if (skipBlurSubmitRef.current) {
      skipBlurSubmitRef.current = false;
      cancelEditing();
      return;
    }
    void submitRename();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submitRename();
    } else if (e.key === "Escape") {
      cancelEditing();
    }
  };

  return {
    isEditing,
    editName,
    isRenaming,
    renameError,
    inputRef,
    skipBlurSubmitRef,
    beginEditing,
    cancelEditing,
    changeName,
    handleBlur,
    handleKeyDown,
  };
}
