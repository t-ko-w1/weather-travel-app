'use strict';

const { createPool } = require('./db');
const { createReminderRepository } = require('./reminder-repository');
const { createMailTransport, createReminderMailer } = require('./reminder-mail');

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

function safeErrorCode(error) {
  const candidate = typeof error?.code === 'string' ? error.code.toUpperCase() : 'SMTP_SEND_FAILED';
  return /^[A-Z0-9_]{1,100}$/.test(candidate) ? candidate : 'SMTP_SEND_FAILED';
}

function createReminderWorker({ repository, mailer, now = () => new Date(), logger = console, batchSize = 25 }) {
  return async function runOnce() {
    const startedAt = now();
    await repository.recover(startedAt);
    const jobs = await repository.claimDue(startedAt, batchSize);
    const result = { claimed: jobs.length, sent: 0, failed: 0, cancelled: 0 };
    for (const job of jobs) {
      if (!await repository.isSendable(job)) {
        await repository.cancel(job, now());
        result.cancelled += 1;
        continue;
      }
      try {
        const response = await mailer.send(job);
        await repository.markSent(job, response?.messageId, now());
        result.sent += 1;
      } catch (error) {
        const errorCode = safeErrorCode(error);
        const delay = RETRY_DELAYS_MS[job.attemptNumber - 1] || 0;
        await repository.markFailed(job, errorCode, now(), delay);
        logger.error?.(`Reminder job ${job.id} failed (${errorCode}).`);
        result.failed += 1;
      }
    }
    logger.info?.(`Reminder run complete: claimed=${result.claimed}, sent=${result.sent}, failed=${result.failed}, cancelled=${result.cancelled}.`);
    return result;
  };
}

async function main() {
  require('dotenv').config();
  if (!process.argv.includes('--once')) {
    console.error('Usage: npm run reminders:run -- --once');
    process.exitCode = 2;
    return;
  }
  const pool = createPool();
  try {
    const { transporter, from } = createMailTransport();
    const repository = createReminderRepository(pool);
    const runOnce = createReminderWorker({ repository, mailer: createReminderMailer({ transporter, from }) });
    await runOnce();
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    // Do not print transport/config objects, which can contain credentials.
    console.error(`Reminder worker failed (${safeErrorCode(error)}).`);
    process.exitCode = 1;
  });
}

module.exports = { createReminderWorker, safeErrorCode, RETRY_DELAYS_MS };
