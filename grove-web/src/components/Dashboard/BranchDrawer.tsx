import { useState, useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  GitBranch,
  Search,
  Plus,
  ChevronDown,
  ChevronRight,
  X,
  Check,
  Edit3,
  Trash2,
  GitMerge,
  Folder,
  FolderOpen,
  Loader2,
  ArrowDownToLine,
  ListTodo,
  Circle,
  Cloud,
} from "lucide-react";
import type { Branch, Task } from "../../data/types";
import { getRemotes, getBranches as apiGetBranches } from "../../api";

// Branch with task info
interface BranchWithTasks {
  name: string;
  taskCount: number;
  liveTasks: number;
  idleTasks: number;
  tasks: Task[];
}

interface BranchDrawerProps {
  isOpen: boolean;
  branches: Branch[];
  tasks?: Task[];
  isLoading?: boolean;
  projectId: string | null;
  onClose: () => void;
  onCheckout: (branch: Branch) => void;
  onNewBranch: () => void;
  onRename: (branch: Branch) => void;
  onDelete: (branch: Branch) => void;
  onMerge: (branch: Branch) => void;
  onPullMerge?: (branch: Branch) => void;
  onPullRebase?: (branch: Branch) => void;
  onTaskClick?: (task: Task) => void;
}

// Tree node for nested folder structure
interface BranchTreeNode {
  name: string; // folder name or branch display name
  fullPath: string; // full path for folder key
  branch?: Branch; // only set for leaf nodes (actual branches)
  children: Map<string, BranchTreeNode>;
}

// Build a tree structure from flat branch list
function buildBranchTree(branches: Branch[]): BranchTreeNode {
  const root: BranchTreeNode = {
    name: "",
    fullPath: "",
    children: new Map(),
  };

  branches.forEach(branch => {
    const parts = branch.name.split("/");
    let current = root;
    let pathSoFar = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;

      if (i === parts.length - 1) {
        // Last part - this is the branch itself
        current.children.set(part, {
          name: part,
          fullPath: pathSoFar,
          branch,
          children: new Map(),
        });
      } else {
        // Intermediate folder
        if (!current.children.has(part)) {
          current.children.set(part, {
            name: part,
            fullPath: pathSoFar,
            children: new Map(),
          });
        }
        current = current.children.get(part)!;
      }
    }
  });

  return root;
}

// Count total branches in a tree node (including nested)
function countBranches(node: BranchTreeNode): number {
  if (node.branch) return 1;
  let count = 0;
  node.children.forEach(child => {
    count += countBranches(child);
  });
  return count;
}

// Get sorted children (folders first, then branches, alphabetically)
function getSortedChildren(node: BranchTreeNode): BranchTreeNode[] {
  const children = Array.from(node.children.values());
  const folders = children.filter(c => !c.branch).sort((a, b) => a.name.localeCompare(b.name));
  const branches = children.filter(c => c.branch).sort((a, b) => a.name.localeCompare(b.name));
  return [...folders, ...branches];
}

