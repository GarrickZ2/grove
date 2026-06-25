import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseXlsx } from './xlsxParser';

function buildWorkbook(sheets: Array<{ name: string; rows: unknown[][] }>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const { name, rows } of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return buf as ArrayBuffer;
}

describe('parseXlsx', () => {
  it('parses a single-sheet workbook with a header row', async () => {
    const buf = buildWorkbook([
      { name: 'Sheet1', rows: [
        ['id', 'name', 'score'],
        ['a', 'alice', '0.9'],
        ['b', 'bob', '0.1'],
      ] },
    ]);
    const sheets = await parseXlsx(buf);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe('Sheet1');
    expect(sheets[0].table.columns).toEqual(['id', 'name', 'score']);
    expect(sheets[0].table.rows).toEqual([
      { id: 'a', name: 'alice', score: '0.9' },
      { id: 'b', name: 'bob', score: '0.1' },
    ]);
  });

  it('parses a multi-sheet workbook in order', async () => {
    const buf = buildWorkbook([
      { name: 'first', rows: [['a'], ['1']] },
      { name: 'second', rows: [['b'], ['2']] },
      { name: 'third', rows: [['c'], ['3']] },
    ]);
    const sheets = await parseXlsx(buf);
    expect(sheets.map((s) => s.name)).toEqual(['first', 'second', 'third']);
    expect(sheets[1].table.rows[0]).toEqual({ b: '2' });
  });

  it('fills missing cells with empty string', async () => {
    const buf = buildWorkbook([
      { name: 's', rows: [
        ['a', 'b', 'c'],
        ['1'],          // missing b, c
        ['', 'x', 'y'], // empty a
      ] },
    ]);
    const sheets = await parseXlsx(buf);
    expect(sheets[0].table.rows).toEqual([
      { a: '1', b: '', c: '' },
      { a: '', b: 'x', c: 'y' },
    ]);
  });

  it('generates "column_N" names for empty header cells', async () => {
    const buf = buildWorkbook([
      { name: 's', rows: [
        ['', 'name', ''],
        ['1', 'alice', '2'],
      ] },
    ]);
    const sheets = await parseXlsx(buf);
    expect(sheets[0].table.columns).toEqual(['column_1', 'name', 'column_3']);
  });

  it('returns empty table for an empty sheet', async () => {
    const buf = buildWorkbook([{ name: 'empty', rows: [] }]);
    const sheets = await parseXlsx(buf);
    expect(sheets[0].table.columns).toEqual([]);
    expect(sheets[0].table.rows).toEqual([]);
    expect(sheets[0].table.totalRows).toBe(0);
  });

  it('reports totalRows accurately', async () => {
    const buf = buildWorkbook([
      { name: 's', rows: [
        ['h'],
        ['1'], ['2'], ['3'], ['4'],
      ] },
    ]);
    const sheets = await parseXlsx(buf);
    expect(sheets[0].table.totalRows).toBe(4);
  });

  it('stringifies formula cell objects to their computed value', async () => {
    // aoa_to_sheet doesn't write formulas; build one manually.
    const wb = XLSX.utils.book_new();
    const ws: XLSX.WorkSheet = {};
    ws['A1'] = { t: 's', v: 'x' };
    ws['B1'] = { t: 's', v: 'y' };
    ws['A2'] = { t: 'n', v: 1 };
    ws['B2'] = { f: 'A2+1', v: 2, t: 'n' }; // formula cell with computed value
    ws['!ref'] = 'A1:B2';
    XLSX.utils.book_append_sheet(wb, ws, 's');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const sheets = await parseXlsx(buf);
    expect(sheets[0].table.columns).toEqual(['x', 'y']);
    expect(sheets[0].table.rows[0]).toEqual({ x: '1', y: '2' });
  });
});
