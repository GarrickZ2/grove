import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Check, Search, Loader2, AppWindow } from "lucide-react";
import type { AppInfo } from "../../api";

export interface AppPickerOption {
  id: string;
  label: string;
  /** App name to match against installed applications */
  appName?: string;
  /** Legacy command value (for backward compatibility) */
  command?: string;
}

// IDE options - will be filtered by installed applications
export const ideAppOptions: AppPickerOption[] = [
  { id: "vscode", label: "VS Code", appName: "Visual Studio Code", command: "code" },
  { id: "cursor", label: "Cursor", appName: "Cursor", command: "cursor" },
  { id: "windsurf", label: "Windsurf", appName: "Windsurf", command: "windsurf" },
  { id: "zed", label: "Zed", appName: "Zed", command: "zed" },
  { id: "sublime", label: "Sublime Text", appName: "Sublime Text", command: "subl" },
  { id: "nova", label: "Nova", appName: "Nova", command: "nova" },
  { id: "rustrover", label: "RustRover", appName: "RustRover", command: "rustrover" },
  { id: "webstorm", label: "WebStorm", appName: "WebStorm", command: "webstorm" },
  { id: "idea", label: "IntelliJ IDEA", appName: "IntelliJ IDEA", command: "idea" },
  { id: "pycharm", label: "PyCharm", appName: "PyCharm", command: "pycharm" },
  { id: "goland", label: "GoLand", appName: "GoLand", command: "goland" },
  { id: "clion", label: "CLion", appName: "CLion", command: "clion" },
  { id: "phpstorm", label: "PHPStorm", appName: "PhpStorm", command: "phpstorm" },
  { id: "xcode", label: "Xcode", appName: "Xcode" },
];

// Terminal options - will be filtered by installed applications
export const terminalAppOptions: AppPickerOption[] = [
  { id: "system", label: "System Default", appName: "Terminal" },
  { id: "iterm", label: "iTerm2", appName: "iTerm", command: "iterm" },
  { id: "warp", label: "Warp", appName: "Warp", command: "warp" },
  { id: "kitty", label: "Kitty", appName: "kitty", command: "kitty" },
  { id: "alacritty", label: "Alacritty", appName: "Alacritty", command: "alacritty" },
  { id: "hyper", label: "Hyper", appName: "Hyper", command: "hyper" },
];

interface InstalledOption {
  option: AppPickerOption;
  app: AppInfo;
}

interface AppPickerProps {
  /** Predefined options that will be filtered by installed apps */
  options: AppPickerOption[];
  /** Current value (app path or command) */
  value: string;
  /** Called when value changes */
  onChange: (value: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** List of installed applications */
  applications?: AppInfo[];
  /** Whether applications are loading */
  isLoadingApps?: boolean;
  /** Filter function for other applications (e.g., only show IDEs or terminals) */
  appFilter?: (app: AppInfo) => boolean;
}

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
}

