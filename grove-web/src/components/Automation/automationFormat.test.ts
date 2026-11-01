import { describe, expect, it } from "vitest";
import { describeAutomationSchedule, describeWindow, scheduleEnded } from "./automationFormat";

const at = (y: number, m: number, d: number, h = 0, min = 0) => Math.floor(new Date(y, m - 1, d, h, min).getTime() / 1000);

describe("automation schedule format", () => {
  it("describes one-time runs without the cron", () => {
    expect(describeAutomationSchedule({ schedule_cron: "", run_once_at: at(2030, 12, 31, 14, 30) })).toMatch(/^Once on .*2030.*14:30$/);
  });

  it("appends the recurring window", () => {
    const window = { starts_at: at(2030, 11, 10), ends_at: at(2030, 12, 31, 23, 59) };
    expect(describeWindow(window)).toMatch(/^from .+, until .+$/);
    expect(describeAutomationSchedule({ schedule_cron: "0 9 * * 5", ...window })).toMatch(/Friday.*, from .+, until .+/);
    expect(describeAutomationSchedule({ schedule_cron: "0 9 * * *" })).toBe("At 09:00");
  });

  it("marks finished bounded schedules as ended", () => {
    expect(scheduleEnded({ enabled: false, run_once_at: at(2020, 1, 1) })).toBe(true);
    expect(scheduleEnded({ enabled: false, ends_at: at(2020, 1, 1) })).toBe(true);
    expect(scheduleEnded({ enabled: true, ends_at: at(2020, 1, 1) })).toBe(false);
    expect(scheduleEnded({ enabled: false })).toBe(false);
  });
});
