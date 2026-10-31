vi.hoisted(() => vi.stubEnv("VITE_BUDDIES_MOCK", "true"));
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useBuddyComposer } from "./useBuddyComposer";
import { buddiesMock } from "../api/buddies.mock";

it("sends mock attachments to only the current Buddy Segment and stops its turn", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const buddy = buddiesMock.create({ name: "Draft partner", agent: "codex" });
  let composer!: ReturnType<typeof useBuddyComposer>;
  const onSent = vi.fn();
  function Harness() { composer = useBuddyComposer(buddy, onSent); return null; }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness />));
  await act(async () => composer.send("Read this", [new File(["notes"], "notes.txt")]));
  expect(buddiesMock.messages(buddy.id)[0]).toMatchObject({ role: "user", text: "Read this", files: ["notes.txt"] });
  expect(onSent).toHaveBeenCalledOnce();
  act(() => composer.stop()); expect(buddiesMock.get(buddy.id).status).toBe("idle");
  buddiesMock.switchAgent(buddy.id, { agent: "claude-code" });
  expect(buddiesMock.messages(buddy.id)).toEqual([]);
  act(() => root.unmount()); vi.unstubAllGlobals();
});
