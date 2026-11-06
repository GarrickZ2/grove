import { afterEach, describe, expect, it } from "vitest";
import { appendHmacToUrl, machineUrl, setMachineApiBase } from "./client";

describe("machineUrl", () => {
  afterEach(() => setMachineApiBase(null));

  it("leaves paths alone at home", async () => {
    expect(machineUrl("/api/v1/x")).toBe("/api/v1/x");
    expect(await appendHmacToUrl("/api/v1/x")).toBe("/api/v1/x");
  });

  it("points paths at the selected machine, and only paths", async () => {
    setMachineApiBase("http://localhost:4567");
    expect(machineUrl("/api/v1/x")).toBe("http://localhost:4567/api/v1/x");
    expect(machineUrl("ws://elsewhere/api")).toBe("ws://elsewhere/api");
    expect(await appendHmacToUrl("/api/v1/x")).toBe("http://localhost:4567/api/v1/x");
  });

  it("keeps a machine's path in the WebSocket host", async () => {
    const { getApiHost, setMachineApiBase } = await import("./client");
    setMachineApiBase("http://grove.test/api/v1/machines/dev/via");
    expect(getApiHost()).toBe("grove.test/api/v1/machines/dev/via");
    setMachineApiBase("http://localhost:4100");
    expect(getApiHost()).toBe("localhost:4100");
    setMachineApiBase(null);
  });

  it("signs the path the request really goes to", async () => {
    const { getSignedHeaders, setDeviceSession, setMachineApiBase } = await import("./client");
    const { hmacSha256Hex } = await import("./hmac");
    setDeviceSession("a".repeat(64), "b".repeat(64));
    setMachineApiBase("http://grove.test/api/v1/machines/dev/via");
    const headers = await getSignedHeaders("GET", "/api/v1/projects");
    setMachineApiBase(null);
    const message = `${headers["X-Timestamp"]}|${headers["X-Nonce"]}|GET|/api/v1/machines/dev/via/api/v1/projects`;
    expect(headers["X-Signature"]).toBe(await hmacSha256Hex("b".repeat(64), message));
  });
});
