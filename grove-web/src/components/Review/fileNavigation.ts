/**
 * Convert a file emitted by an Agent into the task-relative path used by the
 * Review file tree. Agents commonly report absolute paths, while lazy tree
 * loading only accepts paths beneath the current Task.
 */
export function taskRelativeFilePath(
  targetPath: string,
  taskPath: string | null,
): string | null {
  const target = targetPath
    .replace(/^file:\/\/(?=[^/])/, '//')
    .replace(/^file:\/\//, '')
    .replace(/\\/g, '/')
    .replace(/^\/([A-Za-z]:\/)/, '$1')
    .replace(/^\.\//, '');

  const absolute = target.startsWith('/') || /^[A-Za-z]:\//.test(target);
  if (!absolute) return target;
  if (!taskPath) return null;

  const root = taskPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const windowsPath = /^[A-Za-z]:\//.test(root) || root.startsWith('//');
  const comparableTarget = windowsPath ? target.toLowerCase() : target;
  const comparableRoot = windowsPath ? root.toLowerCase() : root;
  if (comparableTarget === comparableRoot) return '';
  if (comparableTarget.startsWith(`${comparableRoot}/`)) return target.slice(root.length + 1);
  return null;
}
