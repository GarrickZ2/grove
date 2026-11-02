import { pttKeyLabel } from "../../../../components/AI/utils";
import { keycapParts } from "../../../ui/keycaps";

/** Keycaps for a push-to-talk key: lone modifiers read "Left Cmd", other keys use the shared keycaps. */
export function pttKeycaps(key: string): string[] {
  if (key === " ") return ["Space"];
  const label = pttKeyLabel(key);
  return label !== key ? [label] : keycapParts(key);
}
