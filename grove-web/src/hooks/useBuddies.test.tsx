import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBuddies } from "./useBuddies";
import { createBuddiesMock } from "../api/buddies.mock";
import { getBuddy, listBuddies } from "../api/buddies";
vi.mock("../api/buddies", () => ({ listBuddies: vi.fn(), getBuddy: vi.fn() }));
afterEach(() => { localStorage.clear(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
describe("useBuddies selection", () => {
  it("does not let a pending detail read overwrite a saved change", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mock = createBuddiesMock();
    vi.mocked(listBuddies).mockResolvedValue(mock.list());
    let finish!: (value: ReturnType<typeof mock.get>) => void;
    vi.mocked(getBuddy).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    let data!: ReturnType<typeof useBuddies>;
    function Harness() { data = useBuddies(); return null; }
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
    const old = mock.get("mock-chief");
    act(() => data.accept({ ...old, name: "Updated Chief" }));
    await act(async () => finish(old));
    expect(data.buddy?.name).toBe("Updated Chief");
    expect(data.items[0].name).toBe("Updated Chief");
    act(() => root.unmount());
  });
  it("restores selection and ignores an older detail response after switching", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mock = createBuddiesMock();
    localStorage.setItem("grove-buddy-selected", "mock-inbox");
    vi.mocked(listBuddies).mockResolvedValue(mock.list());
    let finish!: (value: ReturnType<typeof mock.get>) => void;
    vi.mocked(getBuddy).mockImplementation(async (id) => id === "mock-inbox" ? new Promise((resolve) => { finish = resolve; }) : mock.get(id));
    let data!: ReturnType<typeof useBuddies>;
    function Harness() { data = useBuddies(); return null; }
    const host = document.createElement("div"); const root = createRoot(host);
    await act(async () => root.render(<Harness />));
    expect(data.selectedId).toBe("mock-inbox");
    await act(async () => data.select("mock-chief"));
    await act(async () => finish(mock.get("mock-inbox")));
    expect(data.buddy?.id).toBe("mock-chief");
    act(() => root.unmount());
  });
});
