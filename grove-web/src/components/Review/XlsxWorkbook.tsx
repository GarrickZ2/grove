import { lazy, Suspense, useEffect, useState } from 'react';
import { AlertCircle, FileSpreadsheet, Loader2 } from 'lucide-react';
import type { XlsxSheet } from './xlsxParser';

// DataTablePreview already lives in its own lazy chunk (previewRenderers.tsx
// imports it via React.lazy). Importing it from here pulls that chunk in only
// when an .xlsx file is opened.
const DataTablePreview = lazy(() =>
  import('./DataTablePreview').then((m) => ({ default: m.DataTablePreview })),
);

export interface XlsxWorkbookProps {
  downloadUrl: string;
}

export function XlsxWorkbook({ downloadUrl }: XlsxWorkbookProps) {
  const [loadedUrl, setLoadedUrl] = useState(downloadUrl);
  const [sheets, setSheets] = useState<XlsxSheet[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hoveredTab, setHoveredTab] = useState<number | null>(null);

  // React 19 idiom: when a controlled prop changes, reset dependent state
  // during render so the effect below sees a clean baseline.
  if (loadedUrl !== downloadUrl) {
    setLoadedUrl(downloadUrl);
    setSheets(null);
    setError(null);
    setActive(0);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(loadedUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching workbook`);
        const buf = await res.arrayBuffer();
        const m = await import('./xlsxParser');
        const parsed = await m.parseXlsx(buf);
        if (cancelled) return;
        setSheets(parsed);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Note: the parent's Refresh button does NOT trigger a re-fetch here.
    // Binary files are streamed through `downloadUrl`, which only changes when
    // the user picks a different file. Closing/reopening the preview is the
    // supported way to pick up external edits to an open xlsx.
  }, [loadedUrl]);

  if (error) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 p-6 text-center"
        style={{ color: 'var(--color-error)' }}>
        <AlertCircle className="w-6 h-6" />
        <p className="text-sm font-medium">Failed to open workbook</p>
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{error}</p>
      </div>
    );
  }

  if (!sheets) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2"
        style={{ color: 'var(--color-text-muted)' }}>
        <Loader2 className="w-5 h-5 animate-spin" />
        <p className="text-sm">Loading workbook…</p>
      </div>
    );
  }

  if (sheets.length === 0) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2"
        style={{ color: 'var(--color-text-muted)' }}>
        <FileSpreadsheet className="w-6 h-6" />
        <p className="text-sm">Workbook has no sheets</p>
      </div>
    );
  }

  const activeSheet = sheets[Math.min(active, sheets.length - 1)];

  return (
    <div className="flex flex-col h-full w-full">
      {sheets.length > 1 && (
        <div
          className="flex items-center gap-0.5 px-2 pt-1.5 shrink-0 overflow-x-auto border-b"
          style={{
            borderColor: 'var(--color-border)',
            background: 'var(--color-bg-secondary)',
          }}
          role="tablist"
        >
          {sheets.map((sheet, i) => {
            const isActive = i === active;
            const isHovered = i === hoveredTab;
            return (
              <button
                key={sheet.name}
                type="button"
                role="tab"
                id={`xlsx-sheet-tab-${i}`}
                aria-selected={isActive}
                aria-controls={`xlsx-sheet-panel-${i}`}
                onClick={() => setActive(i)}
                onMouseEnter={() => setHoveredTab(i)}
                onMouseLeave={() => setHoveredTab(null)}
                className="px-3 py-1.5 text-xs whitespace-nowrap rounded-t-md transition-colors border-b-2 -mb-px"
                style={{
                  color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
                  borderColor: isActive ? 'var(--color-highlight)' : 'transparent',
                  background: isActive
                    ? 'var(--color-bg)'
                    : isHovered
                      ? 'var(--color-bg-tertiary)'
                      : 'transparent',
                }}
              >
                {sheet.name}
                <span className="ml-1.5 text-[10px] tabular-nums opacity-60">
                  {sheet.table.totalRows}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div
        className="flex-1 min-h-0"
        role="tabpanel"
        id={`xlsx-sheet-panel-${active}`}
        aria-labelledby={`xlsx-sheet-tab-${active}`}
      >
        <Suspense fallback={
          <div className="h-full w-full flex items-center justify-center"
            style={{ color: 'var(--color-text-muted)' }}>
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        }>
          <DataTablePreview {...activeSheet.table} />
        </Suspense>
      </div>
    </div>
  );
}
