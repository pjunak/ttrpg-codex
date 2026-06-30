import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  esc,
  escapeRe,
  norm,
  slugify,
  extractOutline,
  expandWikiLinks,
  setWikiLinkResolver,
  clearMarkdownCache,
  jaroWinkler,
  pageEditToggle,
  trapFocus,
} from '../web/js/utils.js';

import { I18n } from '../web/js/i18n.js';

describe('esc', () => {
  it('escapes the four HTML-significant characters', () => {
    assert.equal(esc('<a href="#">A&B</a>'), '&lt;a href=&quot;#&quot;&gt;A&amp;B&lt;/a&gt;');
  });
  it('coerces null/undefined to empty string', () => {
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
  });
});

describe('escapeRe', () => {
  it('escapes regex meta-characters', () => {
    assert.equal(escapeRe('a.b*c?'), 'a\\.b\\*c\\?');
  });
});

describe('norm', () => {
  it('lowercases and strips diacritics', () => {
    assert.equal(norm('Křesadlo'), 'kresadlo');
    assert.equal(norm('Šárka'), 'sarka');
    assert.equal(norm('café'), 'cafe');
  });
  it('idempotent on plain ASCII', () => {
    assert.equal(norm('hello world'), 'hello world');
  });
});

describe('slugify', () => {
  it('produces ASCII slug from Czech', () => {
    assert.equal(slugify('Křesadlo Hlubokomyslné'), 'kresadlo-hlubokomyslne');
  });
  it('caps at 80 chars', () => {
    const long = 'a'.repeat(100);
    assert.equal(slugify(long).length, 80);
  });
  it('strips punctuation', () => {
    assert.equal(slugify('Hello, World!'), 'hello-world');
  });
});

describe('extractOutline', () => {
  it('extracts ATX headings up to ###', () => {
    const md = '# A\n## B\n### C\n#### D\nplain';
    const out = extractOutline(md);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map(o => o.level), [1, 2, 3]);
    assert.deepEqual(out.map(o => o.text), ['A', 'B', 'C']);
  });

  it('disambiguates duplicate headings with -2, -3 suffixes', () => {
    const md = '# Foo\n## Foo\n## Foo';
    const out = extractOutline(md);
    assert.deepEqual(out.map(o => o.slug), ['foo', 'foo-2', 'foo-3']);
  });

  it('handles trailing # in setext-like headings', () => {
    const md = '## Section ##';
    const out = extractOutline(md);
    assert.equal(out[0].slug, 'section');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(extractOutline(''), []);
    assert.deepEqual(extractOutline(null), []);
  });
});

describe('expandWikiLinks + resolver', () => {
  it('passes through text when no resolver is set', () => {
    setWikiLinkResolver(null);
    assert.equal(expandWikiLinks('see [[Frulam]]'), 'see [[Frulam]]');
  });

  it('rewrites resolved links into markdown links', () => {
    setWikiLinkResolver((label, hint) => ({ kind: 'postava', id: 'frulam_a7b3c9' }));
    assert.equal(
      expandWikiLinks('see [[Frulam]]'),
      'see [Frulam](#/postava/frulam_a7b3c9)'
    );
  });

  it('renders unresolved links with a missing-link span', () => {
    setWikiLinkResolver(() => null);
    const out = expandWikiLinks('see [[Mystery NPC]]');
    assert.match(out, /class="wlink-missing"/);
    assert.match(out, /\[\[Mystery NPC\]\]/);
  });

  it('handles disambiguation hint syntax', () => {
    setWikiLinkResolver((label, hint) => {
      if (hint === 'postava:foo') return { kind: 'postava', id: 'foo' };
      return null;
    });
    assert.equal(
      expandWikiLinks('[[Foo|postava:foo]]'),
      '[Foo](#/postava/foo)'
    );
  });
});

describe('clearMarkdownCache', () => {
  it('exists and is callable', () => {
    assert.equal(typeof clearMarkdownCache, 'function');
    clearMarkdownCache();   // does not throw
  });
});

