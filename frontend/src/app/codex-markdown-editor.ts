import { LitElement, html, nothing, type TemplateResult } from "lit";
import { EditorState, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { baseKeymap, chainCommands, setBlockType, toggleMark, wrapIn, lift } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { wrapInList, splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { tableEditing, addRowAfter, addColumnAfter, deleteTable } from "prosemirror-tables";
import { parseRichMarkdown, serializeRichMarkdown, richMarkdownSchema as schema } from "./rich-markdown.js";
import { markdownColors, markdownHighlights, markdownEffects, markdownSizes } from "./markdown-formats.js";
import { parseCampaignMarkdown, renderCampaignMarkdown, safeCampaignMarkdownLink, type CampaignMarkdownContext } from "./campaign-markdown.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";

type Mode = "formatted" | "markdown" | "preview";
let writerID = 0;

export class CodexMarkdownEditor extends LitElement {
  static override properties = {
    value: { type: String }, name: { type: String }, label: { type: String }, identity: { type: String },
    context: { attribute: false }, disabled: { type: Boolean }, maximumLength: { type: Number }, saveLabel: { type: String },
    mode: { state: true }, split: { state: true }, expanded: { state: true }, menu: { state: true }, issue: { state: true },
  };
  declare value: string;
  declare name: string;
  declare label: string;
  declare identity: string;
  declare context: CampaignMarkdownContext | undefined;
  declare disabled: boolean;
  declare maximumLength: number;
  declare saveLabel: string | undefined;
  declare private mode: Mode;
  declare private split: boolean;
  declare private expanded: boolean;
  declare private menu: string;
  declare private issue: string;
  readonly #id = `wiki-writer-${++writerID}`;
  readonly #ui = new UiLocalizationController(this);
  #view: EditorView | undefined;
  #originals = new WeakMap<import("prosemirror-model").Node, string>();
  #richValue = "";
  #lastEmitted = "";
  #sourceSelection = { from: 0, to: 0 };
  #returnFocus: HTMLElement | undefined;

  constructor() {
    super(); this.value = ""; this.name = "description"; this.label = ""; this.identity = "";
    this.disabled = false; this.maximumLength = 200_000; this.mode = "formatted";
    this.split = false; this.expanded = false; this.menu = ""; this.issue = "";
  }
  protected override createRenderRoot() { return this; }
  override disconnectedCallback(): void { this.#view?.destroy(); this.#view = undefined; super.disconnectedCallback(); }
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (!this.#view) this.#mount();
    else if (changed.has("identity") || changed.has("value") && this.value !== this.#lastEmitted && this.value !== this.#richValue) this.#loadRich();
    this.#view?.setProps({ editable: () => !this.disabled, attributes: { "aria-label": this.label || uiText("Wiki text"), "aria-multiline": "true", role: "textbox" } });
    if (this.disabled) this.menu = "";
    const dialog = this.querySelector<HTMLDialogElement>("dialog");
    if (dialog && !dialog.open) dialog.show();
  }

  #mount(): void {
    const target = this.querySelector<HTMLElement>(".writer-rich");
    if (!target) return;
    const parsed = parseRichMarkdown(this.value); this.#originals = parsed.originals; this.#richValue = this.value;
    this.#view = new EditorView(target, {
      state: this.#state(parsed.doc),
      dispatchTransaction: transaction => {
        const view = this.#view;
        if (!view || this.disabled) return;
        const next = view.state.apply(transaction);
        if (transaction.docChanged) {
          const source = serializeRichMarkdown(next.doc, this.#originals);
          if (source.length > this.maximumLength) { this.issue = uiText("The text is too long."); return; }
          view.updateState(next); this.#richValue = source; this.#change(source);
        } else { view.updateState(next); this.requestUpdate(); }
      },
      handleDOMEvents: { click: (_view, event) => { if ((event.target as Element).closest("a")) { event.preventDefault(); return true; } return false; } },
    });
    this.requestUpdate();
  }
  #state(doc: import("prosemirror-model").Node): EditorState {
    return EditorState.create({ doc, plugins: [history(), keymap({
      "Mod-z": undo, "Mod-y": redo, "Mod-Shift-z": redo,
      "Mod-b": toggleMark(schema.marks["strong"]!), "Mod-i": toggleMark(schema.marks["em"]!),
      "Mod-u": toggleMark(schema.marks["effect"]!, { value: "underline" }),
      Enter: chainCommands(splitListItem(schema.nodes["list_item"]!), baseKeymap["Enter"]!),
      Tab: sinkListItem(schema.nodes["list_item"]!), "Shift-Tab": liftListItem(schema.nodes["list_item"]!),
    }), keymap(baseKeymap), tableEditing()] });
  }
  #loadRich(): void {
    const parsed = parseRichMarkdown(this.value); this.#originals = parsed.originals; this.#richValue = this.value;
    this.#view?.updateState(this.#state(parsed.doc));
  }
  #change(source: string): void {
    this.value = source; this.#lastEmitted = source; this.issue = "";
    this.dispatchEvent(new CustomEvent("markdown-change", { detail: { value: source }, bubbles: true, composed: true }));
  }
  public focusEditor(): void { if (this.mode === "markdown") this.querySelector<HTMLTextAreaElement>(".writer-source")?.focus(); else this.#view?.focus(); }

  protected override render() {
    return html`<dialog class=${`writer-dialog ${this.expanded ? "writer-expanded" : "writer-inline"}`}
      aria-label=${this.label || uiText("Wiki text")} @cancel=${this.#cancelDialog} @keydown=${this.#keyDown}>
      <div class="writer-heading"><span>${this.label}</span><button type="button" class="writer-expand" ?disabled=${this.disabled}
        @click=${this.#expand}>${this.expanded ? uiText("Back to character") : uiText("Expand writer")}</button></div>
      <div class="writer-tools-wrap" @focusout=${this.#menuBlur}>
        <div class="writer-toolbar" role="group" aria-label=${uiText("Text formatting")} @pointerdown=${this.#rememberSource}>
          ${this.#button("↶", "Undo", () => this.#command(undo), "writer-optional", this.mode !== "formatted")}
          ${this.#button("↷", "Redo", () => this.#command(redo), "writer-optional", this.mode !== "formatted")}
          <select aria-label=${uiText("Text style")} ?disabled=${this.disabled || this.mode === "preview"}
            @change=${this.#blockStyle} .value=${this.#blockValue()}>
            <option value="paragraph">${uiText("Normal text")}</option>
            ${[1, 2, 3, 4, 5, 6].map(level => html`<option value=${String(level)}>${uiText("Heading {0}", { "0": level })}</option>`)}
            <option value="blockquote">${uiText("Quote")}</option><option value="code_block">${uiText("Code block")}</option>
          </select>
          <select class="writer-optional" aria-label=${uiText("Font family")} ?disabled=${this.disabled || this.mode === "preview"}
            @change=${(event: Event) => this.#format("font", (event.target as HTMLSelectElement).value)} .value=${this.#markValue("font", "serif")}>
            <option value="serif">Lora</option><option value="sans">Inter</option><option value="mono">Mono</option>
          </select>
          <select class="writer-size" aria-label=${uiText("Text size")} ?disabled=${this.disabled || this.mode === "preview"}
            @change=${(event: Event) => this.#format("size", (event.target as HTMLSelectElement).value)} .value=${this.#markValue("size", "16")}>
            ${markdownSizes.map(size => html`<option value=${String(size)} ?selected=${String(size) === this.#markValue("size", "16")}>${size}</option>`)}
          </select><span class="writer-separator writer-optional" aria-hidden="true"></span>
          ${this.#button(html`<b>B</b>`, "Bold", () => this.#format("strong"))}
          ${this.#button(html`<i>I</i>`, "Italic", () => this.#format("em"), "writer-secondary")}
          ${this.#button(html`<u>U</u>`, "Underline", () => this.#format("effect", "underline"), "writer-optional")}
          ${this.#menuButton(html`<span class="writer-color-icon">A</span>⌄`, "Text color", "color", "writer-color-menu")}
          ${this.#menuButton("▰⌄", "Highlight", "highlight", "writer-secondary")}
          ${this.#menuButton("≡⌄", "Lists and insert", "insert", "writer-optional")}
          ${this.#menuButton("⋯", "More formatting", "more")}
          <span class="writer-toolbar-space"></span>
          <select class="writer-mode" aria-label=${uiText("Editor view")} .value=${this.mode} @change=${(e: Event) => this.#setMode((e.target as HTMLSelectElement).value as Mode)}>
            <option value="formatted">${uiText("Formatted")}</option><option value="markdown">Markdown</option><option value="preview">${uiText("Preview")}</option>
          </select>
          <button type="button" class="writer-secondary" title=${uiText("Side by side")} aria-label=${uiText("Side by side")}
            aria-pressed=${this.split} @click=${() => { this.split = !this.split; if (this.split && this.mode === "preview") this.#setMode("formatted"); }}>◫</button>
        </div>
        ${this.menu ? html`<div class="writer-menu" id=${`${this.#id}-menu`} role="group" aria-label=${uiText("Text formatting")}>
          ${this.#menuContent()}<button type="button" class="writer-menu-close" @click=${this.#closeMenu}>${uiText("Close")}</button></div>` : nothing}
      </div>
      <div class=${`writer-panes ${this.split ? "is-split" : ""}`} @pointerdown=${() => { this.menu = ""; }}>
        <div class="writer-writing" ?hidden=${this.mode === "preview"}>
          <div class="writer-rich campaign-markdown" ?hidden=${this.mode !== "formatted"}></div>
          <textarea class="writer-source" id=${`${this.#id}-source`} aria-label=${`${this.label} Markdown`} name=${this.name}
            ?hidden=${this.mode !== "markdown"} ?disabled=${this.disabled} .value=${this.value} maxlength=${this.maximumLength}
            @input=${this.#sourceInput} @select=${this.#rememberSource} @keyup=${this.#rememberSource}></textarea>
        </div>
        <div class="writer-preview" ?hidden=${!this.split && this.mode !== "preview"} aria-label=${uiText("Article preview")}>
          ${this.context ? renderCampaignMarkdown(parseCampaignMarkdown(this.value), this.context) : nothing}
        </div>
      </div>
      ${this.issue ? html`<p class="writer-issue" role="alert">${this.issue}</p>` : nothing}
      ${this.expanded ? html`<footer class="writer-expanded-actions"><button type="button" @click=${this.#expand}>${uiText("Back to character")}</button>
        <button type="button" class="primary-record-action" ?disabled=${this.disabled} @click=${this.#requestSave}>${this.saveLabel || uiText("Save text")}</button></footer>` : nothing}
    </dialog>`;
  }
  #button(content: string | TemplateResult, label: Parameters<typeof uiText>[0], click: () => void, className = "", disabled = false) {
    const mark = ({ Bold: "strong", Italic: "em", Underline: "effect", Strikethrough: "strike", Superscript: "sup", Subscript: "sub" } as Record<string, string>)[label];
    const active = mark ? this.#selectionMarks().some(item => item.type.name === mark && (label !== "Underline" || item.attrs["value"] === "underline")) : false;
    return html`<button type="button" class=${className} aria-label=${uiText(label)} title=${uiText(label)}
      aria-pressed=${mark && this.mode === "formatted" ? active : nothing}
      ?disabled=${disabled || this.disabled || this.mode === "preview"} @click=${click}>${content}</button>`;
  }
  #menuButton(content: string | TemplateResult, label: Parameters<typeof uiText>[0], menu: string, className = "") {
    return html`<button type="button" class=${className} aria-label=${uiText(label)} title=${uiText(label)} aria-expanded=${this.menu === menu}
      aria-controls=${`${this.#id}-menu`} ?disabled=${this.disabled || this.mode === "preview"}
      @click=${() => { this.menu = this.menu === menu ? "" : menu; }}>${content}</button>`;
  }
  #menuContent() {
    if (this.menu === "color" || this.menu === "highlight") {
      const kind = this.menu;
      return html`<div class="writer-color-grid"><button type="button" @click=${() => this.#format(kind, "")}>${uiText("Default")}</button>
        ${(kind === "color" ? markdownColors : markdownHighlights).map(color => html`<button type="button" @click=${() => this.#format(kind, color)}>
          <span class=${`writer-swatch md-color-${color}`} aria-hidden="true">●</span>${uiText(colorLabels[color])}</button>`)}</div>`;
    }
    if (this.menu === "link" || this.menu === "image" || this.menu === "wiki") return html`
      <label>${uiText(this.menu === "wiki" ? "Campaign link" : "URL")}<input class="writer-insert-url" aria-label=${uiText(this.menu === "wiki" ? "Campaign link" : "URL")} /></label>
      <label>${uiText(this.menu === "image" ? "Alternative text" : "Label")}<input class="writer-insert-label" /></label>
      <button type="button" @click=${this.#insertLink}>${uiText("Insert")}</button>`;
    if (this.menu === "insert") return html`
      ${this.#button(uiText("Bullet list"), "Bullet list", () => this.#list(false))}
      ${this.#button(uiText("Numbered list"), "Numbered list", () => this.#list(true))}
      ${["wiki", "link", "image"].map(kind => html`<button type="button" @click=${() => { this.menu = kind; }}>${uiText(kind === "wiki" ? "Campaign link" : kind === "link" ? "Link" : "Image")}</button>`)}
      ${this.#button(uiText("Table"), "Table", this.#insertTable)}
      ${this.#button(uiText("Add row"), "Add row", () => this.#command(addRowAfter))}
      ${this.#button(uiText("Add column"), "Add column", () => this.#command(addColumnAfter))}
      ${this.#button(uiText("Delete table"), "Delete table", () => this.#command(deleteTable))}
      ${this.#button(uiText("Divider"), "Divider", () => this.#insertBlock("horizontal_rule", "\n\n---\n\n"))}`;
    return html`
      <label>${uiText("Text size")}<select @change=${(e: Event) => this.#format("size", (e.target as HTMLSelectElement).value)}>
        ${markdownSizes.map(size => html`<option value=${String(size)} ?selected=${String(size) === this.#markValue("size", "16")}>${size}</option>`)}</select></label>
      <label>${uiText("Font family")}<select @change=${(e: Event) => this.#format("font", (e.target as HTMLSelectElement).value)}><option value="serif">Lora</option><option value="sans">Inter</option><option value="mono">Mono</option></select></label>
      <div class="writer-menu-row">${this.#button("I", "Italic", () => this.#format("em"))}${this.#button("U", "Underline", () => this.#format("effect", "underline"))}
        ${this.#button("S̶", "Strikethrough", () => this.#format("strike"))}${this.#button("x²", "Superscript", () => this.#format("sup"))}${this.#button("x₂", "Subscript", () => this.#format("sub"))}</div>
      <select aria-label=${uiText("Text effect")} @change=${(e: Event) => this.#format("effect", (e.target as HTMLSelectElement).value)}>
        <option value="">${uiText("Text effect")}</option>${markdownEffects.map(effect => html`<option value=${effect}>${uiText(effectLabels[effect])}</option>`)}</select>
      <div class="writer-menu-row">${["left", "center", "right"].map(align => this.#button(align === "left" ? "≡←" : align === "center" ? "≡" : "→≡", align === "left" ? "Align left" : align === "center" ? "Center" : "Align right", () => this.#format("align", align)))}</div>
      <button type="button" @click=${() => { this.menu = "insert"; }}>${uiText("Lists and insert")}</button>
      <button type="button" @click=${() => { this.menu = "highlight"; }}>${uiText("Highlight")}</button>
      <button type="button" @click=${() => { this.menu = "color"; }}>${uiText("Text color")}</button>
      <button type="button" @click=${() => { this.split = !this.split; this.menu = ""; }}>${uiText("Side by side")}</button>
      ${this.#button(uiText("Undo"), "Undo", () => this.#command(undo), "", this.mode !== "formatted")}
      ${this.#button(uiText("Redo"), "Redo", () => this.#command(redo), "", this.mode !== "formatted")}
      ${this.#button(uiText("Clear formatting"), "Clear formatting", this.#clearFormatting)}`;
  }
  #markValue(name: string, fallback: string): string {
    return String(this.#selectionMarks().find(mark => mark.type.name === name)?.attrs["value"] ?? fallback);
  }
  #selectionMarks(): readonly import("prosemirror-model").Mark[] {
    const state = this.#view?.state; if (!state) return [];
    if (state.storedMarks) return state.storedMarks;
    if (state.selection.empty) return state.selection.$from.marks();
    let marks: readonly import("prosemirror-model").Mark[] | undefined;
    state.doc.nodesBetween(state.selection.from, state.selection.to, node => { if (marks) return false; if (node.isInline) marks = node.marks; return marks === undefined; });
    return marks ?? [];
  }
  #blockValue(): string { const parent = this.#view?.state.selection.$from.parent; return parent?.type.name === "heading" ? String(parent.attrs["level"]) : parent?.type.name ?? "paragraph"; }
  #command(command: Command): void { if (this.disabled) return; const view = this.#view; if (this.mode !== "formatted" || !view) return; command(view.state, view.dispatch, view); view.focus(); this.menu = ""; }
  #format(kind: string, value?: string): void {
    if (this.disabled) return;
    if (this.mode === "markdown") {
      const pair = kind === "strong" ? ["**", "**"] : kind === "em" ? ["*", "*"] : kind === "strike" ? ["~~", "~~"]
        : kind === "sup" || kind === "sub" ? [`<${kind}>`, `</${kind}>`]
          : [`<${kind === "highlight" ? "mark" : "span"} data-md-${kind}="${value}">`, kind === "highlight" ? "</mark>" : "</span>"];
      if (value === "") { this.issue = uiText("Use Clear formatting in the formatted view."); this.menu = ""; return; }
      this.#sourceWrap(pair[0]!, pair[1]!); return;
    }
    const view = this.#view; const type = schema.marks[kind]; if (!view || !type) return;
    if (value === "" || kind === "effect" && value === "underline" && this.#markValue("effect", "") === "underline") { const { from, to } = view.state.selection; view.dispatch(view.state.tr.removeMark(from, to, type).removeStoredMark(type)); }
    else if (value !== undefined) {
      const { from, to, empty } = view.state.selection;
      const mark = type.create({ value });
      view.dispatch(empty ? view.state.tr.addStoredMark(mark) : view.state.tr.addMark(from, to, mark));
    } else this.#command(toggleMark(type));
    this.menu = ""; view.focus();
  }
  readonly #blockStyle = (e: Event): void => {
    const value = (e.target as HTMLSelectElement).value;
    if (this.mode === "markdown") {
      if (value === "code_block") this.#sourceWrap("\n```\n", "\n```\n");
      else this.#sourcePrefix(value === "blockquote" ? "> " : /^\d$/u.test(value) ? "#".repeat(Number(value)) + " " : "");
      return;
    }
    if (value === "paragraph" && this.#inside("blockquote")) this.#command(lift);
    if (value === "blockquote") this.#command(this.#inside("blockquote") ? lift : wrapIn(schema.nodes["blockquote"]!));
    else this.#command(setBlockType(schema.nodes[/^\d$/u.test(value) ? "heading" : value]!, /^\d$/u.test(value) ? { level: Number(value) } : null));
  };
  #inside(name: string): boolean { const position = this.#view?.state.selection.$from; if (!position) return false; for (let depth = position.depth; depth > 0; depth--) if (position.node(depth).type.name === name) return true; return false; }
  #list(ordered: boolean): void { if (this.mode === "markdown") this.#sourcePrefix(ordered ? "1. " : "- "); else this.#command(this.#inside(ordered ? "ordered_list" : "bullet_list") ? liftListItem(schema.nodes["list_item"]!) : wrapInList(schema.nodes[ordered ? "ordered_list" : "bullet_list"]!)); }
  #sourceWrap(before: string, after: string): void {
    const { from, to } = this.#sourceSelection; this.#sourceReplace(before + this.value.slice(from, to) + after, from + before.length, to + before.length);
  }
  #sourcePrefix(prefix: string): void {
    const { from, to } = this.#sourceSelection;
    const start = this.value.lastIndexOf("\n", from - 1) + 1; let end = this.value.indexOf("\n", to); if (end < 0) end = this.value.length;
    const lines = this.value.slice(start, end).split("\n").map(line => prefix + line.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/u, "")).join("\n");
    this.#sourceSelection = { from: start, to: end }; this.#sourceReplace(lines, start, start + lines.length);
  }
  #sourceReplace(text: string, from?: number, to?: number): void {
    if (this.disabled) return;
    const selection = this.#sourceSelection;
    const source = this.value.slice(0, selection.from) + text + this.value.slice(selection.to);
    if (source.length > this.maximumLength) { this.issue = uiText("The text is too long."); return; }
    this.#change(source); this.menu = "";
    void this.updateComplete.then(() => { const area = this.querySelector<HTMLTextAreaElement>(".writer-source"); area?.focus(); area?.setSelectionRange(from ?? selection.from + text.length, to ?? selection.from + text.length); this.#rememberSource(); });
  }
  readonly #rememberSource = (): void => { const area = this.querySelector<HTMLTextAreaElement>(".writer-source"); if (this.mode === "markdown" && area) this.#sourceSelection = { from: area.selectionStart, to: area.selectionEnd }; };
  readonly #sourceInput = (e: Event): void => { this.#rememberSource(); this.#change((e.target as HTMLTextAreaElement).value); };
  #setMode(mode: Mode): void { if (mode === "formatted" && this.value !== this.#richValue) this.#loadRich(); this.mode = mode; this.menu = ""; if (mode === "preview") this.split = false; }
  readonly #clearFormatting = (): void => { if (this.mode === "markdown") { this.issue = uiText("Use Clear formatting in the formatted view."); return; } const view = this.#view; if (!view) return; const { from, to } = view.state.selection; view.dispatch(view.state.tr.removeMark(from, to).setStoredMarks([])); this.#command(lift); this.menu = ""; };
  readonly #insertLink = (): void => {
    const href = this.querySelector<HTMLInputElement>(".writer-insert-url")?.value.trim() ?? "";
    const label = this.querySelector<HTMLInputElement>(".writer-insert-label")?.value.trim() ?? "";
    const kind = this.menu;
    if (kind === "wiki" ? !/^[^\[\]\n]{1,200}$/u.test(href) : !safeCampaignMarkdownLink(href) || kind === "image" && /^(?:mailto:|#\/)/u.test(href)) {
      this.issue = uiText("Enter a valid link."); return;
    }
    if (this.mode === "markdown") { this.#sourceReplace(kind === "wiki" ? `[[${href}]]` : `${kind === "image" ? "!" : ""}[${label.replace(/[\[\]]/gu, "")}](${href.replace(/\)/gu, "%29")})`); return; }
    const view = this.#view; if (!view) return;
    if (kind === "wiki") {
      const [name, ...hint] = href.split("|"); view.dispatch(view.state.tr.replaceSelectionWith(schema.node("wiki", { label: name, hint: hint.join("|") })));
    } else if (kind === "image") view.dispatch(view.state.tr.replaceSelectionWith(schema.node("image", { src: href, alt: label })));
    else if (view.state.selection.empty) view.dispatch(view.state.tr.replaceSelectionWith(schema.text(label || href, [schema.mark("link", { href })])));
    else view.dispatch(view.state.tr.addMark(view.state.selection.from, view.state.selection.to, schema.mark("link", { href })));
    this.menu = ""; view.focus();
  };
  #insertBlock(type: string, source: string): void { if (this.mode === "markdown") { this.#sourceReplace(source); return; } const view = this.#view; if (view) view.dispatch(view.state.tr.replaceSelectionWith(schema.node(type))); this.menu = ""; view?.focus(); }
  readonly #insertTable = (): void => {
    if (this.mode === "markdown") { this.#sourceReplace("\n\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\n"); return; }
    const cell = (header: boolean) => schema.node(header ? "table_header" : "table_cell", null, schema.node("paragraph"));
    const table = schema.node("table", null, [schema.node("table_row", null, [cell(true), cell(true)]), schema.node("table_row", null, [cell(false), cell(false)])]);
    const view = this.#view; if (view) view.dispatch(view.state.tr.replaceSelectionWith(table)); this.menu = ""; view?.focus();
  };
  readonly #expand = async (): Promise<void> => {
    const dialog = this.querySelector<HTMLDialogElement>("dialog"); if (!dialog) return;
    const expanding = !this.expanded;
    if (expanding) this.#returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.expanded = expanding; this.menu = ""; if (expanding) this.split = true;
    if (expanding && this.mode === "preview") this.#setMode("formatted");
    dialog.close(); await this.updateComplete;
    if (!this.isConnected) return;
    // showModal requires a closed dialog; updated() also opens the ordinary inline surface.
    if (dialog.open) dialog.close();
    if (expanding) dialog.showModal(); else { dialog.show(); this.#returnFocus?.focus(); }
  };
  readonly #cancelDialog = (e: Event): void => { e.preventDefault(); if (this.menu) this.#closeMenu(); else if (this.expanded) void this.#expand(); };
  readonly #closeMenu = (): void => { this.menu = ""; };
  readonly #menuBlur = (e: FocusEvent): void => { if (e.relatedTarget instanceof Node && !(e.currentTarget as Node).contains(e.relatedTarget)) this.menu = ""; };
  readonly #keyDown = (e: KeyboardEvent): void => { if (e.isComposing) return; if (e.key === "Escape" && this.menu) { e.preventDefault(); e.stopPropagation(); this.menu = ""; this.focusEditor(); } if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); this.#requestSave(); } };
  readonly #requestSave = (): void => { this.dispatchEvent(new CustomEvent("markdown-save", { bubbles: true, composed: true })); };
}

const colorLabels = { gold: "Gold", danger: "Red", info: "Blue", success: "Green", mystery: "Purple", muted: "Muted" } as const;
const effectLabels = { underline: "Underline", glow: "Glow", "small-caps": "Small caps", spoiler: "Spoiler" } as const;
customElements.define("codex-markdown-editor", CodexMarkdownEditor);
