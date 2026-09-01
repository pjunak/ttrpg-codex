import { describe, expect, it } from "vitest";
import { renderRewriteStatus, rewriteStatus } from "../src/rewrite-status.js";

describe("rewrite status", () => {
  it("states that the frontend is not a complete campaign replacement", () => {
    expect(rewriteStatus.eyebrow).toBe("Development build");
    expect(rewriteStatus.explanation).toContain("not a replacement");
    expect(rewriteStatus.explanation).toContain("deprecated v1");
  });

  it("replaces the application root with a single status landmark", () => {
    const root = new FakeElement("div");
    const document = new FakeDocument(root);

    renderRewriteStatus(document as unknown as Document);

    expect(root.children).toHaveLength(1);
    expect(root.children[0]?.tagName).toBe("main");
    expect(root.children[0]?.className).toBe("rewrite-status");
    expect(root.children[0]?.children.map((child) => child.textContent)).toEqual([
      rewriteStatus.eyebrow,
      rewriteStatus.heading,
      rewriteStatus.explanation,
    ]);
  });

  it("fails clearly when the HTML shell does not provide its root", () => {
    const document = new FakeDocument(null);
    expect(() => renderRewriteStatus(document as unknown as Document)).toThrow(
      "rewrite status root is missing",
    );
  });
});

class FakeDocument {
  constructor(private readonly root: FakeElement | null) {}

  querySelector(): HTMLElement | null {
    return this.root as unknown as HTMLElement | null;
  }

  createElement(tagName: string): HTMLElement {
    return new FakeElement(tagName) as unknown as HTMLElement;
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  className = "";
  textContent: string | null = null;

  constructor(readonly tagName: string) {}

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }
}
