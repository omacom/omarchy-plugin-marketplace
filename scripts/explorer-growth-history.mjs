import { execFileSync } from "node:child_process";

const historicalMethod = "git-catalog-snapshots";
const dayMilliseconds = 86_400_000;

function utcDayNumber(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Explorer growth contains an invalid UTC day");
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error("Explorer growth contains an invalid UTC day");
  }
  return timestamp / dayMilliseconds;
}

function generatedUtcDay(value) {
  if (typeof value !== "string") throw new Error("Explorer growth has an invalid generatedAt timestamp");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error("Explorer growth has an invalid generatedAt timestamp");
  }
  return value.slice(0, 10);
}

function assertGrowthSeries(growth) {
  if (!Array.isArray(growth) || growth.length === 0) {
    throw new Error("Explorer growth must contain a historical series");
  }
  let previousDay;
  let previousTotal = 0;
  for (const point of growth) {
    if (!point || Object.keys(point).sort().join(",") !== "added,date,total"
      || !Number.isInteger(point.total)
      || point.total < 0
      || !Number.isInteger(point.added)) {
      throw new Error("Explorer growth contains an invalid historical point");
    }
    const day = utcDayNumber(point.date);
    if ((previousDay !== undefined && day !== previousDay + 1)
      || point.added !== point.total - previousTotal) {
      throw new Error("Explorer growth is not a contiguous daily series");
    }
    previousDay = day;
    previousTotal = point.total;
  }
}

function sameGrowthPoint(first, second) {
  return first.date === second.date
    && first.total === second.total
    && first.added === second.added;
}

export function assertCompleteGitHistory(projectRoot) {
  let shallowState;
  try {
    shallowState = execFileSync(
      "git",
      ["rev-parse", "--is-shallow-repository"],
      { cwd: projectRoot, encoding: "utf8" },
    ).trim();
  } catch {
    throw new Error("Explorer growth requires complete Git history");
  }
  if (shallowState !== "false") {
    throw new Error("Explorer growth requires complete Git history (shallow repository detected)");
  }
}

export function readCommittedExplorerData(projectRoot) {
  const source = execFileSync(
    "git",
    ["show", "HEAD:site/explorer-data.json"],
    { cwd: projectRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(source);
}

export function assertGrowthContinuity(previousExplorer, nextGrowth, generatedAt) {
  if (previousExplorer?.growthMeta?.method !== historicalMethod) {
    throw new Error("Explorer growth does not extend the committed historical series");
  }
  const previousGrowth = previousExplorer.growth;
  const previousDate = generatedUtcDay(previousExplorer.generatedAt);
  const currentDate = generatedUtcDay(generatedAt);
  assertGrowthSeries(previousGrowth);
  assertGrowthSeries(nextGrowth);

  const elapsedDays = utcDayNumber(currentDate) - utcDayNumber(previousDate);
  if (elapsedDays < 0
    || nextGrowth.length !== previousGrowth.length + elapsedDays
    || previousGrowth.at(-1).date !== previousDate
    || nextGrowth.at(-1).date !== currentDate) {
    throw new Error("Explorer growth does not extend the committed historical series");
  }

  // The committed series' last point came from an in-progress catalog build,
  // not necessarily the final Git commit on that UTC day. It remains provisional
  // until a later-day build finalizes it from complete Git history (including
  // builds committed across midnight). Every earlier point is already final.
  const mutableIndex = previousGrowth.length - 1;
  for (let index = 0; index < previousGrowth.length; index++) {
    if (index === mutableIndex) {
      if (nextGrowth[index]?.date !== previousDate) {
        throw new Error("Explorer growth changed the provisional UTC day boundary");
      }
    } else if (!sameGrowthPoint(previousGrowth[index], nextGrowth[index])) {
      throw new Error("Explorer growth changed or removed a completed UTC day");
    }
  }
}
