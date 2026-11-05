export const LARGE_MARKDOWN_PREVIEW_THRESHOLD = 30_000;

export function isVirtualizedMarkdownPreview(fileName: string, content: string): boolean {
  return /\.(md|markdown)$/i.test(fileName) && content.length > LARGE_MARKDOWN_PREVIEW_THRESHOLD;
}

const FILE_INFO_TYPES: Record<string, string[]> = {
  archive: ["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "jar", "war", "iso", "dmg", "pkg", "deb", "rpm", "apk", "ipa", "msi"],
  audio: ["mp3", "wav", "flac", "aac", "ogg", "m4a"],
  video: ["mp4", "mov", "avi", "mkv", "webm"],
  font: ["ttf", "otf", "woff", "woff2", "eot"],
  other: [
    "exe", "dll", "so", "dylib", "class", "pyc", "wasm",
    "db", "sqlite", "sqlite3", "parquet", "pkl", "npy", "npz", "onnx", "pt", "pth", "h5", "safetensors",
    "doc", "docx", "ppt", "pptx", "odt", "ods", "odp", "pages", "numbers", "psd", "ai", "sketch", "fig",
  ],
};

export function fileExtension(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Which kind of known binary a file is; "" for anything else. */
export function fileInfoCategory(path: string): string {
  const extension = fileExtension(path);
  return Object.keys(FILE_INFO_TYPES).find((category) => FILE_INFO_TYPES[category].includes(extension)) ?? "";
}

const BINARY_SNIFF_LENGTH = 8000;

/** Text decoded from a binary file: a NUL, or a run of replacement characters. */
export function looksBinary(content: string): boolean {
  const head = content.slice(0, BINARY_SNIFF_LENGTH);
  if (head.includes("\u0000")) return true;
  const replaced = head.split("�").length - 1;
  return replaced > 0 && replaced / head.length > 0.1;
}
