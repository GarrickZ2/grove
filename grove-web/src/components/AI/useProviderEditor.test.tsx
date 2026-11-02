import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyProviderField, useProviderEditor, type ProviderEditor, type ProviderEditorOptions } from "./useProviderEditor";
import type { ProviderProfile } from "./types";

const openai: ProviderProfile = {
  id: "p1",
  name: "OpenAI",
  type: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  status: "verified",
};

describe("applyProviderField", () => {
  it("switching type follows the preset base URL and renames a default-named profile", () => {
    const next = applyProviderField(openai, "type", "Groq");
    expect(next).toMatchObject({ type: "Groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", status: "draft" });
    expect(applyProviderField({ ...openai, name: "Work" }, "type", "Groq").name).toBe("Work");
  });

  it("only connection fields reset the status", () => {
    expect(applyProviderField(openai, "name", "Renamed").status).toBe("verified");
    expect(applyProviderField(openai, "apiKey", "sk-test").status).toBe("draft");
  });
});

describe("useProviderEditor", () => {
  let container: HTMLDivElement;
  let root: Root;
  let editor: ProviderEditor;
  let options: ProviderEditorOptions;

  function Probe() {
    editor = useProviderEditor(options);
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    options = {
      providers: [openai],
      onCreate: vi.fn(async (data) => ({ ...data, id: "p2", status: "draft" as const })),
      onUpdate: vi.fn(async (id, data) => ({ ...openai, ...data, id })),
      onDelete: vi.fn(async () => {}),
      onVerify: vi.fn(async () => ({ status: "failed", message: "bad key" })),
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("requires an API key when creating, then creates and closes the form", async () => {
    act(() => editor.startCreate());
    expect(editor.rows).toHaveLength(2);
    await act(async () => editor.save());
    expect(editor.operationError).toBe("Provider name, Base URL, and API Key are required.");
    expect(options.onCreate).not.toHaveBeenCalled();

    act(() => editor.changeField("apiKey", "sk-new"));
    await act(async () => editor.save());
    expect(options.onCreate).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "sk-new", type: "OpenAI" }));
    expect(editor.editingId).toBeNull();
  });

  it("keeps the stored key when an edit leaves it empty", async () => {
    act(() => editor.startEdit(openai));
    act(() => editor.changeField("model", "gpt-4.1"));
    await act(async () => editor.save());
    expect(options.onUpdate).toHaveBeenCalledWith("p1", expect.not.objectContaining({ apiKey: expect.anything() }));
  });

  it("saves a pending key before verifying and reports a failed connection", async () => {
    act(() => editor.startEdit(openai));
    act(() => editor.changeField("apiKey", "sk-pending"));
    await act(async () => editor.verify("p1"));
    expect(options.onUpdate).toHaveBeenCalledWith("p1", { apiKey: "sk-pending" });
    expect(editor.verificationError).toEqual({ providerId: "p1", message: expect.stringContaining("bad key") });
    expect(editor.editingDraft?.status).toBe("failed");
  });
});
