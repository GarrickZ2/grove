import { useState, useEffect, useCallback } from "react";
import { FileText, Edit3, Save, X, Loader2 } from "lucide-react";
import { Button } from "../../../ui";
import type { Task } from "../../../../data/types";
import { useProject } from "../../../../context/ProjectContext";
import { getNotes, updateNotes } from "../../../../api";

interface NotesTabProps {
  task: Task;
}

export function NotesTab({ task }: NotesTabProps) {
  const { selectedProject } = useProject();
  const [isEditing, setIsEditing] = useState(false);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load notes from API
  const loadNotes = useCallback(async () => {
    if (!selectedProject) return;

    try {
      setIsLoading(true);
      setError(null);
      const response = await getNotes(selectedProject.id, task.id);
      setContent(response.content);
      setOriginalContent(response.content);
    } catch (err) {
      console.error("Failed to load notes:", err);
      setContent("");
      setOriginalContent("");
    } finally {
      setIsLoading(false);
    }
  }, [selectedProject, task.id]);

  useEffect(() => {
    loadNotes();
    setIsEditing(false);
  }, [loadNotes]);

  const handleSave = async () => {
    if (!selectedProject) return;

    try {
      setIsSaving(true);
      setError(null);
      await updateNotes(selectedProject.id, task.id, content);
      setOriginalContent(content);
      setIsEditing(false);
    } catch (err) {
      console.error("Failed to save notes:", err);
      setError("Failed to save notes");
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setContent(originalContent);
    setIsEditing(false);
  };

  if (isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <Loader2 className="w-8 h-8 text-[var(--color-text-muted)] mb-3 animate-spin" />
        <p className="text-[var(--color-text-muted)]">Loading notes...</p>
      </div>
    );
  }

  if (!content && !isEditing) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <FileText className="w-12 h-12 text-[var(--color-text-muted)] mb-3" />
        <p className="text-[var(--color-text-muted)] mb-4">No notes for this task</p>
        <Button variant="secondary" size="sm" onClick={() => setIsEditing(true)}>
          <Edit3 className="w-4 h-4 mr-1.5" />
          Add Notes
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-[var(--color-text)] flex items-center gap-2">
          <FileText className="w-4 h-4" />
          Task Notes
        </h3>
        {isEditing ? (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={isSaving}>
              <X className="w-4 h-4 mr-1" />
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={isSaving}>
              {isSaving ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-1" />
              )}
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)}>
            <Edit3 className="w-4 h-4 mr-1" />
            Edit
          </Button>
        )}
      </div>

      {/* Content */}
      {isEditing ? (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Write your notes in Markdown..."
          className="flex-1 w-full p-3 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg
            text-sm text-[var(--color-text)] font-mono resize-none
            focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]
            transition-all duration-200"
        />
      ) : (
        <div className="flex-1 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
          <div className="prose prose-invert prose-sm max-w-none">
            {content.split('\n').map((line, index) => {
              // Simple markdown rendering
              if (line.startsWith('# ')) {
                return <h1 key={index} className="text-lg font-bold text-[var(--color-text)] mt-4 mb-2 first:mt-0">{line.slice(2)}</h1>;
              }
              if (line.startsWith('## ')) {
                return <h2 key={index} className="text-base font-semibold text-[var(--color-text)] mt-3 mb-2">{line.slice(3)}</h2>;
              }
              if (line.startsWith('- [x] ')) {
                return (
                  <div key={index} className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
                    <span className="text-[var(--color-success)]">✓</span>
                    <span className="line-through">{line.slice(6)}</span>
                  </div>
                );
              }
              if (line.startsWith('- [ ] ')) {
                return (
                  <div key={index} className="flex items-center gap-2 text-sm text-[var(--color-text)]">
                    <span className="text-[var(--color-text-muted)]">○</span>
                    <span>{line.slice(6)}</span>
                  </div>
                );
              }
              if (line.startsWith('- ')) {
                return <li key={index} className="text-sm text-[var(--color-text)] ml-4">{line.slice(2)}</li>;
              }
              if (line.trim() === '') {
                return <div key={index} className="h-2" />;
              }
              return <p key={index} className="text-sm text-[var(--color-text)]">{line}</p>;
            })}
          </div>
        </div>
      )}

      {/* Error message */}
      {error && (
        <p className="text-xs text-[var(--color-error)] mt-2">{error}</p>
      )}
    </div>
  );
}
