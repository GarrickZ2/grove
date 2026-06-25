import { describe, expect, it } from 'vitest';
import {
  parseCSV,
  parseTSV,
  parseJSONL,
  detectNumericColumns,
} from './dataTableParsers';

describe('parseCSV', () => {
  it('parses simple CSV with header', () => {
    const result = parseCSV('id,name\n1,alice\n2,bob\n');
    expect(result.columns).toEqual(['id', 'name']);
    expect(result.rows).toEqual([
      { id: '1', name: 'alice' },
      { id: '2', name: 'bob' },
    ]);
  });

  it('handles quoted fields with embedded commas', () => {
    const result = parseCSV('a,b\n"1,2","x"\n');
    expect(result.rows).toEqual([{ a: '1,2', b: 'x' }]);
  });

  it('handles escaped double-quotes inside quoted fields', () => {
    const result = parseCSV('a\n"He said ""hi"""\n');
    expect(result.rows).toEqual([{ a: 'He said "hi"' }]);
  });

  it('returns empty table on empty input', () => {
    expect(parseCSV('')).toEqual({ columns: [], rows: [], totalRows: 0 });
    expect(parseCSV('   \n  \n')).toEqual({ columns: [], rows: [], totalRows: 0 });
  });

  it('fills missing trailing cells with empty string', () => {
    const result = parseCSV('a,b,c\n1,2\n');
    expect(result.rows).toEqual([{ a: '1', b: '2', c: '' }]);
  });

  it('trims cell whitespace', () => {
    const result = parseCSV('a,b\n  1  ,  2  \n');
    expect(result.rows[0]).toEqual({ a: '1', b: '2' });
  });

  it('truncates oversized cells (50k+ chars)', () => {
    const huge = 'x'.repeat(60_000);
    const result = parseCSV(`a\n"${huge}"\n`);
    const cell = result.rows[0].a as string;
    expect(cell.length).toBeLessThanOrEqual(50_001);
    expect(cell.endsWith('…')).toBe(true);
  });

  it('uses "?" as fallback header for empty header cells', () => {
    const result = parseCSV(',name\n1,alice\n');
    expect(result.columns).toEqual(['?', 'name']);
  });
});

describe('parseTSV', () => {
  it('parses tab-separated values', () => {
    const result = parseTSV('a\tb\n1\t2\n3\t4\n');
    expect(result.columns).toEqual(['a', 'b']);
    expect(result.rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('handles tabs inside quoted fields', () => {
    const result = parseTSV('a\n"col1\tcol2"\n');
    expect(result.rows).toEqual([{ a: 'col1\tcol2' }]);
  });
});

describe('parseJSONL', () => {
  it('parses one JSON object per line', () => {
    const content =
      '{"id":"a","score":0.9}\n{"id":"b","score":0.1}\n';
    const result = parseJSONL(content);
    expect(result.columns).toEqual(['id', 'score']);
    expect(result.rows).toHaveLength(2);
  });

  it('preserves native JS types so numeric sort works', () => {
    const result = parseJSONL(
      '{"k":1}\n{"k":10}\n{"k":2}\n',
    );
    expect(result.rows.map((r) => r.k)).toEqual([1, 10, 2]);
  });

  it('preserves boolean and null types', () => {
    const result = parseJSONL('{"a":true,"b":null,"c":"x"}\n');
    expect(result.rows[0]).toEqual({ a: true, b: null, c: 'x' });
  });

  it('falls back to "line" column for invalid JSON', () => {
    const result = parseJSONL('{"a":1}\nNOT_JSON\n{"b":2}\n');
    expect(result.columns.sort()).toEqual(['a', 'b', 'line']);
    const badRow = result.rows.find((r) => r.line === 'NOT_JSON');
    expect(badRow).toBeDefined();
  });

  it('wraps non-object scalars in a "value" column', () => {
    const result = parseJSONL('42\n"hi"\n');
    expect(result.columns).toEqual(['value']);
    expect(result.rows).toEqual([{ value: 42 }, { value: 'hi' }]);
  });

  it('returns empty table on empty input', () => {
    expect(parseJSONL('')).toEqual({ columns: [], rows: [], totalRows: 0 });
    expect(parseJSONL('\n\n')).toEqual({ columns: [], rows: [], totalRows: 0 });
  });
});

describe('detectNumericColumns', () => {
  it('flags columns where all non-empty values parse as numbers', () => {
    const rows = [
      { a: '1', b: 'x' },
      { a: '2', b: 'y' },
      { a: '10.5', b: 'z' },
    ];
    const cols = detectNumericColumns(rows, ['a', 'b']);
    expect(cols.has('a')).toBe(true);
    expect(cols.has('b')).toBe(false);
  });

  it('does not flag columns with mixed numeric / non-numeric values', () => {
    const rows = [{ a: '1' }, { a: 'two' }];
    expect(detectNumericColumns(rows, ['a']).has('a')).toBe(false);
  });

  it('treats empty cells as "skip" not "non-numeric"', () => {
    const rows = [{ a: '1' }, { a: '' }, { a: '3' }];
    expect(detectNumericColumns(rows, ['a']).has('a')).toBe(true);
  });

  it('recognises native numbers in addition to numeric strings', () => {
    const rows = [{ a: 1 }, { a: 2.5 }, { a: 3 }];
    expect(detectNumericColumns(rows, ['a']).has('a')).toBe(true);
  });

  it('returns empty set for all-empty columns', () => {
    const rows = [{ a: '' }, { a: '' }];
    expect(detectNumericColumns(rows, ['a']).has('a')).toBe(false);
  });
});
