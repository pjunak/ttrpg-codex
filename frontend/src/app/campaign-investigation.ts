import { isRecord } from "../core/boundary.js";
import type { CampaignDataset } from "../core/campaign-data.js";
import { characterReadingValue } from "./character-reading.js";
import { projectEntities } from "./campaign-projection.js";
import { campaignPages, recordEditHash } from "./routes.js";
import { searchable, searchTokens } from "./campaign-search.js";

export interface InvestigationQuestion {
  readonly text: string;
  readonly answer: string;
}
export interface InvestigationStatus {
  readonly total: number;
  readonly answered: number;
  readonly open: number;
  readonly solved: boolean;
  readonly manual: boolean;
}

export function investigationQuestions(value: unknown): readonly InvestigationQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const question = typeof item === "string" ? item : isRecord(item) ? item["text"] ?? item["question"] : undefined;
    const answer = isRecord(item) && typeof item["answer"] === "string" ? item["answer"].trim() : "";
    return typeof question === "string" && question.trim() ? [{text: question.trim(), answer}] : [];
  });
}

/** Effective reading status never changes the authored manual override. */
export function investigationStatus(value: Readonly<Record<string, unknown>>): InvestigationStatus {
  const questions = investigationQuestions(value["questions"]);
  const answered = questions.filter(question => question.answer !== "").length;
  const manual = value["solved"] === true;
  return {total: questions.length, answered, open: questions.length - answered,
    manual, solved: manual || questions.length > 0 && answered === questions.length};
}

export interface InvestigationQueueItem extends InvestigationQuestion {
  readonly source: string;
  readonly route: string;
  readonly editRoute: string;
  readonly kind: "characters" | "mysteries";
  readonly visibility: "public" | "dm";
}

export function investigationQueue(dataset: CampaignDataset, query = ""): readonly InvestigationQueueItem[] {
  const tokens = searchTokens(query);
  return campaignPages.filter(page => page.collection === "characters" || page.collection === "mysteries").flatMap(page =>
    projectEntities(dataset, page).flatMap(entity => {
      const kind = page.collection as InvestigationQueueItem["kind"];
      const value = kind === "characters" ? characterReadingValue(entity.raw) : entity.raw;
      return investigationQuestions(value[kind === "characters" ? "unknown" : "questions"])
        .filter(question => tokens.every(token => searchable([entity.name, question.text, question.answer].join(" ")).includes(token)))
        .map(question => ({...question, source: entity.name, route: entity.route,
          editRoute: recordEditHash(page, entity.key, "#/mysteries"), kind, visibility: entity.visibility}));
    }));
}
