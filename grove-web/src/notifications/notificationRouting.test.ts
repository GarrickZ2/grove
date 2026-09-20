import { describe, expect, it } from "vitest";
import {
  clientOwnsNotifications,
  hasInjectedRemoteBackend,
  isLikelyRemoteBrowser,
} from "./notificationRouting";

describe("client notification routing", () => {
  it("lets the local backend own notifications", () => {
    expect(
      clientOwnsNotifications({
        version: "test",
        notification_owner: "backend",
        renders_os_notifications: true,
      }),
    ).toBe(false);
  });

  it("lets a remote/headless backend delegate to the client", () => {
    expect(
      clientOwnsNotifications({
        version: "test",
        notification_owner: "client",
        renders_os_notifications: false,
      }),
    ).toBe(true);
  });

  it("supports older servers through the capability fallback", () => {
    expect(
      clientOwnsNotifications({
        version: "test",
        renders_os_notifications: false,
      }),
    ).toBe(true);
    expect(
      clientOwnsNotifications({
        version: "test",
        renders_os_notifications: true,
      }),
    ).toBe(false);
  });

  it("detects a browser proxy created with --remote-url", () => {
    expect(
      hasInjectedRemoteBackend({
        __GROVE_API_BASE__: "https://remote.example.com",
      }),
    ).toBe(true);
    expect(hasInjectedRemoteBackend({})).toBe(false);
  });

  it("distinguishes direct remote browsers from loopback", () => {
    expect(isLikelyRemoteBrowser("10.0.0.8", {})).toBe(true);
    expect(isLikelyRemoteBrowser("grove.example.com", {})).toBe(true);
    expect(isLikelyRemoteBrowser("localhost", {})).toBe(false);
    expect(isLikelyRemoteBrowser("127.0.0.1", {})).toBe(false);
    expect(isLikelyRemoteBrowser("::1", {})).toBe(false);
    expect(
      isLikelyRemoteBrowser("localhost", {
        __GROVE_API_BASE__: "https://remote.example.com",
      }),
    ).toBe(true);
  });
});
