// Renders terminal output (with ANSI SGR escape codes) as safe HTML so the
// original colors and emphasis are preserved in chat-history <pre> blocks.
//
// Uses ansi_up with the default (use_classes=false) so output is self-contained
// inline-style HTML — no external CSS needed. escape_html defaults to true,
// which means `<` / `>` / `&` in the input are escaped, so the result is safe
// to assign to dangerouslySetInnerHTML.
import { AnsiUp } from "ansi_up";

const ansi = new AnsiUp();

// Covers the full set of escape forms that real terminals emit:
//   ESC [ ... <final>         CSI: SGR colors, cursor, modes
//   ESC ] ... BEL | ESC \     OSC: window title, hyperlinks
//   ESC P / X / ^ / _ ... \   DCS / SOS / PM / APC
//   ESC <other>               two-byte Fe escape (RIS, etc.)
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_].*?\x1b\\|\x1b\[[0-?]*[ -/]*[@-~]|\x1b./g;

/** Strip ANSI sequences from a string, leaving plain text.
 *  Use when you need the raw text — e.g. to derive a chip label that fits
 *  a fixed width without ANSI byte counts breaking truncation. */
export function stripAnsi(input: string | null | undefined): string {
  if (!input) return "";
  return input.replace(ANSI_PATTERN, "");
}

export function ansiToHtml(input: string | null | undefined): string {
  if (!input) return "";
  return ansi.ansi_to_html(input);
}
