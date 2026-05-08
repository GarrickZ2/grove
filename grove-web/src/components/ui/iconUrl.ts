/**
 * Shared file-icon URL resolver.
 *
 * Lives separately from `VSCodeIcon.tsx` so React Fast Refresh can keep
 * working — that rule rejects modules that export both components and
 * utilities. Both the component and raw-DOM call sites import this.
 *
 * Resolution chain:
 *   1. whole filename → material `fileNames`           (Dockerfile, …)
 *   2. extension → material `fileExtensions`            (most languages)
 *   3. extension → linguist language → material         (NEW: TypeScript,
 *      `languageIds`                                       HTML, YAML, PHP, …)
 *   4. default file icon
 *
 * Step 3 bridges the gap material left for callers running outside VS Code:
 * inside VS Code the editor resolves filename→language at runtime, so the
 * icon theme only declares `languageIds.<name>: <icon>`. We don't have that
 * runtime, so we use GitHub Linguist's published extension table as the
 * bridge — same data shape VS Code's built-in language extensions use, just
 * way more comprehensive (804 languages, 1448 extension entries vs ~200 in
 * material's own `fileExtensions`).
 */

import { generateManifest } from "material-icon-theme";
import materialIconThemePkg from "material-icon-theme/package.json";
import * as linguist from "linguist-languages";

// ── material manifest ─────────────────────────────────────────────────

const MANIFEST = generateManifest();
const VERSION = materialIconThemePkg.version;
const CDN_BASE = `https://cdn.jsdelivr.net/npm/material-icon-theme@${VERSION}/icons`;

const DEFAULT_FILE = MANIFEST.file ?? "file";
const DEFAULT_FOLDER = MANIFEST.folder ?? "folder";
const DEFAULT_FOLDER_OPEN = MANIFEST.folderExpanded ?? "folder-open";
const ICON_DEFS = MANIFEST.iconDefinitions ?? {};

interface ManifestSlice {
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
  languageIds?: Record<string, string>;
}

const DARK = MANIFEST as ManifestSlice;
const LIGHT = (MANIFEST.light ?? {}) as ManifestSlice;

// ── manual extension overrides ────────────────────────────────────────

/**
 * Manual overrides for extensions material's `fileExtensions` resolves to a
 * choice we disagree with for grove's audience. These are checked BEFORE
 * `fileExtensions`, so they win over both material's editorial choices and
 * the linguist bridge.
 *
 * Map keys are the extension WITHOUT the leading dot, lowercase. Map values
 * are an icon definition key in `MANIFEST.iconDefinitions`.
 */
const EXTENSION_OVERRIDE: Record<string, string> = {
  // Material maps `.pl → prolog`. For modern web/dev audience Perl is much
  // more commonly the intent; pin to perl.
  pl: "perl",
};

/**
 * Folder name overrides. Material's `folderNames` (4618 entries) misses some
 * very common modern web framework dirs (Redux/Vuex/Pinia state management,
 * GraphQL queries/mutations/subscriptions, REST/RPC/gRPC API layers, etc.).
 * Material does ship the relevant folder icons themselves — we just point
 * the missing folder names at the closest semantic match.
 *
 * Keys are folder name (lowercase). Values are the icon definition key
 * for the CLOSED folder; the OPEN variant is resolved by suffixing
 * `-open`.
 */
const FOLDER_OVERRIDE: Record<string, string> = {
  // State management — all map to material's generic store icon
  redux: "folder-store",
  vuex: "folder-store",
  pinia: "folder-store",
  state: "folder-store",
  reducer: "folder-store",
  reducers: "folder-store",

  // Material has only the singular `folder-controller` mapping
  controllers: "folder-controller",

  // GraphQL operations
  queries: "folder-graphql",
  mutations: "folder-graphql",
  subscriptions: "folder-graphql",

  // API protocol implementation layers
  rest: "folder-api",
  rpc: "folder-api",
  grpc: "folder-api",

  // Misc — closest semantic borrows
  dashboard: "folder-admin",
  storage: "folder-database",
  dto: "folder-typescript",
  sockets: "folder-event",
};

