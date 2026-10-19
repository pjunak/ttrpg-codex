import type { ReactiveController, ReactiveControllerHost } from "lit";
import {
  AddonGitHubClient,
  GitHubRequestError,
  type GitHubDiscovery,
  type GitHubLink,
  type GitHubStatus,
} from "../core/addon-github.js";
import { AdminRequestController } from "./admin-request-controller.js";
import { uiRequestError } from "./ui-errors.js";
import type { MessageKey } from "./ui-localization.js";

export function githubError(error: unknown, t: (key: MessageKey) => string): string {
  if (!(error instanceof GitHubRequestError)) return uiRequestError(error);
  switch (error.code) {
    case "GITHUB_INVALID":
      return t("github.invalid");
    case "GITHUB_IDENTITY":
      return t("github.identity");
    case "GITHUB_PACKAGE":
      return t("github.invalidPackage");
    case "GITHUB_NO_PACKAGE":
      return t("github.noPackage");
    case "GITHUB_TLS":
      return t("github.tls");
    case "GITHUB_UNAVAILABLE":
      return t("github.unavailable");
    default:
      return uiRequestError(error);
  }
}

/** One inventory of sources and update results for the installed add-on list. */
export class AddonGitHubController implements ReactiveController {
  status: GitHubStatus | undefined;
  results: Record<string, GitHubDiscovery | string> = {};
  message = "";
  readonly #requests: AdminRequestController;
  constructor(
    readonly host: ReactiveControllerHost & EventTarget,
    readonly csrf: () => string,
    readonly t: (key: MessageKey) => string,
  ) {
    host.addController(this);
    this.#requests = new AdminRequestController(host, (error) => githubError(error, t));
  }
  get pending(): boolean {
    return this.#requests.pending;
  }
  get error(): string {
    return this.#requests.error;
  }
  set error(message: string) {
    this.#requests.error = message;
  }
  hostDisconnected(): void {
    this.reset();
  }
  reset(): void {
    this.#requests.reset();
    this.status = undefined;
    this.clear();
  }
  clear(addonId?: string): void {
    if (addonId === undefined) this.results = {};
    else delete this.results[addonId];
    this.clearFeedback();
  }
  clearFeedback(): void {
    this.error = "";
    this.message = "";
    this.host.requestUpdate();
  }
  async refresh(): Promise<void> {
    await this.#run(async (client) => {
      const status = await client.status();
      if (!client.signal.aborted) this.status = status;
    });
  }
  async checkAll(): Promise<void> {
    await this.#run(async (client) => {
      this.results = {};
      const status = await client.status();
      if (client.signal.aborted) return;
      this.status = status;
      if (!this.status.sources.length) {
        this.message = this.t("github.noSources");
        return;
      }
      for (const link of this.status.sources) {
        if (client.signal.aborted) return;
        try {
          const result = await client.discover(link.source, link.addonId);
          if (client.signal.aborted) return;
          this.results[link.addonId] = result;
        } catch (error) {
          if (client.signal.aborted) return;
          this.results[link.addonId] = githubError(error, this.t);
        }
        this.host.requestUpdate();
      }
      this.message = this.t("github.checked");
    });
  }
  async unlink(link: GitHubLink): Promise<void> {
    await this.#run(async (client) => {
      const status = await client.source(link, true);
      if (client.signal.aborted) return;
      this.status = status;
      delete this.results[link.addonId];
    });
  }
  async token(repo: string, token: string): Promise<void> {
    await this.#run(async (client) => {
      const status = await client.token(repo, token);
      if (client.signal.aborted) return;
      this.status = status;
      this.results = {};
      this.message = this.t("github.tokenSaved");
    });
  }
  async #run(operation: (client: AddonGitHubClient) => Promise<void>): Promise<void> {
    if (this.pending) return;
    this.message = "";
    await this.#requests.run((signal) => operation(new AddonGitHubClient(this.csrf(), signal)));
  }
}
