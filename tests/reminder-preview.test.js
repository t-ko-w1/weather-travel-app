'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPreviewServer, previewMessage, sampleJob } = require('../scripts/preview-reminder');

test('ローカルプレビューは実テンプレートのHTMLとテキストを送信せず表示する', async () => {
  const server = createPreviewServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    const pageText = await page.text();
    assert.equal(page.status, 200);
    assert.match(pageText, /メール送信・DB接続は行いません/);
    assert.match(pageText, /\/email\.html/);
    assert.match(pageText, /\/text\.txt/);

    const htmlResponse = await fetch(`${base}/email.html`);
    const html = await htmlResponse.text();
    assert.equal(htmlResponse.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(html, previewMessage.html);
    assert.match(html, new RegExp(sampleJob.destination));

    const textResponse = await fetch(`${base}/text.txt`);
    const text = await textResponse.text();
    assert.equal(textResponse.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(text, previewMessage.text);
    assert.match(text, new RegExp(sampleJob.activity));

    const missing = await fetch(`${base}/missing`);
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
