import type { GroveMetaEnvelope } from "./groveMeta";

/** A plugin's `contributes.metaTypes` entry: JSON only, never code. */
export interface PluginMetaType {
  type: string;
  display?: "pill" | "card" | "hidden";
  template?: {
    icon?: string;
    title?: string;
    subtitle?: string;
    badge?: { text?: string; tone?: string };
    fields?: { label?: string; value?: string }[];
  };
}

export interface ResolvedPluginMeta {
  display: "pill" | "card" | "hidden";
  pluginName: string;
  icon?: string;
  title: string;
  subtitle?: string;
  badge?: { text: string; tone: "neutral" | "success" | "warning" | "error" | "info" };
  fields: { label: string; value: string }[];
}

const TONES = new Set(["neutral", "success", "warning", "error", "info"]);

/** Templates of active plugins, keyed by the full envelope type. */
let templates = new Map<string, PluginMetaType>();

export function registerPluginMetaTypes(
  plugins: { id: string; status?: string; contributes?: { metaTypes?: PluginMetaType[] } }[],
): void {
  templates = new Map(
    plugins
      .filter((plugin) => plugin.status === undefined || plugin.status === "active")
      .flatMap((plugin) =>
        (plugin.contributes?.metaTypes ?? []).map(
          (meta) => [`plugin:${plugin.id}/${meta.type}`, meta] as const,
        ),
      ),
  );
}

/** Fill `{{key}}` from `data`. React renders the result as text. */
function fill(template: string | undefined, data: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, key: string) => {
    const value = data[key];
    if (value === undefined || value === null || typeof value === "object") return "";
    return String(value);
  });
}

/**
 * Resolve a plugin envelope against its template. Null falls back to the
 * envelope's text: an unknown type, or one whose Grove-stamped source is not
 * the plugin named by its type, never gets that plugin's look.
 */
export function resolvePluginMeta(envelope: GroveMetaEnvelope): ResolvedPluginMeta | null {
  const match = /^plugin:([^/]+)\/(.+)$/.exec(envelope.type);
  if (!match || envelope.source?.plugin_id !== match[1]) return null;
  const meta = templates.get(envelope.type);
  if (!meta) return null;
  const { template = {}, display = "card" } = meta;
  const data = envelope.data;
  const badgeText = fill(template.badge?.text, data);
  const tone = template.badge?.tone ?? "neutral";
  return {
    display,
    pluginName: envelope.source.plugin_name ?? "",
    icon: template.icon,
    title: fill(template.title, data),
    subtitle: fill(template.subtitle, data) || undefined,
    badge: badgeText
      ? { text: badgeText, tone: (TONES.has(tone) ? tone : "neutral") as "neutral" }
      : undefined,
    fields: (template.fields ?? [])
      .map((field) => ({ label: field.label ?? "", value: fill(field.value, data) }))
      .filter((field) => field.value),
  };
}
