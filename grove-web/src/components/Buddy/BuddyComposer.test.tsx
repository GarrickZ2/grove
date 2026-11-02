import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuddyComposer } from "./BuddyComposer";
import { BuddyConversationHeader } from "./BuddyConversationHeader";
import { createBuddiesMock } from "../../api/buddies.mock";
import { OrbitInterfaceContext } from "../../orbit/ui/interfaceContext";
const transport = vi.hoisted(() => ({ send: vi.fn(), stop: vi.fn(), connected: true, sending: false }));
vi.mock("../../hooks/useBuddyComposer", () => ({ useBuddyComposer: () => transport }));
describe("Buddy composer and header", () => {
  let host: HTMLDivElement; let root: Root;
  const buddy = createBuddiesMock().get("mock-chief");
  beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); transport.connected = true; transport.sending = false; transport.stop.mockReset(); transport.send.mockResolvedValue(undefined); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
  const draft = (value: string) => act(() => { const input = host.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
  it("shows Send while idle instead of recording, disables empty input and sends by clicking", async () => {
    act(() => root.render(<BuddyComposer buddy={buddy} onSent={vi.fn()} />));
    const send = host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
    expect(send.disabled).toBe(true);
    expect(host.querySelector('[aria-label="Record voice message"]')).toBeNull();
    expect(host.querySelector("textarea")?.rows).toBe(1);
    draft("   "); expect(send.disabled).toBe(true);
    draft("Hi"); expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(transport.send).toHaveBeenCalledWith("Hi", []);
    expect(send.disabled).toBe(true);
  });
  it.each(["working", "waiting"] as const)("offers Stop with empty input while %s and Send when text is present", async (status) => {
    act(() => root.render(<BuddyComposer buddy={{ ...buddy, status }} onSent={vi.fn()} />));
    const stop = () => host.querySelector<HTMLButtonElement>('[aria-label="Stop response"]');
    expect(stop()?.type).toBe("button"); expect(stop()?.disabled).toBe(false);
    act(() => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(transport.stop).not.toHaveBeenCalled(); expect(transport.send).not.toHaveBeenCalled();
    draft("   "); expect(stop()).not.toBeNull();
    await act(async () => stop()!.click());
    expect(transport.stop).toHaveBeenCalledOnce(); expect(transport.send).not.toHaveBeenCalled();
    draft("Next message"); expect(stop()).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(transport.send).toHaveBeenCalledWith("Next message", []);
    expect(stop()).not.toBeNull();
    act(() => root.render(<BuddyComposer buddy={{ ...buddy, status: "idle" }} onSent={vi.fn()} />));
    expect(stop()).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(true);
  });
  it("under Orbit lets the typed text leave the box while sending, keeping a failed draft visible", async () => {
    let resolve!: () => void;
    transport.send.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    act(() => root.render(<OrbitInterfaceContext.Provider value><BuddyComposer buddy={buddy} onSent={vi.fn()} /></OrbitInterfaceContext.Provider>));
    draft("Leaving");
    const textarea = host.querySelector("textarea")!;
    act(() => { host.querySelector<HTMLButtonElement>(".buddy-oc-orb")!.click(); });
    expect(host.querySelector(".oc-send-out")?.textContent).toBe("Leaving");
    expect(textarea.classList.contains("oc-send-out-source")).toBe(true);
    expect(transport.send).toHaveBeenCalledWith("Leaving", []);
    await act(async () => { resolve(); });
    expect(textarea.value).toBe("");
    expect(textarea.classList.contains("oc-send-out-source")).toBe(false);
    // A failed send keeps the draft, and it shows again.
    transport.send.mockRejectedValueOnce(new Error("Session disconnected"));
    draft("Kept");
    await act(async () => { host.querySelector<HTMLButtonElement>(".buddy-oc-orb")!.click(); });
    expect(textarea.value).toBe("Kept");
    expect(textarea.classList.contains("oc-send-out-source")).toBe(false);
  });

  it("outside Orbit sends without the send-out copy", async () => {
    act(() => root.render(<BuddyComposer buddy={buddy} onSent={vi.fn()} />));
    draft("Plain");
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
    expect(host.querySelector(".oc-send-out")).toBeNull();
  });

  it("under Orbit morphs one orb between Stop and Send, keeps the same actions and hints while typing", async () => {
    const render = (status: "working" | "idle") => act(() => root.render(<OrbitInterfaceContext.Provider value><BuddyComposer buddy={{ ...buddy, status }} onSent={vi.fn()} /></OrbitInterfaceContext.Provider>));
    render("working");
    expect(host.querySelector("form")?.className).toBe("buddy-composer is-orbit is-running");
    const orb = host.querySelector<HTMLButtonElement>(".buddy-oc-orb")!;
    expect(orb.getAttribute("aria-label")).toBe("Stop response"); expect(orb.dataset.icon).toBe("stop"); expect(orb.type).toBe("button");
    await act(async () => orb.click());
    expect(transport.stop).toHaveBeenCalledOnce();
    expect(host.querySelector(".buddy-oc-hint")).toBeNull();
    act(() => host.querySelector("textarea")!.focus());
    draft("Next message");
    expect(host.querySelector(".buddy-oc-orb")).toBe(orb);
    expect(orb.getAttribute("aria-label")).toBe("Send message"); expect(orb.dataset.icon).toBe("arrow"); expect(orb.type).toBe("submit");
    expect(host.querySelector(".buddy-oc-hint")?.textContent).toBe("\u23CE send \u00b7 \u21E7\u23CE newline");
    await act(async () => orb.click());
    expect(transport.send).toHaveBeenCalledWith("Next message", []);
    render("idle");
    expect(host.querySelector("form")?.className).toBe("buddy-composer is-orbit");
    expect(orb.disabled).toBe(true);
    expect(host.querySelector('[aria-label="Add attachment"]')?.classList.contains("buddy-oc-tool")).toBe(true);
  });
  it("keeps attachment-only inputs sendable during work and restores Stop when removed", () => {
    act(() => root.render(<BuddyComposer buddy={{ ...buddy, status: "working" }} onSent={vi.fn()} />));
    const field = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(field, "files", { value: [new File(["hello"], "notes.txt")] });
    act(() => field.dispatchEvent(new Event("change", { bubbles: true })));
    expect(host.querySelector('[aria-label="Stop response"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.disabled).toBe(false);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove notes.txt"]')!.click());
    expect(host.querySelector('[aria-label="Stop response"]')).not.toBeNull();
  });
  it("reports cancellation failures and disables Stop when disconnected", async () => {
    transport.stop.mockImplementation(() => { throw new Error("Connection lost"); });
    act(() => root.render(<BuddyComposer buddy={{ ...buddy, status: "working" }} onSent={vi.fn()} />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Connection lost");
    transport.connected = false;
    act(() => root.render(<BuddyComposer buddy={{ ...buddy, status: "working" }} onSent={vi.fn()} />));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')?.disabled).toBe(true);
  });
  it("allows an attachment-only message through the same Send button", async () => {
    act(() => root.render(<BuddyComposer buddy={buddy} onSent={vi.fn()} />));
    const file = new File(["hello"], "notes.txt");
    const field = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(field, "files", { value: [file] });
    act(() => field.dispatchEvent(new Event("change", { bubbles: true })));
    const send = host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
    expect(send.disabled).toBe(false);
    await act(async () => send.click());
    expect(transport.send).toHaveBeenCalledWith("", [file]);
    expect(send.disabled).toBe(true);
    expect(host.textContent).not.toContain("notes.txt");
  });
  it.each(["disconnected", "sending"])("blocks submission while %s and keeps the draft", async (state) => {
    transport.connected = state !== "disconnected"; transport.sending = state === "sending";
    act(() => root.render(<BuddyComposer buddy={buddy} onSent={vi.fn()} initialText="Keep me" />));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(transport.send).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")!.value).toBe("Keep me");
  });
  it("preserves IME and multiline Enter and only clears an accepted draft", async () => {
    act(() => root.render(<BuddyComposer buddy={buddy} onSent={vi.fn()} />)); draft("你好");
    for (const init of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) act(() => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init })));
    expect(transport.send).not.toHaveBeenCalled();
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(transport.send).toHaveBeenCalledWith("你好", []);
    expect(host.querySelector("textarea")!.value).toBe("");
  });
  it("keeps text and files after a failed send", async () => {
    transport.send.mockRejectedValue(new Error("Rejected"));
    act(() => root.render(<BuddyComposer buddy={buddy} onSent={vi.fn()} />)); draft("Review this");
    const file = new File(["hello"], "notes.txt");
    const field = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(field, "files", { value: [file] });
    act(() => field.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.textContent).toContain("Rejected"); expect(host.textContent).toContain("notes.txt");
    expect(host.querySelector("textarea")!.value).toBe("Review this");
  });
  it("restores a draft when remounted", () => {
    act(() => root.render(<BuddyComposer buddy={buddy} onSent={vi.fn()} />)); draft("Keep me");
    act(() => root.unmount()); root = createRoot(host);
    act(() => root.render(<BuddyComposer buddy={buddy} onSent={vi.fn()} />));
    expect(host.querySelector("textarea")!.value).toBe("Keep me");
  });
  it("shows working counts and accessible panel controls", () => {
    const panel = vi.fn();
    act(() => root.render(<BuddyConversationHeader buddy={{ ...buddy, status: "working", running_delegations: 1 }} panelOpen={false} onPanel={panel} />));
    expect(host.textContent).toContain("Working · 1 delegation running");
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Open Buddy panel"]')!.click()); expect(panel).toHaveBeenCalledOnce();
  });
});
