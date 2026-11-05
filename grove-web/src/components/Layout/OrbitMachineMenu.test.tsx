import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitMachineMenu } from "./OrbitMachineMenu";
import { homeNote, machineAddress, machineNote, parseHeaders } from "./orbitMachines";
import { getMachines, openMachine, pairMachine, refreshMachineSession, type MachinesOverview, type PairedMachine } from "../../api/machines";
import { signInToMachine } from "../../utils/tauriShell";
import { setMachineApiBase } from "../../api/client";

const shell = vi.hoisted(() => ({ desktop: true }));
vi.mock("../../api/client", () => ({ setMachineApiBase: vi.fn() }));
vi.mock("../../api/machines", () => ({
  getMachines: vi.fn(), openMachine: vi.fn(), pairMachine: vi.fn(), refreshMachineSession: vi.fn(), removeMachine: vi.fn(), updateMachine: vi.fn(),
  needsMachineLogin: (error: { data?: { error?: string } }) => error?.data?.error === "machine_login_required",
}));
vi.mock("../../utils/tauriShell", () => ({ get isTauriShell() { return shell.desktop; }, signInToMachine: vi.fn() }));
vi.mock("../../keyboard/useEscapeScope", () => ({ useEscapeScope: () => {} }));

const home = { id: "home", name: "MacBook", description: "", icon: "laptop" } as const;
const devbox: PairedMachine = { id: "dev", name: "Dev box", description: "Backend", icon: "server", url: "http://dev:3900", status: "online", version: "0.14.2" };
const overview = (patch: Partial<MachinesOverview> = {}): MachinesOverview => ({ current: "home", home_url: "http://localhost:3001", this: home, machines: [devbox], ...patch });

