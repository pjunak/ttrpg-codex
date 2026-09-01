export const rewriteStatus = Object.freeze({
  eyebrow: "Development build",
  heading: "The product interface is being rebuilt.",
  explanation:
    "The Go host and Add-on API are available for development, but this version is not a replacement for the campaign interface yet. Use the deprecated v1 release for a complete campaign UI.",
});

export function renderRewriteStatus(document: Document): void {
  const root = document.querySelector<HTMLElement>("#app");
  if (root === null) {
    throw new Error("rewrite status root is missing");
  }

  const main = document.createElement("main");
  main.className = "rewrite-status";

  const eyebrow = document.createElement("p");
  eyebrow.className = "rewrite-status__eyebrow";
  eyebrow.textContent = rewriteStatus.eyebrow;

  const heading = document.createElement("h1");
  heading.textContent = rewriteStatus.heading;

  const explanation = document.createElement("p");
  explanation.textContent = rewriteStatus.explanation;

  main.append(eyebrow, heading, explanation);
  root.replaceChildren(main);
}
