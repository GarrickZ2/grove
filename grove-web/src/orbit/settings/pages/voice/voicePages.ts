import { AudioLines, Cpu, Mic, Volume2, type LucideIcon } from "lucide-react";

export type VoicePageId = "voice" | "vcontrol" | "avoice" | "providers";

export interface VoicePageMeta {
  title: string;
  description: string;
  icon: LucideIcon;
  /** Scroll anchors rendered by the page (`anchorId` on its Groups). */
  subs: { id: string; label: string }[];
  keywords: string[];
}

/** Nav / search registration for the "Voice & AI" group of Orbit Settings. */
export const VOICE_PAGE_META: Record<VoicePageId, VoicePageMeta> = {
  voice: {
    title: "Voice input",
    description: "Talk instead of type. Grove turns speech into clean prompt text.",
    icon: AudioLines,
    subs: [
      { id: "try", label: "Try it" },
      { id: "recognition", label: "Recognition" },
      { id: "revision", label: "Revision" },
      { id: "vocabulary", label: "Vocabulary" },
      { id: "shortcuts", label: "Shortcuts" },
      { id: "guardrails", label: "Guardrails" },
    ],
    keywords: ["audio", "transcription", "speech to text", "dictation", "microphone", "push to talk", "revise", "languages", "preferred terms", "forbidden terms", "replacements"],
  },
  vcontrol: {
    title: "Voice control",
    description: "Drive Grove with spoken commands.",
    icon: Mic,
    subs: [
      { id: "pipeline", label: "Pipeline" },
      { id: "shortcuts", label: "Shortcuts" },
      { id: "limits", label: "Listening limits" },
      { id: "actions", label: "Actions" },
    ],
    keywords: ["speech", "commands", "push to talk", "allowed actions", "language model", "listening"],
  },
  avoice: {
    title: "Agent voice",
    description: "How agents sound when they speak updates aloud.",
    icon: Volume2,
    subs: [
      { id: "profiles", label: "Speaking profiles" },
      { id: "voice", label: "Voice and model" },
      // Only rendered when the provider exposes tuning controls.
      { id: "character", label: "Voice character" },
      { id: "limits", label: "Spoken limits" },
    ],
    keywords: ["speaking profiles", "tts", "text to speech", "elevenlabs", "voices", "preview", "sessions"],
  },
  providers: {
    title: "AI providers",
    description: "Model and speech providers shared across Grove.",
    icon: Cpu,
    subs: [],
    keywords: ["openai", "openrouter", "groq", "together", "fireworks", "elevenlabs", "models", "api key", "base url", "llm", "connection"],
  },
};