export function AppPicker({
  options,
  value,
  onChange,
  placeholder = "Select...",
  applications = [],
  isLoadingApps = false,
  appFilter,
}: AppPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Match options with installed applications
  const installedOptions = useMemo(() => {
    const results: InstalledOption[] = [];

    for (const option of options) {
      if (!option.appName) continue;

      // Find matching installed app
      const matchingApp = applications.find((app) => {
        const appNameLower = app.name.toLowerCase();
        const optionNameLower = option.appName!.toLowerCase();

        // Exact match or contains match
        return (
          appNameLower === optionNameLower ||
          appNameLower.includes(optionNameLower) ||
          optionNameLower.includes(appNameLower)
        );
      });

      if (matchingApp) {
        results.push({ option, app: matchingApp });
      }
    }

    return results;
  }, [options, applications]);

  // Get other applications not in predefined options
  const otherApps = useMemo(() => {
    const installedAppPaths = new Set(installedOptions.map((io) => io.app.path));
    let filtered = applications.filter((app) => !installedAppPaths.has(app.path));

    // Apply additional filter if provided
    if (appFilter) {
      filtered = filtered.filter(appFilter);
    }

    return filtered;
  }, [applications, installedOptions, appFilter]);

  // Filter by search query
  const searchedInstalledOptions = useMemo(() => {
    if (!searchQuery) return installedOptions;
    const query = searchQuery.toLowerCase();
    return installedOptions.filter(
      (io) =>
        io.option.label.toLowerCase().includes(query) ||
        io.app.name.toLowerCase().includes(query)
    );
  }, [installedOptions, searchQuery]);

  const searchedOtherApps = useMemo(() => {
    if (!searchQuery) return otherApps;
    const query = searchQuery.toLowerCase();
    return otherApps.filter((app) => app.name.toLowerCase().includes(query));
  }, [otherApps, searchQuery]);

  // Find display info for current value
  const selectedInfo = useMemo(() => {
    // Check if value is an app path
    const matchedApp = applications.find((app) => app.path === value);
    if (matchedApp) {
      // Check if it's one of the predefined options
      const matchedOption = installedOptions.find((io) => io.app.path === value);
      return {
        label: matchedOption?.option.label || matchedApp.name,
        isInstalled: true,
      };
    }

    // Check if value is a legacy command
    const matchedByCommand = options.find((opt) => opt.command === value);
    if (matchedByCommand) {
      return { label: matchedByCommand.label, isInstalled: false };
    }

    // Custom value
    if (value) {
      return { label: value, isInstalled: false };
    }

    return null;
  }, [value, applications, options, installedOptions]);

  // Calculate dropdown position
  const updateDropdownPosition = useCallback(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const spaceBelow = viewportHeight - rect.bottom;
      const dropdownHeight = 400;

      const top =
        spaceBelow < dropdownHeight && rect.top > dropdownHeight
          ? rect.top + window.scrollY - dropdownHeight - 4
          : rect.bottom + window.scrollY + 4;

      setDropdownPosition({
        top,
        left: rect.left + window.scrollX,
        width: Math.max(rect.width, 320),
      });
    }
  }, []);

  // Update position when opening
  useEffect(() => {
    if (isOpen) {
      updateDropdownPosition();
      window.addEventListener("scroll", updateDropdownPosition, true);
      window.addEventListener("resize", updateDropdownPosition);
      setTimeout(() => searchInputRef.current?.focus(), 100);
      return () => {
        window.removeEventListener("scroll", updateDropdownPosition, true);
        window.removeEventListener("resize", updateDropdownPosition);
      };
    }
  }, [isOpen, updateDropdownPosition]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setIsOpen(false);
        setSearchQuery("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelectApp = (appPath: string) => {
    onChange(appPath);
    setIsOpen(false);
    setSearchQuery("");
  };

  // Render dropdown using portal
  const renderDropdown = () => {
    if (!isOpen || !dropdownPosition) return null;

    const hasInstalledOptions = searchedInstalledOptions.length > 0;
    const hasOtherApps = searchedOtherApps.length > 0;

    return createPortal(
      <AnimatePresence>
        <motion.div
          ref={dropdownRef}
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.15 }}
          style={{
            position: "absolute",
            top: dropdownPosition.top,
            left: dropdownPosition.left,
            width: dropdownPosition.width,
            zIndex: 9999,
          }}
          className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-hidden"
        >
          {/* Search input */}
          <div className="p-2 border-b border-[var(--color-border)]">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search applications..."
                className="w-full pl-9 pr-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md
                  text-sm text-[var(--color-text)] placeholder-[var(--color-text-muted)]
                  focus:outline-none focus:border-[var(--color-highlight)]"
              />
            </div>
          </div>

          <div className="max-h-[340px] overflow-y-auto">
            {isLoadingApps ? (
              <div className="px-3 py-8 text-center text-sm text-[var(--color-text-muted)] flex flex-col items-center gap-2">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Loading applications...</span>
              </div>
            ) : (
              <>
                {/* Installed applications from predefined options */}
                {hasInstalledOptions && (
                  <div className="py-1">
                    <div className="px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
                      Installed
                    </div>
                    {searchedInstalledOptions.map(({ option, app }) => (
                      <button
                        key={option.id}
                        onClick={() => handleSelectApp(app.path)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors
                          ${app.path === value
                            ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                            : "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                          }`}
                      >
                        <AppWindow className="w-5 h-5 flex-shrink-0 text-[var(--color-text-muted)]" />
                        <div className="flex-1 text-left min-w-0">
                          <div className="font-medium">{option.label}</div>
                          <div className="text-xs text-[var(--color-text-muted)] truncate">
                            {app.name}
                          </div>
                        </div>
                        {app.path === value && <Check className="w-4 h-4 flex-shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}

                {/* Other installed applications */}
                {hasOtherApps && (
                  <div className={`py-1 ${hasInstalledOptions ? "border-t border-[var(--color-border)]" : ""}`}>
                    <div className="px-3 py-1.5 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
                      Other Applications
                    </div>
                    {searchedOtherApps.map((app) => (
                      <button
                        key={app.path}
                        onClick={() => handleSelectApp(app.path)}
                        className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors
                          ${app.path === value
                            ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                            : "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                          }`}
                      >
                        <AppWindow className="w-4 h-4 flex-shrink-0 text-[var(--color-text-muted)]" />
                        <div className="flex-1 text-left min-w-0">
                          <div className="truncate">{app.name}</div>
                        </div>
                        {app.path === value && <Check className="w-4 h-4 flex-shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}

                {/* Empty state */}
                {!hasInstalledOptions && !hasOtherApps && (
                  <div className="px-3 py-8 text-center text-sm text-[var(--color-text-muted)]">
                    {searchQuery ? "No applications found" : "No applications available"}
                  </div>
                )}
              </>
            )}
          </div>
        </motion.div>
      </AnimatePresence>,
      document.body
    );
  };

  return (
    <div className="w-full" ref={containerRef}>
      <div className="relative">
        <button
          ref={triggerRef}
          onClick={() => setIsOpen(!isOpen)}
          className={`w-full flex items-center gap-3 px-3 py-2 bg-[var(--color-bg-secondary)] border rounded-lg
            text-sm transition-all duration-200
            ${isOpen
              ? "border-[var(--color-highlight)] ring-1 ring-[var(--color-highlight)]"
              : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
            }`}
        >
          {selectedInfo ? (
            <>
              <AppWindow className="w-4 h-4 flex-shrink-0 text-[var(--color-text-muted)]" />
              <span className="flex-1 text-left text-[var(--color-text)]">
                {selectedInfo.label}
              </span>
            </>
          ) : (
            <span className="flex-1 text-left text-[var(--color-text-muted)]">
              {placeholder}
            </span>
          )}
          <motion.div
            animate={{ rotate: isOpen ? 180 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <ChevronDown className="w-4 h-4 text-[var(--color-text-muted)]" />
          </motion.div>
        </button>

        {renderDropdown()}
      </div>
    </div>
  );
}
