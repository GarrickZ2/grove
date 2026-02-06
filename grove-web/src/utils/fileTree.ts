// File tree utility: converts flat file paths to a recursive tree structure

export interface FileTreeNode {
  name: string;
  path: string;       // Full relative path
  isDir: boolean;
  children?: FileTreeNode[];
}

/**
 * Build a tree structure from a flat list of file paths.
 * Directories are sorted before files, then alphabetically.
 */
export function buildFileTree(files: string[]): FileTreeNode[] {
  const root: Map<string, FileTreeNode> = new Map();

  for (const filePath of files) {
    const parts = filePath.split('/');
    let currentLevel = root;
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = i === parts.length - 1;

      if (!currentLevel.has(part)) {
        const node: FileTreeNode = {
          name: part,
          path: currentPath,
          isDir: !isLast,
          children: isLast ? undefined : [],
        };
        currentLevel.set(part, node);
      }

      const node = currentLevel.get(part)!;

      if (!isLast) {
        // Ensure it's marked as a directory
        if (!node.isDir) {
          node.isDir = true;
          node.children = node.children || [];
        }
        // Move into children map
        const childMap = new Map<string, FileTreeNode>();
        for (const child of node.children!) {
          childMap.set(child.name, child);
        }
        currentLevel = childMap;
        // We'll reconstruct children from the map at the end
        node.children = Array.from(childMap.values());
      }
    }
  }

  // Rebuild properly using a recursive approach
  return sortNodes(buildFromPaths(files));
}

function buildFromPaths(files: string[]): FileTreeNode[] {
  // Group by first path segment
  const groups = new Map<string, string[]>();

  for (const filePath of files) {
    const slashIndex = filePath.indexOf('/');
    if (slashIndex === -1) {
      // It's a file at root level
      groups.set(filePath, []);
    } else {
      const dir = filePath.substring(0, slashIndex);
      const rest = filePath.substring(slashIndex + 1);
      if (!groups.has(dir)) {
        groups.set(dir, []);
      }
      groups.get(dir)!.push(rest);
    }
  }

  const nodes: FileTreeNode[] = [];

  for (const [name, children] of groups) {
    if (children.length === 0) {
      // File node
      nodes.push({ name, path: name, isDir: false });
    } else {
      // Directory node
      const childNodes = buildFromPaths(children);
      // Fix child paths to include parent
      fixPaths(childNodes, name);
      nodes.push({ name, path: name, isDir: true, children: childNodes });
    }
  }

  return nodes;
}

function fixPaths(nodes: FileTreeNode[], prefix: string) {
  for (const node of nodes) {
    node.path = `${prefix}/${node.path}`;
    if (node.children) {
      fixPaths(node.children, prefix);
    }
  }
}

function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes
    .map((node) => {
      if (node.children) {
        return { ...node, children: sortNodes(node.children) };
      }
      return node;
    })
    .sort((a, b) => {
      // Directories first
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      // Then alphabetically
      return a.name.localeCompare(b.name);
    });
}
