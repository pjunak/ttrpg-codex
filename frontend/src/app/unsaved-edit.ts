export const unsavedEditMessage = "Discard the unsaved changes in this entry?";

export function confirmDiscardUnsavedEdit(
  dirty: boolean,
  confirm: (message: string) => boolean,
): boolean {
  return !dirty || confirm(unsavedEditMessage);
}

export function protectUnsavedEditBeforeUnload(dirty: boolean, event: BeforeUnloadEvent): void {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
}