// ── linguist ext → language (with disambiguation) ─────────────────────

/**
 * When a file extension is claimed by multiple linguist languages we have to
 * pick one — pick the option closer to the modern web/dev audience grove
 * targets. Each entry is `<ext> → <linguist language name>`. Comments record
 * which alternatives we passed on.
 *
 * Anything not listed here uses linguist's first-emitted language (alphabetical
 * by language name due to module export order); when a single sensible pick
 * exists this still works fine for niche extensions.
 */
const EXT_DISAMBIGUATION: Record<string, string> = {
  // C-family — header convention
  h: "C", // also C++, Objective-C
  hh: "C++", // also Hack
  cp: "C++", // also Component Pascal

  // Objective-C wins over MATLAB/Mercury/Wolfram — iOS/Mac dev far more common
  m: "Objective-C",
  mm: "Objective-C++", // also XML

  // Perl wins over Prolog/Raku — Perl still has the largest existing footprint
  pl: "Perl",
  pm: "Perl", // also Raku, X PixMap
  t: "Perl", // also Raku, Terra, Turing

  // .NET / functional naming with special chars (post-normalize lookups)
  cs: "C#", // also Smalltalk
  fs: "F#", // also Filterscript, Forth, GLSL
  cake: "C#", // also CoffeeScript

  // OCaml wins over Standard ML
  ml: "OCaml",

  // Elixir wins over Euphoria
  ex: "Elixir",

  // JavaScript wins over Erlang on .es (modern usage = ES module variant)
  es: "JavaScript",

  // GLSL shader extensions
  frag: "GLSL", // also JavaScript
  vert: "GLSL",

  // PHP for .inc — most common in PHP ecosystems
  inc: "PHP",

  // .php — linguist's Hack wins alphabetically; pin to PHP since Hack is
  // a Facebook-internal niche and PHP dominates this extension.
  php: "PHP",

  // HTML wins over Ecmarkup (which is a niche W3C spec dialect)
  html: "HTML",

  // JSON wins over OAS variants
  json: "JSON",

  // Common Lisp wins over Cool/OpenCL on .cl — modern dev rarely uses Cool
  cl: "Common Lisp",

  // Single-letter extensions: pick popular language
  d: "D", // also DTrace, Makefile
  f: "Fortran", // also Filebench WML, Forth
  for: "Fortran",
  s: "Assembly", // also Motorola 68K Assembly, Unix Assembly
  n: "Nemerle", // also Roff
  l: "Lex", // material has no Lex icon — falls through to default

  // Misc
  ms: "MAXScript", // also Roff, Unix Assembly
  al: "Perl", // .al as Perl module (material has no AL icon anyway)
  ks: "KerboScript", // also Kickstart
  fx: "HLSL", // also FLUX (no material icon for FLUX)

  // YAML loses to MiniYAML alphabetically in linguist's iteration order;
  // pin it explicitly. Material has a YAML icon, none for MiniYAML.
  yml: "YAML",
  yaml: "YAML",
};

/**
 * Linguist language names that don't lower-case neatly to a material
 * languageId. Keys are normalized linguist names (lowercase, spaces→dashes);
 * values are the material languageId. Found these by diffing material's 200
 * languageIds against linguist's normalized names.
 */
const LANG_NAME_ALIAS: Record<string, string> = {
  "c#": "csharp",
  "c++": "cpp",
  "objective-c++": "objective-cpp",
  "f#": "fsharp",
};

/**
 * Build a single ext → linguist-language-name map at module load.
 * Disambiguation entries take priority over linguist's iteration order so
 * `.m` deterministically resolves to Objective-C regardless of how
 * linguist-languages happens to enumerate.
 */
