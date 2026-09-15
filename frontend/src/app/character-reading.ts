import { uiText } from "./ui-localization.js";

/** Knowledge controls host reading presentation, not storage or authorization. */
export function characterKnowledge(value: Readonly<Record<string, unknown>>): number {
  const level = value["knowledge"];
  return typeof level === "number" && Number.isInteger(level) && level >= 0 && level <= 4 ? level : 4;
}

export function characterReadingValue(value: Readonly<Record<string, unknown>>, inspect = false): Readonly<Record<string, unknown>> {
  const level = characterKnowledge(value);
  if (inspect || level >= 2) return value;
  const reading: Record<string, unknown> = {};
  for (const key of ["id", "visibility", "linkedTwinId", "updatedAt", "lastChange", "knowledge"]) {
    if (Object.hasOwn(value, key)) reading[key] = value[key];
  }
  reading["name"] = level >= 1 ? value["name"] : uiText("knowledge.unknown");
  return reading;
}