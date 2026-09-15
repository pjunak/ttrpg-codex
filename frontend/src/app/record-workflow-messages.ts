export const recordWorkflowEn = {
  "notes.private": "DM notes",
  "notes.privateHelp": "Visible only to the DM. Kept separately from the overview and map notes.",
} as const;
export const recordWorkflowCs: Record<keyof typeof recordWorkflowEn, string> = {
  "notes.private": "Poznámky PJ",
  "notes.privateHelp": "Viditelné pouze pro PJ. Ukládají se odděleně od přehledu a poznámek k mapě.",
};
