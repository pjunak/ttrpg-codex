import { html, nothing } from "lit";
import { formText } from "../core/forms.js";
import { uiText } from "./ui-localization.js";

/** Shown while a signed-in session expired: sign in again as the same role to continue. */
export function sessionRecovery(options: {
  readonly busy: boolean;
  readonly error: string;
  resume(password: string): Promise<boolean>;
}) {
  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    if (await options.resume(formText(new FormData(form), "password"))) form.reset();
  };
  return html`<section class="session-recovery" data-codex-ui data-ui-state="error" aria-labelledby="session-recovery-title">
    <h2 id="session-recovery-title">${uiText("session.recoverTitle")}</h2>
    <p role="status">${uiText("session.recoverHint")}</p>
    <form @submit=${submit}>
      <div data-ui-toolbar>
        <div data-ui-field>
          <label for="session-recovery-password">${uiText("shell.passwordLabel")}</label>
          <input class="ui-control" id="session-recovery-password" name="password" type="password"
            autocomplete="current-password" required ?disabled=${options.busy} />
        </div>
        <button class="ui-button" data-ui-variant="primary" type="submit" ?disabled=${options.busy}>${uiText("session.resume")}</button>
      </div>
    </form>
    ${options.error ? html`<p role="alert">${options.error}</p>` : nothing}
  </section>`;
}
