import * as XLSX from 'xlsx';
import type { DataTable } from './dataTableParsers';

export interface XlsxSheet {
  name: string;
  table: DataTable;
}

/** SheetJS may return rich cell values (formula objects, dates, hyperlinks).
 *  For a preview we want plain strings — show the computed value if present,
 *  else the formatted text, else JSON. Date cells are emitted as YYYY-MM-DD
 *  instead of an ISO timestamp so they read naturally in a preview table. */
function stringifyCell(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if ('v' in obj && obj.v != null) return String(obj.v);
    if ('w' in obj && obj.w != null) return String(obj.w);
    return JSON.stringify(v);
  }
  return String(v);
}

function sheetToTable(ws: XLSX.WorkSheet): DataTable {
  // header: 1 → array-of-arrays so we can read the raw first row and
  // control column naming for empty headers.
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: '',
    blankrows: false,
    raw: true,
  });
  if (raw.length === 0) return { columns: [], rows: [], totalRows: 0 };

  const headerRow = raw[0];
  const colCount = headerRow.length;
  const columns: string[] = [];
  for (let i = 0; i < colCount; i++) {
    const v = headerRow[i];
    const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
    columns.push(s || `column_${i + 1}`);
  }

  const rows: Record<string, unknown>[] = [];
  for (let r = 1; r < raw.length; r++) {
    const row = raw[r];
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i]] = stringifyCell(row[i]);
    }
    rows.push(obj);
  }
  return { columns, rows, totalRows: rows.length };
}

export async function parseXlsx(buf: ArrayBuffer): Promise<XlsxSheet[]> {
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheets: XlsxSheet[] = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    sheets.push({ name, table: sheetToTable(ws) });
  }
  return sheets;
}
