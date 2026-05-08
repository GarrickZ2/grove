/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useMemo, type ReactNode } from 'react';
import { MarkdownRenderer, MermaidBlock, D2Block } from '../ui/MarkdownRenderer';
import { PreviewCommentHost } from './PreviewCommentHost';
import { highlightCode as highlightLocal, detectLanguage as detectLanguageLocal } from './syntaxHighlight';
import type { DiffFile } from '../../api/review';

function withCommentHost(
  node: ReactNode,
  previewComment: RenderFullProps['previewComment'] | undefined,
): ReactNode {
  if (!previewComment) return node;
  return <PreviewCommentHost previewComment={previewComment}>{node}</PreviewCommentHost>;
}

// ============================================================================
// Preview Renderer Registry
// ============================================================================

export interface PreviewCommentMarker {
  id: string;
  label: string;
  selector?: string;
  xpath?: string;
  extraBlocks?: Array<{ selector: string; xpath: string }>;
}

export interface RenderFullProps {
  content: string;
  fileName?: string;
  onImageClick?: (url: string) => void;
  onSvgClick?: (svg: string) => void;
  previewComment?: {
    enabled: boolean;
    previewId: string;
    markers?: PreviewCommentMarker[];
  };
}

export interface PreviewRenderer {
  /** Unique identifier */
  id: string;
  /** Human-readable label for tooltip */
  label: string;
  /** Test whether this renderer handles the given file path */
  match: (path: string) => boolean;
  /**
   * 'url'  — content passed to renderFull is a download URL (images, PDFs, etc.)
   * 'text' — content passed to renderFull is the fetched file text
   */
  contentType: 'url' | 'text';
  /**
   * Render full-file preview content.
   * `content` is either a URL or file text depending on `contentType`.
   * Optional `onImageClick` / `onSvgClick` callbacks enable lightbox support.
   */
  renderFull: (props: RenderFullProps) => React.ReactNode;
  /**
   * Whether this renderer supports diff-mode segment preview.
   * If false, the preview drawer will use `renderFull` with reconstructed content.
   */
  supportsDiffSegments: boolean;
  /**
   * Whether the preview supports element-level comments. Defaults to true.
   * Cross-origin iframes (e.g. the browser PDF viewer) can't be introspected
   * so they opt out explicitly.
   */
  supportsComments?: boolean;
}

// ============================================================================
// Built-in Renderers
// ============================================================================

const markdownRenderer: PreviewRenderer = {
  id: 'markdown',
  label: 'Preview markdown',
  match: (path) => /\.(md|markdown)$/i.test(path),
  contentType: 'text',
  renderFull: ({ content, onImageClick, onSvgClick, previewComment }) => withCommentHost(
    <MarkdownRenderer content={content} onImageClick={onImageClick} onMermaidClick={onSvgClick} onD2Click={onSvgClick} enableHeadingIds />,
    previewComment,
  ),
  supportsDiffSegments: true,
};

const mermaidRenderer: PreviewRenderer = {
  id: 'mermaid',
  label: 'Preview diagram',
  match: (path) => /\.(mmd|mermaid)$/i.test(path),
  contentType: 'text',
  renderFull: ({ content, onSvgClick, previewComment }) => withCommentHost(
    <MermaidBlock code={content} onPreviewClick={onSvgClick} />,
    previewComment,
  ),
  supportsDiffSegments: false,
};

const svgRenderer: PreviewRenderer = {
  id: 'svg',
  label: 'Preview SVG',
  match: (path) => /\.svg$/i.test(path),
  contentType: 'text',
  renderFull: ({ content, onSvgClick, previewComment }) => withCommentHost(
    <div
      className={`flex items-center justify-center p-4 [&_svg]:max-w-full [&_svg]:max-h-[70vh]${onSvgClick ? " cursor-pointer hover:opacity-80 transition-opacity" : ""}`}
      dangerouslySetInnerHTML={{ __html: content }}
      onClick={onSvgClick ? () => {
        const responsive = content
          .replace(/\s*width="[^"]*"/, ' width="100%"')
          .replace(/\s*height="[^"]*"/, ' height="100%"')
          .replace(/(<svg[^>]*?)(?=\s*>)/, '$1 style="max-width:90vw;max-height:85vh;width:auto;height:auto;" preserveAspectRatio="xMidYMid meet"');
        onSvgClick(responsive);
      } : undefined}
    />,
    previewComment,
  ),
  supportsDiffSegments: false,
};

const imageRenderer: PreviewRenderer = {
  id: 'image',
  label: 'Preview image',
  match: (path) => /\.(png|jpe?g|webp|gif|bmp|ico)$/i.test(path),
  contentType: 'url',
  renderFull: ({ content, onImageClick, previewComment }) => withCommentHost(
    <div
      className={`flex items-center justify-center h-full p-6${onImageClick ? " cursor-pointer" : ""}`}
      style={{ background: "var(--color-bg-secondary)" }}
      onClick={onImageClick ? () => onImageClick(content) : undefined}
    >
      <img
        src={content}
        alt=""
        className={`max-w-full max-h-[70vh] object-contain rounded-lg shadow-md${onImageClick ? " hover:opacity-80 transition-opacity" : ""}`}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
          (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
        }}
      />
      <div className="hidden text-sm" style={{ color: "var(--color-text-muted)" }}>Failed to load image</div>
    </div>,
    previewComment,
  ),
  supportsDiffSegments: false,
};

