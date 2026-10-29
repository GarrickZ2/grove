import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionActionsMenu } from "./TaskChat";

describe("Orbit session actions", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it("exposes the existing session actions with the selected session id", () => {
    const fork = vi.fn();
    const refresh = vi.fn();
    const reconnect = vi.fn();
    const archive = vi.fn();
    const remove = vi.fn();
    const rename = vi.fn();
    act(() => root.render(<SessionActionsMenu
      surface="orbit" chatId="chat-a" forkCapable importCapable={false} importSessions={[]}
      importLoading={false} authMethods={[]} logoutCapable={false}
      refreshDisabled={false} reconnectDisabled={false} actionsDisabled={false}
      deleteDisabled={false} archiveDisabled={false}
      onFork={fork} onOpenImport={vi.fn()} onLoadMoreImport={vi.fn()} onImport={vi.fn()}
      onLogin={vi.fn()} onLogout={vi.fn()} onRefresh={refresh} onReconnect={reconnect}
      onDelete={remove} onArchive={archive} onRename={rename}
    />));
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Session actions"]')!;
    for (const [label, handler, argument] of [
      ["Rename", rename, undefined], ["Fork", fork, "chat-a"], ["Refresh", refresh, undefined],
      ["Reconnect", reconnect, undefined], ["Archive", archive, "chat-a"], ["Delete", remove, "chat-a"],
    ] as const) {
      act(() => trigger.click());
      const item = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim().startsWith(label));
      expect(item, label).toBeTruthy();
      act(() => item!.click());
      if (argument) expect(handler).toHaveBeenCalledWith(argument);
      else expect(handler).toHaveBeenCalledOnce();
    }
  });
});
