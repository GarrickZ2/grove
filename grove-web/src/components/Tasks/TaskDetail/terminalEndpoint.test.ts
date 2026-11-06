import { afterEach, describe, expect, it } from "vitest";
import { setMachineApiBase } from "../../../api/client";
import { taskTerminalKey, terminalEndpoint } from "./terminalEndpoint";

describe("terminalEndpoint", () => {
  afterEach(() => setMachineApiBase(null));

  it("stays on this server at home", () => {
    expect(terminalEndpoint("p", "t")).toBe(`ws://${window.location.host}/api/v1/projects/p/tasks/t/terminal`);
  });

  it("follows the selected machine", () => {
    setMachineApiBase("http://127.0.0.1:4567");
    expect(terminalEndpoint("p", "t")).toBe("ws://127.0.0.1:4567/api/v1/projects/p/tasks/t/terminal");
    expect(terminalEndpoint()).toBe("ws://127.0.0.1:4567/api/v1/terminal");
  });

  it("keeps a task's terminals apart across machines", () => {
    const home = taskTerminalKey("p", "t");
    setMachineApiBase("http://127.0.0.1:4567");
    expect(taskTerminalKey("p", "t")).not.toBe(home);
  });
});
