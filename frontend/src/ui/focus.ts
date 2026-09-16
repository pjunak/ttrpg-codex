/** Native dialogs supply inertness and return focus; this keeps Tab in the content. */
export function containDialogTab(dialog: HTMLDialogElement, event: KeyboardEvent): void {
  if (event.defaultPrevented || event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
  const controls = [...dialog.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex]')]
    .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && !control.closest('[hidden], [inert]') && control.getClientRects().length > 0 && getComputedStyle(control).visibility !== "hidden");
  const first = controls[0], last = controls.at(-1), active = dialog.ownerDocument.activeElement;
  if (!first) return;
  if (event.shiftKey && (active === first || !controls.includes(active as HTMLElement))) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && (active === last || !controls.includes(active as HTMLElement))) { event.preventDefault(); first.focus(); }
}

/** Tabs activate through the owner's click handler, retaining its data/lifecycle policy. */
export function navigateTabs(list: HTMLElement, event: KeyboardEvent): void {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(tab => tab.closest('[role="tablist"]') === list && !tab.disabled && !tab.hidden && tab.getClientRects().length > 0 && getComputedStyle(tab).visibility !== "hidden");
  const index = tabs.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  const vertical = list.getAttribute("aria-orientation") === "vertical", rtl = getComputedStyle(list).direction === "rtl";
  const forward = vertical ? "ArrowDown" : rtl ? "ArrowLeft" : "ArrowRight", backward = vertical ? "ArrowUp" : rtl ? "ArrowRight" : "ArrowLeft";
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === forward ? (index + 1) % tabs.length : event.key === backward ? (index + tabs.length - 1) % tabs.length : -1;
  if (next < 0) return;
  event.preventDefault(); const target = tabs[next]!; const id = target.id;
  target.click(); (list.ownerDocument.getElementById(id) ?? target).focus();
}
