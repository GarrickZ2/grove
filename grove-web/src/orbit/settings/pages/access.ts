/** Off / Ask / Allow, as the browser and computer settings store it: an on switch plus "don't ask". */
export type Access = "off" | "ask" | "allow";

export const ACCESS_OPTIONS: { value: Access; label: string; title?: string }[] = [
  { value: "off", label: "Off" },
  { value: "ask", label: "Ask", title: "Each chat session asks you once first" },
  { value: "allow", label: "Allow", title: "No asking" },
];

export function access(allowed: boolean, bypass: boolean): Access {
  return !allowed ? "off" : bypass ? "allow" : "ask";
}
