import { LitElement, html, nothing, type TemplateResult } from "lit";
import { EditorState, NodeSelection, TextSelection, type Command } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import {
  baseKeymap,
  chainCommands,
  setBlockType,
  toggleMark,
  wrapIn,
  lift,
} from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { wrapInList, splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { tableEditing, addRowAfter, addColumnAfter, deleteTable } from "prosemirror-tables";
import {
  parseRichMarkdown,
  serializeRichMarkdown,
  richMarkdownSchema as schema,
} from "./rich-markdown.js";
import {
  markdownColors,
  markdownHighlights,
  markdownEffects,
  markdownSizes,
} from "./markdown-formats.js";
import {
  parseCampaignMarkdown,
  renderCampaignMarkdown,
  safeCampaignMarkdownLink,
  searchCampaignWikiRecords,
  type CampaignMarkdownContext,
} from "./campaign-markdown.js";
import {
  openLinkSearch,
  requestAddonLinks,
  validLinkLabel,
  type WriterLinkChoice,
  type WriterLinkGroup,
} from "./writer-link-search.js";
import { openContextMenu, type ContextMenuItem } from "../ui/context-menu.js";
import { uiText, UiLocalizationController } from "./ui-localization.js";
import { MarkdownDraftController } from "./markdown-draft-controller.js";
import type { MarkdownDraft, MarkdownDraftContext } from "../core/markdown-drafts.js";
import { selectOptions } from "./select-options.js";
import { containDialogTab } from "../ui/focus.js";

type Mode = "formatted" | "markdown" | "preview";
/** What a chosen link replaces: a document range, or a range of the Markdown source. */
interface LinkRange {
  readonly source: boolean;
  readonly from: number;
  readonly to: number;
  readonly subject: string;
}
interface LinkAnchor {
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
}
let writerID = 0;

export class CodexMarkdownEditor extends LitElement {
  static override properties = {
    value: { type: String },
    name: { type: String },
    label: { type: String },
    identity: { type: String },
    context: { attribute: false },
    disabled: { type: Boolean },
    maximumLength: { type: Number },
    saveLabel: { type: String },
    draftContext: { attribute: false },
    quietIdle: { type: Boolean },
    linkScope: { type: String },
    selectionBar: { state: true },
    recoveryBusy: { state: true },
    recoveryMessage: { state: true },
    mode: { state: true },
    split: { state: true },
    expanded: { state: true },
    menu: { state: true },
    issue: { state: true },
  };
  declare value: string;
  declare name: string;
  declare label: string;
  declare identity: string;
  declare context: CampaignMarkdownContext | undefined;
  declare disabled: boolean;
  declare maximumLength: number;
  declare saveLabel: string | undefined;
  declare draftContext: MarkdownDraftContext | undefined;
  /** Another editor in the same form already explains local recovery. */
  declare quietIdle: boolean;
  /** "campaign" links records and rules; "rules" (add-on prose) links add-on references only. */
  declare linkScope: "campaign" | "rules";
  declare private selectionBar: (LinkAnchor & { readonly wiki: boolean }) | undefined;
  declare private recoveryBusy: boolean;
  declare private recoveryMessage: string;
  declare private mode: Mode;
  declare private split: boolean;
  declare private expanded: boolean;
  declare private menu: string;
  declare private issue: string;
  readonly #id = `wiki-writer-${++writerID}`;
  readonly #ui = new UiLocalizationController(this);
  readonly #drafts = new MarkdownDraftController(this);
  #view: EditorView | undefined;
  #originals = new WeakMap<import("prosemirror-model").Node, string>();
  #richValue = "";
  #lastEmitted = "";
  #sourceSelection = { from: 0, to: 0 };
  #returnFocus: HTMLElement | undefined;
  #listeners: AbortController | undefined;
  #barFrame = 0;
  #propsView: EditorView | undefined;
  #propsKey = "";

  constructor() {
    super();
    this.value = "";
    this.name = "description";
    this.label = "";
    this.identity = "";
    this.disabled = false;
    this.maximumLength = 200_000;
    this.mode = "formatted";
    this.split = false;
    this.expanded = false;
    this.menu = "";
    this.issue = "";
    this.linkScope = "campaign";
    this.recoveryBusy = false;
    this.recoveryMessage = "";
  }
  protected override createRenderRoot() {
    return this;
  }
  override connectedCallback(): void {
    super.connectedCallback();
    this.#listeners = new AbortController();
    // The selection toolbar is placed in viewport coordinates; follow scrolling.
    this.ownerDocument.addEventListener(
      "scroll",
      () => {
        if (this.selectionBar) this.#updateSelectionBar();
      },
      { capture: true, passive: true, signal: this.#listeners.signal },
    );
  }
  override disconnectedCallback(): void {
    this.#listeners?.abort();
    cancelAnimationFrame(this.#barFrame);
    this.#barFrame = 0;
    this.#view?.destroy();
    this.#view = undefined;
    super.disconnectedCallback();
  }
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    this.#drafts.configure(this.draftContext);
    if (!this.#view) this.#mount();
    // Expanding or collapsing replaces the surface; keep the document, selection and history.
    else if (!this.contains(this.#view.dom)) {
      const state = this.#view.state;
      this.#view.destroy();
      this.#view = undefined;
      this.#mount(state);
    } else if (
      changed.has("identity") ||
      (changed.has("value") && this.value !== this.#lastEmitted && this.value !== this.#richValue)
    )
      this.#loadRich();
    this.#placeSelectionBar();
    // Setting props redraws the browser selection from the editor state, which can lag
    // behind fast Shift+arrow selection, so only do it when the props change.
    const label = this.label || uiText("Wiki text"),
      key = `${this.disabled}|${this.recoveryBusy}|${label}`;
    if (this.#view && (this.#view !== this.#propsView || key !== this.#propsKey)) {
      this.#propsView = this.#view;
      this.#propsKey = key;
      this.#view.setProps({
        editable: () => !this.disabled && !this.recoveryBusy,
        attributes: { "aria-label": label, "aria-multiline": "true", role: "textbox" },
      });
    }
    if (this.disabled) this.menu = "";
  }

  #mount(state?: EditorState): void {
    const target = this.querySelector<HTMLElement>(".writer-rich");
    if (!target) return;
    if (state === undefined) {
      const parsed = parseRichMarkdown(this.value);
      this.#originals = parsed.originals;
      this.#richValue = this.value;
      state = this.#state(parsed.doc);
    }
    this.#view = new EditorView(target, {
      state,
      dispatchTransaction: (transaction) => {
        const view = this.#view;
        if (!view || this.disabled || this.recoveryBusy) return;
        const next = view.state.apply(transaction);
        if (transaction.docChanged) {
          const source = serializeRichMarkdown(next.doc, this.#originals);
          if (source.length > this.maximumLength) {
            this.issue = uiText("The text is too long.");
            return;
          }
          view.updateState(next);
          this.#richValue = source;
          this.#change(source);
        } else {
          view.updateState(next);
          this.requestUpdate();
        }
        this.#updateSelectionBar();
      },
      // Typing "[[" opens the link search; dismissing it keeps the brackets as text.
      handleTextInput: (view, from, to, text) => {
        if (text !== "[" || from < 1 || view.state.doc.textBetween(from - 1, from) !== "[")
          return false;
        view.dispatch(view.state.tr.insertText(text, from, to));
        if (view.state.doc.textBetween(from - 1, from + 1) === "[[")
          this.#openLinkSearch({ source: false, from: from - 1, to: from + 1, subject: "" });
        return true;
      },
      handleDOMEvents: {
        click: (_view, event) => {
          if ((event.target as Element).closest("a")) {
            event.preventDefault();
            return true;
          }
          return false;
        },
        contextmenu: (view, event) => this.#contextMenu(view, event),
        focus: () => {
          this.#updateSelectionBar();
          return false;
        },
        blur: (_view, event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !this.querySelector(".writer-selection-bar")?.contains(event.relatedTarget)
          )
            this.selectionBar = undefined;
          return false;
        },
      },
    });
    this.requestUpdate();
  }
  #state(doc: import("prosemirror-model").Node): EditorState {
    return EditorState.create({
      doc,
      plugins: [
        history(),
        keymap({
          "Mod-z": undo,
          "Mod-y": redo,
          "Mod-Shift-z": redo,
          "Mod-b": toggleMark(schema.marks["strong"]!),
          "Mod-i": toggleMark(schema.marks["em"]!),
          "Mod-u": toggleMark(schema.marks["effect"]!, { value: "underline" }),
          Enter: chainCommands(splitListItem(schema.nodes["list_item"]!), baseKeymap["Enter"]!),
          Tab: sinkListItem(schema.nodes["list_item"]!),
          "Shift-Tab": liftListItem(schema.nodes["list_item"]!),
        }),
        keymap(baseKeymap),
        tableEditing(),
      ],
    });
  }
  #loadRich(): void {
    const parsed = parseRichMarkdown(this.value);
    this.#originals = parsed.originals;
    this.#richValue = this.value;
    this.#view?.updateState(this.#state(parsed.doc));
  }
  #change(source: string): void {
    this.value = source;
    this.#lastEmitted = source;
    // Forms read the named source field; keep it current before listeners run.
    const area = this.querySelector<HTMLTextAreaElement>(".writer-source");
    if (area && area.value !== source) area.value = source;
    this.issue = "";
    this.#drafts.changed(source);
    this.dispatchEvent(
      new CustomEvent("markdown-change", {
        detail: { value: source },
        bubbles: true,
        composed: true,
      }),
    );
  }
  public focusEditor(): void {
    if (this.mode === "markdown")
      this.querySelector<HTMLTextAreaElement>(".writer-source")?.focus();
    else this.#view?.focus();
  }
  public acknowledgeSave(value: string): void {
    this.#drafts.saved(value);
  }
  public discardDraft(): void {
    this.#drafts.discardCurrent();
  }

  #recovery() {
    if (!this.draftContext || !this.#drafts.candidates.length) return nothing;
    const selected = this.#drafts.selected;
    return html`<section class="writer-recovery" aria-label=${uiText("draft.review")}>
      ${html`<details class="writer-recovery-review">
        <summary>${uiText("draft.available", { count: this.#drafts.candidates.length })}</summary>
        <p>${uiText("draft.intro")}</p>
        <label>${uiText("draft.choose")}<select .value=${selected?.id ?? ""} ?disabled=${this.recoveryBusy}
          @change=${(event: Event) => {
            this.#drafts.selected = this.#drafts.candidates.find(
              (item) => item.id === (event.target as HTMLSelectElement).value,
            );
            this.requestUpdate();
          }}>
          ${selectOptions([{ value: "", label: uiText("draft.choose") }, ...this.#drafts.candidates.map((draft, index) => ({ value: draft.id, label: `${index + 1}. ${new Date(draft.savedAt).toLocaleString(this.#ui.locale)}` }))], selected?.id ?? "")}
        </select></label>
        ${
          selected
            ? html`
          ${selected.baseRevision !== this.draftContext.revision || selected.baseValue !== this.draftContext.baseValue ? html`<p class="writer-recovery-warning">${uiText("draft.changed")}</p>` : nothing}
          <div class="writer-recovery-comparison">
            ${[
              ["draft.original", selected.baseValue],
              ["draft.current", this.draftContext.baseValue],
              ["draft.recovered", selected.value],
            ].map(
              ([label, value]) =>
                html`<section><h3>${uiText(label as "draft.original" | "draft.current" | "draft.recovered")}</h3><pre tabindex="0">${value}</pre></section>`,
            )}
          </div>
          ${this.value !== this.draftContext.baseValue ? html`<p>${uiText("draft.preserveCurrent")}</p>` : nothing}
          ${selected.value.length > this.maximumLength ? html`<p>${uiText("draft.tooLong")}</p>` : nothing}
          <div class="writer-recovery-actions">
            <button type="button" ?disabled=${this.disabled || this.recoveryBusy || selected.value.length > this.maximumLength} @click=${() => this.#recover(selected)}>${uiText("draft.use")}</button>
            <a download="draft.md" href=${`data:text/markdown;charset=utf-8,${encodeURIComponent(selected.value)}`}>${uiText("draft.download")}</a>
            <button type="button" ?disabled=${this.disabled || this.recoveryBusy} @click=${async () => {
              if (window.confirm(uiText("draft.deleteConfirm"))) {
                this.recoveryBusy = true;
                await this.#drafts.discard(selected);
                this.recoveryBusy = false;
              }
            }}>${uiText("draft.delete")}</button>
          </div>`
            : nothing
        }
      </details>`}
    </section>`;
  }

  #recoveryStatus() {
    if (!this.draftContext) return nothing;
    if (this.quietIdle && this.#drafts.status === "idle")
      return html`<span class="visually-hidden" role="status">${this.recoveryMessage}</span>`;
    return html`<p class="writer-recovery-status" role=${this.#drafts.status === "unavailable" ? "alert" : nothing}>
        ${uiText(({ idle: "draft.enabled", saving: "draft.saving", saved: "draft.saved", unavailable: "draft.unavailable" } as const)[this.#drafts.status])}
        ${this.#drafts.status === "unavailable" ? html`<a download="draft.md" href=${`data:text/markdown;charset=utf-8,${encodeURIComponent(this.value)}`}>${uiText("draft.download")}</a>` : nothing}
      </p><span class="visually-hidden" role="status">${this.recoveryMessage}</span>`;
  }

  async #recover(draft: MarkdownDraft): Promise<void> {
    if (this.disabled || this.recoveryBusy) return;
    this.recoveryBusy = true;
    const value = await this.#drafts.recover(draft);
    if (value !== undefined) {
      this.#change(value);
      this.#loadRich();
      this.recoveryMessage = uiText("draft.replaced");
    }
    this.recoveryBusy = false;
    await this.updateComplete;
    if (value !== undefined) this.focusEditor();
  }

  protected override render() {
    const className = `writer-dialog ${this.expanded ? "writer-expanded" : "writer-inline"}${this.split ? " is-split" : ""}`,
      label = this.label || uiText("Wiki text");
    // Inline the writer is part of the form; only the full-screen writer is a (modal) dialog.
    return this.expanded
      ? html`<dialog class=${className} aria-label=${label} @cancel=${this.#cancelDialog}
          @keydown=${this.#keyDown}>${this.#surface()}</dialog>`
      : html`<div class=${className} role="group" aria-label=${label} @keydown=${this.#keyDown}>
          ${this.#surface()}</div>`;
  }
  #surface() {
    return html`
      ${
        this.expanded
          ? html`<div class="writer-heading"><span class="writer-title">${this.label || uiText("Wiki text")}</span>
        <button type="button" class="writer-expand" aria-label=${uiText("writer.collapse")} title=${uiText("writer.collapse")}
          @click=${this.#expand}>✕</button></div>`
          : nothing
      }
      ${this.#recovery()}
      <div class="writer-tools-wrap" @focusout=${this.#menuBlur}>
        <div class="writer-toolbar" role="group" aria-label=${uiText("Text formatting")} @pointerdown=${this.#rememberSource}>
          ${this.#button("↶", "Undo", () => this.#command(undo), "writer-optional", this.mode !== "formatted")}
          ${this.#button("↷", "Redo", () => this.#command(redo), "writer-optional", this.mode !== "formatted")}
          <select aria-label=${uiText("Text style")} ?disabled=${this.disabled || this.mode === "preview"}
            @change=${this.#blockStyle} .value=${this.#blockValue()}>
            <option value="paragraph">${uiText("Normal text")}</option>
            ${[1, 2, 3, 4, 5, 6].map((level) => html`<option value=${String(level)}>${uiText("Heading {0}", { "0": level })}</option>`)}
            <option value="blockquote">${uiText("Quote")}</option><option value="code_block">${uiText("Code block")}</option>
          </select>
          <select class="writer-optional" aria-label=${uiText("Font family")} ?disabled=${this.disabled || this.mode === "preview"}
            @change=${(event: Event) => this.#format("font", (event.target as HTMLSelectElement).value)} .value=${this.#markValue("font", "serif")}>
            <option value="serif">Lora</option><option value="sans">Inter</option><option value="mono">Mono</option>
          </select>
          <select class="writer-size" aria-label=${uiText("Text size")} ?disabled=${this.disabled || this.mode === "preview"}
            @change=${(event: Event) => this.#format("size", (event.target as HTMLSelectElement).value)} .value=${this.#markValue("size", "16")}>
            ${markdownSizes.map((size) => html`<option value=${String(size)} ?selected=${String(size) === this.#markValue("size", "16")}>${size}</option>`)}
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
            aria-pressed=${this.split} @click=${() => {
              this.split = !this.split;
              if (this.split && this.mode === "preview") this.#setMode("formatted");
            }}>◫</button>
          ${
            this.expanded
              ? nothing
              : html`<button type="button" class="writer-expand" aria-label=${uiText("Expand writer")} title=${uiText("Expand writer")}
            ?disabled=${this.disabled} @click=${this.#expand}>⤢</button>`
          }
        </div>
        ${
          this.menu
            ? html`<div class="writer-menu" id=${`${this.#id}-menu`} role="group" aria-label=${uiText("Text formatting")}>
          ${this.#menuContent()}<button type="button" class="writer-menu-close" @click=${this.#closeMenu}>${uiText("Close")}</button></div>`
            : nothing
        }
      </div>
      <div class=${`writer-panes ${this.split ? "is-split" : ""}`} @pointerdown=${() => {
        this.menu = "";
      }}>
        <div class="writer-writing" ?hidden=${this.mode === "preview"}>
          <div class="writer-rich campaign-markdown" ?hidden=${this.mode !== "formatted"}></div>
          <textarea class="writer-source" id=${`${this.#id}-source`} aria-label=${`${this.label} Markdown`} name=${this.name}
            ?hidden=${this.mode !== "markdown"} ?disabled=${this.disabled || this.recoveryBusy} .value=${this.value} maxlength=${this.maximumLength}
            @input=${this.#sourceInput} @select=${this.#rememberSource} @keyup=${this.#rememberSource}></textarea>
        </div>
        <div class="writer-preview" ?hidden=${!this.split && this.mode !== "preview"} aria-label=${uiText("Article preview")}>
          ${this.#preview()}
        </div>
      </div>
      ${this.#selectionToolbar()}
      ${this.issue ? html`<p class="writer-issue" role="alert">${this.issue}</p>` : nothing}
      ${
        this.expanded
          ? html`<footer class="writer-expanded-actions">${this.#recoveryStatus()}<span class="writer-toolbar-space"></span>
        <button type="button" @click=${this.#expand}>${uiText("writer.collapse")}</button>
        <button type="button" class="ui-action" data-ui-variant="primary" ?disabled=${this.disabled} @click=${this.#requestSave}>${this.saveLabel || uiText("Save text")}</button></footer>`
          : html`<div class="writer-footer">${this.#recoveryStatus()}</div>`
      }`;
  }
  #button(
    content: string | TemplateResult,
    label: Parameters<typeof uiText>[0],
    click: () => void,
    className = "",
    disabled = false,
  ) {
    const mark = (
      {
        Bold: "strong",
        Italic: "em",
        Underline: "effect",
        Strikethrough: "strike",
        Superscript: "sup",
        Subscript: "sub",
      } as Record<string, string>
    )[label];
    const active = mark
      ? this.#selectionMarks().some(
          (item) =>
            item.type.name === mark &&
            (label !== "Underline" || item.attrs["value"] === "underline"),
        )
      : false;
    return html`<button type="button" class=${className} aria-label=${uiText(label)} title=${uiText(label)}
      aria-pressed=${mark && this.mode === "formatted" ? active : nothing}
      ?disabled=${disabled || this.disabled || this.mode === "preview"} @click=${click}>${content}</button>`;
  }
  #menuButton(
    content: string | TemplateResult,
    label: Parameters<typeof uiText>[0],
    menu: string,
    className = "",
  ) {
    return html`<button type="button" class=${className} aria-label=${uiText(label)} title=${uiText(label)} aria-expanded=${this.menu === menu}
      aria-controls=${`${this.#id}-menu`} ?disabled=${this.disabled || this.mode === "preview"}
      @click=${() => {
        this.menu = this.menu === menu ? "" : menu;
      }}>${content}</button>`;
  }
  #menuContent() {
    if (this.menu === "color" || this.menu === "highlight") {
      const kind = this.menu;
      return html`<div class="writer-color-grid"><button type="button" @click=${() => this.#format(kind, "")}>${uiText("Default")}</button>
        ${(kind === "color" ? markdownColors : markdownHighlights).map(
          (color) => html`<button type="button" @click=${() => this.#format(kind, color)}>
          <span class=${`writer-swatch md-color-${color}`} aria-hidden="true">●</span>${uiText(colorLabels[color])}</button>`,
        )}</div>`;
    }
    if (this.menu === "link" || this.menu === "image")
      return html`
      <label>${uiText("URL")}<input class="writer-insert-url" aria-label=${uiText("URL")} /></label>
      <label>${uiText(this.menu === "image" ? "Alternative text" : "Label")}<input class="writer-insert-label" /></label>
      <button type="button" @click=${this.#insertLink}>${uiText("Insert")}</button>`;
    if (this.menu === "insert")
      return html`
      ${this.#button(uiText("Bullet list"), "Bullet list", () => this.#list(false))}
      ${this.#button(uiText("Numbered list"), "Numbered list", () => this.#list(true))}
      <button type="button" @click=${(event: Event) => {
        const range = this.#currentLinkRange();
        if (range) this.#openLinkSearch(range, anchorOf(event.currentTarget as HTMLElement));
      }}>${uiText("Link to…")}</button>
      ${(["link", "image"] as const).map(
        (kind) =>
          html`<button type="button" @click=${() => {
            this.menu = kind;
          }}>${uiText(kind === "link" ? "Link" : "Image")}</button>`,
      )}
      ${this.#button(uiText("Table"), "Table", this.#insertTable)}
      ${this.#button(uiText("Add row"), "Add row", () => this.#command(addRowAfter))}
      ${this.#button(uiText("Add column"), "Add column", () => this.#command(addColumnAfter))}
      ${this.#button(uiText("Delete table"), "Delete table", () => this.#command(deleteTable))}
      ${this.#button(uiText("Divider"), "Divider", () => this.#insertBlock("horizontal_rule", "\n\n---\n\n"))}`;
    return html`
      <label>${uiText("Text size")}<select @change=${(e: Event) => this.#format("size", (e.target as HTMLSelectElement).value)}>
        ${markdownSizes.map((size) => html`<option value=${String(size)} ?selected=${String(size) === this.#markValue("size", "16")}>${size}</option>`)}</select></label>
      <label>${uiText("Font family")}<select @change=${(e: Event) => this.#format("font", (e.target as HTMLSelectElement).value)}><option value="serif">Lora</option><option value="sans">Inter</option><option value="mono">Mono</option></select></label>
      <div class="writer-menu-row">${this.#button("I", "Italic", () => this.#format("em"))}${this.#button("U", "Underline", () => this.#format("effect", "underline"))}
        ${this.#button("S̶", "Strikethrough", () => this.#format("strike"))}${this.#button("x²", "Superscript", () => this.#format("sup"))}${this.#button("x₂", "Subscript", () => this.#format("sub"))}</div>
      <select aria-label=${uiText("Text effect")} @change=${(e: Event) => this.#format("effect", (e.target as HTMLSelectElement).value)}>
        <option value="">${uiText("Text effect")}</option>${markdownEffects.map((effect) => html`<option value=${effect}>${uiText(effectLabels[effect])}</option>`)}</select>
      <div class="writer-menu-row">${["left", "center", "right"].map((align) => this.#button(align === "left" ? "≡←" : align === "center" ? "≡" : "→≡", align === "left" ? "Align left" : align === "center" ? "Center" : "Align right", () => this.#format("align", align)))}</div>
      <button type="button" @click=${() => {
        this.menu = "insert";
      }}>${uiText("Lists and insert")}</button>
      <button type="button" @click=${() => {
        this.menu = "highlight";
      }}>${uiText("Highlight")}</button>
      <button type="button" @click=${() => {
        this.menu = "color";
      }}>${uiText("Text color")}</button>
      <button type="button" @click=${() => {
        this.split = !this.split;
        this.menu = "";
      }}>${uiText("Side by side")}</button>
      ${this.#button(uiText("Undo"), "Undo", () => this.#command(undo), "", this.mode !== "formatted")}
      ${this.#button(uiText("Redo"), "Redo", () => this.#command(redo), "", this.mode !== "formatted")}
      ${this.#button(uiText("Clear formatting"), "Clear formatting", this.#clearFormatting)}`;
  }
  #markValue(name: string, fallback: string): string {
    return String(
      this.#selectionMarks().find((mark) => mark.type.name === name)?.attrs["value"] ?? fallback,
    );
  }
  #selectionMarks(): readonly import("prosemirror-model").Mark[] {
    const state = this.#view?.state;
    if (!state) return [];
    if (state.storedMarks) return state.storedMarks;
    if (state.selection.empty) return state.selection.$from.marks();
    let marks: readonly import("prosemirror-model").Mark[] | undefined;
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
      if (marks) return false;
      if (node.isInline) marks = node.marks;
      return marks === undefined;
    });
    return marks ?? [];
  }
  #blockValue(): string {
    const parent = this.#view?.state.selection.$from.parent;
    return parent?.type.name === "heading"
      ? String(parent.attrs["level"])
      : (parent?.type.name ?? "paragraph");
  }
  #command(command: Command): void {
    if (this.disabled) return;
    const view = this.#view;
    if (this.mode !== "formatted" || !view) return;
    command(view.state, view.dispatch, view);
    view.focus();
    this.menu = "";
  }
  #format(kind: string, value?: string): void {
    if (this.disabled) return;
    if (this.mode === "markdown") {
      const pair =
        kind === "strong"
          ? ["**", "**"]
          : kind === "em"
            ? ["*", "*"]
            : kind === "strike"
              ? ["~~", "~~"]
              : kind === "sup" || kind === "sub"
                ? [`<${kind}>`, `</${kind}>`]
                : [
                    `<${kind === "highlight" ? "mark" : "span"} data-md-${kind}="${value}">`,
                    kind === "highlight" ? "</mark>" : "</span>",
                  ];
      if (value === "") {
        this.issue = uiText("Use Clear formatting in the formatted view.");
        this.menu = "";
        return;
      }
      this.#sourceWrap(pair[0]!, pair[1]!);
      return;
    }
    const view = this.#view;
    const type = schema.marks[kind];
    if (!view || !type) return;
    if (
      value === "" ||
      (kind === "effect" && value === "underline" && this.#markValue("effect", "") === "underline")
    ) {
      const { from, to } = view.state.selection;
      view.dispatch(view.state.tr.removeMark(from, to, type).removeStoredMark(type));
    } else if (value !== undefined) {
      const { from, to, empty } = view.state.selection;
      const mark = type.create({ value });
      view.dispatch(
        empty ? view.state.tr.addStoredMark(mark) : view.state.tr.addMark(from, to, mark),
      );
    } else this.#command(toggleMark(type));
    this.menu = "";
    view.focus();
  }
  readonly #blockStyle = (e: Event): void => {
    const value = (e.target as HTMLSelectElement).value;
    if (this.mode === "markdown") {
      if (value === "code_block") this.#sourceWrap("\n```\n", "\n```\n");
      else
        this.#sourcePrefix(
          value === "blockquote"
            ? "> "
            : /^\d$/u.test(value)
              ? "#".repeat(Number(value)) + " "
              : "",
        );
      return;
    }
    if (value === "paragraph" && this.#inside("blockquote")) this.#command(lift);
    if (value === "blockquote")
      this.#command(this.#inside("blockquote") ? lift : wrapIn(schema.nodes["blockquote"]!));
    else
      this.#command(
        setBlockType(
          schema.nodes[/^\d$/u.test(value) ? "heading" : value]!,
          /^\d$/u.test(value) ? { level: Number(value) } : null,
        ),
      );
  };
  #inside(name: string): boolean {
    const position = this.#view?.state.selection.$from;
    if (!position) return false;
    for (let depth = position.depth; depth > 0; depth--)
      if (position.node(depth).type.name === name) return true;
    return false;
  }
  #list(ordered: boolean): void {
    if (this.mode === "markdown") this.#sourcePrefix(ordered ? "1. " : "- ");
    else
      this.#command(
        this.#inside(ordered ? "ordered_list" : "bullet_list")
          ? liftListItem(schema.nodes["list_item"]!)
          : wrapInList(schema.nodes[ordered ? "ordered_list" : "bullet_list"]!),
      );
  }
  #sourceWrap(before: string, after: string): void {
    const { from, to } = this.#sourceSelection;
    this.#sourceReplace(
      before + this.value.slice(from, to) + after,
      from + before.length,
      to + before.length,
    );
  }
  #sourcePrefix(prefix: string): void {
    const { from, to } = this.#sourceSelection;
    const start = this.value.lastIndexOf("\n", from - 1) + 1;
    let end = this.value.indexOf("\n", to);
    if (end < 0) end = this.value.length;
    const lines = this.value
      .slice(start, end)
      .split("\n")
      .map((line) => prefix + line.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/u, ""))
      .join("\n");
    this.#sourceSelection = { from: start, to: end };
    this.#sourceReplace(lines, start, start + lines.length);
  }
  #sourceReplace(text: string, from?: number, to?: number): void {
    if (this.disabled) return;
    const selection = this.#sourceSelection;
    const source = this.value.slice(0, selection.from) + text + this.value.slice(selection.to);
    if (source.length > this.maximumLength) {
      this.issue = uiText("The text is too long.");
      return;
    }
    this.#change(source);
    this.menu = "";
    void this.updateComplete.then(() => {
      const area = this.querySelector<HTMLTextAreaElement>(".writer-source");
      area?.focus();
      area?.setSelectionRange(
        from ?? selection.from + text.length,
        to ?? selection.from + text.length,
      );
      this.#rememberSource();
    });
  }
  readonly #rememberSource = (): void => {
    const area = this.querySelector<HTMLTextAreaElement>(".writer-source");
    if (this.mode === "markdown" && area)
      this.#sourceSelection = { from: area.selectionStart, to: area.selectionEnd };
  };
  readonly #sourceInput = (e: Event): void => {
    this.#rememberSource();
    this.#change((e.target as HTMLTextAreaElement).value);
  };
  #setMode(mode: Mode): void {
    if (mode === "formatted" && this.value !== this.#richValue) this.#loadRich();
    this.mode = mode;
    this.menu = "";
    if (mode === "preview") this.split = false;
  }
  readonly #clearFormatting = (): void => {
    if (this.mode === "markdown") {
      this.issue = uiText("Use Clear formatting in the formatted view.");
      return;
    }
    const view = this.#view;
    if (!view) return;
    const { from, to } = view.state.selection;
    view.dispatch(view.state.tr.removeMark(from, to).setStoredMarks([]));
    this.#command(lift);
    this.menu = "";
  };
  readonly #insertLink = (): void => {
    const href = this.querySelector<HTMLInputElement>(".writer-insert-url")?.value.trim() ?? "";
    const label = this.querySelector<HTMLInputElement>(".writer-insert-label")?.value.trim() ?? "";
    const kind = this.menu;
    if (!safeCampaignMarkdownLink(href) || (kind === "image" && href.startsWith("mailto:"))) {
      this.issue = uiText("Enter a valid link.");
      return;
    }
    if (this.mode === "markdown") {
      this.#sourceReplace(
        `${kind === "image" ? "!" : ""}[${label.replace(/[[\]]/gu, "")}](${href.replace(/\)/gu, "%29")})`,
      );
      return;
    }
    const view = this.#view;
    if (!view) return;
    if (kind === "image")
      view.dispatch(
        view.state.tr.replaceSelectionWith(schema.node("image", { src: href, alt: label })),
      );
    else if (view.state.selection.empty)
      view.dispatch(
        view.state.tr.replaceSelectionWith(
          schema.text(label || href, [schema.mark("link", { href })]),
        ),
      );
    else
      view.dispatch(
        view.state.tr.addMark(
          view.state.selection.from,
          view.state.selection.to,
          schema.mark("link", { href }),
        ),
      );
    this.menu = "";
    view.focus();
  };
  #insertBlock(type: string, source: string): void {
    if (this.mode === "markdown") {
      this.#sourceReplace(source);
      return;
    }
    const view = this.#view;
    if (view) view.dispatch(view.state.tr.replaceSelectionWith(schema.node(type)));
    this.menu = "";
    view?.focus();
  }
  readonly #insertTable = (): void => {
    if (this.mode === "markdown") {
      this.#sourceReplace("\n\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\n");
      return;
    }
    const cell = (header: boolean) =>
      schema.node(header ? "table_header" : "table_cell", null, schema.node("paragraph"));
    const table = schema.node("table", null, [
      schema.node("table_row", null, [cell(true), cell(true)]),
      schema.node("table_row", null, [cell(false), cell(false)]),
    ]);
    const view = this.#view;
    if (view) view.dispatch(view.state.tr.replaceSelectionWith(table));
    this.menu = "";
    view?.focus();
  };
  readonly #expand = async (): Promise<void> => {
    const expanding = !this.expanded;
    if (expanding)
      this.#returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    else this.querySelector<HTMLDialogElement>("dialog.writer-expanded")?.close();
    this.expanded = expanding;
    this.menu = "";
    if (expanding && this.mode === "preview") this.#setMode("formatted");
    if (expanding) this.split = this.mode === "markdown";
    await this.updateComplete;
    if (!this.isConnected) return;
    if (expanding) this.querySelector<HTMLDialogElement>("dialog.writer-expanded")?.showModal();
    // The inline surface was rebuilt, so a control the writer opened from is gone;
    // return to its replacement, the expand button.
    else if (this.#returnFocus?.isConnected) this.#returnFocus.focus();
    else this.querySelector<HTMLElement>(".writer-inline .writer-expand")?.focus();
  };
  readonly #cancelDialog = (e: Event): void => {
    e.preventDefault();
    if (this.menu) this.#closeMenu();
    else if (this.expanded) void this.#expand();
  };
  readonly #closeMenu = (): void => {
    this.menu = "";
  };
  readonly #menuBlur = (e: FocusEvent): void => {
    if (e.relatedTarget instanceof Node && !(e.currentTarget as Node).contains(e.relatedTarget))
      this.menu = "";
  };
  readonly #keyDown = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    // List indentation claims Tab first; otherwise Tab stays inside the full-screen writer.
    if (e.currentTarget instanceof HTMLDialogElement) containDialogTab(e.currentTarget, e);
    if (e.key === "Escape" && this.menu) {
      e.preventDefault();
      e.stopPropagation();
      this.menu = "";
      this.focusEditor();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !e.defaultPrevented) {
      const range = this.#currentLinkRange();
      if (range) {
        e.preventDefault();
        e.stopPropagation();
        this.#openLinkSearch(range);
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      this.#requestSave();
    }
  };
  readonly #requestSave = (): void => {
    this.dispatchEvent(new CustomEvent("markdown-save", { bubbles: true, composed: true }));
  };

  #preview() {
    if (this.context)
      return renderCampaignMarkdown(parseCampaignMarkdown(this.value), this.context);
    // Add-on prose has no campaign data; wiki links resolve through the rule-details providers.
    return this.linkScope === "rules"
      ? html`<codex-addon-markdown .source=${this.value}></codex-addon-markdown>`
      : nothing;
  }
  #currentLinkRange(): LinkRange | undefined {
    if (this.disabled || this.mode === "preview") return undefined;
    if (this.mode === "markdown") {
      this.#rememberSource();
      const { from, to } = this.#sourceSelection;
      return { source: true, from, to, subject: this.value.slice(from, to) };
    }
    const view = this.#view;
    if (!view) return undefined;
    const selection = view.state.selection;
    if (selection instanceof NodeSelection && selection.node.type.name === "wiki")
      return {
        source: false,
        from: selection.from,
        to: selection.to,
        subject: String(selection.node.attrs["label"]),
      };
    // A link is one inline node, so a selection across blocks only places one.
    if (!selection.$from.sameParent(selection.$to))
      return { source: false, from: selection.to, to: selection.to, subject: "" };
    return {
      source: false,
      from: selection.from,
      to: selection.to,
      subject: view.state.doc.textBetween(selection.from, selection.to, " "),
    };
  }
  #anchorFor(range: LinkRange): LinkAnchor {
    const view = this.#view;
    if (!range.source && view) {
      const start = view.coordsAtPos(range.from),
        end = view.coordsAtPos(range.to, -1);
      return {
        x: start.left,
        top: Math.min(start.top, end.top),
        bottom: Math.max(start.bottom, end.bottom),
      };
    }
    return anchorOf(this.querySelector<HTMLElement>(".writer-source") ?? this);
  }
  #openLinkSearch(range: LinkRange, anchor: LinkAnchor = this.#anchorFor(range)): void {
    if (this.disabled) return;
    this.menu = "";
    this.selectionBar = undefined;
    const subject = range.subject.trim().replace(/\s+/gu, " ");
    openLinkSearch(this.ownerDocument, anchor, {
      query: subject.slice(0, 200),
      ...(subject ? { subject: subject.length > 60 ? `${subject.slice(0, 59)}…` : subject } : {}),
      search: this.#searchLinks,
      choose: (choice) => this.#applyLink(range, subject, choice),
      returnFocus: range.source
        ? this.querySelector<HTMLElement>(".writer-source")
        : (this.#view?.dom ?? null),
    });
  }
  readonly #searchLinks = async (
    query: string,
    signal: AbortSignal,
  ): Promise<readonly WriterLinkGroup[]> => {
    const records =
      this.linkScope === "campaign" && this.context
        ? searchCampaignWikiRecords(this.context, query)
        : [];
    return [...records, ...(await requestAddonLinks(this, query, signal))];
  };
  /** Selected words keep their wording and point at the chosen target. */
  #applyLink(range: LinkRange, subject: string, choice: WriterLinkChoice): void {
    const label = choice.hint && validLinkLabel(subject) ? subject : choice.label;
    if (!validLinkLabel(label) || this.disabled) return;
    if (range.source) {
      this.#sourceSelection = { from: range.from, to: range.to };
      this.#sourceReplace(`[[${label}${choice.hint ? `|${choice.hint}` : ""}]]`);
      return;
    }
    const view = this.#view;
    if (!view || range.to > view.state.doc.content.size) return;
    const marks = view.state.doc.resolve(range.from).marks();
    const transaction = view.state.tr.replaceWith(
      range.from,
      range.to,
      schema.node("wiki", { label, hint: choice.hint }, undefined, marks),
    );
    view.dispatch(
      transaction
        .setSelection(TextSelection.create(transaction.doc, range.from + 1))
        .scrollIntoView(),
    );
    view.focus();
  }
  readonly #unlink = (): void => {
    const view = this.#view;
    const selection = view?.state.selection;
    if (
      !view ||
      this.disabled ||
      !(selection instanceof NodeSelection) ||
      selection.node.type.name !== "wiki"
    )
      return;
    view.dispatch(
      view.state.tr.replaceSelectionWith(
        schema.text(String(selection.node.attrs["label"]), selection.node.marks),
        false,
      ),
    );
    view.focus();
  };
  #contextMenu(view: EditorView, event: MouseEvent): boolean {
    // Shift+right-click keeps the browser's own menu (spelling, paste). Menus outside a
    // modal dialog would be inert, so the full-screen writer keeps the browser menu too.
    if (
      event.shiftKey ||
      this.disabled ||
      this.mode !== "formatted" ||
      view.dom.closest("dialog:modal")
    )
      return false;
    event.preventDefault();
    const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (at && at.inside >= 0 && view.state.doc.nodeAt(at.inside)?.type.name === "wiki")
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at.inside)));
    const range = this.#currentLinkRange();
    if (!range) return true;
    const wiki = view.state.selection instanceof NodeSelection,
      point = { x: event.clientX, top: event.clientY, bottom: event.clientY };
    const items: ContextMenuItem[] = [
      {
        label: uiText(wiki ? "Change link…" : "Link to…"),
        icon: "⌕",
        detail: "Ctrl+K",
        run: () => this.#openLinkSearch(range, point),
      },
      ...(wiki ? [{ label: uiText("Unlink"), run: this.#unlink }] : []),
      {
        label: uiText("Bold"),
        detail: "Ctrl+B",
        separator: true,
        run: () => this.#format("strong"),
      },
      { label: uiText("Italic"), detail: "Ctrl+I", run: () => this.#format("em") },
      { label: uiText("Clear formatting"), run: this.#clearFormatting },
    ];
    openContextMenu(this.ownerDocument, { x: event.clientX, y: event.clientY }, items, {
      returnFocus: view.dom,
    });
    return true;
  }
  /** At most once a frame, after the editor has read the browser's selection. */
  #updateSelectionBar(): void {
    if (this.#barFrame) return;
    this.#barFrame = requestAnimationFrame(() => {
      this.#barFrame = 0;
      this.#placeBarFor();
    });
  }
  #placeBarFor(): void {
    const view = this.#view;
    if (
      !view ||
      this.mode !== "formatted" ||
      this.disabled ||
      !view.hasFocus() ||
      view.state.selection.empty
    ) {
      if (this.selectionBar) this.selectionBar = undefined;
      return;
    }
    const range = this.#currentLinkRange();
    if (!range) return;
    this.selectionBar = {
      ...this.#anchorFor(range),
      wiki: view.state.selection instanceof NodeSelection,
    };
  }
  #selectionToolbar() {
    const bar = this.selectionBar;
    if (!bar) return nothing;
    const link = (): void => {
      const range = this.#currentLinkRange();
      if (range) this.#openLinkSearch(range);
    };
    // Buttons keep focus (and the selection) in the text; keyboard users have Ctrl+B/I/K.
    return html`<div class="writer-selection-bar" popover="manual" role="toolbar"
      aria-label=${uiText("Selected text")} @pointerdown=${(event: Event) => event.preventDefault()}>
      ${
        bar.wiki
          ? html`<button type="button" tabindex="-1" @click=${link}>⌕ ${uiText("Change link…")}</button>
            <button type="button" tabindex="-1" @click=${this.#unlink}>${uiText("Unlink")}</button>`
          : html`<button type="button" tabindex="-1" aria-label=${uiText("Bold")} title=${uiText("Bold")}
              @click=${() => this.#format("strong")}><b>B</b></button>
            <button type="button" tabindex="-1" aria-label=${uiText("Italic")} title=${uiText("Italic")}
              @click=${() => this.#format("em")}><i>I</i></button>
            <button type="button" tabindex="-1" class="writer-selection-link" @click=${link}>⌕ ${uiText("Link to…")}</button>`
      }
    </div>`;
  }
  #placeSelectionBar(): void {
    const bar = this.querySelector<HTMLElement>(".writer-selection-bar"),
      anchor = this.selectionBar;
    if (!bar || !anchor) return;
    if (!bar.matches(":popover-open")) bar.showPopover();
    const window = this.ownerDocument.defaultView!,
      box = bar.getBoundingClientRect(),
      // On touch screens the system's own selection menu sits above the words.
      below = window.matchMedia("(pointer: coarse)").matches || anchor.top - box.height - 8 < 8;
    bar.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - box.width - 8))}px`;
    bar.style.top = `${below ? anchor.bottom + 8 : anchor.top - box.height - 8}px`;
  }
}

function anchorOf(element: HTMLElement): LinkAnchor {
  const box = element.getBoundingClientRect();
  return { x: box.left, top: box.top, bottom: box.bottom };
}

const colorLabels = {
  gold: "Gold",
  danger: "Red",
  info: "Blue",
  success: "Green",
  mystery: "Purple",
  muted: "Muted",
} as const;
const effectLabels = {
  underline: "Underline",
  glow: "Glow",
  "small-caps": "Small caps",
  spoiler: "Spoiler",
} as const;
customElements.define("codex-markdown-editor", CodexMarkdownEditor);
