'use strict';

const nodemailer = require('nodemailer');

function createMailTransport(env = process.env) {
  const port = Number(env.MAIL_PORT || 1025);
  if (!env.MAIL_HOST || !Number.isInteger(port) || port < 1 || port > 65535 || !env.MAIL_FROM) {
    throw new Error('MAIL_HOST、MAIL_PORT、MAIL_FROMを設定してください。');
  }
  const options = {
    host: env.MAIL_HOST,
    port,
    secure: env.MAIL_SECURE === 'true',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  };
  if (env.MAIL_USER || env.MAIL_PASSWORD) {
    if (!env.MAIL_USER || !env.MAIL_PASSWORD) throw new Error('MAIL_USERとMAIL_PASSWORDを両方設定してください。');
    options.auth = { user: env.MAIL_USER, pass: env.MAIL_PASSWORD };
  }
  return { transporter: nodemailer.createTransport(options), from: env.MAIL_FROM };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function formatJapaneseDate(dateValue) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue));
  if (!match) throw new TypeError('お出かけ日はYYYY-MM-DD形式である必要があります。');
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== dateValue) {
    throw new TypeError('有効なお出かけ日が必要です。');
  }
  const weekday = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'][date.getUTCDay()];
  return `${Number(year)}年${Number(month)}月${Number(day)}日（${weekday}）`;
}

function createReminderMessage(job, from) {
  const outingDate = formatJapaneseDate(job.outingDate);
  const destination = String(job.destination || '');
  const activity = job.activity?.trim() || '';
  const textLines = [
    'お出かけの予定が近づいています！',
    '',
    `お出かけ日：${outingDate}`,
    `目的地：${destination}`,
  ];
  if (activity) textLines.push(`活動内容：${activity}`);
  textLines.push('', '当日の天気や交通情報を確認して、楽しいお出かけの準備を進めましょう！', '', 'このメールはお出かけ記録アプリから自動送信されています。');

  const safeDestination = escapeHtml(destination);
  const safeActivity = escapeHtml(activity);
  const activityRow = activity
    ? `<tr><td style="padding:12px 16px;border-top:1px solid #e5e7eb;color:#475569;font-size:14px;vertical-align:top;width:100px;">活動内容</td><td style="padding:12px 16px;border-top:1px solid #e5e7eb;color:#172033;font-size:15px;line-height:1.7;white-space:pre-wrap;">${safeActivity}</td></tr>`
    : '';
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>お出かけリマインダー</title></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#172033;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f1f5f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:28px 24px;background-color:#e0f2fe;color:#075985;font-size:22px;font-weight:700;line-height:1.5;">お出かけの予定が近づいています！</td></tr>
        <tr><td style="padding:24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #e5e7eb;border-radius:8px;">
            <tr><td style="padding:12px 16px;color:#475569;font-size:14px;width:100px;">お出かけ日</td><td style="padding:12px 16px;color:#172033;font-size:15px;font-weight:600;">${escapeHtml(outingDate)}</td></tr>
            <tr><td style="padding:12px 16px;border-top:1px solid #e5e7eb;color:#475569;font-size:14px;vertical-align:top;">目的地</td><td style="padding:12px 16px;border-top:1px solid #e5e7eb;color:#172033;font-size:15px;line-height:1.7;">${safeDestination}</td></tr>
            ${activityRow}
          </table>
          <p style="margin:24px 0 0;color:#334155;font-size:15px;line-height:1.8;">当日の天気や交通情報を確認して、楽しいお出かけの準備を進めましょう！</p>
        </td></tr>
        <tr><td style="padding:16px 24px;background-color:#f8fafc;color:#64748b;font-size:12px;line-height:1.6;">このメールはお出かけ記録アプリから自動送信されています。</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { from, subject: '【お出かけリマインダー】7日後のお出かけ予定をお知らせします', text: textLines.join('\n'), html };
}

function createReminderMailer({ transporter, from }) {
  return {
    async send(job) {
      const message = createReminderMessage(job, from);
      return transporter.sendMail({
        ...message,
        to: job.recipientEmail,
        // SMTP cannot provide exactly-once delivery. A stable job ID helps mail systems
        // identify retries, while DB claims prevent concurrent workers from sending twice.
        messageId: `<outing-reminder-${job.id}@weather-travel.local>`,
      });
    },
  };
}

module.exports = { createMailTransport, createReminderMailer, createReminderMessage, escapeHtml, formatJapaneseDate };
