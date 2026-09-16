const english = {
  clear: "Clear search", show: "Show options", empty: "No matching options", loading: "Loading options…",
  narrow: "Showing the first 100 matches. Type more to narrow the list.", required: "Choose an option.",
};
const czech: typeof english = {
  clear: "Vymazat hledání", show: "Zobrazit možnosti", empty: "Žádné odpovídající možnosti", loading: "Načítání možností…",
  narrow: "Zobrazeno prvních 100 výsledků. Upřesněte hledání.", required: "Vyberte možnost.",
};
export function messages(element: Element): typeof english {
  return (element.closest("[lang]")?.getAttribute("lang") ?? element.ownerDocument.documentElement.lang).startsWith("cs") ? czech : english;
}
export function folded(value: string): string { return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase(); }
export function setAttribute(element: Element, name: string, value: string | null): void {
  if (value === null) { if (element.hasAttribute(name)) element.removeAttribute(name); }
  else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}
export interface ControlHandle { refresh(): void; dispose(): void }
/** Reset's default action runs after event listeners and their microtasks. */
export function onFormReset(form: HTMLFormElement | null, signal: AbortSignal, refresh: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  form?.addEventListener("reset", event => {
    clearTimeout(timer); timer = setTimeout(() => { timer = undefined; if (!signal.aborted && !event.defaultPrevented) refresh(); }, 0);
  }, { signal });
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
}