describe('jaroWinkler', () => {
  it('returns 1 for identical strings', () => {
    assert.equal(jaroWinkler('Frulam', 'Frulam'), 1);
  });

  it('is case- and diacritic-insensitive via norm()', () => {
    assert.equal(jaroWinkler('Křesava', 'kresava'), 1);
    assert.equal(jaroWinkler('FRULAM',  'frulam'),  1);
  });

  it('returns 0 when either input is empty', () => {
    assert.equal(jaroWinkler('', 'anything'), 0);
    assert.equal(jaroWinkler('anything', ''), 0);
    assert.equal(jaroWinkler('', ''),         0);
    assert.equal(jaroWinkler(null, 'x'),      0);
    assert.equal(jaroWinkler('x', undefined), 0);
  });

  it('ranks shared-prefix matches higher than transpositions (Winkler bonus)', () => {
    // "Frulam Mondath" shares the 6-char prefix "frulam" with the
    // query → should score above "Mondath Frulam" which has the
    // same characters but a different prefix.
    const prefix = jaroWinkler('Frulam',          'Frulam Mondath');
    const swap   = jaroWinkler('Frulam',          'Mondath Frulam');
    assert.ok(prefix > swap, `expected prefix>${swap} but got ${prefix}`);
    assert.ok(prefix > 0.8,  `prefix match should be strong: got ${prefix}`);
  });

  it('typo tolerance: single-character substitution scores high', () => {
    // "Frulan" vs "Frulam" — one substitution should remain very
    // similar (>0.9 with Winkler prefix bonus).
    const s = jaroWinkler('Frulan', 'Frulam');
    assert.ok(s > 0.9, `single-char substitution should score >0.9: got ${s}`);
  });

  it('returns 0 for entirely disjoint strings (no common chars)', () => {
    assert.equal(jaroWinkler('abc', 'xyz'), 0);
  });

  it('result stays in [0, 1]', () => {
    const samples = [
      ['frulam', 'frulam mondath'], ['kira', 'k'], ['a', 'ab'],
      ['kreseva', 'kresava'], ['', 'x'], ['martin', 'martina'],
    ];
    for (const [a, b] of samples) {
      const s = jaroWinkler(a, b);
      assert.ok(s >= 0 && s <= 1, `score out of bounds for ${JSON.stringify([a, b])}: ${s}`);
    }
  });
});

describe('pageEditToggle', () => {
  // Register tiny catalogs so t() resolves the new edit-toggle keys
  // (with {label} interpolation) instead of returning the bare key.
  I18n.register('en', {
    'action.editStart': '✏ Edit {label}',
    'action.editDone': '✓ Done',
    'action.editStartTitle': 'Turn on editing — {label}',
    'action.editStopTitle': 'Turn off editing',
  });

  it('renders the start button with interpolated label + module action', () => {
    const html = pageEditToggle({ moduleName: 'WorldMap', isEditing: false, label: 'the map' });
    assert.match(html, /data-action="WorldMap\.toggleEditing"/);
    assert.match(html, /✏ Edit the map/);
    assert.match(html, /title="Turn on editing — the map"/);
    assert.doesNotMatch(html, /is-active/);
  });

  it('renders the done button when editing', () => {
    const html = pageEditToggle({ moduleName: 'Timeline', isEditing: true, label: 'the timeline' });
    assert.match(html, /class="page-edit-toggle is-active"/);
    assert.match(html, /✓ Done/);
    assert.match(html, /title="Turn off editing"/);
  });
});

describe('trapFocus', () => {
  it('returns a callable no-op when there is no DOM (Node import safety)', () => {
    // Node test env has no `document`; trapFocus must degrade gracefully
    // so importing modules that call it at runtime never crash tests.
    const release = trapFocus(null);
    assert.equal(typeof release, 'function');
    release();           // must not throw
    release();           // idempotent
  });
});
