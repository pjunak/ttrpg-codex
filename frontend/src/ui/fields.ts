import { onFormReset, setAttribute, type ControlHandle } from "./messages.js";

let sequence = 0;
type FieldControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
export function enhanceField(field: HTMLElement): ControlHandle {
  const scope = new AbortController(), signal = scope.signal;
  const control = field.querySelector<FieldControl>('input:not([data-ui-generated]), select, textarea');
  if (!control) return { refresh() {}, dispose() {} };
  const originalDescription = control.getAttribute("aria-describedby"), originalInvalid = control.getAttribute("aria-invalid"), originalLabel = control.getAttribute("aria-label");
  const error = field.ownerDocument.createElement("small"); error.className = "ui-error"; error.id = `codex-field-error-${++sequence}`;
  error.hidden = true; error.dataset["uiGenerated"] = ""; error.setAttribute("aria-live", "polite"); field.append(error);
  let invalid = false;
  const refresh = (): void => {
    const authored = field.querySelector<HTMLElement>("[data-ui-error]");
    if (originalLabel === null && !control.hasAttribute("aria-labelledby")) {
      const label = [...control.labels ?? []][0] ?? field.querySelector("label") ?? (field.tagName === "LABEL" ? field : null);
      if (label) {
        const copy = label.cloneNode(true) as HTMLElement;
        for (const node of copy.querySelectorAll("input,select,textarea,button,small,[data-ui-generated],[data-ui-help],[data-ui-error]")) node.remove();
        setAttribute(control, "aria-label", copy.textContent?.trim() || null);
      }
    }
    const hints = [...field.querySelectorAll<HTMLElement>("small:not(.ui-error):not([data-ui-generated]), [data-ui-help], [data-ui-error]")].filter(node => !node.hidden && !node.closest('[data-ui-generated]'));
    for (const hint of hints) if (!hint.id) hint.id = `codex-field-help-${++sequence}`;
    const authoredMessage = authored && !authored.hidden ? authored.textContent?.trim() : "";
    const message = authoredMessage || (invalid ? control.validationMessage : "");
    error.textContent = authoredMessage ? "" : message; error.hidden = !error.textContent;
    setAttribute(control, "aria-invalid", message ? "true" : originalInvalid);
    setAttribute(control, "aria-describedby", [...new Set([...(originalDescription?.split(/\s+/u) ?? []), ...hints.map(hint => hint.id), ...(!error.hidden ? [error.id] : [])])].join(" ") || null);
  };
  control.addEventListener("invalid", () => { invalid = true; refresh(); }, { signal });
  control.addEventListener("input", () => { if (invalid) refresh(); }, { signal });
  control.addEventListener("change", () => { if (invalid) refresh(); }, { signal });
  onFormReset(control.form, signal, () => { invalid = false; refresh(); });
  refresh(); return { refresh, dispose: () => { scope.abort(); error.remove(); setAttribute(control, "aria-describedby", originalDescription); setAttribute(control, "aria-invalid", originalInvalid); setAttribute(control, "aria-label", originalLabel); } };
}