describe("Orbit machine menu", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const assign = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("location", { ...window.location, assign });
    assign.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  const render = async (value: MachinesOverview) => {
    vi.mocked(getMachines).mockResolvedValue(value);
    await act(async () => { root.render(<OrbitMachineMenu />); });
  };
  const button = (label: string | RegExp) => [...document.querySelectorAll("button")].find((b) => (typeof label === "string" ? (b.textContent ?? "").includes(label) || b.getAttribute("aria-label")?.includes(label) : label.test(b.textContent ?? "")));
  const openMenu = async () => { await act(async () => { button("Machine:")!.click(); }); };

  it("names the machine this window is showing, not the one serving it", async () => {
    await render(overview({ current: "dev" }));
    expect(button("Machine:")!.textContent).toContain("Dev box");
  });

  it("marks the machine Grove runs on", () => {
    expect(homeNote(home)).toBe("This machine");
    expect(homeNote({ ...home, description: "Daily driver" })).toBe("This machine · Daily driver");
  });

  it("switches through the local port and back home", async () => {
    vi.mocked(openMachine).mockResolvedValue("http://localhost:4100");
    await render(overview());
    await openMenu();
    const probe = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", probe);
    await act(async () => { button(/Dev box/)!.click(); });
    expect(openMachine).toHaveBeenCalledWith("dev");
    expect(probe).toHaveBeenCalledWith("http://localhost:4100/api/v1/config");
    expect(setMachineApiBase).toHaveBeenCalledWith("http://localhost:4100");
    expect(assign).not.toHaveBeenCalled();
  });

  it("stays put when the machine doesn't answer", async () => {
    vi.mocked(setMachineApiBase).mockClear();
    vi.mocked(openMachine).mockResolvedValue("http://localhost:4100");
    await render(overview());
    await openMenu();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await act(async () => { button(/Dev box/)!.click(); });
    expect(setMachineApiBase).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Can't reach Dev box");
  });

  it("stays put when the proxy can't reach the machine behind it", async () => {
    vi.mocked(setMachineApiBase).mockClear();
    vi.mocked(openMachine).mockResolvedValue("http://localhost:4100");
    await render(overview());
    await openMenu();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    await act(async () => { button(/Dev box/)!.click(); });
    expect(setMachineApiBase).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Can't reach Dev box");
  });

  it("doesn't offer an offline machine as a destination", async () => {
    await render(overview({ machines: [{ ...devbox, status: "offline" }] }));
    await openMenu();
    expect(button(/Dev box/)!.disabled).toBe(true);
    expect(button(/Dev box/)!.textContent).toContain("Offline");
  });

  it("asks to sign in again when a machine revoked this one", async () => {
    await render(overview({ machines: [{ ...devbox, status: "signed_out" }] }));
    await openMenu();
    await act(async () => { button(/Dev box/)!.click(); });
    expect(document.querySelector<HTMLInputElement>('input.oui-field')!.value).toBe("http://dev:3900");
  });

  it("names a new machine right after connecting", async () => {
    vi.mocked(pairMachine).mockResolvedValue({ id: "gpu", name: "gpu-01", description: "", icon: "gpu" });
    await render(overview());
    await openMenu();
    await act(async () => { button("Connect a machine")!.click(); });
    const fields = document.querySelectorAll<HTMLInputElement>("input.oui-field");
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { set.call(fields[0], "gpu:3900"); fields[0].dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { set.call(fields[1], "secret12"); fields[1].dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(pairMachine).toHaveBeenCalledWith("gpu:3900", "secret12", {});
    expect(document.querySelector<HTMLInputElement>("input.oui-field")!.value).toBe("gpu-01");
  });

  const connectTo = async (address: string, key: string) => {
    await render(overview());
    await openMenu();
    await act(async () => { button("Connect a machine")!.click(); });
    const fields = document.querySelectorAll<HTMLInputElement>("input.oui-field");
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { set.call(fields[0], address); fields[0].dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { set.call(fields[1], key); fields[1].dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  };
  const loginRequired = { data: { error: "machine_login_required" }, message: "behind a sign-in page" };

  it("signs in through a window, then carries on connecting", async () => {
    shell.desktop = true;
    vi.mocked(pairMachine).mockReset();
    vi.mocked(pairMachine).mockRejectedValueOnce(loginRequired).mockResolvedValueOnce({ id: "cf", name: "cloud", description: "", icon: "cloud" });
    vi.mocked(signInToMachine).mockResolvedValue("CF_Authorization=jwt");
    await connectTo("grove.example.com", "secret12");
    expect(signInToMachine).toHaveBeenCalledWith("http://grove.example.com");
    expect(pairMachine).toHaveBeenLastCalledWith("grove.example.com", "secret12", { Cookie: "CF_Authorization=jwt" });
    expect(document.querySelector<HTMLInputElement>("input.oui-field")!.value).toBe("cloud");
  });

  it("explains the way forward in a browser, where no window can sign in", async () => {
    shell.desktop = false;
    vi.mocked(pairMachine).mockReset();
    vi.mocked(signInToMachine).mockClear();
    vi.mocked(pairMachine).mockRejectedValueOnce(loginRequired);
    await connectTo("grove.example.com", "secret12");
    expect(signInToMachine).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("desktop app");
    expect(document.querySelector("textarea")).not.toBeNull();
    shell.desktop = true;
  });

  it("renews an expired sign-in without asking for the passkey", async () => {
    shell.desktop = true;
    vi.mocked(signInToMachine).mockResolvedValue("CF_Authorization=new");
    await render(overview({ machines: [{ ...devbox, status: "needs_login" }] }));
    await openMenu();
    expect(button(/Dev box/)!.textContent).toContain("Sign in to reconnect");
    await act(async () => { button(/Dev box/)!.click(); });
    expect(signInToMachine).toHaveBeenCalledWith("http://dev:3900");
    expect(refreshMachineSession).toHaveBeenCalledWith("dev", "CF_Authorization=new");
    expect(document.querySelector("form")).toBeNull();
  });

  it("completes an address the way the server does", () => {
    expect(machineAddress(" grove.example.com/ ")).toBe("http://grove.example.com");
    expect(machineAddress("https://grove.example.com")).toBe("https://grove.example.com");
  });

  it("reads request headers line by line", () => {
    expect(parseHeaders("CF-Access-Client-Id: abc\n\nnot a header\nX-Url: a:b")).toEqual({ "CF-Access-Client-Id": "abc", "X-Url": "a:b" });
  });

  it("says why a machine can't be reached", () => {
    expect(machineNote({ ...devbox, status: "offline" })).toBe("Offline");
    expect(machineNote({ ...devbox, url: null })).toBe("Connected from there");
    expect(machineNote(devbox)).toBe("Backend");
  });
});
