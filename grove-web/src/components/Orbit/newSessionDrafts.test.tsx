import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatOrNewSession } from "./ChatOrNewSession";
import { beginNewSession, endNewSession, hasNewSession, newSessionEnd, newSessionShown } from "./newSessionDrafts";

vi.mock("./OrbitNewChat", () => ({ OrbitNewChat: ({ workspaceTask }: { workspaceTask: string }) => <p>new in {workspaceTask}</p> }));

describe("a new Session in a Task's workspace", () => {
  let host: HTMLDivElement;
  let root: Root;
  const chatActive = vi.fn();
  const render = (isActive = true) => act(() => root.render(
    <ChatOrNewSession projectId="p" taskId="t" taskName="Work" isActive={isActive}>
      {(active) => { chatActive(active); return <p>chat</p>; }}
    </ChatOrNewSession>,
  ));
  const chatHidden = () => host.querySelector(".orbit-new-slot") !== null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    endNewSession("p", "t", "left");
    host.remove();
    vi.unstubAllGlobals();
  });

  it("puts the composer in the chat's place and keeps the chat mounted", () => {
    render();
    expect(chatHidden()).toBe(false);
    act(() => beginNewSession("p", "t"));
    expect(host.textContent).toBe("chatnew in Work");
    expect(chatHidden()).toBe(true);
    expect(chatActive).toHaveBeenLastCalledWith(false);
    expect(newSessionShown()).toBe(true);
  });

  it("ends when one of the Task's Sessions is opened, not another Task's", () => {
    render();
    act(() => beginNewSession("p", "t"));
    const open = (taskId: string) => act(() => { window.dispatchEvent(new CustomEvent("grove:switch-chat", { detail: { projectId: "p", taskId, chatId: "c" } })); });
    open("other");
    expect(hasNewSession("p", "t")).toBe(true);
    open("t");
    expect(chatHidden()).toBe(false);
    expect(newSessionEnd("p", "t")).toBe("left");
    expect(newSessionShown()).toBe(false);
  });

  it("does not count as shown while its page is hidden, and comes back with it", () => {
    render(false);
    act(() => beginNewSession("p", "t"));
    expect(newSessionShown()).toBe(false);
    expect(host.textContent).toBe("chat");
    render(true);
    expect(newSessionShown()).toBe(true);
    expect(host.textContent).toBe("chatnew in Work");
  });
});
