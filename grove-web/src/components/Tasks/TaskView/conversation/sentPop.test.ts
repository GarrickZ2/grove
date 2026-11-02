import { describe, expect, it } from "vitest";
import { QUEUED_POP_WINDOW_MS, SENT_POP_WINDOW_MS, createSentPopRegistry } from "./sentPop";

describe("sent bubble registry", () => {
  it("lets a just-sent message pop once; history and unknown ids never pop", () => {
    let now = 10_000;
    const registry = createSentPopRegistry(() => now);
    registry.record("fresh");
    expect(registry.claim("fresh")).toBe(true);
    expect(registry.claim("fresh")).toBe(false);
    expect(registry.claim("history")).toBe(false);
    registry.record("late");
    now += SENT_POP_WINDOW_MS + 1;
    expect(registry.claim("late")).toBe(false);
  });

  it("hands the pop to a replacement element when the first went away unseen", () => {
    const registry = createSentPopRegistry(() => 0);
    registry.record("a");
    expect(registry.claim("a")).toBe(true);
    registry.release("a");
    expect(registry.claim("a")).toBe(true);
    registry.done("a");
    registry.release("a");
    expect(registry.claim("a")).toBe(false);
  });

  it("keeps queued messages eligible until the queue dispatches them", () => {
    let now = 0;
    const registry = createSentPopRegistry(() => now);
    registry.record("q", { queued: true });
    now = QUEUED_POP_WINDOW_MS - 1;
    expect(registry.claim("q")).toBe(true);
  });
});
