import { Schema, type Mark, type MarkSpec, type Node as RichNode, type NodeSpec } from "prosemirror-model";
import { schema as commonSchema, defaultMarkdownSerializer, MarkdownSerializer } from "prosemirror-markdown";
import { tableNodes } from "prosemirror-tables";
import type { Token, Tokens } from "marked";
import { parseCampaignMarkdown, safeCampaignMarkdownLink } from "./campaign-markdown.js";
import { markdownFormatClose, parseMarkdownFormat } from "./markdown-formats.js";

function formatMark(kind: string, tag = "span"): MarkSpec {
  return {
    attrs: { value: { default: "" } },
    parseDOM: [{ tag: `${tag}[data-md-${kind}]`, getAttrs: element => {
      const value = element.getAttribute(`data-md-${kind}`) ?? "";
      return parseMarkdownFormat(`<${tag} data-md-${kind}="${value}">`) ? { value } : false;
    } }],
    toDOM: mark => [tag, { [`data-md-${kind}`]: mark.attrs["value"], class: `md-${kind}-${mark.attrs["value"]}` }, 0],
  };
}

const nodes: Record<string, NodeSpec> = {
  image: { ...commonSchema.nodes.image.spec, parseDOM: [{ tag: "img[src]", getAttrs: element => {
    const src = element.getAttribute("src") ?? "";
    return safeImage(src) ? { src, alt: element.getAttribute("alt") ?? "", title: element.getAttribute("title") } : false;
  } }] },
  wiki: {
    inline: true, group: "inline", atom: true, attrs: { label: {}, hint: { default: "" } },
    parseDOM: [{ tag: "span[data-md-wiki-label]", getAttrs: element => {
      const label = element.getAttribute("data-md-wiki-label") ?? "", hint = element.getAttribute("data-md-wiki-hint") ?? "";
      return /^[^\[\]|\n]{1,200}$/u.test(label) && /^[^\]\n]{0,300}$/u.test(hint) ? { label, hint } : false;
    } }],
    toDOM: node => ["span", { class: "wiki-link writer-wiki-link", "data-md-wiki-label": node.attrs["label"], "data-md-wiki-hint": node.attrs["hint"] }, String(node.attrs["label"])],
  },
  raw_inline: {
    inline: true, group: "inline", atom: true, attrs: { source: {} },
    parseDOM: [{ tag: 'code[data-md-raw="inline"]', getAttrs: element => ({ source: element.textContent ?? "" }) }],
    toDOM: node => ["code", { class: "writer-raw-inline", "data-md-raw": "inline" }, String(node.attrs["source"])],
  },
  raw_block: {
    group: "block", atom: true, attrs: { source: {} },
    parseDOM: [{ tag: 'pre[data-md-raw="block"]', priority: 60, getAttrs: element => ({ source: element.textContent ?? "" }) }],
    toDOM: node => ["pre", { class: "writer-raw-block", "data-md-raw": "block" }, String(node.attrs["source"])],
  },
  ...tableNodes({ tableGroup: "block", cellContent: "paragraph+", cellAttributes: {
    align: { default: null, getFromDOM: element => ["left", "center", "right"].includes(element.style.textAlign) ? element.style.textAlign : null,
      setDOMAttr: (value, attrs) => { if (["left", "center", "right"].includes(String(value))) attrs["class"] = `table-align-${value}`; } },
  } }),
};

export const richMarkdownSchema = new Schema({
  nodes: commonSchema.spec.nodes.append(nodes),
  marks: commonSchema.spec.marks.update("link", {
    ...commonSchema.marks.link.spec,
    parseDOM: [{ tag: "a[href]", getAttrs: element => {
      const href = element.getAttribute("href") ?? "";
      return safeCampaignMarkdownLink(href) ? { href, title: element.getAttribute("title") } : false;
    } }],
  }).append({
    strike: { parseDOM: [{ tag: "del" }, { tag: "s" }], toDOM: () => ["del", 0] },
    color: formatMark("color"), highlight: formatMark("highlight", "mark"), effect: formatMark("effect"),
    size: formatMark("size"), font: formatMark("font"), align: formatMark("align"),
    sup: { parseDOM: [{ tag: "sup" }], toDOM: () => ["sup", 0] },
    sub: { parseDOM: [{ tag: "sub" }], toDOM: () => ["sub", 0] },
  }),
});

