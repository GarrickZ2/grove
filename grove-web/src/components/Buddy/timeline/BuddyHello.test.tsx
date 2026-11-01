import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Buddy } from "../../../api/buddies";
import { BuddyHello } from "./BuddyHello";

const buddy = { id: "b", name: "Atlas", role: "Explore code", avatar: null } as Buddy;

it("plays the arrival only for a newly created Buddy", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); const root = createRoot(host);
  act(() => root.render(<BuddyHello buddy={buddy} arriving />));
  expect(host.querySelector(".buddy-hello.is-arriving")).not.toBeNull();
  expect(host.querySelectorAll(".buddy-hello-spark")).toHaveLength(8);
  expect(host.textContent).toContain("Hi, I'm Atlas");
  act(() => root.render(<BuddyHello buddy={buddy} />));
  expect(host.querySelector(".buddy-hello-spark")).toBeNull();
  expect(host.textContent).toContain("Say hi to Atlas");
  expect(host.textContent).toContain("Explore code");
  act(() => root.unmount()); vi.unstubAllGlobals();
});
