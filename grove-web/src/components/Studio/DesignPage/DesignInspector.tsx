import { useState, type DragEvent, type ReactNode } from "react";
import {
  AlignCenter, AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignLeft, AlignRight, AlignStartHorizontal,
  AlignStartVertical, ArrowDown, ArrowRight, ChevronDown, ChevronRight, Columns3, Copy, Frame, Image, LayoutGrid, Link2, Palette,
  RectangleHorizontal, Rows3, Send, Shapes, TextCursorInput, Trash2, Type, X,
} from "lucide-react";
import type { Design, DesignComment } from "../../../api/designs";
import { relativeText } from "../../../orbit/ui";
import { Avatar } from "./DesignThread";
import type { DesignVariable, PickedElement, TreeNode } from "./DesignFrame";
import { length, px, toHex } from "./designEdit";
import { usePageHtml } from "./useDesignData";

export interface Picked {
  file: string;
  element: PickedElement;
}

interface Props {
  projectId: string;
  taskId: string;
  design: Design;
  /** Each page's layer tree, by file. */
  trees: Record<string, TreeNode[]>;
  /** Each page's CSS variables, by file. */
  variables: Record<string, DesignVariable[]>;
  /** Set a variable; `page` is the page it was listed for. */
  onTweak: (page: string, variable: DesignVariable, value: string) => void;
  /** The artboard the user last chose. */
  selected: string | null;
  picked: Picked | null;
  /** The agent is working on the files; nothing can be changed. */
  readOnly: boolean;
  onSelectPage: (file: string) => void;
  onSelectNode: (file: string, path: string) => void;
  onStyle: (props: Record<string, string>) => void;
  onText: (value: string) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onMove: (file: string, path: string, target: string, place: "before" | "after" | "inside") => void;
  /** The task's design comments; the ones open on this design are listed. */
  comments: DesignComment[];
  /** The chat's agent, when a chat is open to send comments to. */
  agent: string | null;
  canSend: boolean;
  onSendComments: (comments: DesignComment[]) => void;
  onOpenThread: (comment: DesignComment, at: { x: number; y: number }) => void;
  onClose: () => void;
}

