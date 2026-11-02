import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeAudio } from "../../../../api";
import { defaultAudioSettings } from "../../../../components/AI/useAISettingsData";
import type { AudioSettings } from "../../../../components/AI/types";
import { VoiceInputPage } from "./VoiceInputPage";

const recorder = vi.hoisted(() => ({
  status: "idle",
  elapsed: 0,
  frequencyData: null,
  error: null,
  start: vi.fn(async () => {}),
  stop: vi.fn(async (): Promise<Blob | null> => new Blob(["audio"])),
  cancel: vi.fn(),
}));
const audioState = vi.hoisted(() => ({ settings: null as AudioSettings | null, save: vi.fn() }));

vi.mock("../../../../context", () => ({ useProject: () => ({ selectedProject: { id: "proj", name: "grove" } }) }));
vi.mock("../../../../components/ui", () => ({ Combobox: ({ value }: { value: string }) => <span data-testid="provider">{value}</span> }));
vi.mock("../../../../api", () => ({ transcribeAudio: vi.fn() }));
vi.mock("../../../../hooks/useAudioRecorder", () => ({ useAudioRecorder: () => recorder }));
vi.mock("../../../../hooks/useStreamingTranscription", () => ({
  useStreamingTranscription: () => ({ status: "idle", finalizedSentences: [], currentText: "", frequencyData: null, error: null, start: vi.fn(), stop: vi.fn(), cancel: vi.fn() }),
}));
vi.mock("../../../../components/AI/useAISettingsData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../components/AI/useAISettingsData")>()),
  useProviderProfiles: () => ({ providers: [{ id: "p1", name: "OpenAI", type: "OpenAI", baseUrl: "", apiKey: "", model: "whisper-1", status: "verified" }], loading: false }),
  useAudioSettings: () => ({ settings: audioState.settings, loading: false, save: audioState.save }),
}));

describe("Orbit VoiceInputPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  const render = (settings: AudioSettings) => {
    audioState.settings = settings;
    act(() => root.render(<VoiceInputPage />));
  };
  const mic = () => container.querySelector<HTMLButtonElement>('[aria-label="Hold to talk"]')!;
  // jsdom has no PointerEvent; React only looks at the event type.
  const pointer = (type: string, init: MouseEventInit) => new MouseEvent(type, init);
  const transcript = () => container.querySelector(".ost-v-transcript")!.textContent;

  it("keeps Try it disabled until voice input has a provider", () => {
    render(defaultAudioSettings);
    expect(mic().disabled).toBe(true);
    expect(transcript()).toContain("Turn on voice input");
    render({ ...defaultAudioSettings, enabled: true });
    expect(mic().disabled).toBe(true);
    expect(transcript()).toContain("Choose a speech provider");
  });

  it("records while held and shows the raw and revised transcript from the real endpoint", async () => {
    vi.mocked(transcribeAudio).mockResolvedValue({ raw: "um fix the icon", revised: "Fix the icon.", final: "Fix the icon." });
    render({ ...defaultAudioSettings, enabled: true, reviseEnabled: true, transcribeProvider: "p1" });
    expect(mic().disabled).toBe(false);

    act(() => mic().dispatchEvent(pointer("pointerdown", { bubbles: true })));
    expect(recorder.start).toHaveBeenCalled();
    expect(mic().getAttribute("aria-pressed")).toBe("true");

    await act(async () => mic().dispatchEvent(pointer("pointerup", { bubbles: true })));
    expect(transcribeAudio).toHaveBeenCalledWith(expect.any(Blob), "proj", expect.any(AbortSignal));
    expect(container.querySelector(".ost-v-raw s")?.textContent).toBe("um fix the icon");
    expect(container.querySelector(".ost-v-clean")?.textContent).toBe("Fix the icon.");
  });

  it("explains a recording that was too short", async () => {
    recorder.stop.mockResolvedValueOnce(null);
    render({ ...defaultAudioSettings, enabled: true, transcribeProvider: "p1", minDuration: 3 });
    act(() => mic().dispatchEvent(pointer("pointerdown", { bubbles: true })));
    await act(async () => mic().dispatchEvent(pointer("pointerup", { bubbles: true })));
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(transcript()).toContain("Hold for at least 3 sec");
  });

  it("dims dependent settings while voice input is off and saves the toggle", async () => {
    render(defaultAudioSettings);
    expect(container.querySelector('[aria-label="Revise transcript"]')?.hasAttribute("disabled")).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Voice input"]')!.click());
    expect(audioState.save).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });
});
