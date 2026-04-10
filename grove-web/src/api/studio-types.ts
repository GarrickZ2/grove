/**
 * Shared types for Studio Resource and Task Artifact APIs.
 * Both APIs serve file listings and work-directory entries with the same shape.
 */

/** A file or directory entry returned by Studio Resource or Artifact APIs. */
export interface StudioFileEntry {
  name: string;
  path: string;
  size: number;
  modified_at: string;
  is_dir: boolean;
}

/** A work-directory symlink entry. */
export interface StudioWorkDirEntry {
  name: string;
  target_path: string;
  exists: boolean;
}
