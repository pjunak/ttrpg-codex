/**
 * Shared rich-formatting contract for Markdown-backed editors.
 *
 * The registry is intentionally editor-agnostic: core screens and addons can
 * use the same source syntax without depending on EasyMDE or CodeMirror.
 */

const GROUP_ORDER = Object.freeze({ color: 10, highlight: 20, effect: 30 });

function _wrap(id, group, labelKey, open, close, tone) {
  return Object.freeze({ id, group, labelKey, open, close, tone, operation: 'wrap' });
}

function _reset(id, group, labelKey) {
  return Object.freeze({ id, group, labelKey, operation: 'reset' });
}

export const MARKDOWN_FORMAT_GROUPS = Object.freeze([
  Object.freeze({
    id: 'color',
    labelKey: 'markdown.toolbar.color',
    toolbarClass: 'md-format-color',
    toolbarText: 'A',
    items: Object.freeze([
      _wrap('color-gold', 'color', 'markdown.color.gold', '<span data-md-color="gold">', '</span>', 'gold'),
      _wrap('color-danger', 'color', 'markdown.color.danger', '<span data-md-color="danger">', '</span>', 'danger'),
      _wrap('color-info', 'color', 'markdown.color.info', '<span data-md-color="info">', '</span>', 'info'),
      _wrap('color-success', 'color', 'markdown.color.success', '<span data-md-color="success">', '</span>', 'success'),
      _wrap('color-mystery', 'color', 'markdown.color.mystery', '<span data-md-color="mystery">', '</span>', 'mystery'),
      _wrap('color-muted', 'color', 'markdown.color.muted', '<span data-md-color="muted">', '</span>', 'muted'),
      _reset('color-reset', 'color', 'markdown.color.reset'),
    ]),
  }),
  Object.freeze({
    id: 'highlight',
    labelKey: 'markdown.toolbar.highlight',
    toolbarClass: 'md-format-highlight',
    toolbarText: '▰',
    items: Object.freeze([
      _wrap('highlight-gold', 'highlight', 'markdown.color.gold', '<mark data-md-highlight="gold">', '</mark>', 'gold'),
      _wrap('highlight-danger', 'highlight', 'markdown.color.danger', '<mark data-md-highlight="danger">', '</mark>', 'danger'),
      _wrap('highlight-info', 'highlight', 'markdown.color.info', '<mark data-md-highlight="info">', '</mark>', 'info'),
      _wrap('highlight-success', 'highlight', 'markdown.color.success', '<mark data-md-highlight="success">', '</mark>', 'success'),
      _wrap('highlight-mystery', 'highlight', 'markdown.color.mystery', '<mark data-md-highlight="mystery">', '</mark>', 'mystery'),
      _reset('highlight-reset', 'highlight', 'markdown.highlight.reset'),
    ]),
  }),
  Object.freeze({
    id: 'effect',
    labelKey: 'markdown.toolbar.effects',
    toolbarClass: 'md-format-effects',
    toolbarText: '✦',
    items: Object.freeze([
      _wrap('effect-underline', 'effect', 'markdown.effect.underline', '<span data-md-effect="underline">', '</span>'),
      _wrap('effect-glow', 'effect', 'markdown.effect.glow', '<span data-md-effect="glow">', '</span>'),
      _wrap('effect-small-caps', 'effect', 'markdown.effect.smallCaps', '<span data-md-effect="small-caps">', '</span>'),
      _wrap('effect-spoiler', 'effect', 'markdown.effect.spoiler', '<span data-md-effect="spoiler" tabindex="0">', '</span>'),
      _wrap('effect-superscript', 'effect', 'markdown.effect.superscript', '<sup>', '</sup>'),
      _wrap('effect-subscript', 'effect', 'markdown.effect.subscript', '<sub>', '</sub>'),
      _reset('effect-reset', 'effect', 'markdown.effect.reset'),
      Object.freeze({ id: 'format-clear', labelKey: 'markdown.format.clear', operation: 'clear' }),
    ]),
  }),
]);

export const MARKDOWN_FORMATS = Object.freeze(
  MARKDOWN_FORMAT_GROUPS.flatMap((group) => group.items),
);

const FORMAT_BY_ID = new Map(MARKDOWN_FORMATS.map((format) => [format.id, format]));
const WRAPPERS = MARKDOWN_FORMATS.filter((format) => format.operation === 'wrap');

function _boundedIndex(value, length) {
  const number = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.max(0, Math.min(length, number));
}

