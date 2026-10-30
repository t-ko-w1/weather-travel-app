'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRecipient, safeSmtpErrorMessage, sendTestEmail } = require('../scripts/send-test-email');

test('宛先は単一のメールアドレスに限定する', () => {
  assert.equal(normalizeRecipient(' test@example.com '), 'test@example.com');
  assert.equal(normalizeRecipient('one@example.com,two@example.com'), null);
  assert.equal(normalizeRecipient('not-an-email'), null);
  assert.equal(normalizeRecipient('a@example.com\r\nBcc:other@example.com'), null);
});

test('宛先の再確認が一致するまでSMTP接続も送信もしない', async () => {
  let transportCreated = false;
  await assert.rejects(sendTestEmail({
    recipient: 'test@example.com', confirmation: 'other@example.com',
    transportFactory() { transportCreated = true; throw new Error('must not happen'); },
  }), /宛先の確認が一致しない/);
  assert.equal(transportCreated, false);
});

test('確認後はSMTP接続を検証してから指定先1件だけへテスト内容を送る', async () => {
  const calls = [];
  const logs = [];
  const result = await sendTestEmail({
    recipient: 'test@example.com', confirmation: 'test@example.com', env: { sentinel: 'not logged' },
    logger: { info: (message) => logs.push(message), error: (message) => logs.push(message) },
    transportFactory(env) {
      assert.deepEqual(env, { sentinel: 'not logged' });
      return {
        from: 'sender@example.com',
        transporter: {
          async verify() { calls.push('verify'); },
          async sendMail(message) { calls.push(message); return { accepted: ['test@example.com'] }; },
          close() { calls.push('close'); },
        },
      };
    },
  });
  assert.equal(result.accepted, 1);
  assert.equal(calls[0], 'verify');
  assert.deepEqual(calls[1], {
    from: 'sender@example.com', to: 'test@example.com',
    subject: '[SMTP TEST] お天気・お出かけ記録アプリ',
    text: 'これはSMTP接続確認用のテストメールです。\nお天気・お出かけ記録アプリから送信しました。',
  });
  assert.equal(calls[2], 'close');
  assert.match(logs[0], /test@example.com/);
});

test('SMTPエラーは認証・接続の日本語メッセージへ置き換え、詳細をログに出さない', async () => {
  const logs = [];
  const result = await sendTestEmail({
    recipient: 'test@example.com', confirmation: 'test@example.com',
    logger: { info() {}, error: (message) => logs.push(message) },
    transportFactory() {
      return { from: 'sender@example.com', transporter: {
        async verify() { const error = new Error('secret password leaked'); error.code = 'EAUTH'; throw error; },
        close() {},
      } };
    },
  });
  assert.equal(result.failed, true);
  assert.match(logs[0], /SMTP認証に失敗/);
  assert.ok(!logs.join('').includes('secret password leaked'));
  assert.match(safeSmtpErrorMessage({ code: 'ECONNREFUSED', message: 'private details' }), /SMTPサーバーに接続できません/);
  assert.ok(!safeSmtpErrorMessage({ message: 'private details' }).includes('private details'));
});
