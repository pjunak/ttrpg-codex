import { html, nothing } from "lit";
import type { GitHubCandidate, GitHubSource } from "../core/addon-github.js";
import type { MessageKey } from "./ui-localization.js";

/** The version a DM recognises: Actions builds are named by commit, so show its short form. */
export function githubCandidateVersion(candidate: GitHubCandidate, source: GitHubSource): string {
  return source.channel === "actions" && /^[a-f0-9]{40,64}$/u.test(candidate.version)
    ? candidate.version.slice(0, 7)
    : candidate.version;
}

/**
 * One package found on GitHub: a single summary line, then the release notes
 * and the technical provenance (file, commit, build, identity) behind
 * disclosures. `showName` names the file in the summary when several packages
 * have to be told apart.
 */
export function githubCandidateDetails(
  candidate: GitHubCandidate,
  source: GitHubSource,
  t: (key: MessageKey) => string,
  locale: string,
  { label = "", showName = false }: { label?: string; showName?: boolean } = {},
) {
  const p = candidate.provenance;
  const published = p?.publishedAt ? new Date(p.publishedAt) : undefined;
  const upstream =
    source.channel === "release" && candidate.version
      ? `https://github.com/${source.repo}/releases/tag/${encodeURIComponent(candidate.version)}`
      : p?.runId
        ? `https://github.com/${source.repo}/actions/runs/${p.runId}`
        : "";
  const link = upstream
    ? html`<p><a href=${upstream} target="_blank" rel="noreferrer">${t(source.channel === "release" ? "github.openRelease" : "github.openBuild")}</a></p>`
    : nothing;
  return html`<p class="github-candidate-summary">${label ? html`<strong>${label}</strong> · ` : nothing}${showName ? html`<strong>${candidate.name}</strong> · ` : nothing}${githubCandidateVersion(candidate, source)}${
    published
      ? html` · ${t("github.published")} <time datetime=${p!.publishedAt} title=${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(published)}>${new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(published)}</time>`
      : nothing
  }</p>
    <div class="github-candidate-more">
      ${
        source.channel === "release"
          ? html`<details><summary>${t("github.changes")}</summary>
        ${p?.notes ? html`<pre class="github-release-notes" tabindex="0">${p.notes}</pre>` : html`<p>${t("github.noNotes")}</p>`}
        ${p?.notesTruncated ? html`<p>${t("github.truncatedNotes")}</p>` : nothing}
        ${link}
      </details>`
          : nothing
      }
      <details class="github-candidate-technical"><summary>${t("github.packageDetails")}</summary>
        <p>${t("github.file")}: <code>${candidate.name}</code></p>
        <p>${p?.commit ? html`${t("github.commit")}: <code>${p.commit}</code>` : t("github.unknownCommit")}</p>
        ${p?.runId ? html`<p>${t("github.build")} #${p.runId}${p.runAttempt ? ` · ${t("github.attempt")} ${p.runAttempt}` : ""}</p>` : nothing}
        <p>${t("github.packageIdentity")}: <code>${candidate.digest || candidate.id}</code></p>
        ${source.channel === "release" ? nothing : link}
        <p class="settings-hint">${t("github.metadataHint")}</p>
      </details>
    </div>`;
}