const formatSerializers = Object.fromEntries(["color", "highlight", "effect", "size", "font", "align"].map(kind => [kind, {
  open: (_state: unknown, mark: Mark) => `<${kind === "highlight" ? "mark" : "span"} data-md-${kind}="${String(mark.attrs["value"])}">`,
  close: kind === "highlight" ? "</mark>" : "</span>", mixable: true, expelEnclosingWhitespace: true,
}]));

export const richMarkdownSerializer = new MarkdownSerializer({
  ...defaultMarkdownSerializer.nodes,
  wiki: (state, node) => state.write(`[[${node.attrs["label"]}${node.attrs["hint"] ? `|${node.attrs["hint"]}` : ""}]]`),
  raw_inline: (state, node) => state.write(String(node.attrs["source"])),
  raw_block: (state, node) => { state.write(String(node.attrs["source"])); state.closeBlock(node); },
  table: (state, node) => {
    const rows: string[][] = [];
    node.forEach(row => {
      const cells: string[] = [];
      row.forEach(cell => cells.push(richMarkdownSerializer.serialize(richMarkdownSchema.node("doc", null, cell.content))
        .replace(/\n+/gu, "<br>").replace(/(?<!\\)\|/gu, "\\|")));
      rows.push(cells);
    });
    if (rows.length) {
      state.write(`| ${rows[0]!.join(" | ")} |\n`);
      const aligns: string[] = [];
      node.firstChild?.forEach(cell => aligns.push(cell.attrs["align"] === "center" ? ":---:" : cell.attrs["align"] === "right" ? "---:" : "---"));
      state.write(`| ${aligns.join(" | ")} |\n`);
      for (const row of rows.slice(1)) state.write(`| ${row.join(" | ")} |\n`);
    }
    state.closeBlock(node);
  },
}, {
  ...defaultMarkdownSerializer.marks, ...formatSerializers,
  strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  sup: { open: "<sup>", close: "</sup>" }, sub: { open: "<sub>", close: "</sub>" },
});

export interface RichMarkdownDocument {
  readonly doc: RichNode;
  readonly originals: WeakMap<RichNode, string>;
}

/** Keep unknown syntax as source nodes, and retain untouched top-level blocks verbatim. */
export function parseRichMarkdown(source: string): RichMarkdownDocument {
  const originals = new WeakMap<RichNode, string>();
  const tokens = parseCampaignMarkdown(source).tokens;
  const children: RichNode[] = [];
  for (const token of tokens) {
    if (token.type === "space") continue;
    let node: RichNode;
    try { node = block(token); }
    catch { node = richMarkdownSchema.node("raw_block", { source: token.raw }); }
    originals.set(node, token.raw);
    children.push(node);
  }
  if (!children.length) children.push(richMarkdownSchema.node("paragraph"));
  return { doc: richMarkdownSchema.node("doc", null, children), originals };
}

export function serializeRichMarkdown(doc: RichNode, originals?: WeakMap<RichNode, string>): string {
  const blocks: string[] = [];
  doc.forEach(node => blocks.push(originals?.get(node) ?? richMarkdownSerializer.serialize(richMarkdownSchema.node("doc", null, node))));
  return blocks.map(value => value.replace(/\n+$/u, "")).join("\n\n");
}

