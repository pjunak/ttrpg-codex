import { html } from "lit";
import type { GitHubStatus } from "../core/addon-github.js";
import type { MessageKey } from "./ui-localization.js";

export function repositoryName(input: string): string {
  return input.trim().replace(/^https:\/\/github\.com\//iu, "").replace(/\/$/u, "").replace(/\.git$/u, "").toLowerCase();
}

export function hasGitHubAccess(status: GitHubStatus | undefined, repository: string): boolean {
  return !!status && (status.credentials.defaultSource !== "none" || status.credentials.repositories.includes(repositoryName(repository)));
}

export function githubTokenHelp(t: (key: MessageKey) => string) {
  return html`<div class="github-token-help">
    <ol><li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">${t("github.createToken")}</a> ${t("github.tokenOwner")}</li>
      <li>${t("github.tokenRepository")}</li><li>${t("github.tokenPermissions")}</li><li>${t("github.tokenPaste")}</li></ol>
    <p>${t("github.tokenStorage")}</p>
    <a href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens" target="_blank" rel="noreferrer">${t("github.tokenGuide")}</a>
  </div>`;
}
