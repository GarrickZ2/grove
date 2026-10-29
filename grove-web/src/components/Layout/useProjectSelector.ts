import type React from "react";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useProject } from "../../context";
import type { Project } from "../../data/types";
import { filterProjectsByType } from "../../utils/projectFilter";

export type ProjectTypeFilter = "coding" | "studio";

/** Shared state and behavior behind the project selector dropdowns (classic sidebar and Orbit). */
export function useProjectSelector(onProjectSwitch?: (projectId?: string) => void) {
  const { selectedProject, projects, selectProject, refreshProjects } = useProject();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [typeFilter, setTypeFilterState] = useState<ProjectTypeFilter>(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("projectSelectorTab");
    } catch {
      return "coding";
    }
    if (stored === "coding" || stored === "studio") return stored;
    return "coding";
  });

  const setTypeFilter = (tab: ProjectTypeFilter) => {
    setTypeFilterState(tab);
    try {
      localStorage.setItem("projectSelectorTab", tab);
    } catch {
      // Ignore storage errors (private browsing, quota exceeded)
    }
  };
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const filteredProjects = useMemo(() => {
    let list = projects;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    return filterProjectsByType(list, typeFilter);
  }, [projects, searchQuery, typeFilter]);

  // Derive activeProjectId from filteredProjects without setState-in-effect
  const derivedActiveProjectId = useMemo(() => {
    if (!isOpen || filteredProjects.length === 0) return null;
    if (activeProjectId && filteredProjects.some((p) => p.id === activeProjectId)) {
      return activeProjectId;
    }
    return filteredProjects[0].id;
  }, [filteredProjects, isOpen, activeProjectId]);

  useEffect(() => {
    if (!derivedActiveProjectId || !isOpen) return;

    itemRefs.current[derivedActiveProjectId]?.scrollIntoView({
      block: "nearest",
    });
  }, [derivedActiveProjectId, isOpen]);

  // Helper to close dropdown and reset search
  const closeDropdown = useCallback(() => {
    setIsOpen(false);
    setSearchQuery("");
    setActiveProjectId(null);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        closeDropdown();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [closeDropdown]);

  // Auto-focus search input when dropdown opens
  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [isOpen]);

  // Refresh project list each time the dropdown opens so newly registered or
  // renamed projects show up without a full page reload.
  useEffect(() => {
    if (!isOpen) return;
    void refreshProjects();
  }, [isOpen, refreshProjects]);

  const handleSelectProject = (project: Project) => {
    const switched = selectedProject?.id !== project.id;
    selectProject(project);
    closeDropdown();
    if (switched) onProjectSwitch?.(project.id);
  };

  const moveActiveProject = (direction: 1 | -1) => {
    if (filteredProjects.length === 0) return;

    const currentIndex = filteredProjects.findIndex((project) => project.id === derivedActiveProjectId);
    const startIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (startIndex + direction + filteredProjects.length) % filteredProjects.length;
    setActiveProjectId(filteredProjects[nextIndex].id);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActiveProject(1);
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActiveProject(-1);
      return;
    }

    if (e.key === "Enter") {
      if (!derivedActiveProjectId) return;

      const activeProject = filteredProjects.find((project) => project.id === derivedActiveProjectId);
      if (!activeProject) return;

      e.preventDefault();
      handleSelectProject(activeProject);
      return;
    }

    if (e.key === "Escape") {
      if (searchQuery) {
        setSearchQuery("");
      } else {
        closeDropdown();
      }
      e.stopPropagation();
    }
  };

  return {
    selectedProject,
    filteredProjects,
    isOpen,
    setIsOpen,
    closeDropdown,
    searchQuery,
    setSearchQuery,
    typeFilter,
    setTypeFilter,
    activeProjectId: derivedActiveProjectId,
    setActiveProjectId,
    dropdownRef,
    searchInputRef,
    itemRefs,
    handleSelectProject,
    handleSearchKeyDown,
  };
}
