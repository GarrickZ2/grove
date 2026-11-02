import { describe, expect, it } from "vitest";
import { configWithVoiceSnapshot, profileSignature, voiceMeta, voiceSnapshot } from "./useSpeakingProfileEditor";
import type { SpeakingProviderSchema } from "./types";

const schema: SpeakingProviderSchema = {
  providerType: "ElevenLabs",
  fields: [{ key: "stability", label: "Stability", type: "range", defaultValue: 0.5 }],
};

describe("speaking profile helpers", () => {
  it("snapshots a chosen voice into the config and drops stale details", () => {
    const config = configWithVoiceSnapshot({ voiceAccent: "old" }, "voiceId", { voiceId: "v1", name: "Ada", language: "en" });
    expect(config).toEqual({ voiceId: "v1", voiceName: "Ada", voiceLanguage: "en" });
    expect(voiceSnapshot(config, "v1", "Profile")).toMatchObject({ voiceId: "v1", name: "Ada", language: "en" });
    expect(voiceSnapshot({}, "v1", "New Speaking Profile")?.name).toBe("Selected voice");
    expect(voiceSnapshot({}, "", "Profile")).toBeNull();
  });

  it("treats schema defaults and key order as unchanged", () => {
    const base = { name: " Calm ", providerId: "p1", maxCharacters: 280, maxDurationSeconds: 30 };
    expect(profileSignature({ ...base, config: { b: 1, a: 2 } }, schema))
      .toBe(profileSignature({ ...base, name: "Calm", config: { a: 2, b: 1, stability: 0.5 } }, schema));
  });

  it("formats voice metadata", () => {
    expect(voiceMeta({ voiceId: "v", name: "V", language: "en", useCase: "narrative_story" })).toEqual(["en", "narrative story"]);
  });
});
