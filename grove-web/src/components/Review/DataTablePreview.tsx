import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  ModuleRegistry,
  AllCommunityModule,
  themeQuartz,
  type ColDef,
} from 'ag-grid-community';
import { useTheme } from '../../context/ThemeContext';
import { detectNumericColumns } from './dataTableParsers';
import './dataTablePreview.css';

// Pin the registration flag on globalThis so it survives Vite HMR
// module re-evaluation. A module-scope `let` resets every time HMR swaps
// the module, causing registerModules() to fire twice and AG Grid to throw
// `ModuleAlreadyRegistered`.
const AG_GRID_REGISTERED = Symbol.for('grove.agGridRegistered');
const g = globalThis as unknown as Record<symbol, boolean>;
function ensureModulesRegistered() {
  if (g[AG_GRID_REGISTERED]) return;
  ModuleRegistry.registerModules([AllCommunityModule]);
  g[AG_GRID_REGISTERED] = true;
}

type DataTableRow = Record<string, unknown>;

export interface DataTablePreviewProps {
  columns: string[];
  rows: DataTableRow[];
}

export function DataTablePreview({ columns, rows }: DataTablePreviewProps) {
  ensureModulesRegistered();
  const { theme } = useTheme();

  // Detect numeric columns once and reuse for both coercion (so the filter
  // `equals` does numeric compare rather than string compare) and the sort
  // comparator (so `2 < 10` orders correctly).
  const numericCols = useMemo(
    () => detectNumericColumns(rows, columns),
    [rows, columns],
  );

  // AG Grid's `equals` / `greaterThan` / `lessThan` filters compare with strict
  // `===` — if a cell is the string `"1"` (CSV parsing keeps values as strings)
  // and the user types `1` (parsed to number), `"1" === 1` is false and the
  // filter never matches. Coerce numeric columns to actual numbers here so
  // Community filters behave intuitively.
  const coercedRows = useMemo(() => {
    // Skip the .map when there's nothing to coerce: returning the same
    // `rows` reference lets AG Grid skip the full row remount that
    // would happen on a new array identity.
    if (rows.length === 0 || numericCols.size === 0) return rows;
    return rows.map((row) => {
      let mutated: DataTableRow | null = null;
      for (const col of numericCols) {
        const v = row[col];
        if (typeof v === 'number') continue;
        if (typeof v !== 'string' || v === '') continue;
        const n = Number(v);
        if (!Number.isFinite(n) || Number.isNaN(n)) continue;
        if (!mutated) mutated = { ...row };
        mutated[col] = n;
      }
      return mutated ?? row;
    });
  }, [rows, numericCols]);

  // theme.id is the trigger — recompute the theme when the user switches
  // theme. The actual colours are CSS variables, so they pick up changes
  // without re-creating the theme; this id just forces React to commit a
  // new themeQuartz.withParams result.
  const gridTheme = useMemo(
    () => {
      void theme.id;
      return themeQuartz.withParams({
        backgroundColor: 'var(--color-bg)',
        foregroundColor: 'var(--color-text)',
        headerBackgroundColor: 'var(--color-bg-secondary)',
        headerTextColor: 'var(--color-text)',
        borderColor: 'var(--color-border)',
        rowHoverColor: 'var(--color-bg-tertiary)',
        oddRowBackgroundColor: 'transparent',
        rowBorder: { color: 'var(--color-border)', style: 'solid', width: 1 },
        columnBorder: { color: 'var(--color-border)', style: 'solid', width: 1 },
        headerRowBorder: { color: 'var(--color-border)', style: 'solid', width: 2 },
        wrapperBorderRadius: 0,
        wrapperBorder: false,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        fontSize: 12,
        cellHorizontalPadding: 12,
        rowHeight: 30,
        headerHeight: 34,
        spacing: 6,
        accentColor: 'var(--color-highlight)',
      });
    },
    [theme.id],
  );

  const columnDefs = useMemo<ColDef[]>(
    () =>
      columns.map((field) => {
        const isNumeric = numericCols.has(field);
        return {
          field,
          headerName: field,
          resizable: true,
          sortable: true,
          minWidth: 80,
          maxWidth: 480,
          filter: isNumeric ? 'agNumberColumnFilter' : 'agTextColumnFilter',
          // Expose the full Community operator set per type. Compound
          // AND/OR (Set Filter) is Enterprise — not available here.
          filterParams: isNumeric
            ? {
                filterOptions: [
                  'equals',
                  'notEqual',
                  'lessThan',
                  'lessThanOrEqual',
                  'greaterThan',
                  'greaterThanOrEqual',
                  'inRange',
                ],
                defaultOption: 'equals',
                includeBlanksInEquals: false,
              }
            : {
                filterOptions: [
                  'equals',
                  'notEqual',
                  'contains',
                  'notContains',
                  'startsWith',
                  'endsWith',
                ],
                defaultOption: 'contains',
                trimInput: true,
              },
          // No floating-filter row — filter conditions live behind the
          // column menu (≡ icon), which is the default AG Grid layout.
          floatingFilter: false,
          tooltipValueGetter: (p: { data?: Record<string, unknown> }) => {
            const v = p.data?.[field];
            return v == null ? '' : String(v);
          },
          ...(isNumeric
            ? {
                comparator: (a: unknown, b: unknown) => {
                  const an = typeof a === 'number' ? a : Number(a);
                  const bn = typeof b === 'number' ? b : Number(b);
                  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
                  return String(a ?? '').localeCompare(String(b ?? ''));
                },
              }
            : {}),
        };
      }),
    [columns, numericCols],
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({
      resizable: true,
      sortable: true,
      minWidth: 80,
      suppressMovable: true,
    }),
    [],
  );

  if (columns.length === 0) {
    return (
      <div
        className="h-full w-full flex items-center justify-center text-sm"
        style={{ color: 'var(--color-text-muted)' }}
      >
        Empty file
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <div className="ag-theme-quartz h-full w-full">
        <AgGridReact
          theme={gridTheme}
          rowData={coercedRows}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          headerHeight={34}
          rowHeight={30}
          animateRows={false}
          // Mouse-drag text selection works out of the box on plain <td>s;
          // without this flag AG Grid intercepts clicks for its own range
          // selection and the browser's native ⌘C is lost.
          enableCellTextSelection={true}
          suppressCellFocus={false}
          tooltipShowDelay={300}
        />
      </div>
    </div>
  );
}
