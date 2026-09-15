import { html, nothing } from "lit";
import type { GitHubCandidate, GitHubSource } from "../core/addon-github.js";
import type { MessageKey } from "./ui-localization.js";

export function githubCandidateDetails(candidate: GitHubCandidate, source: GitHubSource, t: (key: MessageKey) => string, locale: string) {
  const p = candidate.provenance;
  const upstream = source.channel === "release" && candidate.version
    ? `https://github.com/${source.repo}/releases/tag/${encodeURIComponent(candidate.version)}`
    : p?.runId ? `https://github.com/${source.repo}/actions/runs/${p.runId}` : "";
  return html`<p><strong>${candidate.name}</strong> · ${candidate.version}</p>
    <p>${p?.commit ? html`${t("github.commit")}: <code>${p.commit}</code>` : t("github.unknownCommit")}</p>
    ${p?.runId ? html`<p>${t("github.build")} #${p.runId}${p.runAttempt ? ` · ${t("github.attempt")} ${p.runAttempt}` : ""}</p>` : nothing}
    ${p?.publishedAt ? html`<p>${t("github.published")}: <time datetime=${p.publishedAt}>${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(p.publishedAt))}</time></p>` : nothing}
    ${source.channel === "release" ? html`<details><summary>${t("github.changes")}</summary>
      ${p?.notes ? html`<pre class="github-release-notes" tabindex="0">${p.notes}</pre>` : html`<p>${t("github.noNotes")}</p>`}
      ${p?.notesTruncated ? html`<p>${t("github.truncatedNotes")}</p>` : nothing}
    </details>` : nothing}
    ${upstream ? html`<p><a href=${upstream} target="_blank" rel="noreferrer">${t(source.channel === "release" ? "github.openRelease" : "github.openBuild")}</a></p>` : nothing}
    <details><summary>${t("github.packageIdentity")}</summary><code>${candidate.digest || candidate.id}</code></details>
    <p class="settings-hint">${t("github.metadataHint")}</p>`;
}
