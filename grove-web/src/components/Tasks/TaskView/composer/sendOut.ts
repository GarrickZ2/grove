import "../conversation/sent-pop.css";

/**
 * Visual only: as an Orbit send clears the composer, a copy of what was typed
 * fades and slides up out of the input, so it reads as the message leaving
 * the box while its bubble pops into the transcript. The real editor is
 * cleared at once as before; the copy is inert and removes itself.
 */
export function playComposerSendOut(editor: HTMLElement | null): void {
  if (!editor || !editor.parentElement || !editor.textContent?.trim() || reducedMotion()) return;
  const ghost = editor.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  ghost.setAttribute("contenteditable", "false");
  placeGhost(editor, ghost);
  ghost.scrollTop = editor.scrollTop;
}

/**
 * The same for a textarea composer (Buddy), whose text stays until the send
 * resolves: the copy leaves while the textarea's own text is hidden. Returns
 * a restore for when the send fails and the draft is kept.
 */
export function playTextareaSendOut(textarea: HTMLTextAreaElement | null): () => void {
  if (!textarea || !textarea.parentElement || !textarea.value.trim() || reducedMotion()) return () => {};
  const style = window.getComputedStyle(textarea);
  const ghost = document.createElement("div");
  for (const property of ["font", "letterSpacing", "lineHeight", "padding", "color", "textAlign", "boxSizing", "borderRadius"] as const) {
    ghost.style[property] = style[property];
  }
  ghost.style.whiteSpace = "pre-wrap";
  ghost.style.overflowWrap = "anywhere";
  ghost.style.border = "0";
  ghost.textContent = textarea.value;
  placeGhost(textarea, ghost);
  ghost.scrollTop = textarea.scrollTop;
  textarea.classList.add("oc-send-out-source");
  return () => textarea.classList.remove("oc-send-out-source");
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function placeGhost(source: HTMLElement, ghost: HTMLElement) {
  ghost.setAttribute("aria-hidden", "true");
  ghost.tabIndex = -1;
  ghost.classList.add("oc-send-out");
  // Same offset parent as the source, so it lands exactly over it.
  ghost.style.position = "absolute";
  ghost.style.left = `${source.offsetLeft}px`;
  ghost.style.top = `${source.offsetTop}px`;
  ghost.style.width = `${source.offsetWidth}px`;
  ghost.style.height = `${source.offsetHeight}px`;
  source.after(ghost);
  const remove = () => ghost.remove();
  ghost.addEventListener("animationend", remove, { once: true });
  // Never leave a copy behind (hidden tab, cancelled animation).
  window.setTimeout(remove, 400);
}
