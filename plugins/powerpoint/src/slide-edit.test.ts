import { describe, expect, it } from 'vitest';
import { parseOutline } from './slide-edit.js';

describe('parseOutline', () => {
  it('treats untabbed prose as a flat list', () => {
    expect(parseOutline('one\ntwo')).toEqual([
      { text: 'one', level: 0 },
      { text: 'two', level: 0 },
    ]);
  });

  it('reads one leading tab as the second level', () => {
    expect(parseOutline('parent\n\tchild')).toEqual([
      { text: 'parent', level: 0 },
      { text: 'child', level: 1 },
    ]);
  });

  it('lets a list come back up a level', () => {
    expect(parseOutline('a\n\tb\n\t\tc\n\td').map(p => p.level)).toEqual([0, 1, 2, 1]);
  });

  it('clamps past the deepest level OOXML allows', () => {
    // ST_TextIndentLevelType maxes out at 8; a deeper value is schema-invalid.
    expect(parseOutline(`${'\t'.repeat(20)}too deep`)[0]?.level).toBe(8);
  });

  it('strips only leading tabs, leaving the text itself untouched', () => {
    const [first] = parseOutline('\t\tPick creation\tvs\tSLA');
    expect(first?.text).toBe('Pick creation\tvs\tSLA');
    expect(first?.level).toBe(2);
  });

  it('keeps leading spaces, which are prose rather than an outline level', () => {
    expect(parseOutline('  indented by spaces')).toEqual([{ text: '  indented by spaces', level: 0 }]);
  });

  it('keeps a blank paragraph as a blank paragraph', () => {
    expect(parseOutline('a\n\nb').map(p => p.text)).toEqual(['a', '', 'b']);
  });
});
