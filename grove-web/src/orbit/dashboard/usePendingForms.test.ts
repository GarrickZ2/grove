import { describe, expect, it } from "vitest";
import { usableForm } from "./usePendingForms";

const form = (kind: string, options: string[] = []) => ({
  form: { request_id: "r1", agent_name: "Agent", message: "Pick", field: { name: "env", label: "Env", description: null, required: true, kind, options } },
});

describe("usableForm", () => {
  it("accepts simple inline forms", () => {
    expect(usableForm(form("text"))?.field.kind).toBe("text");
    expect(usableForm(form("boolean"))?.field.kind).toBe("boolean");
    expect(usableForm(form("choice", ["a", "b"]))?.field.options).toEqual(["a", "b"]);
  });

  it("sends long choice lists, unknown kinds and old servers to the session", () => {
    expect(usableForm(form("choice", ["a", "b", "c", "d"]))).toBeNull();
    expect(usableForm(form("choice", []))).toBeNull();
    expect(usableForm(form("integer"))).toBeNull();
    expect(usableForm({ form: null })).toBeNull();
    expect(usableForm("<!doctype html>")).toBeNull();
  });
});
