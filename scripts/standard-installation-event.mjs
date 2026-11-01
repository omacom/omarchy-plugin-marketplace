import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Resolve only the unique latest transition for this label and webhook actor.
// GitHub may record issue.updated_at one second after the label event timestamp.
export function resolveStandardInstallationEvent(events, reviewer, requestedAt) {
  const requested = Date.parse(requestedAt);
  if (!Array.isArray(events) || !Number.isFinite(requested) || !reviewer) throw new Error('Invalid approval event input');
  const transitions = events.filter(e => ['labeled', 'unlabeled'].includes(e?.event) && e?.label?.name === 'standard-installation-approved');
  if (transitions.some(e => !Number.isSafeInteger(e.id) || e.id < 1 || !Number.isFinite(Date.parse(e.created_at)))) throw new Error('Invalid approval transition');
  transitions.sort((a,b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
  const latest = transitions.at(-1);
  const candidates = transitions.filter(e => { const age = requested - Date.parse(e.created_at); return age >= 0 && age <= 1000; });
  if (!latest || latest.event !== 'labeled' || latest.actor?.login !== reviewer || candidates.length !== 1 || candidates[0] !== latest) throw new Error('Standard installation approval label event does not match the workflow trigger');
  return {id:latest.id, createdAt:latest.created_at};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pages = JSON.parse(readFileSync(0, 'utf8'));
  const event = resolveStandardInstallationEvent(pages.flat(), process.argv[2], process.argv[3]);
  console.log(`${event.id}\t${event.createdAt}`);
}
