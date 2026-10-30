'use strict';

require('dotenv').config();
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { createMailTransport } = require('../src/reminder-mail');

function normalizeRecipient(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  if (email.length > 254 || /[,;\s\r\n]/.test(email)) return null;
  if (!/^[^@<>]+@[^@<>]+\.[^@<>]+$/.test(email)) return null;
  return email;
}

function safeSmtpErrorMessage(error) {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
  const responseCode = Number(error?.responseCode);
  if (code === 'EAUTH' || responseCode === 535) {
    return 'SMTP認証に失敗しました。.envのMAIL_USERとMAIL_PASSWORDを確認してください。認証情報は表示していません。';
  }
  if (['ECONNECTION', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ESOCKET', 'ETLS'].includes(code)) {
    return 'SMTPサーバーに接続できませんでした。.envのMAIL_HOST、MAIL_PORT、MAIL_SECUREと接続状態を確認してください。';
  }
  return 'SMTP処理に失敗しました。認証情報を含む詳細は表示していません。';
}

async function sendTestEmail({ recipient, confirmation, env = process.env, transportFactory = createMailTransport, logger = console }) {
  const address = normalizeRecipient(recipient);
  if (!address) throw new Error('宛先メールアドレスを1件だけ指定してください。');
  if (confirmation !== address) throw new Error('宛先の確認が一致しないため、送信を中止しました。');

  let transporter;
  try {
    const mail = transportFactory(env);
    transporter = mail.transporter;
    await transporter.verify();
    const result = await transporter.sendMail({
      from: mail.from,
      to: address,
      subject: '[SMTP TEST] お天気・お出かけ記録アプリ',
      text: [
        'これはSMTP接続確認用のテストメールです。',
        'お天気・お出かけ記録アプリから送信しました。',
      ].join('\n'),
    });
    logger.info(`SMTPテストメールを送信しました。宛先: ${address}`);
    return { accepted: Array.isArray(result.accepted) ? result.accepted.length : 1 };
  } catch (error) {
    logger.error(safeSmtpErrorMessage(error));
    return { accepted: 0, failed: true };
  } finally {
    if (transporter && typeof transporter.close === 'function') transporter.close();
  }
}

async function main() {
  const recipient = normalizeRecipient(process.argv[2]);
  if (!recipient || process.argv.length !== 3) {
    console.error('使い方: npm run mail:test -- recipient@example.com');
    process.exitCode = 2;
    return;
  }

  const prompt = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log(`送信先: ${recipient}`);
    console.log('この宛先1件だけにテストメールを送信します。');
    const confirmation = await prompt.question('続けるには、上記の宛先をそのまま再入力してください: ');
    const result = await sendTestEmail({ recipient, confirmation });
    if (result.failed || result.accepted === 0) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    prompt.close();
  }
}

if (require.main === module) main();

module.exports = { normalizeRecipient, safeSmtpErrorMessage, sendTestEmail };
