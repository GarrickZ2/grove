import { AudioLines, Cpu, Mic, Volume2, type LucideIcon } from "lucide-react";
import type { TabId } from "./types";

export const tabs: { id: TabId; label: string; icon: LucideIcon; subtitle: string }[] = [
  { id: "audio", label: "Audio", icon: AudioLines, subtitle: "Transcription, revision, and vocabulary shaping" },
  { id: "voice_control", label: "Voice Control", icon: Mic, subtitle: "Speech-to-action execution via AI tool calls" },
  { id: "agent_voice", label: "Agent Voice", icon: Volume2, subtitle: "Speaking profiles for short agent touchpoints" },
  { id: "providers", label: "Providers", icon: Cpu, subtitle: "Global AI provider profiles and model defaults" },
];

export const providerPresets = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "together", label: "Together", baseUrl: "https://api.together.xyz/v1" },
  { id: "fireworks", label: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1" },
  { id: "elevenlabs", label: "ElevenLabs", baseUrl: "https://api.elevenlabs.io" },
  { id: "custom", label: "Custom Base URL", baseUrl: "" },
] as const;