function _findExactWrapper(value) {
  return WRAPPERS.find((format) => (
    value.length >= format.open.length + format.close.length
    && value.startsWith(format.open)
    && value.endsWith(format.close)
    && _outerTagClosesAtEnd(value, format)
  ));
}

function _outerTagClosesAtEnd(value, format) {
  const tag = format.open.match(/^<([a-z]+)/i)?.[1]?.toLowerCase();
  if (!tag) return false;
  const tokenPattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  tokenPattern.lastIndex = format.open.length;
  let depth = 1;
  let match;
  while ((match = tokenPattern.exec(value))) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return tokenPattern.lastIndex === value.length;
  }
  return false;
}

function _findSurroundingWrapper(source, start, end) {
  return WRAPPERS.find((format) => (
    start >= format.open.length
    && source.slice(start - format.open.length, start) === format.open
    && source.slice(end, end + format.close.length) === format.close
  ));
}

/**
 * Return the owned wrapper chain around a selection, from outermost to
 * innermost. Wrappers can be selected as source or sit immediately around the
 * selected text; both forms are treated identically.
 */
function _selectionContext(source, start, end) {
  let innerStart = start;
  let innerEnd = end;
  const selectedWrappers = [];

  while (innerStart < innerEnd) {
    const wrapper = _findExactWrapper(source.slice(innerStart, innerEnd));
    if (!wrapper) break;
    selectedWrappers.push(wrapper);
    innerStart += wrapper.open.length;
    innerEnd -= wrapper.close.length;
  }

  let regionStart = start;
  let regionEnd = end;
  const surroundingWrappers = [];
  while (true) {
    const wrapper = _findSurroundingWrapper(source, regionStart, regionEnd);
    if (!wrapper) break;
    surroundingWrappers.unshift(wrapper);
    regionStart -= wrapper.open.length;
    regionEnd += wrapper.close.length;
  }

  return {
    innerText: source.slice(innerStart, innerEnd),
    regionStart,
    regionEnd,
    wrappers: [...surroundingWrappers, ...selectedWrappers],
  };
}

function _sortWrappers(wrappers) {
  return [...wrappers].sort((left, right) => (
    (GROUP_ORDER[left.group] ?? 100) - (GROUP_ORDER[right.group] ?? 100)
  ));
}

/**
 * Apply one registry format to a Markdown source selection.
 *
 * The result is a replace operation rather than a mutated editor instance, so
 * it can be consumed by EasyMDE, another host editor, or an addon-owned UI.
 */
export function editMarkdownSelection(source, selectionStart, selectionEnd, formatId, placeholder = 'styled text') {
  const value = String(source ?? '');
  const first = _boundedIndex(selectionStart, value.length);
  const second = _boundedIndex(selectionEnd, value.length);
  const start = Math.min(first, second);
  const end = Math.max(first, second);
  const format = FORMAT_BY_ID.get(formatId);

  if (!format) {
    return { changed: false, reason: 'unknown-format', from: start, to: end };
  }

  const context = _selectionContext(value, start, end);
  if (context.innerText.includes('\n')) {
    return { changed: false, reason: 'inline-only', from: start, to: end };
  }

  const placeholderText = String(placeholder || 'styled text').replace(/[\r\n]+/g, ' ');
  const innerText = context.innerText || (format.operation === 'wrap' ? placeholderText : '');
  let wrappers = [...context.wrappers];

  if (format.operation === 'clear') {
    wrappers = [];
  } else if (format.operation === 'reset') {
    wrappers = wrappers.filter((wrapper) => wrapper.group !== format.group);
  } else {
    const alreadyApplied = wrappers.some((wrapper) => wrapper.id === format.id);
    wrappers = wrappers.filter((wrapper) => wrapper.group !== format.group);
    if (!alreadyApplied) wrappers.push(format);
  }

  wrappers = _sortWrappers(wrappers);
  const opening = wrappers.map((wrapper) => wrapper.open).join('');
  const closing = [...wrappers].reverse().map((wrapper) => wrapper.close).join('');
  const replacement = `${opening}${innerText}${closing}`;
  const selectionFrom = context.regionStart + opening.length;

  return {
    changed: value.slice(context.regionStart, context.regionEnd) !== replacement,
    reason: null,
    from: context.regionStart,
    to: context.regionEnd,
    replacement,
    selectionStart: selectionFrom,
    selectionEnd: selectionFrom + innerText.length,
  };
}
