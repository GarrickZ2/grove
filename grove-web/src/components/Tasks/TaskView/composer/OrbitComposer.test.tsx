import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitComposer, OrbitSendOrb, OrbitStatusBar } from "./OrbitComposer";
import { OrbitSetupChip } from "./OrbitSetupChip";
import { buildComposerStatus, type ComposerStatusInput } from "./composerStatus";

vi.mock("../../../../keyboard/useEscapeScope", () => ({ useEscapeScope: vi.fn() }));
vi.mock("../SubagentAvatar", () => ({ SubagentAvatar: ({ sessionId }: { sessionId: string }) => <i data-avatar={sessionId} /> }));

const base: ComposerStatusInput = {
  running: false, planEntries: [], planDocTitle: null, subagents: [],
  queue: { count: 0, failed: 0 }, memoryCount: 0, commentCount: 0, ask: null,
};

describe("Orbit composer", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders no status zone when idle with nothing to show", () => {
    act(() => root.render(<OrbitStatusBar status={buildComposerStatus(base)} activeTray={null} onTrayChange={() => {}} />));
    expect(container.querySelector(".oc-status")).toBeNull();
  });

  it("shows one plan chip with the current step and n/m, and toggles its tray", () => {
    const onTrayChange = vi.fn();
    const status = buildComposerStatus({
      ...base, running: true,
      planEntries: [{ content: "Done", status: "completed" }, { content: "Check dark theme", status: "in_progress" }],
      queue: { count: 1, failed: 1 },
    });
    act(() => root.render(<OrbitStatusBar status={status} activeTray={null} onTrayChange={onTrayChange} />));
    const plan = container.querySelector<HTMLButtonElement>(".oc-chip.is-plan")!;
    expect(plan.textContent).toBe("Check dark theme1/2");
    expect(container.textContent).not.toMatch(/Step \d of/);
    expect(container.querySelector(".oc-chip.is-error")?.textContent).toBe("Queue1");
    expect(container.textContent).not.toContain("Memory");
    act(() => plan.click());
    expect(onTrayChange).toHaveBeenCalledWith("plan");
  });

  it("reads just Working with the live dot while a turn runs without a plan", () => {
    act(() => root.render(<OrbitStatusBar status={buildComposerStatus({ ...base, running: true })} activeTray={null} onTrayChange={() => {}} />));
    const chip = container.querySelector('[role="status"]')!;
    expect(chip.textContent).toBe("Working");
    expect(chip.querySelector(".oc-live")).not.toBeNull();
  });

  it("closes an open tray when its chip is clicked again", () => {
    const onTrayChange = vi.fn();
    const status = buildComposerStatus({ ...base, memoryCount: 2 });
    act(() => root.render(<OrbitStatusBar status={status} activeTray="memory" onTrayChange={onTrayChange} />));
    act(() => container.querySelector<HTMLButtonElement>(".oc-chip.is-on")!.click());
    expect(onTrayChange).toHaveBeenCalledWith(null);
  });

  it("offers a chip to reopen a set-aside agent request", () => {
    const onTrayChange = vi.fn();
    act(() => root.render(<OrbitStatusBar status={buildComposerStatus({ ...base, ask: "permission" })} activeTray={null} onTrayChange={onTrayChange} />));
    const chip = container.querySelector<HTMLButtonElement>(".oc-chip.is-ask")!;
    expect(chip.textContent).toBe("Permission request");
    act(() => chip.click());
    expect(onTrayChange).toHaveBeenCalledWith("ask");
  });

  it("morphs one orb between send, queue and stop, wiring the matching handler", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const onSendNow = vi.fn();
    const render = (action: "send" | "queue" | "stop" | "sendNow" | "idle") => act(() => root.render(
      <OrbitSendOrb action={action} disabled={false} onSend={onSend} onStop={onStop} onSendNow={onSendNow} />,
    ));
    render("idle");
    const orb = () => container.querySelector<HTMLButtonElement>(".oc-orb")!;
    expect(orb().disabled).toBe(true);
    render("stop");
    expect(orb().dataset.icon).toBe("stop");
    expect(orb().getAttribute("aria-label")).toBe("Stop");
    act(() => orb().click());
    expect(onStop).toHaveBeenCalledTimes(1);
    render("queue");
    expect(orb().dataset.icon).toBe("arrow");
    expect(orb().title).toMatch(/queue/i);
    act(() => orb().click());
    render("sendNow");
    act(() => orb().click());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSendNow).toHaveBeenCalledTimes(1);
  });

  it("renders the frame with tools, typing hint and the running light", () => {
    act(() => root.render(
      <OrbitComposer running hint="⏎ send · ⇧⏎ newline" tools={<button type="button">Attach</button>} orb={<span />}>
        <div contentEditable />
      </OrbitComposer>,
    ));
    expect(container.querySelector(".oc-shell")?.classList.contains("is-running")).toBe(true);
    expect(container.querySelector(".oc-hint")?.textContent).toBe("⏎ send · ⇧⏎ newline");
    act(() => root.render(<OrbitComposer running={false} orb={<span />}><div /></OrbitComposer>));
    expect(container.querySelector(".oc-hint")).toBeNull();
  });

  it("summarises the setup chip as Agent · Model · Mode with short, whole-word labels", () => {
    act(() => root.render(
      <OrbitSetupChip
        agentLabel="Claude Code"
        fields={[
          { id: "model", kind: "model", label: "Model", value: "default", onSelect: vi.fn(), options: [{ value: "default", label: "Default (recommended)" }, { value: "opus", label: "Opus" }] },
          { id: "mode", kind: "mode", label: "Mode", value: "bypass", onSelect: vi.fn(), options: [{ value: "default", label: "Default" }, { value: "bypass", label: "Bypass permissions" }] },
        ]}
      />,
    ));
    const chip = container.querySelector<HTMLButtonElement>(".oc-setup-chip")!;
    expect(chip.textContent).toBe("Claude CodeDefaultBypass");
    expect(container.querySelector(".oc-setup-risk")?.textContent).toBe("Bypass");
  });

  it("lists one row per setting with its full value, opening options in a submenu", () => {
    const onMode = vi.fn();
    const onToggle = vi.fn();
    act(() => root.render(
      <OrbitSetupChip
        agentLabel="Claude Code"
        fields={[
          { id: "model", kind: "model", label: "Model", value: "sonnet", onSelect: vi.fn(), options: [{ value: "sonnet", label: "Sonnet", description: "Everyday tasks" }, { value: "opus", label: "Opus" }] },
          { id: "mode", kind: "mode", label: "Mode", value: "bypass", onSelect: onMode, options: [{ value: "default", label: "Default" }, { value: "bypass", label: "Bypass permissions" }] },
        ]}
        toggles={[{ id: "fast", label: "Fast mode", value: false, onToggle }]}
      />,
    ));
    act(() => container.querySelector<HTMLButtonElement>(".oc-setup-chip")!.click());
    const rows = Array.from(container.querySelectorAll<HTMLButtonElement>("button.oc-menu-row"));
    expect(rows.map((row) => row.textContent)).toEqual(["ModelSonnet", "ModeBypass permissions"]);
    // Level 1 has no descriptions.
    expect(container.querySelector(".oc-menu")?.textContent).not.toContain("Everyday tasks");
    expect(container.querySelector(".oc-sub")).toBeNull();

    // → opens the row's submenu; the current option carries the check.
    act(() => { rows[1].focus(); rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    const sub = container.querySelector(".oc-sub")!;
    expect(sub.getAttribute("aria-label")).toBe("Mode");
    expect(sub.querySelector('[aria-checked="true"]')?.textContent).toBe("Bypass permissions");

    // ← goes back to level 1.
    act(() => sub.querySelector<HTMLButtonElement>("[data-option]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(container.querySelector(".oc-sub")).toBeNull();

    act(() => rows[1].click());
    act(() => container.querySelector<HTMLButtonElement>('[data-option="default"]')!.click());
    expect(onMode).toHaveBeenCalledWith("default");
    // Picking closes the menu.
    expect(container.querySelector(".oc-menu")).toBeNull();

    act(() => container.querySelector<HTMLButtonElement>(".oc-setup-chip")!.click());
    act(() => container.querySelector<HTMLButtonElement>('.oc-menu-toggle [role="switch"]')!.click());
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("adds search to long option lists", () => {
    const options = Array.from({ length: 10 }, (_, index) => ({ value: `m${index}`, label: `Model ${index}` }));
    act(() => root.render(<OrbitSetupChip agentLabel="Codex" fields={[{ id: "model", kind: "model", label: "Model", value: "m0", onSelect: vi.fn(), options }]} />));
    act(() => container.querySelector<HTMLButtonElement>(".oc-setup-chip")!.click());
    act(() => container.querySelector<HTMLButtonElement>("button.oc-menu-row")!.click());
    expect(container.querySelector(".oc-sub-search input")).not.toBeNull();
  });

  it("opens the phone setup sheet with rows, then a setting's options with a back button", () => {
    const onMode = vi.fn();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    act(() => root.render(
      <OrbitSetupChip
        sheet
        agentLabel="Codex"
        fields={[{ id: "mode", kind: "mode", label: "Mode", value: "auto", onSelect: onMode, options: [{ value: "auto", label: "Auto review" }, { value: "full", label: "Full access" }] }]}
      />,
    ));
    act(() => container.querySelector<HTMLButtonElement>(".oc-setup-chip")!.click());
    const sheet = () => document.body.querySelector(".oc-sheet");
    expect(sheet()?.textContent).toContain("Session setup");
    act(() => sheet()!.querySelector<HTMLButtonElement>('[data-row="mode"]')!.click());
    expect(sheet()?.querySelector(".oc-sheet-head")?.textContent).toBe("Mode");
    act(() => sheet()!.querySelector<HTMLButtonElement>(".oc-sheet-back")!.click());
    expect(sheet()?.querySelector(".oc-sheet-head")?.textContent).toBe("Session setup");
    act(() => sheet()!.querySelector<HTMLButtonElement>('[data-row="mode"]')!.click());
    act(() => sheet()!.querySelector<HTMLButtonElement>('[data-option="full"]')!.click());
    expect(onMode).toHaveBeenCalledWith("full");
  });
});