/** A design's open comments; with `onSend`, the way to hand them all to the agent. */
export function DesignCommentList({ design, comments, agent, canSend, onSend, onOpen }: {
  design: Design;
  comments: DesignComment[];
  agent?: string | null;
  canSend?: boolean;
  onSend?: (comments: DesignComment[]) => void;
  onOpen: (comment: DesignComment, at: { x: number; y: number }) => void;
}) {
  if (comments.length === 0) return <div className="design-comments"><div className="design-comments-none">No open comments</div></div>;
  return (
    <div className="design-comments">
      <div className="design-comments-list">
        {comments.map((comment) => (
          <button
            key={comment.id}
            type="button"
            className="design-comment-row"
            onClick={(event) => {
              const box = event.currentTarget.getBoundingClientRect();
              onOpen(comment, { x: box.left - 342, y: box.top + 12 });
            }}
          >
            <Avatar name={comment.author} />
            <span className="design-comment-text">
              <span className="design-comment-meta">
                <b>{comment.author}</b>
                <span>{design.pages.find((page) => page.file === comment.page)?.title ?? comment.page}</span>
                <span>{relativeText(comment.timestamp)}</span>
              </span>
              <span className="design-comment-body">{comment.content}</span>
              {comment.replies.length ? <span className="design-comment-replies">{comment.replies.length} {comment.replies.length === 1 ? "reply" : "replies"}</span> : null}
            </span>
          </button>
        ))}
      </div>
      {onSend ? (
        <div className="design-comments-foot">
          <button
            type="button"
            className="design-btn is-primary"
            disabled={!canSend}
            title={canSend ? undefined : "Open the task's chat to send comments to its agent"}
            onClick={() => onSend(comments)}
          >
            <Send size={13} />
            Send {comments.length} to {agent || "the agent"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

const KIND_ICON: Record<string, typeof Type> = {
  Text: Type, Button: RectangleHorizontal, Link: Link2, Image, Icon: Shapes, Input: TextCursorInput, Row: Columns3, Column: Rows3, Grid: LayoutGrid,
};

/**
 * Beside the board: the layers of every page, and the properties of the
 * element chosen. A change here is made in the page at once and written into
 * its HTML file.
 */
export function DesignInspector({
  projectId, taskId, design, trees, variables, onTweak, selected, picked, readOnly,
  onSelectPage, onSelectNode, onStyle, onText, onDuplicate, onRemove, onMove, comments, agent, canSend, onSendComments, onOpenThread, onClose,
}: Props) {
  const [tab, setTab] = useState<"properties" | "code" | "tweaks" | "comments">("properties");
  const openComments = comments.filter((comment) => comment.design === design.slug && comment.status === "open");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [drop, setDrop] = useState<{ key: string; place: "before" | "after" | "inside" } | null>(null);
  const [dragging, setDragging] = useState<{ file: string; path: string } | null>(null);

  const isOpen = (key: string, holdsSelection: boolean) => open[key] ?? holdsSelection;
  const toggle = (key: string, now: boolean) => setOpen((previous) => ({ ...previous, [key]: !now }));

  const codePage = design.pages.find((page) => page.file === (picked?.file ?? selected)) ?? design.pages[0];

  const row = (file: string, node: TreeNode, depth: number): ReactNode => {
    const key = `${file}:${node.path}`;
    const chosen = picked?.file === file && picked.element.xpath === node.path;
    const holds = picked?.file === file && Boolean(picked.element.xpath?.startsWith(`${node.path}/`));
    const expanded = node.children.length > 0 && isOpen(key, holds);
    const Icon = KIND_ICON[node.kind] ?? Rows3;
    const canDrop = dragging?.file === file && dragging.path !== node.path && !node.path.startsWith(`${dragging.path}/`);
    return (
      <div key={key}>
        <div
          className={`design-layer${chosen ? " is-chosen" : ""}${drop?.key === key ? ` is-drop-${drop.place}` : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable={!readOnly}
          onClick={() => onSelectNode(file, node.path)}
          onDragStart={(event: DragEvent) => {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", node.path);
            setDragging({ file, path: node.path });
          }}
          onDragEnd={() => {
            setDragging(null);
            setDrop(null);
          }}
          onDragOver={(event: DragEvent) => {
            if (!canDrop) return;
            event.preventDefault();
            const box = event.currentTarget.getBoundingClientRect();
            const part = (event.clientY - box.top) / box.height;
            // The middle of a container's row puts the layer inside it.
            const holds = node.kind === "Row" || node.kind === "Column" || node.kind === "Grid";
            const place = holds && part > 0.3 && part < 0.7 ? "inside" : part < 0.5 ? "before" : "after";
            if (drop?.key !== key || drop.place !== place) setDrop({ key, place });
          }}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            if (canDrop && dragging && drop?.key === key) onMove(file, dragging.path, node.path, drop.place);
            setDragging(null);
            setDrop(null);
          }}
        >
          {node.children.length > 0 ? (
            <button
              type="button"
              className="design-layer-twist"
              onClick={(event) => {
                event.stopPropagation();
                toggle(key, expanded);
              }}
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          ) : <span className="design-layer-twist" />}
          <Icon size={12} className="design-layer-icon" />
          <span className="design-layer-kind">{node.kind}</span>
          <span className="design-layer-name">{node.name}</span>
        </div>
        {expanded ? node.children.map((child) => row(file, child, depth + 1)) : null}
      </div>
    );
  };

  return (
    <aside className="design-inspector" onPointerDown={(event) => event.stopPropagation()}>
      <div className="design-inspector-tabs">
        <button type="button" className={`design-tab${tab === "properties" ? " is-active" : ""}`} onClick={() => setTab("properties")}>Properties</button>
        <button type="button" className={`design-tab${tab === "code" ? " is-active" : ""}`} onClick={() => setTab("code")}>Code</button>
        <button type="button" className={`design-tab${tab === "tweaks" ? " is-active" : ""}`} onClick={() => setTab("tweaks")}>Tweaks</button>
        <button type="button" className={`design-tab${tab === "comments" ? " is-active" : ""}`} onClick={() => setTab("comments")}>
          Comments
        </button>
        <span className="design-play-gap" />
        <button type="button" className="design-icon-btn" onClick={onClose} title="Hide" aria-label="Hide the inspector"><X size={14} /></button>
      </div>
      {tab === "comments" ? (
        <DesignCommentList
          design={design}
          comments={openComments}
          agent={agent}
          canSend={canSend}
          onSend={onSendComments}
          onOpen={(comment, at) => {
            onSelectPage(comment.page);
            onOpenThread(comment, at);
          }}
        />
      ) : tab === "code" ? (
        codePage ? <CodeView projectId={projectId} taskId={taskId} design={design.slug} file={codePage.file} version={codePage.version} /> : null
      ) : tab === "tweaks" ? (
        codePage ? (
          <Tweaks
            title={codePage.title}
            variables={variables[codePage.file] ?? []}
            readOnly={readOnly}
            onTweak={(variable, value) => onTweak(codePage.file, variable, value)}
          />
        ) : null
      ) : (
        <>
          <div className="design-layers">
            {design.pages.map((page) => {
              const expanded = isOpen(page.file, picked?.file === page.file || selected === page.file);
              return (
                <div key={page.file}>
                  <div className={`design-layer is-page${selected === page.file ? " is-chosen" : ""}`} style={{ paddingLeft: 8 }} onClick={() => onSelectPage(page.file)}>
                    <button
                      type="button"
                      className="design-layer-twist"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(page.file, expanded);
                      }}
                      aria-label={expanded ? "Collapse" : "Expand"}
                    >
                      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <Frame size={12} className="design-layer-icon" />
                    <span className="design-layer-name">{page.title}</span>
                  </div>
                  {expanded ? (trees[page.file] ?? []).map((node) => row(page.file, node, 1)) : null}
                </div>
              );
            })}
          </div>
          <div className="design-props">
            {picked ? (
              <Properties
                key={`${picked.file}:${picked.element.xpath}`}
                element={picked.element}
                tokens={(variables[picked.file] ?? []).filter((variable) => variable.kind === "color")}
                readOnly={readOnly}
                onStyle={onStyle}
                onText={onText}
                onDuplicate={onDuplicate}
                onRemove={onRemove}
              />
            ) : (
              <div className="design-props-empty">
                <strong>Nothing selected</strong>
                <span>Click any element in the design to edit it here.</span>
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function CodeView({ projectId, taskId, design, file, version }: { projectId: string; taskId: string; design: string; file: string; version: string }) {
  const loaded = usePageHtml(projectId, taskId, design, file, version);
  return (
    <div className="design-code">
      <div className="design-code-file">design/{design}/{file}</div>
      <pre>{loaded?.html ?? ""}</pre>
    </div>
  );
}

/** The CSS variables a page is tuned by, grouped by the stylesheet that defines them. */
function Tweaks({ title, variables, readOnly, onTweak }: { title: string; variables: DesignVariable[]; readOnly: boolean; onTweak: (variable: DesignVariable, value: string) => void }) {
  if (variables.length === 0) {
    return (
      <div className="design-props-empty">
        <strong>No tweaks on {title}</strong>
        <span>Colors, sizes and spacing the page keeps in CSS variables appear here. Ask the agent to move the values worth tuning into variables.</span>
      </div>
    );
  }
  const files = [...new Set(variables.map((variable) => variable.file))];
  return (
    <fieldset className="design-props design-props-body" disabled={readOnly}>
      {readOnly ? <div className="design-props-note">The agent is working on these files. Editing comes back when it stops.</div> : null}
      {files.map((file) => (
        <Section key={file} title={file || `${title} (this page only)`}>
          {variables.filter((variable) => variable.file === file).map((variable) => (
            <div key={variable.name} className="design-tweak">
              <span className="design-tweak-name" title={variable.name}>{variable.name.replace(/^--/, "")}</span>
              {variable.kind === "color"
                ? <ColorField value={variable.resolved} onCommit={(value) => onTweak(variable, value)} />
                : <Field value={variable.value} onCommit={(value) => onTweak(variable, value.trim())} />}
            </div>
          ))}
        </Section>
      ))}
    </fieldset>
  );
}

interface PropertiesProps {
  element: PickedElement;
  /** The page's color variables, offered beside every color. */
  tokens: DesignVariable[];
  readOnly: boolean;
  onStyle: (props: Record<string, string>) => void;
  onText: (value: string) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}

const WEIGHTS = ["300", "400", "500", "600", "700", "800"];

const AUTO = "auto";

/** Where an element sits in its parent, as the CSS that puts it there. */
function alignment(style: Record<string, string>, axis: "across" | "down", to: "start" | "center" | "end"): Record<string, string> | null {
  const parentFlex = style.parentDisplay.includes("flex");
  const parentRow = parentFlex && style.parentDirection.startsWith("row");
  const self = { "align-self": to === "start" ? "flex-start" : to === "end" ? "flex-end" : "center" };
  const margins = (before: string, after: string) => ({ [before]: to === "start" ? "" : AUTO, [after]: to === "end" ? "" : AUTO });
  if (axis === "across") {
    if (parentFlex && !parentRow) return self;
    return margins("margin-left", "margin-right");
  }
  if (parentRow) return self;
  if (parentFlex) return margins("margin-top", "margin-bottom");
  return null;
}

function Properties({ element, tokens, readOnly, onStyle, onText, onDuplicate, onRemove }: PropertiesProps) {
  const style = element.styles;
  const flex = style.display.includes("flex");
  const inFlex = style.parentDisplay.includes("flex");
  const align = (axis: "across" | "down", to: "start" | "center" | "end") => {
    const props = alignment(style, axis, to);
    if (props) onStyle(props);
  };
  const hasText = Boolean(element.text);
  const sizing = (inline: string) => (inline === "100%" ? "fill" : inline ? "fixed" : "hug");

  const sizeRow = (label: string, prop: "width" | "height", measured: number, inline: string) => (
    <Row label={label}>
      <Field value={inline && inline !== "100%" ? px(inline) : String(measured)} unit={inline.endsWith("%") ? "" : "px"} disabled={readOnly} onCommit={(value) => onStyle({ [prop]: length(value) })} />
      <select
        className="design-field is-select"
        value={sizing(inline)}
        disabled={readOnly}
        onChange={(event) => onStyle({ [prop]: event.target.value === "hug" ? "" : event.target.value === "fill" ? "100%" : `${measured}px` })}
      >
        <option value="hug">Hug</option>
        <option value="fixed">Fixed</option>
        <option value="fill">Fill</option>
      </select>
    </Row>
  );

  return (
    <fieldset className="design-props-body" disabled={readOnly}>
      <div className="design-props-head">
        <span className="design-layer-kind">{element.kind}</span>
        <span className="design-props-selector" title={element.selector}>{element.selector?.split(" > ").pop()}</span>
        <span className="design-play-gap" />
        <button type="button" className="design-icon-btn" onClick={onDuplicate} title="Duplicate" aria-label="Duplicate"><Copy size={13} /></button>
        <button type="button" className="design-icon-btn" onClick={onRemove} title="Delete" aria-label="Delete"><Trash2 size={13} /></button>
      </div>
      {readOnly ? <div className="design-props-note">The agent is working on these files. Editing comes back when it stops.</div> : null}

      <div className="design-align" role="group" aria-label="Align in its container">
        <button type="button" onClick={() => align("across", "start")} title="Align left" aria-label="Align left"><AlignStartVertical size={14} /></button>
        <button type="button" onClick={() => align("across", "center")} title="Center across" aria-label="Center across"><AlignCenterVertical size={14} /></button>
        <button type="button" onClick={() => align("across", "end")} title="Align right" aria-label="Align right"><AlignEndVertical size={14} /></button>
        <button type="button" disabled={!inFlex} onClick={() => align("down", "start")} title="Align top" aria-label="Align top"><AlignStartHorizontal size={14} /></button>
        <button type="button" disabled={!inFlex} onClick={() => align("down", "center")} title="Center down" aria-label="Center down"><AlignCenterHorizontal size={14} /></button>
        <button type="button" disabled={!inFlex} onClick={() => align("down", "end")} title="Align bottom" aria-label="Align bottom"><AlignEndHorizontal size={14} /></button>
      </div>

      {element.textOnly ? (
        <Section title="Content">
          <textarea
            className="design-field is-area"
            defaultValue={element.text ?? ""}
            rows={2}
            onBlur={(event) => {
              if (event.target.value !== (element.text ?? "")) onText(event.target.value);
            }}
          />
        </Section>
      ) : null}

      <Section title="Size">
        {sizeRow("Width", "width", element.width, style.inlineWidth)}
        {sizeRow("Height", "height", element.height, style.inlineHeight)}
        <Row label="Position">
          <select className="design-field is-select is-wide" value={style.position} onChange={(event) => onStyle({ position: event.target.value === "static" ? "" : event.target.value })}>
            {["static", "relative", "absolute", "fixed", "sticky"].map((value) => <option key={value} value={value}>{value === "static" ? "In flow" : value[0].toUpperCase() + value.slice(1)}</option>)}
          </select>
        </Row>
        {inFlex ? (
          <Row label="Grow">
            <Field value={style.flexGrow} onCommit={(value) => onStyle({ "flex-grow": value.trim() })} />
          </Row>
        ) : null}
      </Section>

      <Section title="Layout">
        {flex ? (
          <>
            <Row label="Direction">
              <Choice
                value={style.flexDirection.startsWith("column") ? "column" : "row"}
                options={[["row", <ArrowRight key="r" size={13} />, "Row"], ["column", <ArrowDown key="c" size={13} />, "Column"]]}
                onChange={(value) => onStyle({ "flex-direction": value })}
              />
            </Row>
            <Row label="Align">
              <Choice
                value={style.alignItems}
                options={[["flex-start", "Start", "Start"], ["center", "Center", "Center"], ["flex-end", "End", "End"], ["stretch", "Fill", "Stretch"]]}
                onChange={(value) => onStyle({ "align-items": value })}
              />
            </Row>
            <Row label="Justify">
              <select className="design-field is-select is-wide" value={style.justifyContent} onChange={(event) => onStyle({ "justify-content": event.target.value })}>
                {["normal", "flex-start", "center", "flex-end", "space-between", "space-around"].map((value) => <option key={value} value={value}>{value.replace("flex-", "")}</option>)}
              </select>
            </Row>
            <Row label="Gap">
              <Field value={px(style.gap === "normal" ? "0px" : style.gap)} unit="px" onCommit={(value) => onStyle({ gap: length(value) })} />
            </Row>
          </>
        ) : null}
        <Row label="Padding">
          <div className="design-field-grid">
            {(["Top", "Right", "Bottom", "Left"] as const).map((side) => (
              <Field key={side} value={px(style[`padding${side}`])} hint={side[0]} onCommit={(value) => onStyle({ [`padding-${side.toLowerCase()}`]: length(value) })} />
            ))}
          </div>
        </Row>
      </Section>

      {hasText ? (
        <Section title="Text">
          <Row label="Size">
            <Field value={px(style.fontSize)} unit="px" onCommit={(value) => onStyle({ "font-size": length(value) })} />
            <select className="design-field is-select" value={style.fontWeight} onChange={(event) => onStyle({ "font-weight": event.target.value })}>
              {(WEIGHTS.includes(style.fontWeight) ? WEIGHTS : [style.fontWeight, ...WEIGHTS]).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </Row>
          <Row label="Color">
            <ColorField value={style.color} tokens={tokens} onCommit={(value) => onStyle({ color: value })} />
          </Row>
          <Row label="Align">
            <Choice
              value={style.textAlign === "start" ? "left" : style.textAlign}
              options={[["left", <AlignLeft key="l" size={13} />, "Left"], ["center", <AlignCenter key="c" size={13} />, "Center"], ["right", <AlignRight key="r" size={13} />, "Right"]]}
              onChange={(value) => onStyle({ "text-align": value })}
            />
          </Row>
        </Section>
      ) : null}

      <Section title="Appearance">
        <Row label="Fill">
          <ColorField value={style.backgroundColor} tokens={tokens} onCommit={(value) => onStyle({ "background-color": value })} />
        </Row>
        <Row label="Border">
          <Field
            value={style.borderStyle === "none" ? "0" : px(style.borderWidth)}
            unit="px"
            onCommit={(value) => onStyle({ "border-width": length(value), "border-style": Number.parseFloat(value) > 0 ? (style.borderStyle === "none" ? "solid" : style.borderStyle) : "none" })}
          />
        </Row>
        {style.borderStyle !== "none" ? (
          <Row label="Stroke">
            <ColorField value={style.borderColor} tokens={tokens} onCommit={(value) => onStyle({ "border-color": value })} />
          </Row>
        ) : null}
        <Row label="Opacity">
          <Field value={style.opacity} onCommit={(value) => onStyle({ opacity: value.trim() })} />
        </Row>
        <Row label="Radius">
          <Field value={px(style.borderRadius)} unit="px" onCommit={(value) => onStyle({ "border-radius": length(value) })} />
        </Row>
      </Section>
    </fieldset>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="design-props-section">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="design-props-row">
      <span className="design-props-label">{label}</span>
      <div className="design-props-value">{children}</div>
    </div>
  );
}

/** A value typed over; it is applied on Enter or when the field is left. */
function Field({ value, unit, hint, disabled, onCommit }: { value: string; unit?: string; hint?: string; disabled?: boolean; onCommit: (value: string) => void }) {
  return (
    <label className="design-field">
      {hint ? <span className="design-field-hint">{hint}</span> : null}
      <input
        key={value}
        defaultValue={value}
        disabled={disabled}
        spellCheck={false}
        onBlur={(event) => {
          if (event.target.value.trim() !== value) onCommit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {unit ? <span className="design-field-unit">{unit}</span> : null}
    </label>
  );
}

function ColorField({ value, tokens = [], onCommit }: { value: string; tokens?: DesignVariable[]; onCommit: (value: string) => void }) {
  const hex = toHex(value);
  const [open, setOpen] = useState(false);
  return (
    <div className="design-color">
    <label className="design-field is-color">
      <input type="color" value={hex ?? "#ffffff"} onChange={(event) => onCommit(event.target.value)} aria-label="Pick a color" />
      <input
        key={value}
        defaultValue={hex ?? (value === "rgba(0, 0, 0, 0)" ? "none" : value)}
        spellCheck={false}
        onBlur={(event) => {
          const typed = event.target.value.trim();
          if (typed && typed !== (hex ?? value)) onCommit(typed === "none" ? "transparent" : typed);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {tokens.length > 0 ? (
        <button type="button" className={`design-field-tokens${open ? " is-on" : ""}`} onClick={() => setOpen(!open)} title="Colors of the design system" aria-label="Colors of the design system">
          <Palette size={12} />
        </button>
      ) : null}
    </label>
    {open ? (
      <div className="design-swatches">
        {tokens.slice(0, 40).map((token) => (
          <button
            key={token.name}
            type="button"
            style={{ background: token.resolved }}
            title={`${token.name.replace(/^--/, "")} · ${token.resolved}`}
            aria-label={token.name}
            onClick={() => onCommit(`var(${token.name})`)}
          />
        ))}
      </div>
    ) : null}
    </div>
  );
}

function Choice({ value, options, onChange }: { value: string; options: Array<[string, ReactNode, string]>; onChange: (value: string) => void }) {
  return (
    <div className="design-choice" role="radiogroup">
      {options.map(([option, label, title]) => (
        <button key={option} type="button" role="radio" aria-checked={value === option} className={value === option ? "is-on" : ""} title={title} onClick={() => onChange(option)}>
          {label}
        </button>
      ))}
    </div>
  );
}
