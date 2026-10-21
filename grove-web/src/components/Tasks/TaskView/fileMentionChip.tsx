import { createRoot } from "react-dom/client";
import { getProjectStyle } from "../../../utils/projectStyle";
import { iconUrlForFile } from "../../ui/iconUrl";

/** Create a non-editable file chip DOM element */
export function createFileChip(
  filePath: string,
  isDir = false,
  displayLabel?: string,
  category?: string,
  favIconUrl?: string,
  projectId?: string,
  accentPalette?: string[],
): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.file = filePath;
  if (displayLabel) chip.dataset.label = displayLabel;
  if (category) chip.dataset.category = category;
  chip.title = filePath;
  // Pill-style chip: neutral background + highlight text, matching the
  // FileChip used in MarkdownRenderer for visual consistency.
  chip.style.cssText =
    "display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:9999px;" +
    "background:color-mix(in srgb,var(--color-bg-secondary) 80%,var(--color-bg));" +
    "border:1px solid color-mix(in srgb,var(--color-border) 65%,transparent);" +
    "font-size:12px;font-weight:500;color:var(--color-highlight);" +
    "margin:0 2px;user-select:none;vertical-align:baseline;line-height:1.5;";

  const isLink = filePath.toLowerCase().endsWith(".link.json");
  const baseName = filePath.split("/").filter(Boolean).pop() || "";

  if (category === "Project Root" && projectId) {
    chip.dataset.projectId = projectId;
    const projectStyle = getProjectStyle(projectId, accentPalette);
    const ProjectIcon = projectStyle.Icon;
    const iconHost = document.createElement("span");
    iconHost.style.cssText =
      `display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center;` +
      `border-radius:4px;flex-shrink:0;background:${projectStyle.color.bg};color:${projectStyle.color.fg};`;
    chip.appendChild(iconHost);
    createRoot(iconHost).render(<ProjectIcon width={11} height={11} />);
  } else if (category === "Task") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "13");
    svg.setAttribute("height", "13");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText = "display:inline-block;vertical-align:middle;flex-shrink:0;";
    svg.innerHTML = '<rect x="3" y="5" width="6" height="6" rx="1"/><path d="m3 17 2 2 4-4M13 6h8M13 10h8M13 16h8M13 20h8"/>';
    chip.appendChild(svg);
  } else if (category === "Sketch") {
    // Render Lucide Palette icon in SVG for visual consistency and premium look!
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "13");
    svg.setAttribute("height", "13");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2.5");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.style.cssText = "display:inline-block;vertical-align:middle;flex-shrink:0;";
    svg.innerHTML = '<path d="M12 22C17.5228 22 22 17.5228 22 12C22 9.27457 20.8967 6.80675 19.1022 5.01218C18.2562 4.16622 17.2163 3.48624 16.068 3.0182C15.0084 2.58616 13.8341 2.30232 12.593 2.08311C12.2023 2.0141 11.817 2.29631 11.7981 2.6923C11.7644 3.39864 11.4589 4.09345 10.9255 4.62689C10.2224 5.33002 9.21556 5.65655 8.24357 5.51268C7.8485 5.4542 7.47271 5.71961 7.4287 6.11902C7.30403 7.25055 6.85223 8.35825 6.09633 9.22213C5.5564 9.83918 4.8213 10.222 4.02058 10.3168C3.62648 10.3635 3.32356 10.6868 3.32043 11.0857C3.3106 12.3332 3.52458 13.5676 3.9482 14.716C4.4172 15.9877 5.16335 17.1472 6.13682 18.1207C8.7562 20.74 12 22 12 22Z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="11.5" cy="7.5" r="1"/><circle cx="16.5" cy="9.5" r="1"/><circle cx="15.5" cy="14.5" r="1"/>';
    chip.appendChild(svg);
  } else {
    // Material file icon via shared resolver (same matcher as <VSCodeIcon>).
    // `.link.json` is grove's worktree-link sentinel; render it as a plain JSON
    // so the chip reads as "linked file" rather than the generic JSON-anything.
    const iconUrl = isLink
      ? iconUrlForFile("link.json")
      : iconUrlForFile(baseName, { isFolder: isDir });

    const img = document.createElement("img");
    img.src = favIconUrl || iconUrl;
    img.alt = "";
    img.width = 13;
    img.height = 13;
    img.style.cssText =
      "display:inline-block;vertical-align:middle;flex-shrink:0;";
    if (favIconUrl) {
      img.style.borderRadius = "2px";
      img.style.objectFit = "contain";
      img.onerror = () => {
        img.src = iconUrl;
        img.onerror = () => {
          img.style.display = "none";
        };
        img.style.borderRadius = "0";
      };
    } else {
      // Hide the broken-image glyph if the CDN is blocked / offline.
      // The chip's text label is still meaningful without the icon.
      img.onerror = () => {
        img.style.display = "none";
      };
    }
    chip.appendChild(img);
  }

  const label = document.createElement("span");
  const text = displayLabel || (isDir ? filePath : filePath.split("/").pop() || filePath);
  const MAX_CHIP_TITLE = 40;
  label.textContent = text.length > MAX_CHIP_TITLE ? `${text.slice(0, MAX_CHIP_TITLE).trimEnd()}…` : text;
  label.style.cssText = "max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  chip.appendChild(label);

  const closeBtn = document.createElement("span");
  closeBtn.dataset.chipClose = "true";
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cssText =
    "margin-left:2px;cursor:pointer;opacity:0.6;font-size:13px;line-height:1;color:var(--color-highlight);";
  chip.appendChild(closeBtn);

  return chip;
}
