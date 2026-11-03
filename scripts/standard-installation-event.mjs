import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { approvalDecisionForEvents } from "./approve-submission.mjs";
import { standardInstallationApprovalLabel } from "./verification-review.mjs";

export function resolveStandardInstallationEvent(events, reviewer, requestedAt) {
  const decision = approvalDecisionForEvents(events, {
    approver: reviewer,
    expectedRequestedAt: requestedAt,
    label: standardInstallationApprovalLabel,
  });
  return { id: decision.eventId, createdAt: decision.requestedAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const pages = JSON.parse(readFileSync(0, "utf8"));
    if (!Array.isArray(pages)) throw new Error("Expected paginated issue events");
    const event = resolveStandardInstallationEvent(pages.flat(), process.argv[2], process.argv[3]);
    console.log(`${event.id}\t${event.createdAt}`);
  } catch {
    console.error("Standard installation approval label event does not match the workflow trigger.");
    process.exitCode = 1;
  }
}
