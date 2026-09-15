import { html, nothing } from "lit";
import { investigationQuestions, investigationStatus } from "./campaign-investigation.js";
import { uiText } from "./ui-localization.js";

export function investigationBadge(value: Readonly<Record<string, unknown>>) {
  const status = investigationStatus(value);
  return html`<span class=${`investigation-badge ${status.solved ? "is-solved" : "is-open"}`}>${uiText(status.solved ? "investigation.solved" : "investigation.open")}</span>
    <span class="investigation-count">${uiText("investigation.count", {open: status.open, total: status.total})}</span>`;
}
export function investigationAnswers(value: Readonly<Record<string, unknown>>) {
  const status = investigationStatus(value), questions = investigationQuestions(value["questions"]);
  const open = questions.filter(question => !question.answer), answered = questions.filter(question => question.answer);
  return html`<section class="investigation-reading" aria-label=${uiText("Questions and answers")}>
    <h2 class="record-section-title">${uiText("Questions and answers")}</h2>
    <p>${investigationBadge(value)}</p>
    ${status.manual ? html`<p class="field-help">${uiText("investigation.manual")}</p>` : nothing}
    ${open.length ? html`<ul class="investigation-questions">${open.map(question => html`<li><p>${question.text}</p></li>`)}</ul>` : html`<p class="empty-state">${uiText("investigation.noOpen")}</p>`}
    <details class="investigation-history"><summary>${uiText("investigation.history")} (${answered.length})</summary>
      ${answered.length ? html`<ul class="investigation-questions">${answered.map(question => html`<li><p>${question.text}</p><div class="investigation-answer"><strong>${uiText("Answer")}</strong><p>${question.answer}</p></div></li>`)}</ul>` : html`<p class="empty-state">${uiText("investigation.noAnswers")}</p>`}
    </details>
  </section>`;
}
