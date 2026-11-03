import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BuddySwipeRow } from "./BuddySwipeRow";

let host: HTMLDivElement, root: Root;
const actions = { onToggleRead: vi.fn(), onTogglePin: vi.fn(), onDelete: vi.fn(), onSelect: vi.fn() };
function Harness({ unread = false }: { unread?: boolean }) {
  const [open, setOpen] = useState(false);
  return <BuddySwipeRow unread={unread} pinned={false} open={open} onOpen={setOpen} blocked={() => false}
    onToggleRead={actions.onToggleRead} onTogglePin={actions.onTogglePin} onDelete={actions.onDelete}>
    <button type="button" onClick={actions.onSelect}>Ada</button>
  </BuddySwipeRow>;
}
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

const content = () => host.querySelector<HTMLElement>(".buddy-swipe-content")!;
const swipe = (dx: number, dy = 0) => {
  const fire = (type: string, x: number, y: number) => act(() => { content().dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }), { pointerId: 7, pointerType: "touch" })); });
  fire("pointerdown", 200, 100);
  fire("pointermove", 200 + dx / 2, 100 + dy / 2);
  fire("pointermove", 200 + dx, 100 + dy);
  fire("pointerup", 200 + dx, 100 + dy);
};

it("toggles read state on a long right swipe without opening the conversation", () => {
  act(() => root.render(<Harness unread />));
  expect(host.querySelector(".buddy-swipe-leading")?.textContent).toBe("Read");
  swipe(110);
  expect(actions.onToggleRead).toHaveBeenCalledOnce();
  act(() => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(actions.onSelect).not.toHaveBeenCalled();
});

it("reveals Pin and Delete on a left swipe; tapping the open row closes it", async () => {
  act(() => root.render(<Harness />));
  swipe(-120);
  expect(content().style.transform).toBe("translateX(-148px)");
  act(() => [...host.querySelectorAll<HTMLButtonElement>(".buddy-swipe-trailing button")].find((b) => b.textContent === "Delete")!.click());
  expect(actions.onDelete).toHaveBeenCalledOnce();
  expect(content().style.transform).toBe("translateX(0px)");
  swipe(-120);
  // A later tap, not the click that ends the swipe gesture itself.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  act(() => host.querySelector<HTMLButtonElement>(".buddy-swipe-content button")!.click());
  expect(actions.onSelect).not.toHaveBeenCalled();
  expect(content().style.transform).toBe("translateX(0px)");
});

it("leaves vertical scrolling alone", () => {
  act(() => root.render(<Harness />));
  swipe(6, 80);
  expect(content().style.transform).toBe("translateX(0px)");
  expect(actions.onToggleRead).not.toHaveBeenCalled();
});
