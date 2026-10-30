'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createReminderWorker, RETRY_DELAYS_MS, safeErrorCode } = require('../src/reminder-worker');
const { createReminderRepository } = require('../src/reminder-repository');
const { createMailTransport, createReminderMailer } = require('../src/reminder-mail');

const job = {
  id: '21', outingRecordId: '50', userId: '7', attemptNumber: 1,
  recipientEmail: 'verified@example.test', scheduledAt: new Date('2026-04-13T01:00:00.000Z'),
  outingDate: '2026-04-20', destination: '公園', activity: '散歩',
};

test('ワーカーは期限到来ジョブを送信し、成功結果と注入時計を記録する', async () => {
  const calls = [];
  const repository = {
    async recover(now) { calls.push(['recover', now]); },
    async claimDue(now, limit) { calls.push(['claim', now, limit]); return [job]; },
    async isSendable() { return true; },
    async markSent(...args) { calls.push(['sent', ...args]); },
  };
  const run = createReminderWorker({
    repository, mailer: { async send(value) { assert.equal(value, job); return { messageId: 'mail-1' }; } },
    now: () => new Date('2026-04-13T01:00:00.000Z'), logger: { info() {}, error() {} },
  });
  assert.deepEqual(await run(), { claimed: 1, sent: 1, failed: 0, cancelled: 0 });
  assert.equal(calls[0][0], 'recover');
  assert.equal(calls[1][2], 25);
  assert.equal(calls[2][0], 'sent');
});

test('他ユーザーや通知無効の状態を送信直前に検知してキャンセルする', async () => {
  let sent = false;
  let cancelled = false;
  const repository = {
    async recover() {}, async claimDue() { return [job]; }, async isSendable() { return false; },
    async cancel() { cancelled = true; },
  };
  const run = createReminderWorker({ repository, mailer: { async send() { sent = true; } }, logger: { info() {} } });
  assert.deepEqual(await run(), { claimed: 1, sent: 0, failed: 0, cancelled: 1 });
  assert.equal(cancelled, true);
  assert.equal(sent, false);
});

test('メール失敗は最大5試行内で間隔を指定して再試行し、ログへ秘密を含めない', async () => {
  let failure;
  const logs = [];
  const repository = {
    async recover() {}, async claimDue() { return [job]; }, async isSendable() { return true; },
    async markFailed(...args) { failure = args; },
  };
  const run = createReminderWorker({
    repository,
    mailer: { async send() { const error = new Error('do not log: SMTP password'); error.code = 'ETIMEDOUT'; throw error; } },
    now: () => new Date('2026-04-13T01:02:00.000Z'), logger: { info() {}, error(message) { logs.push(message); } },
  });
  assert.deepEqual(await run(), { claimed: 1, sent: 0, failed: 1, cancelled: 0 });
  assert.equal(failure[1], 'ETIMEDOUT');
  assert.equal(failure[3], RETRY_DELAYS_MS[0]);
  assert.ok(!logs.join('').includes('SMTP password'));
  assert.equal(safeErrorCode({ code: 'smtp bad\npassword' }), 'SMTP_SEND_FAILED');
});

test('複数ワーカーのDB claimはSKIP LOCKEDと所有者・確認済みメール条件で排他する', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (/SELECT j\.id/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const repository = createReminderRepository({ async connect() { return client; } });
  assert.deepEqual(await repository.claimDue(new Date('2026-04-13T00:00:00Z')), []);
  const claim = statements.find((sql) => /SELECT j\.id/.test(sql));
  assert.match(claim, /SKIP LOCKED/);
  assert.match(claim, /o\.user_id = j\.user_id/);
  assert.match(claim, /u\.email_verified = TRUE/);
  assert.match(claim, /o\.reminder_enabled = TRUE/);
});

test('再起動復旧は期限切れleaseと24時間を超えた未処理通知を扱う', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'reminder-repository.js'), 'utf8');
  assert.match(source, /lock_expires_at <= \$1/);
  assert.match(source, /scheduled_at < \$2::timestamptz - interval '24 hours'/);
  assert.match(source, /scheduled_at < \$1::timestamptz - interval '24 hours'/);
  assert.match(source, /\$2::timestamptz \+ \(\$3::double precision \* interval '1 millisecond'\)/);
  assert.match(source, /WORKER_LEASE_EXPIRED/);
  assert.match(source, /REMINDER_WINDOW_EXPIRED/);
});

test('メール設定を環境変数から読み、日付・目的地・活動内容を安全に両形式へ反映する', async () => {
  const { transporter, from } = createMailTransport({
    MAIL_HOST: 'localhost', MAIL_PORT: '1025', MAIL_SECURE: 'false',
    MAIL_FROM: 'Test <test@example.test>',
  });
  assert.equal(typeof transporter.sendMail, 'function');
  let message;
  const mailer = createReminderMailer({
    from, transporter: { async sendMail(value) { message = value; return { messageId: 'fake-id' }; } },
  });
  await mailer.send(job);
  assert.equal(message.to, job.recipientEmail);
  assert.equal(message.subject, '【お出かけリマインダー】7日後のお出かけ予定をお知らせします');
  assert.match(message.text, /お出かけの予定が近づいています！/);
  assert.match(message.text, /お出かけ日：2026年4月20日（月曜日）/);
  assert.match(message.text, /目的地：公園/);
  assert.match(message.text, /活動内容：散歩/);
  assert.match(message.text, /当日の天気や交通情報を確認して、楽しいお出かけの準備を進めましょう！/);
  assert.match(message.text, /自動送信/);
  assert.match(message.html, /<table role="presentation"/);
  assert.match(message.html, /活動内容/);
  assert.equal(message.messageId, '<outing-reminder-21@weather-travel.local>');
  await transporter.close();
});

test('活動内容が未入力なら省略し、HTMLではユーザー入力をエスケープする', async () => {
  let message;
  const mailer = createReminderMailer({
    from: 'test@example.test',
    transporter: { async sendMail(value) { message = value; return { messageId: 'fake-id' }; } },
  });
  await mailer.send({ ...job, destination: '<img src=x onerror=alert(1)> & Park', activity: '  ' });
  assert.doesNotMatch(message.text, /活動内容/);
  assert.doesNotMatch(message.html, /活動内容/);
  assert.match(message.html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; Park/);
  assert.doesNotMatch(message.html, /<img src=x/);
});
