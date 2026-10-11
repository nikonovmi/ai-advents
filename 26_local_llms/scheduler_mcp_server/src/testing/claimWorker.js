import { parentPort, workerData } from "node:worker_threads";

import { openScheduler } from "../db.js";

/**
 * One contender for the atomic-claim test: its own connection to the shared
 * file, claiming as fast as it can for a fixed number of rounds, all at the
 * same instant. Reports every run id it was handed.
 */
const { file, rounds, at } = workerData;
const scheduler = openScheduler({ file });
const runIds = [];
for (let i = 0; i < rounds; i++) {
  for (const { run } of scheduler.claimDueRuns({ now: at }).claimed) runIds.push(run.id);
}
scheduler.close();
parentPort.postMessage(runIds);
