'use strict';

require('dotenv').config();
const { randomUUID } = require('node:crypto');
const { createPool, withTransaction } = require('../src/db');
const { createReminderRepository } = require('../src/reminder-repository');
const { createReminderWorker } = require('../src/reminder-worker');
const { createMailTransport, createReminderMailer } = require('../src/reminder-mail');
const { scheduledAtForDate } = require('../src/reminder-scheduling');

function safeFailure(message) {
  const error = new Error(message);
  error.safeForCli = true;
  return error;
}

function assertMailpitConfig(env) {
  if (env.MAIL_HOST !== '127.0.0.1' || Number(env.MAIL_PORT) !== 1025 || env.MAIL_SECURE !== 'false') {
    throw safeFailure('安全確認: MAIL_HOST=127.0.0.1、MAIL_PORT=1025、MAIL_SECURE=false が必要です。');
  }
  if (!env.MAIL_FROM) throw safeFailure('MAIL_FROMを設定してください。');
}

function futureOutingDateTokyo(daysAhead = 14, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const date = new Date(`${values.year}-${values.month}-${values.day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}

function configuredDatabaseName(env) {
  if (env.DATABASE_URL) {
    return decodeURIComponent(new URL(env.DATABASE_URL).pathname.replace(/^\//, ''));
  }
  return env.PGDATABASE;
}

async function createFixture(pool, marker, outingDate, scheduledAt) {
  return withTransaction(pool, async (query) => {
    const user = await query(`INSERT INTO public.users
      (google_sub, email, email_verified, display_name)
      VALUES ($1, $2, TRUE, $3) RETURNING id`,
    [`mailpit-reminder-test:${marker}`, `mailpit-${marker}@example.test`, `MAILPIT TEST ${marker}`]);
    const userId = user.rows[0].id;
    const trip = await query(`INSERT INTO public.outing_records
      (outing_date, city, destination, activity, notes, weather, user_id, reminder_enabled)
      VALUES ($1, $2, $3, $4, $5, NULL, $6, TRUE) RETURNING id`,
    [outingDate, 'MAILPIT TEST', `[MAILPIT TEST ${marker}] テスト用お出かけ`, 'Mailpitへの送信確認', marker, userId]);
    const outingRecordId = trip.rows[0].id;
    const reminder = await query(`INSERT INTO public.reminder_jobs
      (outing_record_id, user_id, outing_date, destination_snapshot, scheduled_at, status)
      VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
    [outingRecordId, userId, outingDate, `[MAILPIT TEST ${marker}] テスト用お出かけ`, scheduledAt]);
    return { userId, outingRecordId, reminderJobId: reminder.rows[0].id };
  });
}

async function readStatus(pool, jobId) {
  const result = await pool.query(`SELECT j.status AS "jobStatus", j.attempt_count AS "attemptCount",
      count(a.id)::integer AS "attemptRows",
      max(a.status) FILTER (WHERE a.attempt_number = 1) AS "firstAttemptStatus"
    FROM public.reminder_jobs j LEFT JOIN public.reminder_attempts a ON a.reminder_job_id = j.id
    WHERE j.id = $1 GROUP BY j.id`, [jobId]);
  return result.rows[0];
}

async function main() {
  assertMailpitConfig(process.env);
  if (configuredDatabaseName(process.env) !== 'weather_travel_db') {
    throw safeFailure('安全確認: Mailpitテストはweather_travel_db以外のDBでは実行しません。');
  }

  const { transporter, from } = createMailTransport(process.env);
  let pool;
  try {
    await transporter.verify();
    pool = createPool();
    const connection = await pool.query(`SELECT current_database() AS database,
      inet_server_addr()::text AS server_address`);
    const { database, server_address: serverAddress } = connection.rows[0];
    const normalizedServerAddress = serverAddress?.replace(/\/\d+$/, '');
    if (database !== 'weather_travel_db' || (normalizedServerAddress && !['127.0.0.1', '::1'].includes(normalizedServerAddress))) {
      throw safeFailure('安全確認: DB接続先がローカルのweather_travel_dbではありません。');
    }
    const schema = await pool.query(`SELECT to_regclass('public.users') AS users,
      to_regclass('public.outing_records') AS outings,
      to_regclass('public.reminder_jobs') AS jobs,
      to_regclass('public.reminder_attempts') AS attempts`);
    if (Object.values(schema.rows[0]).some((value) => value === null)) {
      throw safeFailure('リマインダーのDBマイグレーションが適用されていません。');
    }

    const marker = randomUUID();
    const outingDate = futureOutingDateTokyo(14);
    const scheduledAt = scheduledAtForDate(outingDate);
    const injectedNow = new Date(scheduledAt);
    if (injectedNow <= new Date()) throw safeFailure('テスト日時が現在より未来になりませんでした。');

    const fixture = await createFixture(pool, marker, outingDate, scheduledAt);
    const baseRepository = createReminderRepository(pool);
    const testRepository = {
      // This fixture is newly created and cannot have an expired lease. Avoid global recovery.
      async recover() {},
      claimDue: (now, limit) => baseRepository.claimDue(now, limit, fixture.reminderJobId),
      isSendable: (job) => baseRepository.isSendable(job),
      markSent: (...args) => baseRepository.markSent(...args),
      markFailed: (...args) => baseRepository.markFailed(...args),
      cancel: (...args) => baseRepository.cancel(...args),
    };
    const run = createReminderWorker({
      repository: testRepository,
      mailer: createReminderMailer({ transporter, from }),
      now: () => new Date(injectedNow),
    });

    const firstRun = await run();
    const afterFirstRun = await readStatus(pool, fixture.reminderJobId);
    if (firstRun.sent !== 1 || afterFirstRun.jobStatus !== 'sent'
      || afterFirstRun.firstAttemptStatus !== 'sent' || afterFirstRun.attemptRows !== 1) {
      throw safeFailure('1回目の送信または送信履歴の確認に失敗しました。');
    }

    const secondRun = await run();
    const afterSecondRun = await readStatus(pool, fixture.reminderJobId);
    if (secondRun.claimed !== 0 || afterSecondRun.attemptRows !== 1
      || afterSecondRun.jobStatus !== 'sent' || afterSecondRun.firstAttemptStatus !== 'sent') {
      throw safeFailure('2回目の実行で重複送信防止を確認できませんでした。');
    }

    console.log(JSON.stringify({
      outcome: 'PASS', destination: 'Mailpit 127.0.0.1:1025',
      mailpitInbox: 'http://localhost:8025', marker,
      outingRecordId: fixture.outingRecordId, reminderJobId: fixture.reminderJobId,
      outingDate, scheduledAt, firstRun, afterFirstRun, secondRun, afterSecondRun,
      subject: `お出かけ予定のリマインダー：[MAILPIT TEST ${marker}] テスト用お出かけ`,
    }, null, 2));
    console.log('テスト行は識別用ラベル付きでDBに保持しています。Mailpit画面でmarkerまたは件名を検索してください。');
  } finally {
    if (pool) await pool.end();
    await transporter.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    // Do not log environment values, transport objects, or the raw SMTP error.
    const message = error.safeForCli ? error.message : 'DBまたはSMTP処理に失敗しました。詳細を秘匿して終了します。';
    console.error(`Mailpit reminder test failed: ${message}`);
    process.exitCode = 1;
  });
}

module.exports = { assertMailpitConfig, futureOutingDateTokyo, configuredDatabaseName };
