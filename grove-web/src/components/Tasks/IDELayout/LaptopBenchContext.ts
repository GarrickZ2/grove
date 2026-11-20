import { createContext } from "react";
import type { OrbitPhoneAction } from "./OrbitPhonePanels";

/**
 * iPhone Duo laptop fold, no panel open: the lower screen's workbench. The
 * layout owns the place (and the task's git actions); the chat fills it with
 * what it knows — the todo, the agent, its subagents.
 */
export interface LaptopBench {
  slot: HTMLElement;
  projectId: string;
  taskId: string;
  branch: string;
  actions: OrbitPhoneAction[];
}

export const LaptopBenchContext = createContext<LaptopBench | null>(null);
