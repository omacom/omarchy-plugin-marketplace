const dayMilliseconds = 86_400_000;

export function inclusiveRangeStart(end, days) {
  const dayCount = Math.max(1, Math.trunc(Number(days) || 1));
  const date = new Date(`${end}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (dayCount - 1));
  return date.toISOString().slice(0, 10);
}

export function inclusiveDayCount(from, to) {
  const elapsed = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(1, Math.round(elapsed / dayMilliseconds) + 1);
}
