import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useBuddyResource } from "./useBuddyResource";

it("ignores resource responses from a previous Buddy", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resolveOld!: (value: string) => void;
  const oldLoad = () => new Promise<string>((resolve) => { resolveOld = resolve; });
  const nextLoad = async () => "next Buddy";
  let result!: ReturnType<typeof useBuddyResource<string>>;
  function Harness({ load }: { load: () => Promise<string> }) { result = useBuddyResource(load); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness load={oldLoad} />));
  await act(async () => root.render(<Harness load={nextLoad} />));
  await act(async () => resolveOld("old Buddy"));
  expect(result.data).toBe("next Buddy");
  act(() => root.unmount()); vi.unstubAllGlobals();
});
