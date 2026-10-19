import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineDraft } from "../src/app/inline-draft.js";
import type { CampaignWriteResult } from "../src/app/campaign-writes.js";
import type { CampaignDataset } from "../src/core/campaign-data.js";
import { deferred } from "./deferred.js";

const campaign = {} as CampaignDataset;
const saved = (revision: number): CampaignWriteResult => ({
  ok: true,
  campaign,
  record: { key: "gate", revision, value: {} },
});

function draft(options: { required?: boolean } = {}) {
  const replies: ReturnType<typeof deferred<CampaignWriteResult>>[] = [];
  const saves: { value: unknown; base: unknown }[] = [];
  const closed = vi.fn();
  const current = { base: 1 as unknown, value: "Gate" as unknown };
  const value = new InlineDraft("Gate", 1, {
    save: (value, base) => {
      saves.push({ value, base });
      const reply = deferred<CampaignWriteResult>();
      replies.push(reply);
      return reply.promise;
    },
    rebase: (result) => result.record?.revision,
    current: () => current,
    changed: () => undefined,
    closed,
    ...options,
  });
  return { value, saves, replies, closed, current };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("InlineDraft", () => {
  it("closes an unchanged draft without saving", async () => {
    const { value, saves, closed } = draft();
    await value.commit(true);
    expect(saves).toEqual([]);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("saves a pause-mode draft only after typing stops", async () => {
    const { value, saves } = draft();
    value.input("Gat", true);
    await vi.advanceTimersByTimeAsync(500);
    value.input("Gates", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(saves).toEqual([{ value: "Gates", base: 1 }]);
  });

  it("keeps an edit made during a save and saves it next over the confirmed result", async () => {
    const { value, saves, replies, closed } = draft();
    value.input("North gate");
    const first = value.commit(true);
    expect(value.pending).toBe(true);
    value.input("North gate tower");
    void value.commit(true);
    expect(saves).toHaveLength(1);
    replies[0]!.resolve(saved(2));
    await vi.waitFor(() => expect(saves).toHaveLength(2));
    expect(saves).toEqual([
      { value: "North gate", base: 1 },
      { value: "North gate tower", base: 2 },
    ]);
    expect(closed).not.toHaveBeenCalled();
    replies[1]!.resolve(saved(3));
    await first;
    expect(closed).toHaveBeenCalledOnce();
    expect(value.base).toBe(3);
  });

  it("stays open and dirty when typing continues after a save without another commit", async () => {
    const { value, replies, closed } = draft();
    value.input("North gate");
    const saving = value.commit(true);
    value.input("North gate tower");
    replies[0]!.resolve(saved(2));
    await saving;
    expect([value.dirty, value.original, closed.mock.calls.length]).toEqual([
      true,
      "North gate",
      0,
    ]);
  });

  it("does not close when another part of the draft opened during the save", async () => {
    const { value, replies, closed } = draft();
    value.active = "known:0";
    value.input("A fact");
    const saving = value.commit(true);
    value.active = "known:1";
    replies[0]!.resolve(saved(2));
    await saving;
    expect([closed.mock.calls.length, value.dirty]).toEqual([0, false]);
  });

  it("keeps a rejected draft and waits for the user after a conflict", async () => {
    const { value, saves, replies, current } = draft();
    value.input("Our gate");
    const saving = value.commit(true);
    replies[0]!.resolve({ ok: false, message: "changed elsewhere", conflict: true });
    await saving;
    expect([value.value, value.error, value.conflict]).toEqual([
      "Our gate",
      "changed elsewhere",
      true,
    ]);
    await value.commit(true);
    value.input("Our gate!", true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toHaveLength(1);
    current.base = 4;
    current.value = "Their gate";
    value.keep();
    expect([value.original, value.dirty]).toEqual(["Their gate", true]);
    void value.commit(true);
    expect(saves[1]).toEqual({ value: "Our gate!", base: 4 });
  });

  it("drops a queued edit when its save fails, so retrying is the user's choice", async () => {
    const { value, saves, replies } = draft();
    value.input("One");
    const saving = value.commit(true);
    value.input("Two");
    void value.commit(true);
    replies[0]!.resolve({ ok: false, message: "server unavailable" });
    await saving;
    expect(saves).toHaveLength(1);
    expect([value.value, value.error]).toEqual(["Two", "server unavailable"]);
  });

  it("refuses an empty required value without saving", async () => {
    const { value, saves } = draft({ required: true });
    value.input("  ");
    await value.commit(true);
    expect(saves).toEqual([]);
    expect(value.error).toBe("A name is required.");
  });

  it("a discarded draft cancels its pause and ignores a late answer", async () => {
    const { value, saves, replies, closed } = draft();
    value.input("Pause", true);
    value.discard();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toEqual([]);
    const other = draft();
    other.value.input("Late");
    const saving = other.value.commit(true);
    other.value.discard();
    other.replies[0]!.resolve(saved(2));
    await saving;
    expect(other.value.base).toBe(1);
    expect(closed).toHaveBeenCalledOnce();
    expect(replies).toHaveLength(0);
  });
});
