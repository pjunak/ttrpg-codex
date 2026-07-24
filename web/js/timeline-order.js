export function timelineSittingColumn(sitting) {
  return typeof sitting === 'number' && sitting >= 1 ? sitting : 1;
}

export function planTimelineReorder(columns, getEvent) {
  const writes = [];
  for (const column of columns) {
    column.ids.forEach((id, index) => {
      const existing = getEvent(id);
      if (!existing) return;
      const order = index + 1;
      const movedSitting =
        timelineSittingColumn(existing.sitting) !== column.sitting;
      if (!movedSitting && existing.order === order) return;

      const next = { ...existing, order };
      if (movedSitting) next.sitting = column.sitting;
      writes.push(next);
    });
  }
  return writes;
}
