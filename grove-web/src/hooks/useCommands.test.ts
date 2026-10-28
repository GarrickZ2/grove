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
    expect(ids).not.toContain("panel-review");
    commands.find((command) => command.id === "nav-work")?.handler();
    expect(navigate).toHaveBeenCalledWith("work");
  });
});
