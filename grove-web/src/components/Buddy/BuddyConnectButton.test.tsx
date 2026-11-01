import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ConnectItem } from "../../api/connects";
import { listBuddyConnects } from "../../api/buddyResources";
import { BuddyConnectButton } from "./BuddyConnectButton";

vi.mock("../../api/buddyResources", () => ({ listBuddyConnects: vi.fn() }));
vi.mock("../Config/ConnectSettings", () => ({ ConnectDialog: ({ isOpen, lock }: { isOpen: boolean; lock: { name: string } }) => isOpen ? <div role="dialog">Locked to {lock.name}</div> : null }));
const item = (state: ConnectItem["runtime"]["state"], enabled = true) => ({ id: state, enabled, runtime: { state } }) as ConnectItem;
const buddy = { id: "b", name: "Atlas", project_hash: "p" };

it.each([
  [[], null],
  [[item("online"), item("online")], "online"],
  [[item("online"), item("connecting")], "pending"],
  [[item("online"), item("error")], "error"],
  [[item("error", false)], "off"],
])("summarizes %j as %s and opens the dialog locked to the Buddy", async (items, tone) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(listBuddyConnects).mockResolvedValue(items);
  const host = document.createElement("div"); const root = createRoot(host);
  await act(async () => root.render(<BuddyConnectButton buddy={buddy} />));
  await act(async () => {});
  const dot = host.querySelector(".buddy-connect-status");
  expect(dot ? [...dot.classList].find(name => name.startsWith("is-"))?.slice(3) : null).toBe(tone);
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toContain("Locked to Atlas");
  act(() => root.unmount()); vi.unstubAllGlobals();
});
