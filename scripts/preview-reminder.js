'use strict';

const http = require('node:http');
const { createReminderMessage } = require('../src/reminder-mail');

const sampleJob = Object.freeze({
  id: 'preview-only',
  outingDate: '2026-11-06',
  destination: '上野公園',
  activity: '公園を散策して、近くの美術館を訪れる',
});
const previewMessage = createReminderMessage(sampleJob, 'preview@example.test');

const previewPage = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>リマインダーメール プレビュー</title>
<style>body{margin:0;padding:24px;background:#eef2f7;color:#172033;font-family:system-ui,sans-serif}main{max-width:850px;margin:auto}h1{font-size:1.5rem}.card{margin:16px 0;padding:20px;background:white;border:1px solid #dbe2ea;border-radius:10px}iframe{display:block;width:100%;height:520px;border:1px solid #dbe2ea;background:#f1f5f9}pre{overflow-wrap:anywhere;white-space:pre-wrap;font:15px/1.7 system-ui,sans-serif}small{color:#475569}</style></head>
<body><main><h1>お出かけリマインダーメールのプレビュー</h1>
<p><strong>件名：</strong><span id="subject"></span></p>
<small>これはテスト用データのローカル表示です。メール送信・DB接続は行いません。</small>
<section class="card"><h2>HTMLメール</h2><iframe title="HTMLメールのプレビュー" src="/email.html"></iframe></section>
<section class="card"><h2>プレーンテキストメール</h2><pre id="plain-text">読み込み中…</pre></section>
</main><script>
document.querySelector('#subject').textContent = ${JSON.stringify(previewMessage.subject)};
fetch('/text.txt').then(response => { if (!response.ok) throw new Error('preview unavailable'); return response.text(); })
  .then(text => { document.querySelector('#plain-text').textContent = text; })
  .catch(() => { document.querySelector('#plain-text').textContent = 'テキストを読み込めませんでした。ページを再読み込みしてください。'; });
</script></body></html>`;

function createPreviewServer() {
  return http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'");
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end('Method Not Allowed');
      return;
    }
    if (request.url === '/' || request.url === '/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(previewPage);
      return;
    }
    if (request.url === '/email.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'SAMEORIGIN' }).end(previewMessage.html);
      return;
    }
    if (request.url === '/text.txt') {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(previewMessage.text);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
  });
}

if (require.main === module) {
  const port = Number(process.env.REMINDER_PREVIEW_PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('REMINDER_PREVIEW_PORTには1〜65535の整数を指定してください。');
    process.exitCode = 1;
  } else {
    const server = createPreviewServer();
    server.listen(port, '127.0.0.1', () => {
      console.log(`リマインダーメールのローカルプレビュー: http://127.0.0.1:${port}`);
      console.log('テスト用データを表示しています。メール送信およびDB接続は行いません。');
    });
  }
}

module.exports = { createPreviewServer, previewMessage, sampleJob };
