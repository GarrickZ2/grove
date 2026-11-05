import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMachines } from "../../api/machines";
import { OrbitMachineEntry } from "./OrbitMachineMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const web = vi.hoisted(() => ({ value: {} as { multi_machine?: boolean } }));
vi.mock("../../context", () => ({ useConfig: () => ({ config: { web: web.value } }) }));
vi.mock("../../api/machines", () => ({ getMachines: vi.fn(() => new Promise(() => {})) }));

afterEach(() => {
  web.value = {};
  vi.clearAllMocks();
});

async function mount() {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<OrbitMachineEntry />));
  await act(async () => root.unmount());
}

describe("OrbitMachineEntry", () => {
  it("stays out of the sidebar, and off the network, until turned on", async () => {
    await mount();
    expect(getMachines).not.toHaveBeenCalled();
  });

  it("loads the switcher once turned on", async () => {
    web.value = { multi_machine: true };
    await mount();
    expect(getMachines).toHaveBeenCalledOnce();
  });
});
