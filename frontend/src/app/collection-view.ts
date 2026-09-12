export interface CollectionFilter { readonly field: string; readonly value: string }
export interface CollectionView {
  readonly query: string;
  readonly sort: string;
  readonly direction: "asc" | "desc";
  readonly group: string;
  readonly filters: readonly CollectionFilter[];
}

export const defaultCollectionView: CollectionView = Object.freeze({ query: "", sort: "name", direction: "asc", group: "", filters: [] });

export function parseCollectionView(query: string): CollectionView {
  if (query.length > 64_000) return defaultCollectionView;
  const parameters = new URLSearchParams(query);
  const filters: CollectionFilter[] = [];
  for (const encoded of parameters.getAll("filter").slice(0, 32)) {
    try {
      const value: unknown = JSON.parse(encoded);
      if (Array.isArray(value) && value.length === 2 && value.every(item => typeof item === "string" && item.length <= 512) &&
        !filters.some(item => item.field === value[0] && item.value === value[1])) filters.push({ field: value[0] as string, value: value[1] as string });
    } catch { /* Invalid view preferences have no authority over campaign data. */ }
  }
  return { query: (parameters.get("q") ?? "").slice(0, 512), sort: (parameters.get("sort") || "name").slice(0, 100),
    direction: parameters.get("direction") === "desc" ? "desc" : "asc", group: (parameters.get("group") ?? "").slice(0, 100), filters };
}

export function serializeCollectionView(view: CollectionView): string {
  const parameters = new URLSearchParams({ view: "1" });
  if (view.query) parameters.set("q", view.query);
  if (view.sort !== "name") parameters.set("sort", view.sort);
  if (view.direction !== "asc") parameters.set("direction", view.direction);
  if (view.group) parameters.set("group", view.group);
  for (const filter of view.filters) parameters.append("filter", JSON.stringify([filter.field, filter.value]));
  return parameters.toString();
}

function collectionPreferenceKey(page: string, role: string): string { return `codex:collection-view:${role}:${page}`; }

export function readCollectionView(page: string, role: string): CollectionView {
  try { return parseCollectionView(globalThis.localStorage.getItem(collectionPreferenceKey(page, role)) ?? ""); }
  catch { return defaultCollectionView; }
}

export function rememberCollectionView(page: string, role: string, view: CollectionView): boolean {
  try { globalThis.localStorage.setItem(collectionPreferenceKey(page, role), serializeCollectionView(view)); return true; }
  catch { return false; }
}
