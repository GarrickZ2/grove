/**
 * What a paste into a chat composer carries: its files and its plain text.
 *
 * Copying content that mixes text and images (a web page, a doc, a chat
 * message) puts both on the clipboard, and both are kept. A Finder/Explorer
 * file copy also carries the file names as text; that text is dropped so only
 * the files are attached.
 */
export interface PastedContent {
  files: File[];
  text: string;
}

export function readPastedContent(data: DataTransfer): PastedContent {
  let files = Array.from(data.files);
  // Some screenshot payloads expose only a DataTransferItem, not `files`.
  if (files.length === 0) {
    files = Array.from(data.items).flatMap((item) => {
      const file = item.kind === "file" ? item.getAsFile() : null;
      return file ? [file] : [];
    });
  }
  const text = data.getData("text/plain");
  return { files, text: files.length > 0 && namesOnly(text, files) ? "" : text };
}

/** True when every line of `text` is the name (or a path ending in the name) of a pasted file. */
function namesOnly(text: string, files: File[]): boolean {
  const names = new Set(files.map((file) => file.name));
  return text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .every((line) => names.has(line.split(/[\\/]/).pop() ?? line));
}
