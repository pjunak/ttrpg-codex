import { isRecord } from "./boundary.js";

export interface MarkdownDraftContext {
  readonly role: "dm" | "player";
  readonly collection: string;
  readonly record: string | null;
  readonly field: string;
  readonly revision: number;
  readonly baseValue: string;
}

export interface MarkdownDraft {
  readonly id: string;
  readonly target: string;
  readonly baseRevision: number;
  readonly baseValue: string;
  readonly value: string;
  readonly savedAt: number;
}

export interface MarkdownDraftStore {
  list(target: string): Promise<readonly MarkdownDraft[]>;
  put(draft: MarkdownDraft): Promise<void>;
  remove(drafts: readonly MarkdownDraft[]): Promise<void>;
}

export function markdownDraftTarget(context: MarkdownDraftContext): string {
  // IndexedDB supplies the site boundary. A null record identifies an unsaved entry.
  return JSON.stringify([context.role, context.collection, context.record, context.field]);
}

export function isMarkdownDraft(value: unknown): value is MarkdownDraft {
  return isRecord(value) && typeof value["id"] === "string" && value["id"].length <= 100 &&
    typeof value["target"] === "string" && value["target"].length <= 4096 &&
    typeof value["baseValue"] === "string" && value["baseValue"].length <= 200_000 &&
    typeof value["value"] === "string" && value["value"].length <= 200_000 &&
    typeof value["baseRevision"] === "number" && Number.isSafeInteger(value["baseRevision"]) && value["baseRevision"] >= 0 &&
    typeof value["savedAt"] === "number" && Number.isSafeInteger(value["savedAt"]) && value["savedAt"] > 0;
}

/** Separate writer IDs prevent tabs from replacing one another's unsaved text. */
export class IndexedDBMarkdownDraftStore implements MarkdownDraftStore {
  async #open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      let failed = false;
      const request = indexedDB.open("codex-markdown-drafts", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("drafts", { keyPath: "id" }).createIndex("target", "target");
      };
      request.onsuccess = () => { if (failed) request.result.close(); else resolve(request.result); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => { failed = true; reject(new Error("Draft storage is blocked")); };
    });
  }

  async list(target: string): Promise<readonly MarkdownDraft[]> {
    return this.#list(target);
  }

  async listCollection(role: MarkdownDraftContext["role"], collection: string): Promise<readonly MarkdownDraft[]> {
    const prefix = JSON.stringify([role, collection]).slice(0, -1) + ",";
    return this.#list(IDBKeyRange.bound(prefix, prefix + "\uffff"));
  }

  async #list(target: string | IDBKeyRange): Promise<readonly MarkdownDraft[]> {
    const db = await this.#open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction("drafts", "readonly");
        const request = transaction.objectStore("drafts").index("target").getAll(target);
        transaction.oncomplete = () => {
          const values: unknown[] = request.result;
          if (!values.every(isMarkdownDraft)) { reject(new Error("Unrecognized draft data")); return; }
          resolve(values.sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id)));
        };
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }

  async put(draft: MarkdownDraft): Promise<void> {
    if (!isMarkdownDraft(draft)) throw new Error("Invalid draft");
    await this.#write(store => { store.put(draft); });
  }

  async remove(drafts: readonly MarkdownDraft[]): Promise<void> {
    if (!drafts.length) return;
    await this.#write(store => {
      for (const draft of drafts) {
        const request = store.get(draft.id);
        request.onsuccess = () => {
          const current: unknown = request.result;
          // Delete only the reviewed snapshot; a still-open writer may have changed it.
          if (isMarkdownDraft(current) && current.target === draft.target && current.savedAt === draft.savedAt && current.value === draft.value) store.delete(draft.id);
        };
      }
    });
  }

  async #write(change: (store: IDBObjectStore) => void): Promise<void> {
    const db = await this.#open();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("drafts", "readwrite");
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => reject(transaction.error);
        change(transaction.objectStore("drafts"));
      });
    } finally { db.close(); }
  }
}
