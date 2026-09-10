import { describe, expect, it } from "vitest";
import { EditorState } from "prosemirror-state";
import { parseRichMarkdown, serializeRichMarkdown, richMarkdownSchema as schema } from "../src/app/rich-markdown.js";
import { parseCampaignMarkdown } from "../src/app/campaign-markdown.js";

describe("formatted Markdown editing", () => {
  it("opens incomplete source as editable text without crashing", () => {
    for (const source of [">", ">\n>\n", "- ", "1.\n", "<span data-md-color=\"info\">", "```", "| A |\n| --- |", "\n\n"]) {
      expect(() => parseRichMarkdown(source).doc.check()).not.toThrow();
    }
  });
  it("retains untouched source including unsupported blocks and reference definitions", () => {
    const source = '# Title\n\nA paragraph.\n\n- [x] Original task\n\n[reference]: https://example.com\n\n[Original reference][reference]\n\n<custom-widget id="original">\nKeep this.\n</custom-widget>';
    const parsed = parseRichMarkdown(source);
    const state = EditorState.create({ doc: parsed.doc });
    const next = state.tr.insertText("New ", 1).doc;
    const output = serializeRichMarkdown(next, parsed.originals);
    expect(output).toContain('# New Title');
    expect(output).toContain('- [x] Original task');
    expect(output).toContain('[reference]: https://example.com');
    expect(output).toContain('[Original reference][reference]');
    expect(output).toContain('<custom-widget id="original">\nKeep this.\n</custom-widget>');
  });

  it("round trips rich marks, campaign references, images, lists and tables", () => {
    const source = 'A **bold** [link](https://example.com) and [[Scout|character:scout]].\n\n<span data-md-color="info"><span data-md-size="24">Blue text</span></span>\n\n| Name | Note |\n| --- | :---: |\n| Ally | **Safe** |\n\n1. First\n2. Second\n\n![Portrait](https://example.com/p.png)';
    const parsed = parseRichMarkdown(source);
    const output = serializeRichMarkdown(parsed.doc);
    expect(parseRichMarkdown(output).doc.eq(parsed.doc)).toBe(true);
    expect(output).toContain('[[Scout|character:scout]]');
    expect(output).toContain('data-md-size="24"');
    expect(parseCampaignMarkdown(output).tokens.some(token => token.type === "table")).toBe(true);
  });

  it("keeps unsafe and unknown HTML inert instead of turning it into editor DOM", () => {
    const parsed = parseRichMarkdown('Hello <span onclick="alert(1)">world</span> [bad](javascript:alert) ![bad](javascript:alert)');
    const nodes: string[] = [];
    parsed.doc.descendants(node => { nodes.push(node.type.name); expect(node.marks.some(mark => mark.type.name === "link")).toBe(false); });
    expect(nodes).toContain("raw_inline");
    expect(nodes).not.toContain("image");
    expect(serializeRichMarkdown(parsed.doc)).toContain('onclick="alert(1)"');
  });

  it("writes semantic marks without requiring arbitrary HTML or CSS", () => {
    const source = parseRichMarkdown('Selected text');
    const tr = EditorState.create({ doc: source.doc }).tr
      .addMark(1, 9, schema.mark('color', { value: 'danger' }))
      .addMark(1, 9, schema.mark('font', { value: 'sans' }));
    const output = serializeRichMarkdown(tr.doc, source.originals);
    expect(output).toContain('data-md-color="danger"');
    expect(parseRichMarkdown(output).doc.eq(tr.doc)).toBe(true);
  });
});
