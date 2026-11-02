import { describe, expect, it } from 'vitest';
import { alignText, type DiffRow } from './content-diff';

function texts(rows: DiffRow[]) {
  return rows.map((row) => [row.before?.text ?? null, row.after?.text ?? null]);
}

function expectPreserved(rows: DiffRow[], before: string, after: string) {
  for (const [side, original] of [
    ['before', before],
    ['after', after],
  ] as const) {
    const lines = rows.flatMap((row) => (row[side] ? [row[side]!] : []));
    expect(lines.map((line) => line.text).join('\n')).toBe(original.replace(/\r\n/g, '\n'));
    expect(lines.map((line) => line.lineNumber)).toEqual(lines.map((_, index) => index + 1));
    for (const line of lines) {
      expect(line.fragments.map((fragment) => fragment.text).join('')).toBe(line.text);
      expect(line.fragments.length).toBeGreaterThan(0);
    }
  }
}

describe('activity content alignment', () => {
  it('adds spacers for inserted and removed lines without shifting exact anchors', () => {
    const before = 'Old obsolete instruction\nShared first checkpoint\nShared second checkpoint';
    const after = 'Shared first checkpoint\nBrand new ferry notice\nShared second checkpoint';
    const rows = alignText(before, after);
    expect(texts(rows)).toEqual([
      ['Old obsolete instruction', null],
      ['Shared first checkpoint', 'Shared first checkpoint'],
      [null, 'Brand new ferry notice'],
      ['Shared second checkpoint', 'Shared second checkpoint'],
    ]);
    expect(rows[1].before?.fragments).toEqual([
      { text: 'Shared first checkpoint', changed: false },
    ]);
    expectPreserved(rows, before, after);
  });

  it('pairs similar edited lines next to unrelated inserted and deleted lines', () => {
    const before = [
      'Map readiness',
      'Routes use the cached tiles and detailed walking descriptions for the entire coastal route while the device remains offline.',
      'Keep shared checkpoint.',
      'Remove obsolete elevation tiles.',
      'Final validation passes.',
    ].join('\n');
    const after = [
      'Map readiness',
      'New note: ferry timetable is included.',
      'Routes use the refreshed tiles and detailed walking descriptions for the entire coastal route while the device remains offline, including newly verified ferry connections and accessible detours.',
      'Keep shared checkpoint.',
      'Final validation passes.',
    ].join('\n');
    const rows = alignText(before, after);
    expect(rows).toHaveLength(6);
    expect(rows[1].before).toBeNull();
    expect(rows[1].after?.text).toBe('New note: ferry timetable is included.');
    expect(rows[2].before?.lineNumber).toBe(2);
    expect(rows[2].after?.lineNumber).toBe(3);
    expect(rows[2].before?.fragments).toContainEqual({ text: 'cached', changed: true });
    expect(rows[2].after?.fragments).toContainEqual({ text: 'refreshed', changed: true });
    expect(rows[2].before?.fragments).toContainEqual({ text: 'Routes use the ', changed: false });
    expect(rows[4].before?.text).toBe('Remove obsolete elevation tiles.');
    expect(rows[4].after).toBeNull();
    expectPreserved(rows, before, after);
  });

  it('chooses monotone edited matches instead of pairing unrelated lines by position', () => {
    const before = 'Cache readiness: pending\nSearch readiness: pending\nEnd';
    const after = 'A new note about ferries\nCache readiness: done\nSearch readiness: blocked\nEnd';
    const rows = alignText(before, after);
    expect(texts(rows)).toEqual([
      [null, 'A new note about ferries'],
      ['Cache readiness: pending', 'Cache readiness: done'],
      ['Search readiness: pending', 'Search readiness: blocked'],
      ['End', 'End'],
    ]);
    expectPreserved(rows, before, after);
  });

  it('retains repeated exact lines and real blank lines separately from spacers', () => {
    const before = 'Start\n\nRepeat\nRepeat\n\nEnd\n';
    const after = 'Start\n\nRepeat\nInserted note\nRepeat\n\nEnd\n';
    const rows = alignText(before, after);
    expect(texts(rows)).toEqual([
      ['Start', 'Start'],
      ['', ''],
      ['Repeat', 'Repeat'],
      [null, 'Inserted note'],
      ['Repeat', 'Repeat'],
      ['', ''],
      ['End', 'End'],
      ['', ''],
    ]);
    expect(rows[1].before?.fragments).toEqual([{ text: '', changed: false }]);
    expectPreserved(rows, before, after);
    const blankInsertion = alignText('Start\nEnd', 'Start\n\nEnd');
    expect(blankInsertion[1]).toEqual({
      before: null,
      after: { text: '', lineNumber: 2, fragments: [{ text: '', changed: true }] },
    });
  });

  it('handles absent content without inventing an empty line', () => {
    expect(alignText('', '')).toEqual([]);
    expect(texts(alignText('', 'Added\n'))).toEqual([
      [null, 'Added'],
      [null, ''],
    ]);
    expect(texts(alignText('\n', ''))).toEqual([
      ['', null],
      ['', null],
    ]);
    expectPreserved(alignText('', '\n'), '', '\n');
  });

  it('preserves whitespace and standalone carriage returns while normalizing CRLF', () => {
    const before = '\tCached  maps \r\n \r\nStandalone\rreturn\r\n';
    const after = '\tCached maps\n\t\nStandalone\rreturn\n';
    const rows = alignText(before, after);
    expect(texts(rows)).toEqual([
      ['\tCached  maps ', '\tCached maps'],
      [' ', '\t'],
      ['Standalone\rreturn', 'Standalone\rreturn'],
      ['', ''],
    ]);
    expect(rows[0].before?.fragments.some((fragment) => fragment.changed)).toBe(true);
    expectPreserved(rows, before, after);
  });

  it('does not force unrelated lines into an edited pair', () => {
    const before = 'alpha\nKeep';
    const after = 'tundra snow\nKeep';
    const rows = alignText(before, after);
    expect(texts(rows)).toEqual([
      ['alpha', null],
      [null, 'tundra snow'],
      ['Keep', 'Keep'],
    ]);
    for (const row of rows.slice(0, 2))
      expect((row.before ?? row.after)?.fragments.every((fragment) => fragment.changed)).toBe(true);
    expectPreserved(rows, before, after);
  });

  it('uses exact LCS anchors when repeated lines occur in different orders', () => {
    const before = 'a\nb\na';
    const after = 'b\na\nb';
    const rows = alignText(before, after);
    expect(
      rows.filter((row) => row.before && row.after && row.before.text === row.after.text),
    ).toHaveLength(2);
    expectPreserved(rows, before, after);
  });

  it('bounds dense repeated-line and long-token comparisons while preserving full input', () => {
    const inputs = [
      [
        'x\n' + 'a\n'.repeat(2498) + 'b\n'.repeat(2498) + 'y',
        'z\n' + 'b\n'.repeat(2498) + 'a\n'.repeat(2498) + 'w',
      ],
      ['a\n'.repeat(4999), 'b\n'.repeat(4999)],
      ['cached tiles '.repeat(800), 'cached maps '.repeat(800)],
    ];
    for (const [before, after] of inputs) {
      const rows = alignText(before, after);
      expectPreserved(rows, before, after);
      expect(rows.length).toBeLessThanOrEqual(before.split('\n').length + after.split('\n').length);
    }
  });
});
