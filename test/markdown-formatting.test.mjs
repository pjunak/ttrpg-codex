import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import en from '../web/i18n/en.json' with { type: 'json' };
import cs from '../web/i18n/cs.json' with { type: 'json' };
import {
  MARKDOWN_FORMAT_GROUPS,
  MARKDOWN_FORMATS,
  editMarkdownSelection,
} from '../web/js/markdown-formatting.js';

describe('Markdown formatting registry', () => {
  it('has unique stable ids and localized toolbar labels', () => {
    const ids = MARKDOWN_FORMATS.map((format) => format.id);
    assert.equal(new Set(ids).size, ids.length);

    for (const group of MARKDOWN_FORMAT_GROUPS) {
      assert.equal(typeof en[group.labelKey], 'string', `${group.labelKey} in English`);
      assert.equal(typeof cs[group.labelKey], 'string', `${group.labelKey} in Czech`);
      for (const format of group.items) {
        assert.equal(typeof en[format.labelKey], 'string', `${format.labelKey} in English`);
        assert.equal(typeof cs[format.labelKey], 'string', `${format.labelKey} in Czech`);
      }
    }
  });
});

describe('editMarkdownSelection', () => {
  it('wraps a selection and keeps the inner text selected', () => {
    const result = editMarkdownSelection('Ancient lore', 0, 7, 'color-gold');
    assert.equal(result.replacement, '<span data-md-color="gold">Ancient</span>');
    assert.equal(result.selectionStart, '<span data-md-color="gold">'.length);
    assert.equal(result.selectionEnd, result.selectionStart + 'Ancient'.length);
  });

  it('inserts a selectable placeholder for an empty wrap selection', () => {
    const result = editMarkdownSelection('Lore: ', 6, 6, 'effect-underline', 'styled passage');
    assert.equal(result.replacement, '<span data-md-effect="underline">styled passage</span>');
    assert.equal(result.selectionEnd - result.selectionStart, 'styled passage'.length);
  });

  it('toggles an existing format without nesting a duplicate', () => {
    const source = '<span data-md-color="gold">Lore</span>';
    const start = '<span data-md-color="gold">'.length;
    const result = editMarkdownSelection(source, start, start + 4, 'color-gold');
    assert.equal(result.replacement, 'Lore');
    assert.deepEqual([result.from, result.to], [0, source.length]);
  });

  it('replaces formats in the same group and preserves other groups', () => {
    const source = '<span data-md-color="gold"><span data-md-effect="glow">Lore</span></span>';
    const start = source.indexOf('Lore');
    const result = editMarkdownSelection(source, start, start + 4, 'color-danger');
    assert.equal(
      result.replacement,
      '<span data-md-color="danger"><span data-md-effect="glow">Lore</span></span>',
    );
  });

  it('normalizes wrapper order regardless of the order tools were applied', () => {
    const first = editMarkdownSelection('Lore', 0, 4, 'effect-glow');
    const second = editMarkdownSelection(
      first.replacement,
      first.selectionStart,
      first.selectionEnd,
      'highlight-info',
    );
    assert.equal(
      second.replacement,
      '<mark data-md-highlight="info"><span data-md-effect="glow">Lore</span></mark>',
    );
  });

  it('can clear one group or every owned wrapper around a selection', () => {
    const source = '<span data-md-color="gold"><span data-md-effect="glow">Lore</span></span>';
    const start = source.indexOf('Lore');
    const reset = editMarkdownSelection(source, start, start + 4, 'color-reset');
    assert.equal(reset.replacement, '<span data-md-effect="glow">Lore</span>');

    const clear = editMarkdownSelection(source, start, start + 4, 'format-clear');
    assert.equal(clear.replacement, 'Lore');
  });

  it('recognizes wrappers selected as source, not only inner-text selections', () => {
    const source = '<sup>Lore</sup>';
    const result = editMarkdownSelection(source, 0, source.length, 'effect-subscript');
    assert.equal(result.replacement, '<sub>Lore</sub>');
  });

  it('does not mistake adjacent sibling wrappers for one outer wrapper', () => {
    const source = '<span data-md-color="gold">One</span><span data-md-color="gold">Two</span>';
    const result = editMarkdownSelection(source, 0, source.length, 'effect-glow');
    assert.equal(
      result.replacement,
      `<span data-md-effect="glow">${source}</span>`,
    );
  });

  it('rejects multiline inline formatting without mutating source', () => {
    const result = editMarkdownSelection('one\ntwo', 0, 7, 'effect-glow');
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'inline-only');
    assert.equal(result.replacement, undefined);
  });

  it('leaves reset and unknown operations as no-ops when nothing applies', () => {
    assert.equal(editMarkdownSelection('Lore', 2, 2, 'color-reset').changed, false);
    assert.equal(editMarkdownSelection('Lore', 0, 4, 'missing').reason, 'unknown-format');
  });
});
