import { beforeEach, describe, expect, it } from "vitest";
import { swapMachineView } from "./machineView";
import { NAVIGATION_KEY } from "./navigationState";

describe("swapMachineView", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("brings each machine back to where it was left", () => {
    sessionStorage.setItem(NAVIGATION_KEY, "home-page");
    localStorage.setItem("grove-selected-project", "home-project");

    swapMachineView("home", "dev");
    expect(sessionStorage.getItem(NAVIGATION_KEY)).toBeNull();
    expect(localStorage.getItem("grove-selected-project")).toBeNull();

    sessionStorage.setItem(NAVIGATION_KEY, "dev-page");
    localStorage.setItem("grove-selected-project", "dev-project");
    localStorage.setItem("grove-buddy-selected", "atlas");

    swapMachineView("dev", "home");
    expect(sessionStorage.getItem(NAVIGATION_KEY)).toBe("home-page");
    expect(localStorage.getItem("grove-selected-project")).toBe("home-project");
    expect(localStorage.getItem("grove-buddy-selected")).toBeNull();

    swapMachineView("home", "dev");
    expect(sessionStorage.getItem(NAVIGATION_KEY)).toBe("dev-page");
    expect(localStorage.getItem("grove-buddy-selected")).toBe("atlas");
  });

  it("leaves unrelated preferences shared", () => {
    localStorage.setItem("grove:sidebar.mode", "collapsed");
    swapMachineView("home", "dev");
    expect(localStorage.getItem("grove:sidebar.mode")).toBe("collapsed");
  });
});
