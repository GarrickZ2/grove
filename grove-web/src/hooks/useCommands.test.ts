import { describe, expect, it, vi } from "vitest";
import { buildCommands, type UseCommandsOptions } from "./useCommands";
import type { Project, Task } from "../data/types";

describe("Studio Work commands", () => {
  it("offers Work navigation and Studio panels without destructive local task actions", () => {
    const navigate = vi.fn();
    const options: UseCommandsOptions = {
      navigation: { onNavigate: navigate, activeItem: "work" },
      project: {
        projects: [], selectedProject: { projectType: "studio" } as Project,
        onSelectProject: vi.fn(), onAddProject: vi.fn(),
      },
      taskActions: {
        selectedTask: { id: "_local", name: "Work", status: "active", isLocal: true, branch: "", target: "", createdAt: new Date(), updatedAt: new Date(), multiplexer: "tmux" } as Task,
        inWorkspace: true, isStudio: true,
        opsHandlers: {} as NonNullable<UseCommandsOptions["taskActions"]>["opsHandlers"],
        onEnterWorkspace: vi.fn(), onOpenPanel: vi.fn(), onSwitchInfoTab: vi.fn(), onRefresh: vi.fn(),
      },
    };
    const commands = buildCommands(options);
    const ids = commands.map((command) => command.id);
    expect(ids).toContain("nav-work");
    expect(ids).toContain("panel-artifacts");
    expect(ids).not.toContain("task-archive");
    expect(ids).not.toContain("task-clean");
    expect(ids).not.toContain("task-commit");
    expect(ids).toContain("panel-review");
    commands.find((command) => command.id === "nav-work")?.handler();
    expect(navigate).toHaveBeenCalledWith("work");
  });
});

describe("Plugin page commands", () => {
  it("adds a Go to command per plugin page that navigates to its page id", () => {
    const navigate = vi.fn();
    const icon = "🗂️";
    const commands = buildCommands({ navigation: { onNavigate: navigate, activeItem: "dashboard", pluginPages: [{ id: "plugin:kanban", label: "Board", icon }] } });
    const command = commands.find((c) => c.id === "nav-plugin:kanban")!;
    expect(command).toMatchObject({ name: "Go to Board", category: "Navigation", iconElement: icon });
    expect(command.keywords).toContain("plugin");
    command.handler();
    expect(navigate).toHaveBeenCalledWith("plugin:kanban");
    expect(buildCommands({ navigation: { onNavigate: navigate, activeItem: "dashboard" } }).some((c) => c.id.startsWith("nav-plugin:"))).toBe(false);
  });
});
