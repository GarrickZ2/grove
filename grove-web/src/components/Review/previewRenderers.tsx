/* eslint-disable react-refresh/only-export-components */
import { MarkdownRenderer, MermaidBlock } from '../ui/MarkdownRenderer';
import type { DiffFile } from '../../api/review';

// ============================================================================
// Preview Renderer Registry
// ============================================================================

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
   */
  renderFull: (props: { content: string }) => React.ReactNode;
  /**
   * Whether this renderer supports diff-mode segment preview.
   * If false, the preview drawer will use `renderFull` with reconstructed content.
   */
  supportsDiffSegments: boolean;
}

// ============================================================================
// Built-in Renderers
// ============================================================================

const markdownRenderer: PreviewRenderer = {
  id: 'markdown',
  label: 'Preview markdown',
  match: (path) => /\.(md|markdown)$/i.test(path),
  contentType: 'text',
  renderFull: ({ content }) => <MarkdownRenderer content={content} />,
  supportsDiffSegments: true,
};

const mermaidRenderer: PreviewRenderer = {
  id: 'mermaid',
  label: 'Preview diagram',
  match: (path) => /\.(mmd|mermaid)$/i.test(path),
  contentType: 'text',
  renderFull: ({ content }) => <MermaidBlock code={content} />,
  supportsDiffSegments: false,
};

const svgRenderer: PreviewRenderer = {
  id: 'svg',
  label: 'Preview SVG',
  match: (path) => /\.svg$/i.test(path),
  contentType: 'text',
  renderFull: ({ content }) => (
    <div
      className="flex items-center justify-center p-4 [&_svg]:max-w-full [&_svg]:max-h-[70vh]"
      dangerouslySetInnerHTML={{ __html: content }}
    />
  ),
  supportsDiffSegments: false,
};

const imageRenderer: PreviewRenderer = {
  id: 'image',
  label: 'Preview image',
  match: (path) => /\.(png|jpe?g|webp|gif|bmp|ico)$/i.test(path),
  contentType: 'url',
  renderFull: ({ content }) => (
    <div className="flex items-center justify-center h-full p-6" style={{ background: "var(--color-bg-secondary)" }}>
      <img
        src={content}
        alt=""
        className="max-w-full max-h-[70vh] object-contain rounded-lg shadow-md"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
          (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
        }}
      />
      <div className="hidden text-sm" style={{ color: "var(--color-text-muted)" }}>Failed to load image</div>
    </div>
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
  renderFull: ({ content }) => (
    <iframe
      srcDoc={content}
      sandbox="allow-scripts"
      className="w-full h-full border-0 min-h-[200px]"
      title="HTML Preview"
    />
  ),
  supportsDiffSegments: false,
};

const csvRenderer: PreviewRenderer = {
  id: 'csv',
  label: 'Preview CSV',
  match: (path) => /\.csv$/i.test(path),
  contentType: 'text',
  renderFull: ({ content }) => <CsvTable content={content} />,
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

function buildJsxIframeSrcdoc(code: string): string {
  const wrapped = autoWrapJsx(code);
  const codeJson = JSON.stringify(wrapped).replace(/<\//g, '<\\/');

  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8">',
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
    '<\\/script>',
    '</body></html>',
  ].join('\n');
}

const jsxRenderer: PreviewRenderer = {
  id: 'jsx',
  label: 'Preview JSX',
  match: (path) => /\.(jsx|tsx)$/i.test(path),
  contentType: 'text',
  renderFull: ({ content }) => (
    <iframe
      srcDoc={buildJsxIframeSrcdoc(content)}
      sandbox="allow-scripts"
      className="w-full h-full border-0 min-h-[200px]"
      title="JSX Preview"
    />
  ),
  supportsDiffSegments: false,
};

// ============================================================================
// Registry
// ============================================================================

const renderers: PreviewRenderer[] = [
  jsxRenderer,
  htmlRenderer,
  markdownRenderer,
  mermaidRenderer,
  svgRenderer,
  imageRenderer,
  csvRenderer,
  pdfRenderer,
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
}

export function ImagePreview({ projectId, taskId, file }: ImagePreviewProps) {
  if (!projectId || !taskId) {
    return <div className="preview-loading">Missing project context</div>;
  }

  const imgUrl = `/api/v1/projects/${projectId}/tasks/${taskId}/file?path=${encodeURIComponent(file.new_path)}`;

  return (
    <div className="flex flex-col items-center justify-center gap-3 p-4">
      <img
        src={imgUrl}
        alt={file.new_path}
        className="max-w-full max-h-[70vh] object-contain rounded-lg border border-[var(--color-border)]"
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
