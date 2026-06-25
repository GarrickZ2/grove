import Papa from 'papaparse';

export interface DataTable {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Truncated rows are NOT dropped; rows.length stays the full count.
   *  This is exposed for "showing N of M" footer text if needed later. */
  totalRows: number;
}

const MAX_CELL_LENGTH = 50_000;

function sanitize(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string' && value.length > MAX_CELL_LENGTH) {
    return value.slice(0, MAX_CELL_LENGTH) + '…';
  }
  // Nested objects/arrays land in cells as `[object Object]` after AG Grid's
  // default renderer; stringify them so sort + filter + tooltip behave.
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value;
}

function fromHeaderAndRows(header: string[], body: unknown[][]): DataTable {
  const cols = header.map((h) => String(h ?? '').trim() || '?');
  const rows: Record<string, unknown>[] = body.map((r) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < cols.length; i++) {
      obj[cols[i]] = sanitize(r[i] ?? '');
    }
    return obj;
  });
  return { columns: cols, rows, totalRows: rows.length };
}

function parseDelimited(content: string, delimiter: string): DataTable {
  const result = Papa.parse<string[]>(content.trim(), {
    delimiter,
    skipEmptyLines: 'greedy',
    transform: (v) => (typeof v === 'string' ? v.trim() : v),
  });
  const data = result.data.filter((row) => Array.isArray(row) && row.length > 0);
  if (data.length === 0) return { columns: [], rows: [], totalRows: 0 };
  const [header, ...body] = data;
  return fromHeaderAndRows(header, body);
}

export function parseCSV(content: string): DataTable {
  return parseDelimited(content, ',');
}

export function parseTSV(content: string): DataTable {
  return parseDelimited(content, '\t');
}

export function parseJSONL(content: string): DataTable {
  // Handle Windows / Mac classic line endings — without \r?\n, the trailing
  // \r on every CRLF line makes JSON.parse throw, which would force the
  // entire line into a fallback "line" column and erase the real JSON columns.
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { columns: [], rows: [], totalRows: 0 };

  const records: Record<string, unknown>[] = [];
  const columnSet = new Set<string>();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const flat: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          flat[k] = sanitize(v);
          columnSet.add(k);
        }
        records.push(flat);
      } else {
        records.push({ value: sanitize(obj) });
        columnSet.add('value');
      }
    } catch {
      records.push({ line: line.slice(0, 500) });
      columnSet.add('line');
    }
  }
  const columns = Array.from(columnSet);
  const rows = records.map((r) => {
    const obj: Record<string, unknown> = {};
    for (const c of columns) obj[c] = c in r ? r[c] : '';
    return obj;
  });
  return { columns, rows, totalRows: rows.length };
}

/** Detect columns whose non-empty values are all parseable as a number.
 *  Used by DataTablePreview to install a numeric comparator so sorting
 *  orders `2 < 10` instead of lexicographically `'10' < '2'`. */
export function detectNumericColumns(rows: Record<string, unknown>[], columns: string[]): Set<string> {
  const numeric = new Set<string>();
  for (const col of columns) {
    let total = 0;
    let numericCount = 0;
    for (const row of rows) {
      const v = row[col];
      if (v == null || v === '') continue;
      total++;
      if (typeof v === 'number' && Number.isFinite(v)) {
        numericCount++;
      } else if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) {
        numericCount++;
      }
    }
    if (total > 0 && numericCount === total) numeric.add(col);
  }
  return numeric;
}