// ============================================================================
// CSV Renderer
// ============================================================================

function parseCSV(text: string): string[][] {
  return text.split('\n').filter(line => line.trim()).map(line => {
    const cells: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = !inQuote; }
      } else if (ch === ',' && !inQuote) {
        cells.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    return cells;
  });
}

function CsvTable({ content }: { content: string }) {
  const rows = parseCSV(content);
  if (rows.length === 0) return <p className="p-5 text-sm" style={{ color: "var(--color-text-muted)" }}>Empty file</p>;
  const [header, ...body] = rows;
  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-xs border-collapse" style={{ borderColor: "var(--color-border)" }}>
        <thead style={{ background: "var(--color-bg-secondary)", position: "sticky", top: 0 }}>
          <tr>
            {header.map((cell, i) => (
              <th key={i} className="px-3 py-2 text-left font-semibold whitespace-nowrap"
                style={{ border: "1px solid var(--color-border)", color: "var(--color-text)" }}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, ri) => (
            <tr key={ri} style={{ background: ri % 2 === 0 ? "transparent" : "color-mix(in srgb, var(--color-bg-secondary) 50%, transparent)" }}>
              {row.map((cell, ci) => (
                <td key={ci} className="px-3 py-1.5 whitespace-nowrap max-w-[240px] overflow-hidden text-ellipsis"
                  style={{ border: "1px solid var(--color-border)", color: "var(--color-text)" }}
                  title={cell}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const htmlRenderer: PreviewRenderer = {
  id: 'html',
  label: 'Preview HTML',
  match: (path) => /\.(html?|htm)$/i.test(path),
  contentType: 'text',
  renderFull: ({ content, previewComment }) => (
    <HtmlPreviewFrame content={content} previewComment={previewComment} />
  ),
  supportsDiffSegments: false,
};

const csvRenderer: PreviewRenderer = {
  id: 'csv',
  label: 'Preview CSV',
  match: (path) => /\.csv$/i.test(path),
  contentType: 'text',
  renderFull: ({ content, previewComment }) => withCommentHost(
    <CsvTable content={content} />,
    previewComment,
  ),
  supportsDiffSegments: false,
};

// ============================================================================
// PDF Renderer
// ============================================================================

const pdfRenderer: PreviewRenderer = {
  id: 'pdf',
  label: 'Preview PDF',
  match: (path) => /\.pdf$/i.test(path),
  contentType: 'url',
  renderFull: ({ content }) => (
    <iframe
      src={content}
      className="w-full h-full border-0"
      title="PDF preview"
    />
  ),
  supportsDiffSegments: false,
  supportsComments: false,
};

// ============================================================================
// JSX / TSX Renderer — Live preview via sandboxed iframe + Babel standalone
// ============================================================================

function autoWrapJsx(code: string): string {
  if (/createRoot|ReactDOM\.render/.test(code)) {
    return code.replace(/export\s+default\s+/g, '').replace(/\nexport\s+(?!default)/g, '\n');
  }

  const clean = code
    .replace(/export\s+default\s+/g, '')
    .replace(/\nexport\s+(?!default)/g, '\n');

  const patterns: RegExp[] = [
    /function\s+([A-Z]\w*)\s*[<(]/,
    /const\s+([A-Z]\w*)\s*=\s*(?:\(\)|\([^)]*\))\s*=>/,
    /const\s+([A-Z]\w*)\s*=\s*function/,
    /class\s+([A-Z]\w*)\s+extends\s+\w*Component/,
  ];

  for (const pat of patterns) {
    const m = clean.match(pat);
    if (m) {
      return `${clean}\n\nReactDOM.createRoot(document.getElementById('root')).render(<${m[1]} />);`;
    }
  }

  return `${clean}\ntry { ReactDOM.createRoot(document.getElementById('root')).render(<App />); } catch(e) { document.getElementById('jsx-error').textContent = 'Could not detect component. Ensure it starts with a capital letter (e.g. function App).\\n\\n' + e.message; document.getElementById('jsx-error').style.display = 'block'; }`;
}

function resolveThemeHighlight(): string {
  if (typeof window === 'undefined') return '#f59e0b';
  const v = getComputedStyle(document.documentElement).getPropertyValue('--color-highlight').trim();
  return v || '#f59e0b';
}

function postPreviewCommentTheme(
  frame: HTMLIFrameElement | null,
  previewId: string | undefined,
) {
  if (!frame?.contentWindow || !previewId) return;
  frame.contentWindow.postMessage({
    type: 'grove-preview-comment:theme',
    previewId,
    highlight: resolveThemeHighlight(),
  }, '*');
}

function postPreviewCommentMode(
  frame: HTMLIFrameElement | null,
  previewId: string | undefined,
  enabled: boolean | undefined,
) {
  if (!frame?.contentWindow || !previewId) return;
  frame.contentWindow.postMessage({
    type: enabled ? 'grove-preview-comment:start' : 'grove-preview-comment:stop',
    previewId,
  }, '*');
}

function postPreviewCommentMarkers(
  frame: HTMLIFrameElement | null,
  previewId: string | undefined,
  markers: PreviewCommentMarker[] | undefined,
) {
  if (!frame?.contentWindow || !previewId) return;
  frame.contentWindow.postMessage({
    type: 'grove-preview-comment:markers',
    previewId,
    markers: markers ?? [],
  }, '*');
}

function syncPreviewCommentState(
  frame: HTMLIFrameElement | null,
  previewComment?: RenderFullProps["previewComment"],
) {
  if (!previewComment) return;
  postPreviewCommentTheme(frame, previewComment.previewId);
  postPreviewCommentMode(frame, previewComment.previewId, previewComment.enabled);
  postPreviewCommentMarkers(frame, previewComment.previewId, previewComment.markers);
}

function HtmlPreviewFrame({
  content,
  previewComment,
}: {
  content: string;
  previewComment?: RenderFullProps["previewComment"];
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // srcDoc only depends on content + stable previewId — never on `enabled` or
  // markers. Toggling comment mode / editing markers must not remount iframe.
  const srcDoc = previewComment
    ? buildHtmlPreviewSrcdoc(content, previewComment.previewId)
    : content;

  useEffect(() => {
    postPreviewCommentTheme(frameRef.current, previewComment?.previewId);
    postPreviewCommentMode(frameRef.current, previewComment?.previewId, previewComment?.enabled);
  }, [previewComment?.enabled, previewComment?.previewId]);

  useEffect(() => {
    postPreviewCommentMarkers(frameRef.current, previewComment?.previewId, previewComment?.markers);
  }, [previewComment?.markers, previewComment?.previewId]);

  return (
    <iframe
      ref={frameRef}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      className="w-full h-full border-0 min-h-[200px]"
      title="HTML Preview"
      onLoad={() => syncPreviewCommentState(frameRef.current, previewComment)}
    />
  );
}

function JsxPreviewFrame({
  content,
  previewComment,
}: {
  content: string;
  previewComment?: RenderFullProps["previewComment"];
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const srcDoc = buildJsxIframeSrcdoc(content, previewComment?.previewId);

  useEffect(() => {
    postPreviewCommentTheme(frameRef.current, previewComment?.previewId);
    postPreviewCommentMode(frameRef.current, previewComment?.previewId, previewComment?.enabled);
  }, [previewComment?.enabled, previewComment?.previewId]);

  useEffect(() => {
    postPreviewCommentMarkers(frameRef.current, previewComment?.previewId, previewComment?.markers);
  }, [previewComment?.markers, previewComment?.previewId]);

  return (
    <iframe
      ref={frameRef}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      className="w-full h-full border-0 min-h-[200px]"
      title="JSX Preview"
      onLoad={() => syncPreviewCommentState(frameRef.current, previewComment)}
    />
  );
}

function buildPreviewCommentBridge(previewId: string): string {
  const idJson = JSON.stringify(previewId);
  return [
    '<script>',
    '(function(){',
    'var previewId=' + idJson + ';',
    'var enabled=false;',
    'var overlay=null;',
    'var markerLayer=null;',
    'var markerList=[];',
    'var themeColor="#f59e0b";',
    'function hexToRgb(h){h=String(h||"").trim();if(h.charAt(0)==="#")h=h.slice(1);if(h.length===3)h=h.split("").map(function(c){return c+c;}).join("");if(!/^[0-9a-fA-F]{6}$/.test(h))return null;return{r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16)};}',
    'function withAlpha(c,a){var rgb=hexToRgb(c);if(rgb)return "rgba("+rgb.r+","+rgb.g+","+rgb.b+","+a+")";return c;}',
    'function cssEscape(v){return (window.CSS&&CSS.escape)?CSS.escape(v):String(v).replace(/[^a-zA-Z0-9_-]/g,function(ch){return "\\0000"+ch.charCodeAt(0).toString(16)+" ";});}',
    'function hideOverlay(){if(overlay)overlay.style.display="none";}',
    'function ensureMarkerLayer(){if(markerLayer)return markerLayer;markerLayer=document.createElement("div");markerLayer.setAttribute("data-grove-preview-comment-overlay","true");markerLayer.style.cssText="position:fixed;inset:0;pointer-events:none;z-index:2147483646;";document.documentElement.appendChild(markerLayer);return markerLayer;}',
    'function resolveMarkerEl(m){try{if(m.selector){var a=document.querySelector(m.selector);if(a)return a;}}catch(e){}try{if(m.xpath){var r=document.evaluate(m.xpath,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null);if(r&&r.singleNodeValue&&r.singleNodeValue.nodeType===1)return r.singleNodeValue;}}catch(e){}return null;}',
    'function resolveMarkerEls(m){var head=resolveMarkerEl(m);if(!head)return [];var out=[head];var extras=Array.isArray(m.extraBlocks)?m.extraBlocks:[];for(var i=0;i<extras.length;i++){var eb=extras[i];var el=null;try{if(eb.selector){el=document.querySelector(eb.selector);}}catch(e){}if(!el){try{if(eb.xpath){var r=document.evaluate(eb.xpath,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null);if(r&&r.singleNodeValue&&r.singleNodeValue.nodeType===1)el=r.singleNodeValue;}}catch(e){}}if(el)out.push(el);}return out;}',
    'function renderMarkers(){var layer=ensureMarkerLayer();layer.innerHTML="";markerList.forEach(function(m){var els=resolveMarkerEls(m);if(els.length===0)return;var rects=[];for(var i=0;i<els.length;i++){var rr=els[i].getBoundingClientRect();if(rr.width>0&&rr.height>0)rects.push(rr);}if(rects.length===0)return;var u=unionRect(rects);if(!u)return;var box=document.createElement("div");box.style.cssText="position:absolute;left:"+u.left+"px;top:"+u.top+"px;width:"+Math.max(0,u.width)+"px;height:"+Math.max(0,u.height)+"px;border:1.5px dashed "+withAlpha(themeColor,.85)+";background:"+withAlpha(themeColor,.08)+";box-shadow:0 0 0 1px rgba(255,255,255,.7);border-radius:3px;pointer-events:none;";layer.appendChild(box);var badge=document.createElement("div");badge.textContent=m.label;badge.title="Click to edit or delete comment #"+m.label;badge.style.cssText="position:absolute;left:"+(u.left-6)+"px;top:"+(u.top-10)+"px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:"+themeColor+";color:#fff;font:600 11px/18px -apple-system,BlinkMacSystemFont,\\"Segoe UI\\",Roboto,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.25);pointer-events:auto;cursor:pointer;transition:transform .12s;";badge.addEventListener("mouseenter",function(){badge.style.transform="scale(1.15)";});badge.addEventListener("mouseleave",function(){badge.style.transform="scale(1)";});badge.addEventListener("click",function(ev){ev.preventDefault();ev.stopPropagation();ev.stopImmediatePropagation();window.parent.postMessage({type:"grove-preview-comment:marker-click",previewId:previewId,markerId:m.id},"*");});layer.appendChild(badge);});}',
    'function pathSelector(el){if(!el||el.nodeType!==1)return "";if(el.id)return "#"+cssEscape(el.id);var parts=[];while(el&&el.nodeType===1&&el!==document.documentElement){var part=el.tagName.toLowerCase();var cls=Array.from(el.classList||[]).filter(Boolean).slice(0,2);if(cls.length)part+="."+cls.map(cssEscape).join(".");var parent=el.parentElement;if(parent){var same=Array.from(parent.children).filter(function(c){return c.tagName===el.tagName;});if(same.length>1)part+=":nth-of-type("+(same.indexOf(el)+1)+")";}parts.unshift(part);el=parent;if(parts.length>=6)break;}return parts.join(" > ");}',
    'function xPath(el){if(!el||el.nodeType!==1)return "";var segs=[];while(el&&el.nodeType===1){var i=1,sib=el.previousElementSibling;while(sib){if(sib.tagName===el.tagName)i++;sib=sib.previousElementSibling;}segs.unshift(el.tagName.toLowerCase()+"["+i+"]");el=el.parentElement;if(el===document)break;}return "/"+segs.join("/");}',
    'function clean(s,n){return String(s||"").replace(/\\s+/g," ").trim().slice(0,n);}',
    'function describe(el){var r=el.getBoundingClientRect();var cls=typeof el.className==="string"?el.className:(el.getAttribute("class")||"");return{type:"dom",selector:pathSelector(el),xpath:xPath(el),tagName:el.tagName.toLowerCase(),id:el.id||undefined,className:clean(cls,160)||undefined,role:el.getAttribute("role")||undefined,text:clean(el.innerText||el.textContent||"",300),html:clean(el.outerHTML||"",300),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};}',
    'function pickBlock(el){if(!el)return null;if(el.nodeType!==1){el=el.parentElement;if(!el)return null;}if(el.closest&&el.closest("[data-grove-preview-comment-overlay]"))return null;var cur=el;while(cur&&cur.nodeType===1&&cur!==document.body&&cur!==document.documentElement){var tag=cur.tagName&&cur.tagName.toLowerCase();if(["section","article","main","header","footer","nav","aside","form","table","tr","li","button","a","img","svg","canvas"].indexOf(tag)>=0)return cur;if(/^h[1-6]$/.test(tag)||tag==="p")return cur;var rect=cur.getBoundingClientRect();if(tag==="div"&&rect.width>=24&&rect.height>=16)return cur;if(rect.width>=24&&rect.height>=16){for(var ci=0;ci<cur.childNodes.length;ci++){var cn=cur.childNodes[ci];if(cn.nodeType===Node.TEXT_NODE&&(cn.textContent||"").trim()){return cur;}}}cur=cur.parentElement;}return el;}',
    'function isBlockCandidate(el){var tag=el.tagName&&el.tagName.toLowerCase();if(["section","article","main","header","footer","nav","aside","form","table","tr","li","button","a","img","svg","canvas"].indexOf(tag)>=0)return true;if(/^h[1-6]$/.test(tag)||tag==="p")return true;var r=el.getBoundingClientRect();if(r.width<24||r.height<16)return false;if(tag==="div")return true;for(var i=0;i<el.childNodes.length;i++){var c=el.childNodes[i];if(c.nodeType===Node.TEXT_NODE&&(c.textContent||"").trim())return true;}return false;}',
    'var BLOCKS_BETWEEN_CAP=200;',
    'function blocksBetween(start,end){if(start===end)return [start];var first=start,last=end;if(start.compareDocumentPosition(end)&Node.DOCUMENT_POSITION_PRECEDING){first=end;last=start;}var result=[first];var prev=first;var w=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_ELEMENT);w.currentNode=first;var n=w.nextNode();var steps=0;while(n){if(++steps>BLOCKS_BETWEEN_CAP*8)return [first,last];if(n===last)break;if(!prev.contains(n)&&isBlockCandidate(n)){result.push(n);prev=n;if(result.length>=BLOCKS_BETWEEN_CAP)return [first,last];}n=w.nextNode();}if(result[result.length-1]!==last)result.push(last);return result;}',
    'function describeMulti(blocks){var head=blocks[0];var r=head.getBoundingClientRect();var cls=typeof head.className==="string"?head.className:(head.getAttribute("class")||"");var extras=[];var fullText=clean((head.innerText||head.textContent||""),300);for(var i=1;i<blocks.length;i++){extras.push({selector:pathSelector(blocks[i]),xpath:xPath(blocks[i])});var t=clean((blocks[i].innerText||blocks[i].textContent||""),300);if(t)fullText+="\\n"+t;}return{type:"dom",selector:pathSelector(head),xpath:xPath(head),tagName:head.tagName.toLowerCase(),id:head.id||undefined,className:clean(cls,160)||undefined,role:head.getAttribute("role")||undefined,text:clean(fullText,600),html:"[multi blocks="+blocks.length+" first="+head.tagName.toLowerCase()+"]\\n"+clean(head.outerHTML||"",200),rect:{x:r.x,y:r.y,width:r.width,height:r.height},extraBlocks:extras.length>0?extras:undefined};}',
    'function ensureHoverLayer(){if(overlay)return overlay;overlay=document.createElement("div");overlay.setAttribute("data-grove-preview-comment-overlay","true");overlay.style.cssText="position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:none;";document.documentElement.appendChild(overlay);return overlay;}',
    'function unionRect(rects){if(rects.length===0)return null;var l=Infinity,t=Infinity,r=-Infinity,b=-Infinity;for(var i=0;i<rects.length;i++){var rc=rects[i];if(rc.left<l)l=rc.left;if(rc.top<t)t=rc.top;if(rc.right>r)r=rc.right;if(rc.bottom>b)b=rc.bottom;}return {left:l,top:t,right:r,bottom:b,width:r-l,height:b-t};}',
    'function drawBlocks(blocks){var layer=ensureHoverLayer();layer.innerHTML="";var rects=[];for(var i=0;i<blocks.length;i++)rects.push(blocks[i].getBoundingClientRect());var u=unionRect(rects);if(!u){layer.style.display="none";return;}var box=document.createElement("div");box.style.cssText="position:absolute;left:"+u.left+"px;top:"+u.top+"px;width:"+Math.max(0,u.width)+"px;height:"+Math.max(0,u.height)+"px;border:2px solid "+themeColor+";background:"+withAlpha(themeColor,.12)+";box-shadow:0 0 0 1px rgba(255,255,255,.85),0 0 0 4px "+withAlpha(themeColor,.18)+";pointer-events:none;";layer.appendChild(box);layer.style.display="block";}',
    'var startBlock=null;var lastBlocks=[];',
    'function resetDrag(){startBlock=null;lastBlocks=[];}',
    'function onDown(e){if(!enabled)return;var el=pickBlock(e.target);if(!el)return;startBlock=el;lastBlocks=[el];drawBlocks(lastBlocks);}',
    'function onMove(e){if(!enabled)return;if(startBlock&&e.buttons===0){resetDrag();}var el=pickBlock(e.target);if(!el){if(!startBlock)hideOverlay();return;}if(startBlock){lastBlocks=blocksBetween(startBlock,el);drawBlocks(lastBlocks);}else{lastBlocks=[el];drawBlocks(lastBlocks);}}',
    'function onUp(e){if(!enabled){resetDrag();return;}var hit=pickBlock(e.target);if(!hit){resetDrag();hideOverlay();return;}var blocks=lastBlocks&&lastBlocks.length>0?lastBlocks:[hit];resetDrag();e.preventDefault();e.stopPropagation();if(e.stopImmediatePropagation)e.stopImmediatePropagation();var payload=blocks.length===1?describe(blocks[0]):describeMulti(blocks);window.parent.postMessage({type:"grove-preview-comment:selected",previewId:previewId,payload:payload},"*");hideOverlay();}',
    'function onLeave(e){if(e&&e.buttons===0){resetDrag();hideOverlay();}else if(!startBlock){hideOverlay();}}',
    'function key(e){if(e.key==="Escape"&&enabled){e.preventDefault();e.stopPropagation();if(e.stopImmediatePropagation)e.stopImmediatePropagation();enabled=false;hideOverlay();resetDrag();document.documentElement.style.cursor="";window.parent.postMessage({type:"grove-preview-comment:cancel",previewId:previewId},"*");}}',
    'document.addEventListener("mousedown",onDown,true);document.addEventListener("mousemove",onMove,true);document.addEventListener("mouseup",onUp,true);document.addEventListener("mouseleave",onLeave,true);document.addEventListener("keydown",key,true);window.addEventListener("blur",function(){if(startBlock){resetDrag();hideOverlay();}});',
    'var rerenderScheduled=false;function scheduleRerender(){if(rerenderScheduled)return;rerenderScheduled=true;requestAnimationFrame(function(){rerenderScheduled=false;renderMarkers();if(markerList.length)scheduleVerify();});}',
    'window.addEventListener("resize",scheduleRerender);window.addEventListener("scroll",scheduleRerender,true);',
    'if(window.ResizeObserver){try{var ro=new ResizeObserver(scheduleRerender);ro.observe(document.documentElement);if(document.body)ro.observe(document.body);}catch(e){}}',
    'if(window.MutationObserver){try{var mo=new MutationObserver(function(records){for(var i=0;i<records.length;i++){var t=records[i].target;var ok=true;var node=t.nodeType===1?t:t.parentNode;while(node){if(node.nodeType===1&&node.getAttribute&&node.getAttribute("data-grove-preview-comment-overlay")==="true"){ok=false;break;}node=node.parentNode;}if(ok){scheduleRerender();return;}}});mo.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});}catch(e){}}',
    'var verifyTimer=0;var verifyDeadline=0;function scheduleVerify(){var now=Date.now();if(!verifyDeadline)verifyDeadline=now+30000;var remaining=Math.max(0,verifyDeadline-now);var delay=Math.min(6000,remaining);if(verifyTimer)clearTimeout(verifyTimer);verifyTimer=setTimeout(function(){verifyTimer=0;verifyDeadline=0;var stale=[];markerList.forEach(function(m){if(!resolveMarkerEl(m))stale.push(m.id);});if(stale.length)window.parent.postMessage({type:"grove-preview-comment:markers-stale",previewId:previewId,ids:stale},"*");},delay);}',
    // ── Search support ──────────────────────────────────────────────────
    'var searchRanges=[];var searchMarks=[];var searchUseHL=(typeof CSS!=="undefined"&&"highlights" in CSS);',
    'function clearSearch(){if(searchUseHL){try{CSS.highlights.delete("grove-search");CSS.highlights.delete("grove-search-current");}catch(e){}}for(var i=0;i<searchMarks.length;i++){var m=searchMarks[i];var p=m.parentNode;if(!p)continue;while(m.firstChild)p.insertBefore(m.firstChild,m);p.removeChild(m);}searchRanges=[];searchMarks=[];}',
    'function ensureSearchStyle(){if(document.getElementById("grove-search-style"))return;var st=document.createElement("style");st.id="grove-search-style";st.textContent="::highlight(grove-search){background-color:rgba(245,158,11,.55);color:inherit;}::highlight(grove-search-current){background-color:rgba(245,158,11,.9);color:#1a1a1a;}mark[data-grove-search-mark]{background-color:rgba(245,158,11,.55);border-radius:2px;}mark[data-grove-search-mark][data-grove-search-mark-current=\\"true\\"]{background-color:rgba(245,158,11,.9);color:#1a1a1a;}";document.head.appendChild(st);}',
    'function runSearch(q){clearSearch();if(!q)return 0;ensureSearchStyle();var lower=q.toLowerCase();var qLen=q.length;var nodes=[];var walker=document.createTreeWalker(document.body||document.documentElement,NodeFilter.SHOW_TEXT,{acceptNode:function(node){var p=node.parentElement;if(!p)return NodeFilter.FILTER_REJECT;if(p.closest("[data-grove-preview-comment-overlay]"))return NodeFilter.FILTER_REJECT;var tag=p.tagName&&p.tagName.toLowerCase();if(tag==="script"||tag==="style"||tag==="noscript")return NodeFilter.FILTER_REJECT;if(!node.textContent)return NodeFilter.FILTER_REJECT;return NodeFilter.FILTER_ACCEPT;}});var n;while((n=walker.nextNode()))nodes.push(n);if(searchUseHL){var ranges=[];for(var i=0;i<nodes.length;i++){var t=nodes[i];var txt=t.textContent||"";var lo=txt.toLowerCase();var idx=0;while((idx=lo.indexOf(lower,idx))!==-1){var r=document.createRange();try{r.setStart(t,idx);r.setEnd(t,idx+qLen);ranges.push(r);}catch(e){}idx+=qLen;}}searchRanges=ranges;if(ranges.length){try{var hl=new Highlight();for(var k=0;k<ranges.length;k++)hl.add(ranges[k]);CSS.highlights.set("grove-search",hl);}catch(e){}}return ranges.length;}else{var marks=[];for(var j=0;j<nodes.length;j++){var tn=nodes[j];var txt2=tn.textContent||"";var lo2=txt2.toLowerCase();var occ=[];var p=0;while((p=lo2.indexOf(lower,p))!==-1){occ.push(p);p+=qLen;}if(!occ.length)continue;var pa=tn.parentNode;if(!pa)continue;var cur=tn;var consumed=0;for(var o=0;o<occ.length;o++){var ls=occ[o]-consumed;var aft=cur.splitText(ls);var matched=aft.splitText(qLen);var mk=document.createElement("mark");mk.setAttribute("data-grove-search-mark","true");mk.appendChild(aft);pa.insertBefore(mk,matched);marks.push(mk);cur=matched;consumed=occ[o]+qLen;}}searchMarks=marks;return marks.length;}}',
    'function gotoSearch(idx){if(searchUseHL){if(!searchRanges.length)return;var i=((idx%searchRanges.length)+searchRanges.length)%searchRanges.length;try{CSS.highlights.set("grove-search-current",new Highlight(searchRanges[i]));}catch(e){}var el=searchRanges[i].startContainer.parentElement;if(el&&el.scrollIntoView)el.scrollIntoView({block:"center",behavior:"smooth"});}else{if(!searchMarks.length)return;var j=((idx%searchMarks.length)+searchMarks.length)%searchMarks.length;for(var k=0;k<searchMarks.length;k++)searchMarks[k].removeAttribute("data-grove-search-mark-current");var m=searchMarks[j];m.setAttribute("data-grove-search-mark-current","true");if(m.scrollIntoView)m.scrollIntoView({block:"center",behavior:"smooth"});}}',
    'window.addEventListener("message",function(event){var d=event.data||{};if(d.previewId!==previewId)return;if(d.type==="grove-preview-comment:theme"){if(d.highlight)themeColor=d.highlight;scheduleRerender();}if(d.type==="grove-preview-comment:start"){enabled=true;resetDrag();hideOverlay();document.documentElement.style.cursor="crosshair";}if(d.type==="grove-preview-comment:stop"){enabled=false;resetDrag();document.documentElement.style.cursor="";hideOverlay();}if(d.type==="grove-preview-comment:markers"){markerList=Array.isArray(d.markers)?d.markers:[];scheduleRerender();scheduleVerify();}if(d.type==="grove-preview-search:query"){var total=runSearch(String(d.query||""));window.parent.postMessage({type:"grove-preview-search:result",previewId:previewId,total:total},"*");if(total>0)gotoSearch(0);}if(d.type==="grove-preview-search:goto"){gotoSearch(Number(d.index)||0);}if(d.type==="grove-preview-search:clear"){clearSearch();}});',
    'window.parent.postMessage({type:"grove-preview-comment:ready",previewId:previewId},"*");',
    '})();',
    '</script>',
  ].join('');
}

// Sandboxed iframes (`allow-scripts` only, no `allow-same-origin`) throw a
// SecurityError on any `localStorage` / `sessionStorage` access. React 19 and
// many libraries touch storage during render, which crashes the preview. This
// shim installs an in-memory replacement before any other script runs.
const SANDBOX_STORAGE_SHIM = [
  '<script>',
  '(function(){',
  'function makeStore(){',
  'var data=Object.create(null);',
  'return{',
  'getItem:function(k){return Object.prototype.hasOwnProperty.call(data,k)?data[k]:null;},',
  'setItem:function(k,v){data[String(k)]=String(v);},',
  'removeItem:function(k){delete data[k];},',
  'clear:function(){data=Object.create(null);},',
  'key:function(i){return Object.keys(data)[i]||null;},',
  'get length(){return Object.keys(data).length;}',
  '};',
  '}',
  'function install(name){',
  'try{',
  'var probe=window[name];',
  'probe&&probe.getItem("__grove_probe__");',
  '}catch(e){',
  'try{Object.defineProperty(window,name,{value:makeStore(),configurable:true,writable:true});}catch(_){}',
  '}',
  '}',
  'install("localStorage");install("sessionStorage");',
  '})();',
  '</script>',
].join('');

function buildHtmlPreviewSrcdoc(html: string, previewId: string): string {
  const bridge = buildPreviewCommentBridge(previewId);
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}${SANDBOX_STORAGE_SHIM}`);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html[^>]*>/i, (m) => `${m}<head>${SANDBOX_STORAGE_SHIM}</head>`);
  } else {
    html = `${SANDBOX_STORAGE_SHIM}${html}`;
  }
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${bridge}</body>`);
  }
  return `${html}${bridge}`;
}

function buildJsxIframeSrcdoc(code: string, previewId?: string): string {
  const wrapped = autoWrapJsx(code);
  const codeJson = JSON.stringify(wrapped).replace(/<\//g, '<\\/');
  const commentBridge = previewId ? buildPreviewCommentBridge(previewId) : '';

  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
    SANDBOX_STORAGE_SHIM,
    '<script crossorigin src="https://unpkg.com/react@19/umd/react.development.js"><\\/script>',
    '<script crossorigin src="https://unpkg.com/react-dom@19/umd/react-dom.development.js"><\\/script>',
    '<script crossorigin src="https://unpkg.com/@babel/standalone@7/babel.min.js"><\\/script>',
    '<style>',
    '*{box-sizing:border-box;margin:0;padding:0}',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px;background:#fff;color:#1a1a1a;-webkit-font-smoothing:antialiased}',
    '#root{min-height:100%}',
    '#jsx-error{display:none;color:#dc2626;padding:12px 16px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-family:"SF Mono",Monaco,monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin-top:8px}',
    '</style></head><body>',
    '<div id="root"></div>',
    '<div id="jsx-error"></div>',
    '<script>',
    '(function(){',
    'var errEl=document.getElementById("jsx-error");',
    'window.onerror=function(msg,url,line,col,err){',
    'errEl.textContent=(err&&err.message)||msg+(line?"\\nLine: "+line:"");',
    'errEl.style.display="block";',
    'return true;',
    '};',
    'try{',
    'var result=Babel.transform(' + codeJson + ',{presets:["react","typescript"]});',
    'var s=document.createElement("script");',
    's.textContent=result.code;',
    'document.head.appendChild(s);',
    '}catch(e){',
    'errEl.textContent="Syntax Error: "+e.message;',
    'errEl.style.display="block";',
    '}',
    '})();',
    '</script>',
    commentBridge,
    '</body></html>',
  ].join('\n');
}

const jsxRenderer: PreviewRenderer = {
  id: 'jsx',
  label: 'Preview JSX',
  match: (path) => /\.(jsx|tsx)$/i.test(path),
  contentType: 'text',
  renderFull: ({ content, previewComment }) => (
    <JsxPreviewFrame content={content} previewComment={previewComment} />
  ),
  supportsDiffSegments: false,
};

// ============================================================================
// Source Code Renderer (fallback — any text file, line-level comments)
// ============================================================================

function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  let currentLine = '';
  const openTags: string[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === '\n') {
      for (let t = openTags.length - 1; t >= 0; t--) currentLine += '</span>';
      lines.push(currentLine);
      currentLine = openTags.join('');
      i++;
    } else if (html[i] === '<') {
      const tagEnd = html.indexOf('>', i);
      if (tagEnd === -1) { currentLine += html.slice(i); break; }
      const tag = html.slice(i, tagEnd + 1);
      if (tag.startsWith('</')) { openTags.pop(); currentLine += tag; }
      else if (tag.endsWith('/>')) { currentLine += tag; }
      else { openTags.push(tag); currentLine += tag; }
      i = tagEnd + 1;
    } else {
      currentLine += html[i];
      i++;
    }
  }
  if (currentLine || lines.length > 0) lines.push(currentLine);
  return lines;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function SourceCodePreview({ content, previewComment, fileName }: RenderFullProps) {
  const lang = fileName ? detectLanguageLocal(fileName) : undefined;
  const lines = useMemo(() => {
    const rawLines = content.split('\n');
    if (!lang) return rawLines.map(escapeHtml);
    try {
      const code = rawLines.join('\n');
      const highlighted = highlightLocal(code, lang);
      const split = splitHighlightedLines(highlighted);
      if (split.length === rawLines.length) return split;
      return rawLines.map(escapeHtml);
    } catch {
      return rawLines.map(escapeHtml);
    }
  }, [content, lang]);

  const node = (
    <pre className="markdown-code-block text-xs font-mono leading-6 overflow-x-auto" style={{ color: "var(--color-text)", margin: 0 }}>
      <code>
        {lines.map((lineHtml, i) => (
          <div key={i} className="source-line" style={{ minHeight: '1.5rem', paddingRight: '1rem' }}>
            <span
              dangerouslySetInnerHTML={{ __html: lineHtml || '&nbsp;' }}
            />
          </div>
        ))}
      </code>
    </pre>
  );

  return withCommentHost(node, previewComment);
}

const d2Renderer: PreviewRenderer = {
  id: 'd2',
  label: 'Preview D2 diagram',
  match: (path) => /\.d2$/i.test(path),
  contentType: 'text',
  renderFull: ({ content, onSvgClick, previewComment }) => withCommentHost(
    <D2Block code={content} onPreviewClick={onSvgClick} />,
    previewComment,
  ),
  supportsDiffSegments: false,
};

const sourceCodeRenderer: PreviewRenderer = {
  id: 'source',
  label: 'Preview source code',
  match: () => true,
  contentType: 'text',
  renderFull: (props) => <SourceCodePreview {...props} />,
  supportsDiffSegments: false,
};

const renderers: PreviewRenderer[] = [
  jsxRenderer,
  htmlRenderer,
  markdownRenderer,
  mermaidRenderer,
  d2Renderer,
  svgRenderer,
  imageRenderer,
  csvRenderer,
  pdfRenderer,
  sourceCodeRenderer,
];

/**
 * Find the matching preview renderer for a file path.
 * Returns undefined if no renderer matches.
 */
export function getPreviewRenderer(path: string): PreviewRenderer | undefined {
  return renderers.find((r) => r.match(path));
}

// ============================================================================
// Image Preview Component
// ============================================================================

interface ImagePreviewProps {
  projectId?: string;
  taskId?: string;
  file: DiffFile;
  onImageClick?: (url: string) => void;
}

export function ImagePreview({ projectId, taskId, file, onImageClick }: ImagePreviewProps) {
  if (!projectId || !taskId) {
    return <div className="preview-loading">Missing project context</div>;
  }

  const imgUrl = `/api/v1/projects/${projectId}/tasks/${taskId}/file?path=${encodeURIComponent(file.new_path)}`;

  return (
    <div className="flex flex-col items-center justify-center gap-3 p-4">
      <img
        src={imgUrl}
        alt={file.new_path}
        className={`max-w-full max-h-[70vh] object-contain rounded-lg border border-[var(--color-border)]${onImageClick ? " cursor-pointer hover:opacity-80 transition-opacity" : ""}`}
        onClick={onImageClick ? () => onImageClick(imgUrl) : undefined}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
          (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
        }}
      />
      <div className="hidden text-sm text-[var(--color-text-muted)]">Failed to load image</div>
      <span className="text-xs text-[var(--color-text-muted)]">{file.new_path}</span>
    </div>
  );
}