const EXT_TO_LINGUIST: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  // linguist exports each language as a named ESM export.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const [name, info] of Object.entries(linguist as any)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exts: string[] = (info as any)?.extensions ?? [];
    for (const e of exts) {
      const k = e.startsWith(".") ? e.slice(1).toLowerCase() : e.toLowerCase();
      // Disambiguation always wins, regardless of iteration order.
      if (EXT_DISAMBIGUATION[k]) {
        out[k] = EXT_DISAMBIGUATION[k];
        continue;
      }
      // First-write-wins for non-ambiguous extensions.
      if (out[k] === undefined) out[k] = name;
    }
  }
  // Final pass: ensure disambiguation overrides any first-write-wins miss.
  for (const [k, v] of Object.entries(EXT_DISAMBIGUATION)) {
    out[k] = v;
  }
  return out;
})();

function linguistNameToMaterialLanguageId(linguistName: string): string {
  const norm = linguistName.toLowerCase().replace(/\s+/g, "-");
  return LANG_NAME_ALIAS[norm] ?? norm;
}

// ── matcher ──────────────────────────────────────────────────────────

function pickKey(
  filename: string,
  isFolder: boolean,
  isOpen: boolean,
  light: boolean,
): string {
  const lower = filename.toLowerCase();

  if (isFolder) {
    if (FOLDER_OVERRIDE[lower]) {
      return isOpen ? `${FOLDER_OVERRIDE[lower]}-open` : FOLDER_OVERRIDE[lower];
    }
    const namesD = isOpen ? DARK.folderNamesExpanded : DARK.folderNames;
    const namesL = isOpen ? LIGHT.folderNamesExpanded : LIGHT.folderNames;
    const hit = (light && namesL?.[lower]) || namesD?.[lower];
    if (hit) return hit;
    return isOpen ? DEFAULT_FOLDER_OPEN : DEFAULT_FOLDER;
  }

  // 1. Whole-filename match (Dockerfile, package.json, …).
  const fileNameHit =
    (light && LIGHT.fileNames?.[lower]) || DARK.fileNames?.[lower];
  if (fileNameHit) return fileNameHit;

  // 2. Walk extensions from longest suffix down — handles ".test.ts" → "ts".
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");

    // 2a. Manual override.
    if (EXTENSION_OVERRIDE[ext]) return EXTENSION_OVERRIDE[ext];

    // 2b. Direct fileExtensions hit.
    const direct =
      (light && LIGHT.fileExtensions?.[ext]) || DARK.fileExtensions?.[ext];
    if (direct) return direct;

    // 2c. Linguist bridge: ext → linguist name → material languageId.
    const linguistName = EXT_TO_LINGUIST[ext];
    if (linguistName) {
      const langId = linguistNameToMaterialLanguageId(linguistName);
      const langHit =
        (light && LIGHT.languageIds?.[langId]) || DARK.languageIds?.[langId];
      if (langHit) return langHit;
    }
  }

  return DEFAULT_FILE;
}

function urlForKey(key: string): string {
  const def = ICON_DEFS[key];
  if (def?.iconPath) {
    // iconPath is "./../icons/<name>.svg" — strip everything up to basename.
    const basename = def.iconPath.replace(/^.*\//, "");
    return `${CDN_BASE}/${basename}`;
  }
  // EXTENSION_OVERRIDE entries that aren't in iconDefinitions are treated
  // as literal SVG basenames (without the .svg).
  return `${CDN_BASE}/${key}.svg`;
}

/**
 * Resolve the SVG URL for a file (or folder). Used by both the React
 * `<VSCodeIcon>` component and raw-DOM consumers (e.g. mention chips
 * built inside contenteditable nodes).
 */
export function iconUrlForFile(
  filename: string,
  opts: { isFolder?: boolean; isOpen?: boolean; light?: boolean } = {},
): string {
  const key = pickKey(
    filename,
    opts.isFolder ?? false,
    opts.isOpen ?? false,
    opts.light ?? false,
  );
  return urlForKey(key);
}
