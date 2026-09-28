export type FileRoot =
  | { kind: "project" }
  | { kind: "resource" }
  | { kind: "task"; taskId: string };

/** Identifies a file and the storage namespace that owns it. */
export interface FileLocation {
  projectId: string;
  root: FileRoot;
  /** Path relative to the source root. */
  path: string;
}

const EXTERNAL_REFERENCE_RE = /^(https?:\/\/|data:|blob:|mailto:|tel:|#|javascript:|\/)/i;

export function isAbsoluteFileReference(reference: string): boolean {
  return EXTERNAL_REFERENCE_RE.test(reference.trim());
}

function splitSuffix(reference: string): { path: string; suffix: string } {
  const index = reference.search(/[?#]/);
  if (index < 0) return { path: reference, suffix: "" };
  return { path: reference.slice(0, index), suffix: reference.slice(index) };
}

/** Resolve a reference lexically without allowing it to escape the source root. */
export function resolveRelativeFilePath(
  containingFile: string,
  reference: string,
): { path: string; suffix: string } | undefined {
  let trimmed = reference.trim();
  if (!trimmed) return undefined;
  const isFileUrl = trimmed.startsWith("file://");
  if (!isFileUrl && EXTERNAL_REFERENCE_RE.test(trimmed)) return undefined;
  if (isFileUrl) {
    trimmed = trimmed.slice("file://".length);
    if (/^\/[A-Za-z]:[\\/]/.test(trimmed)) trimmed = trimmed.slice(1);
    else if (!trimmed.startsWith("/")) trimmed = `//${trimmed}`;
  }

  const { path: referencePath, suffix } = splitSuffix(trimmed);
  if (referencePath.startsWith("/")) {
    return { path: referencePath, suffix };
  }
  if (/^[A-Za-z]:[\\/]/.test(referencePath) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(referencePath)) {
    return { path: referencePath.replace(/\\/g, "/"), suffix };
  }
  const normalizedContainingFile = containingFile.replace(/\\/g, "/");
  const containingFileIsAbsolute = normalizedContainingFile.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalizedContainingFile);
  const minParts = normalizedContainingFile.startsWith("//") ? 2 :
    /^[A-Za-z]:\//.test(normalizedContainingFile) ? 1 : 0;
  const parent = normalizedContainingFile.includes("/")
    ? normalizedContainingFile.slice(0, normalizedContainingFile.lastIndexOf("/"))
    : "";
  const parts: string[] = [];

  for (const part of `${parent}/${referencePath}`.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > minParts && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (containingFileIsAbsolute) {
        return undefined;
      } else {
        // Preserve traversal above the declared source root. The frontend
        // does not know the physical relationship between output, input,
        // resource, linked workdirs, and project files; the selected backend
        // endpoint remains the authority for containment and access policy.
        parts.push("..");
      }
    } else {
      parts.push(part);
    }
  }

  if (parts.length === 0) return undefined;
  const prefix = normalizedContainingFile.startsWith("//") ? "//" :
    normalizedContainingFile.startsWith("/") ? "/" : "";
  return {
    path: `${prefix}${parts.join("/")}`,
    suffix,
  };
}

/** Map a file-relative reference to the raw endpoint owned by its source. */
export function resolveFileReference(
  location: FileLocation | undefined,
  reference: string,
): string {
  if (!location) return reference;
  const resolved = resolveRelativeFilePath(location.path, reference);
  if (!resolved) return reference;

  const encodedPath = encodeURIComponent(resolved.path);
  const suffix = resolved.suffix.startsWith("?")
    ? `&${resolved.suffix.slice(1)}`
    : resolved.suffix;
  switch (location.root.kind) {
    case "task":
      return `/api/v1/projects/${location.projectId}/tasks/${location.root.taskId}/files/raw?path=${encodedPath}${suffix}`;
    case "resource":
      return `/api/v1/projects/${location.projectId}/resource/files/raw?path=${encodedPath}${suffix}`;
    case "project":
      return `/api/v1/projects/${location.projectId}/files/raw?path=${encodedPath}${suffix}`;
  }
}
