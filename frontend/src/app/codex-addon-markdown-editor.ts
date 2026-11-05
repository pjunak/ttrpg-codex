import { CodexMarkdownEditor } from "./codex-markdown-editor.js";

/**
 * Public integrated add-on writer (`ui.markdown-editor`): the host writer with
 * no campaign data and no local draft storage. Links go to add-on wiki
 * references only, and its named source field keeps ordinary form submission.
 */
export class CodexAddonMarkdownEditor extends CodexMarkdownEditor {
  override connectedCallback(): void {
    super.connectedCallback();
    // Its own controls are styled already; the add-on's ui.enhance root must not re-wrap them.
    this.toggleAttribute("data-ui-skip", true);
  }
  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    this.context = undefined;
    this.draftContext = undefined;
    this.linkScope = "rules";
    super.willUpdate(changed);
  }
}
customElements.define("codex-addon-markdown-editor", CodexAddonMarkdownEditor);
