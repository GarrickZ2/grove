/** Server filesystem paths may use Windows drive letters or UNC shares. */
export function isAbsoluteFilesystemPath(path: string): boolean {
  const value = path.trim();
  return value.startsWith("/") || /^~(?:[\\/]|$)/.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

export function filesystemBasename(path: string): string {
  return path.trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
}

export function joinFilesystemPath(parent: string, name: string): string {
  const separator = parent.includes("\\") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`;
}

export function filesystemBreadcrumbs(path: string): Array<{ label: string; path: string }> {
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    const normalized = path.replace(/\//g, "\\");
    const root = normalized.slice(0, 2) + "\\";
    const crumbs = [{ label: normalized.slice(0, 2), path: root }];
    let current = root;
    for (const part of normalized.slice(3).split("\\").filter(Boolean)) {
      current += `${current.endsWith("\\") ? "" : "\\"}${part}`;
      crumbs.push({ label: part, path: current });
    }
    return crumbs;
  }
  if (/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(path)) {
    const parts = path.replace(/\//g, "\\").split("\\").filter(Boolean);
    const root = `\\\\${parts[0]}\\${parts[1]}\\`;
    const crumbs = [{ label: `\\\\${parts[0]}\\${parts[1]}`, path: root }];
    let current = root;
    for (const part of parts.slice(2)) {
      current += `${current.endsWith("\\") ? "" : "\\"}${part}`;
      crumbs.push({ label: part, path: current });
    }
    return crumbs;
  }
  const crumbs = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current += `/${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}