export function BranchDrawer({
  isOpen,
  branches,
  tasks = [],
  isLoading = false,
  projectId,
  onClose,
  onCheckout,
  onNewBranch,
  onRename,
  onDelete,
  onMerge,
  onPullMerge,
  onPullRebase,
  onTaskClick,
}: BranchDrawerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [showWithTasks, setShowWithTasks] = useState(true);
  const [showLocal, setShowLocal] = useState(true);
  const [showRemote, setShowRemote] = useState(true);
  const [showRemoteButtons, setShowRemoteButtons] = useState(true);
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);
  const [selectedTaskBranch, setSelectedTaskBranch] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Remote loading state
  const [remotes, setRemotes] = useState<string[]>([]);
  const [loadedRemotes, setLoadedRemotes] = useState<Set<string>>(new Set());
  const [loadedRemoteBranches, setLoadedRemoteBranches] = useState<Record<string, Branch[]>>({});
  const [loadingRemote, setLoadingRemote] = useState<string | null>(null);

  // Load remotes when drawer opens
  useEffect(() => {
    if (isOpen && projectId) {
      getRemotes(projectId)
        .then((res) => {
          setRemotes(res.remotes);
        })
        .catch((err) => {
          console.error("Failed to load remotes:", err);
        });
    }
  }, [isOpen, projectId]);

  // Reset remote state when drawer closes
  useEffect(() => {
    if (!isOpen) {
      setLoadedRemotes(new Set());
      setLoadedRemoteBranches({});
      setLoadingRemote(null);
    }
  }, [isOpen]);

  // Load branches from a specific remote
  const loadRemoteBranches = async (remote: string) => {
    if (!projectId || loadedRemotes.has(remote)) return;

    setLoadingRemote(remote);
    try {
      const res = await apiGetBranches(projectId, remote);
      // Filter: only keep branches in "remote/branch" format
      const remoteBranches: Branch[] = res.branches
        .filter(b => {
          const parts = b.name.split('/');
          // Must have at least "remote/branch" format (2 parts)
          return parts.length >= 2 && parts[0] === remote;
        })
        .map(b => ({
          name: b.name,
          isCurrent: b.is_current,
          isLocal: false,
        }));

      setLoadedRemoteBranches((prev) => ({
        ...prev,
        [remote]: remoteBranches,
      }));
      setLoadedRemotes((prev) => new Set(prev).add(remote));

      // Auto-expand the remote folder and all its first-level subfolders
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        next.add(remote); // Expand remote root (e.g., "origin")

        // Find all first-level folders under this remote
        const firstLevelFolders = new Set<string>();
        remoteBranches.forEach(branch => {
          // Branch name format: "origin/feature/xxx" or "origin/master"
          const parts = branch.name.split('/');
          if (parts.length >= 2 && parts[0] === remote) {
            // Add first-level folder path: "origin/feature"
            firstLevelFolders.add(`${parts[0]}/${parts[1]}`);
          }
        });

        // Expand all first-level folders
        firstLevelFolders.forEach(folder => next.add(folder));
        return next;
      });
    } catch (err) {
      console.error(`Failed to load branches from ${remote}:`, err);
    } finally {
      setLoadingRemote(null);
    }
  };

  const localBranches = branches.filter(b => b.isLocal);

  // Combine all loaded remote branches
  const allRemoteBranches: Branch[] = Object.values(loadedRemoteBranches).flat();

  // Track if we've auto-expanded folders (reset when drawer closes)
  const hasAutoExpandedRef = useRef(false);

  // Reset auto-expand flag when drawer closes
  useEffect(() => {
    if (!isOpen) {
      hasAutoExpandedRef.current = false;
    }
  }, [isOpen]);

  // Auto-expand first-level folders for local branches (only once when drawer opens)
  useEffect(() => {
    if (!isOpen || localBranches.length === 0 || hasAutoExpandedRef.current) return;

    const firstLevelFolders = new Set<string>();
    localBranches.forEach(branch => {
      const parts = branch.name.split('/');
      if (parts.length >= 2) {
        // Add first-level folder (e.g., "feature", "grove", "fix")
        firstLevelFolders.add(parts[0]);
      }
    });

    // Expand all first-level folders (only if not already in the set)
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      firstLevelFolders.forEach(folder => next.add(folder));
      return next;
    });

    hasAutoExpandedRef.current = true;
  }, [isOpen, localBranches]);

  const filteredLocal = localBranches.filter(b =>
    b.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const filteredRemote = allRemoteBranches.filter(b =>
    b.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Group active tasks by target branch
  const branchesWithTasks = useMemo(() => {
    const activeTasks = tasks.filter(t => t.status !== "archived");
    const branchMap = new Map<string, Task[]>();

    activeTasks.forEach(task => {
      const existing = branchMap.get(task.target) || [];
      existing.push(task);
      branchMap.set(task.target, existing);
    });

    const result: BranchWithTasks[] = [];
    branchMap.forEach((branchTasks, branchName) => {
      // Filter by search query
      if (searchQuery && !branchName.toLowerCase().includes(searchQuery.toLowerCase())) {
        return;
      }
      result.push({
        name: branchName,
        taskCount: branchTasks.length,
        liveTasks: branchTasks.filter(t => t.status === "live").length,
        idleTasks: branchTasks.filter(t => t.status === "idle").length,
        tasks: branchTasks,
      });
    });

    // Sort by task count descending
    return result.sort((a, b) => b.taskCount - a.taskCount);
  }, [tasks, searchQuery]);

  // Build tree structures
  const localTree = useMemo(() => buildBranchTree(filteredLocal), [filteredLocal]);
  const remoteTree = useMemo(() => buildBranchTree(filteredRemote), [filteredRemote]);

  const handleBranchClick = (branch: Branch) => {
    if (branch.isCurrent) return;
    setSelectedBranch(selectedBranch?.name === branch.name ? null : branch);
    setSelectedTaskBranch(null);
  };

  const handleTaskBranchClick = (branchName: string) => {
    setSelectedTaskBranch(selectedTaskBranch === branchName ? null : branchName);
    setSelectedBranch(null);
  };

  const toggleFolder = (path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Find branch object by name
  const findBranch = (name: string): Branch | undefined => {
    return branches.find(b => b.name === name);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/30 z-40"
          />

          {/* Drawer */}
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 bottom-0 w-96 bg-[var(--color-bg-secondary)] border-l border-[var(--color-border)] shadow-xl z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
              <div className="flex items-center gap-2">
                <GitBranch className="w-5 h-5 text-[var(--color-highlight)]" />
                <h2 className="font-semibold text-[var(--color-text)]">Switch Branch</h2>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Search */}
            <div className="px-4 py-3 border-b border-[var(--color-border)]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                <input
                  type="text"
                  placeholder="Search branches..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  autoFocus
                  className="w-full pl-9 pr-3 py-2 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-highlight)]"
                />
              </div>
            </div>

            {/* Branch List */}
            <div className="flex-1 overflow-y-auto p-2">
              {isLoading ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 text-[var(--color-text-muted)] animate-spin mb-2" />
                  <p className="text-sm text-[var(--color-text-muted)]">Loading branches...</p>
                </div>
              ) : (
              <>
              {/* Branches with Active Tasks */}
              {branchesWithTasks.length > 0 && (
                <div className="mb-4">
                  <button
                    onClick={() => setShowWithTasks(!showWithTasks)}
                    className="flex items-center gap-1 text-xs font-medium text-[var(--color-highlight)] px-2 py-1.5 hover:text-[var(--color-highlight)] transition-colors uppercase tracking-wider w-full"
                  >
                    {showWithTasks ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                    <ListTodo className="w-3.5 h-3.5 mr-1" />
                    With Active Tasks ({branchesWithTasks.length})
                  </button>
                  <AnimatePresence>
                    {showWithTasks && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="space-y-0.5 overflow-hidden"
                      >
                        {branchesWithTasks.map(bwt => (
                          <TaskBranchItem
                            key={bwt.name}
                            branchWithTasks={bwt}
                            isSelected={selectedTaskBranch === bwt.name}
                            isCurrent={findBranch(bwt.name)?.isCurrent || false}
                            onBranchClick={() => handleTaskBranchClick(bwt.name)}
                            onCheckout={() => {
                              const branch = findBranch(bwt.name);
                              if (branch) {
                                onCheckout(branch);
                                onClose();
                              }
                            }}
                            onTaskClick={(task) => {
                              if (onTaskClick) {
                                onTaskClick(task);
                                onClose();
                              }
                            }}
                          />
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* Local Branches */}
              <div>
                <button
                  onClick={() => setShowLocal(!showLocal)}
                  className="w-full flex items-center gap-1 text-xs font-medium text-[var(--color-text-muted)] px-2 py-1.5 hover:text-[var(--color-text)] transition-colors uppercase tracking-wider"
                >
                  {showLocal ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                  Local ({filteredLocal.length})
                </button>
                <AnimatePresence>
                  {showLocal && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="space-y-0.5 overflow-hidden"
                    >
                      <TreeView
                        node={localTree}
                        depth={0}
                        expandedFolders={expandedFolders}
                        selectedBranch={selectedBranch}
                        folderColor="var(--color-warning)"
                        onToggleFolder={toggleFolder}
                        onBranchClick={handleBranchClick}
                        onCheckout={onCheckout}
                        onMerge={onMerge}
                        onRename={onRename}
                        onDelete={onDelete}
                        onPullMerge={onPullMerge}
                        onPullRebase={onPullRebase}
                        onClose={onClose}
                        isLocal={true}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Remote Loading Buttons - Only show unloaded remotes */}
              {remotes.filter(r => !loadedRemotes.has(r)).length > 0 && (
                <div className="mt-4">
                  <button
                    onClick={() => setShowRemoteButtons(!showRemoteButtons)}
                    className="w-full flex items-center gap-1 text-xs font-medium text-[var(--color-text-muted)] px-2 py-1.5 hover:text-[var(--color-text)] transition-colors uppercase tracking-wider"
                  >
                    {showRemoteButtons ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                    Remote ({remotes.filter(r => !loadedRemotes.has(r)).length})
                  </button>
                  <AnimatePresence>
                    {showRemoteButtons && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="space-y-2 mt-2 px-2 overflow-hidden"
                      >
                        {remotes
                          .filter(remote => !loadedRemotes.has(remote))
                          .map((remote) => {
                            const isLoading = loadingRemote === remote;

                            return (
                              <button
                                key={remote}
                                onClick={() => loadRemoteBranches(remote)}
                                disabled={isLoading}
                                className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                                  isLoading
                                    ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] cursor-wait"
                                    : "bg-[var(--color-bg-tertiary)] text-[var(--color-text)] hover:bg-[var(--color-highlight)]/10 hover:text-[var(--color-highlight)] border border-[var(--color-border)] hover:border-[var(--color-highlight)]/50"
                                }`}
                              >
                                {isLoading ? (
                                  <>
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Loading {remote}...
                                  </>
                                ) : (
                                  <>
                                    <Cloud className="w-4 h-4" />
                                    Load {remote}
                                  </>
                                )}
                              </button>
                            );
                          })}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* Loaded Remote Branches Tree */}
              {filteredRemote.length > 0 && (
                <div className="mt-4">
                  <button
                    onClick={() => setShowRemote(!showRemote)}
                    className="w-full flex items-center gap-1 text-xs font-medium text-[var(--color-text-muted)] px-2 py-1.5 hover:text-[var(--color-text)] transition-colors uppercase tracking-wider"
                  >
                    {showRemote ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                    Remote ({filteredRemote.length})
                  </button>
                  <AnimatePresence>
                    {showRemote && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="space-y-0.5 overflow-hidden"
                      >
                        <TreeView
                          node={remoteTree}
                          depth={0}
                          expandedFolders={expandedFolders}
                          selectedBranch={selectedBranch}
                          folderColor="var(--color-info)"
                          onToggleFolder={toggleFolder}
                          onBranchClick={handleBranchClick}
                          onCheckout={onCheckout}
                          onMerge={onMerge}
                          onRename={onRename}
                          onDelete={onDelete}
                          onPullMerge={onPullMerge}
                          onPullRebase={onPullRebase}
                          onClose={onClose}
                          isLocal={false}
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
              </>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 border-t border-[var(--color-border)]">
              <button
                onClick={() => {
                  onNewBranch();
                  onClose();
                }}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[var(--color-highlight)] hover:opacity-90 text-white rounded-lg text-sm font-medium transition-opacity"
              >
                <Plus className="w-4 h-4" />
                New Branch
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// Task branch item component
interface TaskBranchItemProps {
  branchWithTasks: BranchWithTasks;
  isSelected: boolean;
  isCurrent: boolean;
  onBranchClick: () => void;
  onCheckout: () => void;
  onTaskClick: (task: Task) => void;
}

function TaskBranchItem({
  branchWithTasks,
  isSelected,
  isCurrent,
  onBranchClick,
  onCheckout,
  onTaskClick,
}: TaskBranchItemProps) {
  return (
    <div>
      <button
        onClick={onBranchClick}
        className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors text-left
          ${isCurrent
            ? "bg-[var(--color-highlight)]/10 border border-[var(--color-highlight)]/30"
            : isSelected
              ? "bg-[var(--color-bg-tertiary)]"
              : "hover:bg-[var(--color-bg-tertiary)]"
          }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch className={`w-4 h-4 flex-shrink-0 ${
            isCurrent ? "text-[var(--color-highlight)]" : "text-[var(--color-text-muted)]"
          }`} />
          <span className={`text-sm truncate ${
            isCurrent ? "text-[var(--color-highlight)] font-medium" : "text-[var(--color-text)]"
          }`}>
            {branchWithTasks.name}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Task count badges */}
          <div className="flex items-center gap-1">
            {branchWithTasks.liveTasks > 0 && (
              <span className="flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full bg-[var(--color-success)]/20 text-[var(--color-success)]">
                <Circle className="w-2 h-2 fill-current" />
                {branchWithTasks.liveTasks}
              </span>
            )}
            {branchWithTasks.idleTasks > 0 && (
              <span className="flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full bg-[var(--color-text-muted)]/20 text-[var(--color-text-muted)]">
                <Circle className="w-2 h-2" />
                {branchWithTasks.idleTasks}
              </span>
            )}
          </div>
          {isCurrent && (
            <Check className="w-4 h-4 text-[var(--color-highlight)]" />
          )}
        </div>
      </button>

      {/* Expanded Panel */}
      <AnimatePresence>
        {isSelected && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="py-2 px-3 space-y-2">
              {/* Checkout button (if not current) */}
              {!isCurrent && (
                <button
                  onClick={onCheckout}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white bg-[var(--color-highlight)] hover:opacity-90 rounded-lg transition-colors"
                >
                  <Check className="w-4 h-4" />
                  Checkout
                </button>
              )}

              {/* Task list */}
              <div className="border-t border-[var(--color-border)] pt-2 mt-2">
                <div className="text-xs text-[var(--color-text-muted)] mb-1.5">
                  Tasks ({branchWithTasks.taskCount})
                </div>
                {/* Hint: checkout required before accessing tasks */}
                {!isCurrent && (
                  <div className="text-xs text-[var(--color-warning)] mb-2 px-2">
                    Checkout this branch to access tasks
                  </div>
                )}
                <div className="space-y-1">
                  {branchWithTasks.tasks.map(task => (
                    <button
                      key={task.id}
                      onClick={() => isCurrent && onTaskClick(task)}
                      disabled={!isCurrent}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors text-left
                        ${isCurrent
                          ? "text-[var(--color-text)] hover:bg-[var(--color-bg)] cursor-pointer"
                          : "text-[var(--color-text-muted)] cursor-not-allowed opacity-60"
                        }`}
                    >
                      <Circle className={`w-2.5 h-2.5 flex-shrink-0 ${
                        task.status === "live"
                          ? "fill-[var(--color-success)] text-[var(--color-success)]"
                          : "text-[var(--color-text-muted)]"
                      }`} />
                      <span className="truncate">{task.name}</span>
                      {task.filesChanged > 0 && (
                        <span className="text-xs text-[var(--color-text-muted)] ml-auto flex-shrink-0">
                          {task.filesChanged} files
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Recursive tree view component
interface TreeViewProps {
  node: BranchTreeNode;
  depth: number;
  expandedFolders: Set<string>;
  selectedBranch: Branch | null;
  folderColor: string;
  onToggleFolder: (path: string) => void;
  onBranchClick: (branch: Branch) => void;
  onCheckout: (branch: Branch) => void;
  onMerge: (branch: Branch) => void;
  onRename: (branch: Branch) => void;
  onDelete: (branch: Branch) => void;
  onPullMerge?: (branch: Branch) => void;
  onPullRebase?: (branch: Branch) => void;
  onClose: () => void;
  isLocal: boolean;
}

function TreeView({
  node,
  depth,
  expandedFolders,
  selectedBranch,
  folderColor,
  onToggleFolder,
  onBranchClick,
  onCheckout,
  onMerge,
  onRename,
  onDelete,
  onPullMerge,
  onPullRebase,
  onClose,
  isLocal,
}: TreeViewProps) {
  const sortedChildren = getSortedChildren(node);

  return (
    <>
      {sortedChildren.map(child => {
        if (child.branch) {
          // Render branch
          if (isLocal) {
            return (
              <BranchItem
                key={child.branch.name}
                branch={child.branch}
                displayName={child.name}
                isSelected={selectedBranch?.name === child.branch.name}
                depth={depth}
                onBranchClick={onBranchClick}
                onCheckout={onCheckout}
                onMerge={onMerge}
                onRename={onRename}
                onDelete={onDelete}
                onClose={onClose}
              />
            );
          } else {
            // Remote branch - with actions menu
            return (
              <RemoteBranchItem
                key={child.branch.name}
                branch={child.branch}
                displayName={child.name}
                isSelected={selectedBranch?.name === child.branch.name}
                depth={depth}
                onBranchClick={onBranchClick}
                onCheckout={onCheckout}
                onPullMerge={onPullMerge}
                onPullRebase={onPullRebase}
                onClose={onClose}
              />
            );
          }
        } else {
          // Render folder
          const isExpanded = expandedFolders.has(child.fullPath);
          const branchCount = countBranches(child);

          return (
            <div key={child.fullPath}>
              <button
                onClick={() => onToggleFolder(child.fullPath)}
                style={{ paddingLeft: `${depth * 16 + 12}px` }}
                className="w-full flex items-center gap-2 pr-3 py-2 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
              >
                {isExpanded ? (
                  <FolderOpen className="w-4 h-4" style={{ color: folderColor }} />
                ) : (
                  <Folder className="w-4 h-4" style={{ color: folderColor }} />
                )}
                <span className="text-sm font-medium text-[var(--color-text)]">
                  {child.name}
                </span>
                <span className="text-xs text-[var(--color-text-muted)] ml-auto">
                  {branchCount}
                </span>
                {isExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                )}
              </button>
              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div
                      className="border-l border-[var(--color-border)]"
                      style={{ marginLeft: `${depth * 16 + 20}px` }}
                    >
                      <TreeView
                        node={child}
                        depth={depth + 1}
                        expandedFolders={expandedFolders}
                        selectedBranch={selectedBranch}
                        folderColor={folderColor}
                        onToggleFolder={onToggleFolder}
                        onBranchClick={onBranchClick}
                        onCheckout={onCheckout}
                        onMerge={onMerge}
                        onRename={onRename}
                        onDelete={onDelete}
                        onPullMerge={onPullMerge}
                        onPullRebase={onPullRebase}
                        onClose={onClose}
                        isLocal={isLocal}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        }
      })}
    </>
  );
}

// Branch item component for local branches with actions
interface BranchItemProps {
  branch: Branch;
  displayName: string;
  isSelected: boolean;
  depth: number;
  onBranchClick: (branch: Branch) => void;
  onCheckout: (branch: Branch) => void;
  onMerge: (branch: Branch) => void;
  onRename: (branch: Branch) => void;
  onDelete: (branch: Branch) => void;
  onClose: () => void;
}

function BranchItem({
  branch,
  displayName,
  isSelected,
  depth,
  onBranchClick,
  onCheckout,
  onMerge,
  onRename,
  onDelete,
  onClose,
}: BranchItemProps) {
  return (
    <div>
      <button
        onClick={() => onBranchClick(branch)}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
        className={`w-full flex items-center justify-between pr-3 py-2 rounded-lg transition-colors text-left
          ${branch.isCurrent
            ? "bg-[var(--color-highlight)]/10 border border-[var(--color-highlight)]/30"
            : isSelected
              ? "bg-[var(--color-bg-tertiary)]"
              : "hover:bg-[var(--color-bg-tertiary)]"
          }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch className={`w-4 h-4 flex-shrink-0 ${
            branch.isCurrent ? "text-[var(--color-highlight)]" : "text-[var(--color-text-muted)]"
          }`} />
          <span className={`text-sm truncate ${
            branch.isCurrent ? "text-[var(--color-highlight)] font-medium" : "text-[var(--color-text)]"
          }`}>
            {displayName}
          </span>
        </div>
        {branch.isCurrent && (
          <Check className="w-4 h-4 text-[var(--color-highlight)] flex-shrink-0" />
        )}
      </button>

      {/* Actions Panel */}
      <AnimatePresence>
        {isSelected && !branch.isCurrent && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div
              className="py-2 space-y-1"
              style={{ paddingLeft: `${depth * 16 + 28}px`, paddingRight: "8px" }}
            >
              <button
                onClick={() => {
                  onCheckout(branch);
                  onClose();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white bg-[var(--color-highlight)] hover:opacity-90 rounded-lg transition-colors"
              >
                <Check className="w-4 h-4" />
                Checkout
              </button>
              <button
                onClick={() => {
                  onMerge(branch);
                  onClose();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg)] rounded-lg transition-colors"
              >
                <GitMerge className="w-4 h-4" />
                Merge into current
              </button>
              <div className="border-t border-[var(--color-border)] my-1" />
              <button
                onClick={() => {
                  onRename(branch);
                  onClose();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg)] rounded-lg transition-colors"
              >
                <Edit3 className="w-4 h-4" />
                Rename
              </button>
              <button
                onClick={() => {
                  onDelete(branch);
                  onClose();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-error)] hover:bg-[var(--color-error)]/10 rounded-lg transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                Delete
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Remote branch item component with actions
interface RemoteBranchItemProps {
  branch: Branch;
  displayName: string;
  isSelected: boolean;
  depth: number;
  onBranchClick: (branch: Branch) => void;
  onCheckout: (branch: Branch) => void;
  onPullMerge?: (branch: Branch) => void;
  onPullRebase?: (branch: Branch) => void;
  onClose: () => void;
}

function RemoteBranchItem({
  branch,
  displayName,
  isSelected,
  depth,
  onBranchClick,
  onCheckout,
  onPullMerge,
  onPullRebase,
  onClose,
}: RemoteBranchItemProps) {
  return (
    <div>
      <button
        onClick={() => onBranchClick(branch)}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
        className={`w-full flex items-center justify-between pr-3 py-2 rounded-lg transition-colors text-left
          ${isSelected
            ? "bg-[var(--color-bg-tertiary)]"
            : "hover:bg-[var(--color-bg-tertiary)]"
          }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch className="w-4 h-4 flex-shrink-0 text-[var(--color-text-muted)]" />
          <span className="text-sm text-[var(--color-text)] truncate">
            {displayName}
          </span>
        </div>
      </button>

      {/* Actions Panel */}
      <AnimatePresence>
        {isSelected && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div
              className="py-2 space-y-1"
              style={{ paddingLeft: `${depth * 16 + 28}px`, paddingRight: "8px" }}
            >
              <button
                onClick={() => {
                  onCheckout(branch);
                  onClose();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white bg-[var(--color-highlight)] hover:opacity-90 rounded-lg transition-colors"
              >
                <Check className="w-4 h-4" />
                Checkout
              </button>
              {onPullMerge && (
                <button
                  onClick={() => {
                    onPullMerge(branch);
                    onClose();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg)] rounded-lg transition-colors"
                >
                  <ArrowDownToLine className="w-4 h-4" />
                  Pull (merge)
                </button>
              )}
              {onPullRebase && (
                <button
                  onClick={() => {
                    onPullRebase(branch);
                    onClose();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg)] rounded-lg transition-colors"
                >
                  <ArrowDownToLine className="w-4 h-4" />
                  Pull (rebase)
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
