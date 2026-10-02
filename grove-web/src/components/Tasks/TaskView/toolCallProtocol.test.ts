import { describe, expect, it } from "vitest";
import {
  applyToolCallCreated,
  applyToolCallUpdated,
  applyTerminalOutputUpdate,
  canApplyToolCallUpdate,
  formatToolInputValue,
  hasReadableToolInput,
  hasReadableToolOutput,
  toolCallChipTone,
  toolCallHoverText,
} from "./toolCallReducer";

describe("ACP v1 tool-call reduction", () => {
  it("renders legacy object sequences as complete formatted JSON arrays", () => {
    expect(
      formatToolInputValue('{"content":"First"}, {"content":"Second"}'),
    ).toBe('[\n  {\n    "content": "First"\n  },\n  {\n    "content": "Second"\n  }\n]');
  });

  it("replaces present structured collections, including empty clears", () => {
    const created = applyToolCallCreated(undefined, {
      type: "tool_call",
      id: "tool-1",
      title: "Read file",
      kind: "read",
      status: "pending",
      content: "first",
      output: [{ type: "content", content: { type: "text", text: "first" } }],
      locations: [{ path: "/repo/a.ts", line: 4 }],
    });

    const updated = applyToolCallUpdated(created, {
      type: "tool_call_update",
      id: "tool-1",
      output: [],
      locations: [],
      locations_replace: true,
      protocol_v1: true,
      status: "",
    });

    expect(updated).toEqual(
      expect.objectContaining({
        type: "tool",
        title: "Read file",
        kind: "read",
        status: "pending",
        content: undefined,
        output: [],
        locations: [],
        protocolLocations: [],
      }),
    );
  });

  it("restores MCP image blocks wrapped in ACP text JSON", () => {
    const message = applyToolCallUpdated(undefined, {
      type: "tool_call_update",
      id: "screenshot-1",
      title: "mcp.grove_agent.browser_screenshot",
      status: "completed",
      protocol_v1: true,
      output: [{
        type: "content",
        content: {
          type: "text",
          text: JSON.stringify({
            result: {
              content: [
                { type: "text", text: "{\"mode\":\"viewport\"}" },
                { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
              ],
            },
          }),
        },
      }],
    });

    expect(message.output).toEqual([
      { type: "content", content: { type: "text", text: "{\"mode\":\"viewport\"}" } },
      {
        type: "content",
        content: { type: "image", data: "aW1hZ2U=", mime_type: "image/png" },
      },
    ]);
    expect(message.content).toBe('{"mode":"viewport"}\n\n<image>');
  });

  it("keeps legacy string-delta history incremental", () => {
    const created = applyToolCallCreated(undefined, {
      type: "tool_call",
      id: "legacy-1",
      title: "Bash",
      locations: [{ path: "/repo/a.ts" }],
    });
    const first = applyToolCallUpdated(created, {
      type: "tool_call_update",
      id: "legacy-1",
      status: "running",
      content: "line one",
      locations: [],
      locations_replace: false,
    });
    const second = applyToolCallUpdated(first, {
      type: "tool_call_update",
      id: "legacy-1",
      status: "completed",
      content: "line two",
      locations: [{ path: "/repo/b.ts" }],
      locations_replace: false,
    });

    expect(second).toEqual(
      expect.objectContaining({
        status: "completed",
        content: "line one\nline two",
        locations: [{ path: "/repo/a.ts" }, { path: "/repo/b.ts" }],
      }),
    );
  });

  it("uses update title and wire status when constructing a missing call", () => {
    const message = applyToolCallUpdated(undefined, {
      type: "tool_call_update",
      id: "tool-2",
      title: "Run checks",
      kind: "execute",
      status: "in_progress",
      output: [{ type: "terminal", terminal_id: "terminal-2" }],
      locations_replace: false,
      protocol_v1: true,
    });

    expect(message).toEqual(
      expect.objectContaining({
        title: "Run checks",
        kind: "execute",
        status: "running",
        content: "Terminal terminal-2",
      }),
    );
  });

  it("recomputes Diff-derived paths without retaining the previous snapshot", () => {
    const created = applyToolCallCreated(undefined, {
      type: "tool_call",
      id: "tool-3",
      title: "Edit A",
      kind: "edit",
      status: "in_progress",
      output: [
        {
          type: "diff",
          path: "/repo/a.ts",
          new_text: "a",
          display_text: "+a",
        },
      ],
    });
    const updated = applyToolCallUpdated(created, {
      type: "tool_call_update",
      id: "tool-3",
      protocol_v1: true,
      locations_replace: false,
      output: [
        {
          type: "diff",
          path: "/repo/b.ts",
          new_text: "b",
          display_text: "+b",
        },
      ],
    });

    expect(updated.locations).toEqual([{ path: "/repo/b.ts" }]);
    expect(updated.protocolLocations).toEqual([]);
    expect(updated.status).toBe("running");
  });

  it("requires title when v1 update must construct a missing call", () => {
    expect(
      canApplyToolCallUpdate(undefined, {
        type: "tool_call_update",
        id: "tool-4",
        protocol_v1: true,
        status: "completed",
      }),
    ).toBe(false);
  });

  it("updates only the matching embedded terminal and preserves legacy IDs", () => {
    const created = applyToolCallCreated(undefined, {
      type: "tool_call",
      id: "tool-terminal",
      title: "Run tests",
      kind: "execute",
      status: "in_progress",
      output: [
        { type: "terminal", terminal_id: "terminal-1" },
        { type: "terminal", terminal_id: "terminal-2" },
      ],
    });

    const updated = applyTerminalOutputUpdate(created, {
      type: "terminal_output_update",
      terminal_id: "terminal-2",
      output: "all tests passed\n",
      truncated: true,
      exit_status: { exit_code: 0 },
    });

    expect(updated.output).toEqual([
      { type: "terminal", terminal_id: "terminal-1" },
      {
        type: "terminal",
        terminal_id: "terminal-2",
        output: "all tests passed\n",
        truncated: true,
        exit_status: { exit_code: 0 },
      },
    ]);

    const completedAfterRelease = applyToolCallUpdated(updated, {
      type: "tool_call_update",
      id: "tool-terminal",
      protocol_v1: true,
      status: "completed",
      output: [
        { type: "terminal", terminal_id: "terminal-1" },
        { type: "terminal", terminal_id: "terminal-2" },
      ],
    });
    expect(completedAfterRelease.output?.[1]).toEqual(updated.output?.[1]);
  });
});

describe("tool-call presentation", () => {
  it("keeps completed calls neutral and reserves status color for active or exceptional states", () => {
    expect(toolCallChipTone("completed")).toBe("neutral");
    expect(toolCallChipTone("running")).toBe("running");
    expect(toolCallChipTone("failed")).toBe("warning");
    expect(toolCallChipTone("cancelled")).toBe("cancelled");
  });

  it("does not expose an empty output as expandable content", () => {
    expect(hasReadableToolOutput([], "")).toBe(false);
    expect(
      hasReadableToolOutput(
        [{ type: "content", content: { type: "text", text: "  " } }],
        "",
      ),
    ).toBe(false);
    expect(hasReadableToolOutput(undefined, "  ")).toBe(false);
    expect(hasReadableToolOutput(undefined, "legacy output")).toBe(true);
    expect(hasReadableToolOutput([{
      type: "content",
      content: { type: "image", mime_type: "image/png" },
    }], "")).toBe(true);
    expect(hasReadableToolInput([])).toBe(false);
    expect(hasReadableToolInput([{ label: "Command", value: "git status" }])).toBe(true);
  });

  it("uses the full command for hover text and otherwise preserves the tool title", () => {
    expect(
      toolCallHoverText("Run command", [{ label: "Command", value: "git status --short" }]),
    ).toBe("git status --short");
    expect(toolCallHoverText("Search the Web", [{ label: "Query", value: "ACP" }])).toBe(
      "Search the Web",
    );
  });
});
