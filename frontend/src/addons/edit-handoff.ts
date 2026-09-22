import { BoundaryValidationError } from "../core/boundary.js";

/** Transient JSON only: no DOM, service handles, callbacks, storage or authority. */
export function cloneEditHandoff(value: unknown): unknown {
  const fail = (): never => { throw new BoundaryValidationError("add-on edit handoff", "expected bounded plain JSON"); };
  let nodes = 0;
  const visit = (item: unknown, depth: number, ancestors: ReadonlySet<object>): void => {
    if (++nodes > 100_000 || depth > 40) fail();
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") { if (!Number.isFinite(item)) fail(); return; }
    if (typeof item !== "object" || ancestors.has(item)) return fail();
    const next = new Set(ancestors).add(item);
    if (Array.isArray(item) && (Object.keys(item).length !== item.length ||
      Object.keys(item).some(key => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) fail();
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail();
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) fail();
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) fail();
      visit(descriptor.value, depth + 1, next);
    }
  };
  visit(value, 0, new Set());
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024) fail();
  return JSON.parse(body) as unknown;
}