function block(token: Token): RichNode {
  const schema = richMarkdownSchema;
  switch (token.type) {
    case "paragraph": case "text": {
      const text = token as Tokens.Paragraph;
      return schema.node("paragraph", null, text.tokens ? inline(text.tokens) : text.text ? schema.text(text.text) : []);
    }
    case "heading": {
      const heading = token as Tokens.Heading;
      return schema.node("heading", { level: heading.depth }, inline(heading.tokens));
    }
    case "code": return schema.node("code_block", { params: (token as Tokens.Code).lang ?? "" }, token.text ? schema.text(token.text) : []);
    case "hr": return schema.node("horizontal_rule");
    case "blockquote": return schema.node("blockquote", null, (token as Tokens.Blockquote).tokens.filter(t => t.type !== "space").map(block));
    case "list": {
      const list = token as Tokens.List;
      // Task-list source retains its checked state until a dedicated task-list control edits it.
      if (list.items.some(item => item.task)) return schema.node("raw_block", { source: token.raw });
      return schema.node(list.ordered ? "ordered_list" : "bullet_list", { order: list.start || 1, tight: !list.loose }, list.items.map(item => {
        const content = item.tokens.filter(t => t.type !== "space").map(block);
        if (content[0]?.type.name !== "paragraph") content.unshift(schema.node("paragraph"));
        return schema.node("list_item", null, content);
      }));
    }
    case "table": {
      const table = token as Tokens.Table;
      const row = (cells: readonly Tokens.TableCell[], header: boolean) => schema.node("table_row", null, cells.map((cell, index) =>
        schema.node(header ? "table_header" : "table_cell", { align: table.align[index] ?? null }, schema.node("paragraph", null, inline(cell.tokens)))));
      return schema.node("table", null, [row(table.header, true), ...table.rows.map(cells => row(cells, false))]);
    }
    default: return schema.node("raw_block", { source: token.raw });
  }
}

function inline(tokens: readonly Token[], marks: readonly Mark[] = []): RichNode[] {
  const schema = richMarkdownSchema;
  const result: RichNode[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    const format = token.type === "html" ? parseMarkdownFormat(token.raw.trim()) : undefined;
    if (format) {
      const end = markdownFormatClose(tokens, index + 1, format.tag);
      if (end !== -1) {
        result.push(...inline(tokens.slice(index + 1, end), [...marks, schema.mark(format.mark, format.value ? { value: format.value } : null)]));
        index = end; continue;
      }
    }
    if (token.type === "campaign-wiki-link") {
      const wiki = token as Tokens.Generic;
      result.push(schema.node("wiki", { label: wiki["label"], hint: wiki["hint"] ?? "" }, undefined, marks)); continue;
    }
    switch (token.type) {
      case "text": case "escape": {
        const text = token as Tokens.Text;
        if (text.tokens) result.push(...inline(text.tokens, marks));
        else if (text.text) result.push(schema.text(text.text, marks));
        break;
      }
      case "strong": case "em": case "del": {
        const emphasis = token as Tokens.Strong;
        result.push(...inline(emphasis.tokens, [...marks, schema.mark(token.type === "del" ? "strike" : token.type)])); break;
      }
      case "codespan": if ((token as Tokens.Codespan).text) result.push(schema.text((token as Tokens.Codespan).text, [...marks, schema.mark("code")])); break;
      case "br": result.push(schema.node("hard_break", null, undefined, marks)); break;
      case "link": {
        const link = token as Tokens.Link;
        if (safeCampaignMarkdownLink(link.href)) result.push(...inline(link.tokens, [...marks, schema.mark("link", { href: link.href, title: link.title })]));
        else result.push(schema.node("raw_inline", { source: token.raw }, undefined, marks));
        break;
      }
      case "image": {
        const image = token as Tokens.Image;
        result.push(safeImage(image.href) ? schema.node("image", { src: image.href, alt: image.text, title: image.title }, undefined, marks)
          : schema.node("raw_inline", { source: token.raw }, undefined, marks)); break;
      }
      case "html":
        result.push(/^<br\s*\/?>$/iu.test(token.raw.trim()) ? schema.node("hard_break", null, undefined, marks)
          : schema.node("raw_inline", { source: token.raw }, undefined, marks)); break;
      default: result.push(schema.node("raw_inline", { source: token.raw }, undefined, marks));
    }
  }
  return result;
}

function safeImage(src: string): boolean {
  const safe = safeCampaignMarkdownLink(src);
  return safe !== undefined && !safe.href.startsWith("mailto:") && !safe.href.startsWith("#/");
}
