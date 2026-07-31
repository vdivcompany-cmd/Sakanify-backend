/**
 * scheduler.core.js
 *
 * Central job scheduling engine. Later phases register real jobs into it
 * (Phase 4: expiring stale bed requests, Phase 5: payment/subscription
 * rollover) — this phase only builds the empty engine.
 *
 * Built on node-cron rather than Redis+Bull: node-cron is already a
 * project dependency and needs no extra infrastructure (no Redis
 * connection to stand up) for simple time-based jobs. If a future phase
 * needs a real distributed queue (retries, backoff, concurrency control),
 * this module is the single place to swap the engine without touching
 * call sites.
 */

const cron = require('node-cron');

// name -> { task, expression, running }
const registeredJobs = new Map();

/**
 * Register a job. Does not start it — call start() (or startAll()) to run it.
 * @param {string} name - unique job name
 * @param {string} cronExpression - standard cron expression
 * @param {Function} handler - async function to run on schedule
 */
function registerJob(name, cronExpression, handler) {
  if (registeredJobs.has(name)) {
    throw new Error(`Job "${name}" is already registered`);
  }

  if (!cron.validate(cronExpression)) {
    throw new Error(`Invalid cron expression for job "${name}": ${cronExpression}`);
  }

  const task = cron.schedule(
    cronExpression,
    async () => {
      try {
        await handler();
      } catch (err) {
        console.error(`[scheduler] job "${name}" failed:`, err);
      }
    },
    { scheduled: false },
  );

  registeredJobs.set(name, { task, expression: cronExpression, running: false });
}

function startJob(name) {
  const job = registeredJobs.get(name);
  if (!job) throw new Error(`Job "${name}" is not registered`);
  job.task.start();
  job.running = true;
}

function stopJob(name) {
  const job = registeredJobs.get(name);
  if (!job) throw new Error(`Job "${name}" is not registered`);
  job.task.stop();
  job.running = false;
}

function startAll() {
  for (const name of registeredJobs.keys()) startJob(name);
}

function stopAll() {
  for (const name of registeredJobs.keys()) stopJob(name);
}

function listJobs() {
  return Array.from(registeredJobs.entries()).map(([name, job]) => ({
    name,
    expression: job.expression,
    running: job.running,
  }));
}

module.exports = {
  registerJob,
  startJob,
  stopJob,
  startAll,
  stopAll,
  listJobs,
};
