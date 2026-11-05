import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuddySummary } from "../../api/buddies";
import { BuddySidebar } from "./BuddySidebar";
import type { MachineBuddies } from "./useMachineBuddies";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shown = vi.hoisted(() => ({ items: [] as { label: string; onClick: () => void }[] }));
vi.mock("../ui/ContextMenu", () => ({ ContextMenu: ({ items, position }: { items: typeof shown.items; position: unknown }) => {
  if (position) shown.items = items;
  return null;
} }));
vi.mock("../Layout/SidebarResizer", () => ({ SidebarResizer: () => null }));
vi.mock("./BuddyAvatar", () => ({ BuddyAvatar: () => null }));
vi.mock("./group/BuddyGroupAvatar", () => ({ BuddyGroupAvatar: () => null }));

const buddy = (id: string): BuddySummary => ({ id, name: id, description: "", status: "idle", pinned: false, running_delegations: 0, waiting_delegations: 0, last_activity_at: null } as unknown as BuddySummary);
const section = (id: string, current: boolean, buddies: BuddySummary[] | null): MachineBuddies => ({
  machine: { id, name: id, description: "", icon: "laptop" }, current, base: current ? null : `http://localhost:${id}`, buddies,
});

describe("BuddySidebar across machines", () => {
  let host: HTMLDivElement;
  let root: Root;
  const open = vi.fn();
  const create = vi.fn();

  async function render(machines: MachineBuddies[], items: BuddySummary[], loading = false) {
    await act(async () => root.render(
      <BuddySidebar machines={machines} onOpenMachine={open} onCreateOnMachine={create} loading={loading} items={items} selectedId="" viewingId=""
        onSelect={() => {}} onCreate={() => {}} onBuddySettings={() => {}} onDelete={() => {}} onPin={() => {}}
        onMarkRead={() => {}} onMarkUnread={() => {}} onReorder={() => {}} />,
    ));
  }
  const menus = () => shown.items.map((item) => item.label);
  const menu = (label: string) => shown.items.find((item) => item.label === label)!.onClick;
  const heads = () => [...host.querySelectorAll(".buddy-machine-toggle")].map((head) => head.textContent);
  const button = (name: string) => [...host.querySelectorAll("button")].find((item) => item.textContent?.includes(name) || item.getAttribute("aria-label") === name) as HTMLButtonElement;

  beforeEach(() => {
    localStorage.clear();
    open.mockClear();
    create.mockClear();
    shown.items = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("lists each machine with its Buddies and goes there on select", async () => {
    const dev = section("dev", false, [buddy("Atlas")]);
    await render([section("home", true, []), dev], [buddy("Local")]);
    expect(heads()).toEqual(["home", "dev"]);
    expect(host.textContent).toContain("Local");
    await act(async () => button("Atlas").click());
    expect(open).toHaveBeenCalledWith(dev, { buddyId: "Atlas" });
  });

  it("creates on a machine without going there", async () => {
    const dev = section("dev", false, []);
    await render([section("home", true, []), dev], []);
    await act(async () => button("Create Buddy on dev").click());
    expect(create).toHaveBeenCalledWith(dev, "buddy");
    expect(open).not.toHaveBeenCalled();
  });

  it("offers a group on a machine with enough Buddies, without going there", async () => {
    const dev = section("dev", false, [buddy("Atlas"), buddy("Beacon")]);
    await render([section("home", true, []), dev], []);
    await act(async () => button("Create Buddy on dev").click());
    expect(create).not.toHaveBeenCalled();
    expect(menus()).toContain("New Group");
    await act(async () => menu("New Group")());
    expect(create).toHaveBeenCalledWith(dev, "group");
    expect(open).not.toHaveBeenCalled();
  });

  it("lists another machine's groups and opens them as groups", async () => {
    const group = { ...buddy("Crew"), group: { members: [] } } as unknown as BuddySummary;
    const dev = section("dev", false, [group]);
    await render([section("home", true, []), dev], []);
    await act(async () => button("Crew").click());
    expect(open).toHaveBeenCalledWith(dev, { groupId: "Crew" });
  });

  it("says when a machine can't be reached, and offers nothing on it", async () => {
    await render([section("home", true, []), section("dev", false, null)], []);
    expect(host.textContent).toContain("Not reachable");
    expect(button("Create Buddy on dev")).toBeUndefined();
  });

  it("folds a machine and remembers it", async () => {
    await render([section("home", true, []), section("dev", false, [buddy("Atlas")])], []);
    await act(async () => button("dev").click());
    expect(host.textContent).not.toContain("Atlas");
    expect(localStorage.getItem("grove-buddy-machines-folded")).toBe("dev");
  });

  it("keeps the known list while the machine it just switched to loads", async () => {
    await render([section("dev", true, [buddy("Atlas")])], [], true);
    expect(host.textContent).toContain("Atlas");
  });
});
