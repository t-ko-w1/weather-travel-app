const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontendScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

class MockElement {
  constructor(name = '') {
    this.name = name;
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.attributes = new Set();
    this.listeners = new Map();
    this.children = [];
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  setAttribute(name) { this.attributes.add(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  querySelector(selector) { return this.selectors?.get(selector) || null; }
  querySelectorAll(selector) { return this.groups?.get(selector) || []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  focus() {}
  scrollIntoView() {}
  reset() {
    for (const control of this.controls) control.value = '';
  }
}

class MockFormData {
  constructor(form) { this.values = form.controls.map((control) => [control.name, control.value]); }
  [Symbol.iterator]() { return this.values[Symbol.iterator](); }
}

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function createFrontend(fetchImpl) {
  const names = ['outingDate', 'city', 'destination', 'activity', 'weather', 'notes'];
  const controls = names.map((name) => new MockElement(name));
  const errors = names.map((name) => new MockElement(`error-${name}`));
  const form = new MockElement('form');
  form.controls = controls;
  form.elements = { namedItem: (name) => controls.find((control) => control.name === name) };
  const counters = ['activity', 'notes'].map((name) => new MockElement(`count-${name}`));
  form.groups = new Map([
    ['.field-error', errors],
    ['input, textarea', controls],
  ]);
  form.selectors = new Map(names.map((name, index) => [`[data-error-for="${name}"]`, errors[index]]));
  for (const counter of counters) form.selectors.set(`[data-count-for="${counter.name.slice(6)}"]`, counter);

  const button = new MockElement('submit-button');
  const label = new MockElement('label');
  const icon = new MockElement('icon');
  button.selectors = new Map([['span:last-child', label], ['.button-icon', icon]]);
  const cancel = new MockElement('cancel-edit');
  const status = new MockElement('status');
  const list = new MockElement('list');
  const loading = new MockElement('loading');
  const empty = new MockElement('empty');
  const count = new MockElement('count');
  const title = new MockElement('title');
  const elements = new Map([
    ['#trip-form', form], ['#records-list', list], ['#records-loading', loading],
    ['#records-empty', empty], ['#app-status', status], ['#record-count', count],
    ['#submit-button', button], ['#cancel-edit', cancel], ['#form-title', title],
    ['#outing-date', form.elements.namedItem('outingDate')],
  ]);
  const document = {
    querySelector: (selector) => elements.get(selector) || null,
    createElement: () => new MockElement(),
    createTextNode: (text) => ({ textContent: text }),
  };
  const context = {
    document,
    window: { confirm: () => true },
    fetch: fetchImpl,
    FormData: MockFormData,
    Date,
    console,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(frontendScript, context, { filename: 'public/app.js' });
  return { form, controls, button, label, icon, cancel, status };
}

function submitEvent() { return { preventDefault() {} }; }

test('連続した登録操作はPOSTを1回だけ送り、成功後に送信状態を解除する', async () => {
  let releasePost;
  let postCount = 0;
  const fetchImpl = (url, options = {}) => {
    if (options.method === 'POST') {
      postCount += 1;
      return new Promise((resolve) => { releasePost = resolve; });
    }
    return Promise.resolve(jsonResponse(200, []));
  };
  const ui = createFrontend(fetchImpl);
  ui.controls.find((item) => item.name === 'city').value = '札幌市';
  ui.controls.find((item) => item.name === 'destination').value = '大通公園';
  await new Promise((resolve) => setImmediate(resolve));

  const submit = ui.form.listeners.get('submit');
  const first = submit(submitEvent());
  const second = submit(submitEvent());
  assert.equal(ui.button.disabled, true, 'POST完了までは登録ボタンを無効化する');
  assert.equal(postCount, 1, '短時間の連続送信でもPOSTは1回');

  releasePost(jsonResponse(201, { id: '501' }));
  await Promise.all([first, second]);
  assert.equal(ui.button.disabled, false, '成功後に登録ボタンを再度有効化する');
  assert.match(ui.status.textContent, /登録しました/);
  assert.equal(ui.status.dataset.kind, 'success');
});

test('登録APIが失敗した場合も送信状態を解除してエラーを表示する', async () => {
  let postCount = 0;
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === 'POST') {
      postCount += 1;
      return jsonResponse(400, { error: { message: '入力エラーです。' } });
    }
    return jsonResponse(200, []);
  };
  const ui = createFrontend(fetchImpl);
  ui.controls.find((item) => item.name === 'city').value = '札幌市';
  ui.controls.find((item) => item.name === 'destination').value = '大通公園';
  await new Promise((resolve) => setImmediate(resolve));

  const submit = ui.form.listeners.get('submit');
  await Promise.all([submit(submitEvent()), submit(submitEvent())]);
  assert.equal(postCount, 1, '失敗応答中も二重POSTを送らない');
  assert.equal(ui.button.disabled, false, '失敗後に登録ボタンを再度有効化する');
  assert.match(ui.status.textContent, /入力エラーです/);
  assert.equal(ui.status.dataset.kind, 'error');
});
