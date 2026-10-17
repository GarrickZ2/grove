import { describe, expect, it } from "vitest";
import { toolDisplayName, classifyActionKind, isBackgroundAction, isEditTool, toolVerb } from "./toolCallIdentity";
import { applyToolCallCreated, applyToolCallUpdated, toolCallHoverText } from "./toolCallReducer";
import { collectReadMemoryIds } from "./memoryRead";

describe("programmatic tool names", () => {
  it("preserves tool names for display, including plans and MCP tools", () => {
    for (const name of ["TodoWrite", "update_plan", "exec_command", "mcp__grove__read_notes"]) {
      expect(toolDisplayName({ name, title: "Localized display title" })).toBe(name);
    }
    expect(toolDisplayName({ title: "Original agent title" })).toBe("Original agent title");
    expect(toolDisplayName({ name: "  ", title: "Fallback title" })).toBe("Fallback title");
    expect(toolDisplayName({ title: "" })).toBe("Tool");
  });

  it("does not interpret think operations as plan updates", () => {
    const review = { title: "Tool call review", name: "tool_call_review", kind: "think" };
    expect(toolVerb(review)).toBe("other");
    expect(classifyActionKind(review)).toBe("generic");
    expect(toolDisplayName(review)).toBe("tool_call_review");
    expect(classifyActionKind({ title: "Review", kind: "think" })).toBe("generic");
    expect(classifyActionKind({ title: "Task review", kind: "think" })).toBe("generic");
    expect(classifyActionKind({ title: "Plan", name: "update_plan", kind: "think" })).toBe("todo");
  });

  it("preserves names through omitted/null patches and applies corrections", () => {
    const created = applyToolCallCreated(undefined, { type: "tool_call", id: "t", title: "正在读取", name: "read_file", kind: "read" });
    const patch = (name?: string | null) => ({ type: "tool_call_update", id: "t", protocol_v1: true, name });
    expect(applyToolCallUpdated(created, patch()).name).toBe("read_file");
    expect(applyToolCallUpdated(created, patch(null)).name).toBe("read_file");
    expect(applyToolCallUpdated(created, patch("read_many_files")).name).toBe("read_many_files");
    const legacy = applyToolCallCreated(undefined, { type: "tool_call", id: "t", title: "Read file" });
    expect(legacy.name).toBeUndefined();
    expect(applyToolCallUpdated(legacy, patch("read_file")).name).toBe("read_file");
  });

  it("uses names with localized titles, and respects explicit operation categories", () => {
    expect(isEditTool({ title: "正在修改文件", name: "apply_patch" })).toBe(true);
    expect(classifyActionKind({ title: "正在执行", name: "exec_command" })).toBe("bash");
    expect(isBackgroundAction({ title: "正在读取", name: "read_file" })).toBe(true);
    expect(toolVerb({ title: "Write a report", name: "read_file", kind: "read" })).toBe("read");
    expect(isEditTool({ title: "Edit settings", name: "unrecognized_tool" })).toBe(false);
    expect(isEditTool({ title: "Edit settings", kind: "read" })).toBe(false);
    expect(isEditTool({ title: "Write file" })).toBe(true);
    expect(classifyActionKind({ title: "Run cargo test" })).toBe("bash");
    expect(isBackgroundAction({ title: "Terminal", name: "exec_command", kind: "execute" })).toBe(false);
  });

  it("uses MCP identities without assigning arbitrary plugin tools file-edit behavior", () => {
    expect(classifyActionKind({ title: "读取项目记忆", name: "mcp__grove_agent__memory_read" })).toBe("mcp");
    expect(isEditTool({ title: "Write file", name: "mcp__remote__write_file" })).toBe(false);
    expect(toolCallHoverText("执行测试", [{ label: "Command", value: "cargo test" }], "exec_command"))
      .toBe("exec_command\n执行测试\ncargo test");
  });

  it("uses the name for Memory reads even when display titles or legacy inputs disagree", () => {
    const tool = applyToolCallCreated(undefined, {
      type: "tool_call", id: "t", title: "正在读取记忆", name: "mcp__grove_agent__memory_read",
      status: "completed", input: [{ label: "Entity Id", value: "memory-1" }],
    });
    expect(collectReadMemoryIds([tool])).toEqual(["memory-1"]);
    const foreign = { ...tool, name: "mcp__other__memory_read", title: "memory_read" };
    const recall = { ...tool, name: "memory_recall", title: "memory_read" };
    expect(collectReadMemoryIds([foreign])).toEqual([]);
    expect(collectReadMemoryIds([recall])).toEqual([]);
  });
});
