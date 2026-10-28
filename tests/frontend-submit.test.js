const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const weatherIcons = require('../public/weather-icons');

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
  const weatherLookup = new MockElement('weather-lookup');
  const weatherFeedback = new MockElement('weather-feedback');
  const weatherResult = new MockElement('weather-result');
  weatherResult.hidden = true;
  const weatherDetails = new Map(['weather-result-icon', 'weather-location', 'weather-kind', 'weather-condition', 'weather-temperature', 'weather-high-low', 'weather-precipitation', 'weather-feels-like', 'weather-humidity', 'weather-wind', 'weather-observed', 'weather-retrieved'].map((id) => [`#${id}`, new MockElement(id)]));
  const list = new MockElement('list');
  const loading = new MockElement('loading');
  const empty = new MockElement('empty');
  const count = new MockElement('count');
  const title = new MockElement('title');
  const elements = new Map([
    ['#trip-form', form], ['#records-list', list], ['#records-loading', loading],
    ['#records-empty', empty], ['#app-status', status], ['#record-count', count],
    ['#submit-button', button], ['#cancel-edit', cancel], ['#form-title', title],
    ['#weather-lookup-button', weatherLookup], ['#weather-feedback', weatherFeedback], ['#weather-result', weatherResult],
    ['#outing-date', form.elements.namedItem('outingDate')],
  ]);
  for (const [selector, element] of weatherDetails) elements.set(selector, element);
  const document = {
    querySelector: (selector) => elements.get(selector) || null,
    createElement: () => new MockElement(),
    createTextNode: (text) => ({ textContent: text }),
  };
  const context = {
    document,
    window: { confirm: () => true, WeatherIcons: weatherIcons },
    fetch: fetchImpl,
    FormData: MockFormData,
    Date,
    console,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(frontendScript, context, { filename: 'public/app.js' });
  return { form, controls, button, label, icon, cancel, status, weatherLookup, weatherFeedback, weatherResult, weatherDetails, list };
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

test('天気検索はバックエンド経由で現在天気を表示し、天気欄へ反映する', async () => {
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(String(url));
    if (String(url) === '/api/trips') return jsonResponse(200, []);
    return jsonResponse(200, {
      location: { name: '東京', region: '東京都', country: '日本' },
      dataType: 'current', targetDate: '2026-10-28', weather: '晴れ', temperature: { value: 20, unit: '°C' },
      apparentTemperature: { value: 19, unit: '°C' }, humidity: { value: 60, unit: '%' },
      windSpeed: { value: 5, unit: 'km/h' }, observedAt: '2026-10-27T15:00',
      timezone: 'Asia/Tokyo', retrievedAt: '2026-10-27T06:00:00.000Z',
    });
  };
  const ui = createFrontend(fetchImpl);
  ui.controls.find((item) => item.name === 'city').value = '東京';
  ui.controls.find((item) => item.name === 'outingDate').value = '2026-10-28';
  await new Promise((resolve) => setImmediate(resolve));

  await ui.weatherLookup.listeners.get('click')();
  assert.deepEqual(fetchCalls, ['/api/trips', '/api/weather?city=%E6%9D%B1%E4%BA%AC&date=2026-10-28']);
  assert.equal(ui.weatherLookup.disabled, false);
  assert.equal(ui.weatherResult.hidden, false);
  assert.equal(ui.weatherDetails.get('#weather-condition').textContent, '晴れ');
  assert.equal(ui.weatherDetails.get('#weather-kind').textContent, '現在の天気');
  assert.equal(ui.weatherDetails.get('#weather-temperature').textContent, '20°C');
  assert.match(ui.weatherDetails.get('#weather-observed').textContent, /Asia\/Tokyo/);
  assert.equal(ui.controls.find((item) => item.name === 'weather').value, '晴れ');
});

test('日付変更で予報を再取得し、天気種別と日別値を区別して表示する', async () => {
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(String(url));
    if (String(url) === '/api/trips') return jsonResponse(200, []);
    return jsonResponse(200, {
      dataType: 'forecast', targetDate: '2026-10-29',
      location: { name: '東京', region: '東京都', country: '日本' }, weather: '小雨', temperature: null,
      temperatureMax: { value: 20, unit: '°C' }, temperatureMin: { value: 12, unit: '°C' },
      precipitation: { value: 1.5, unit: 'mm' }, apparentTemperature: null, humidity: null, windSpeed: null,
      observedAt: '2026-10-29', timezone: 'Asia/Tokyo', retrievedAt: '2026-10-28T06:00:00.000Z',
    });
  };
  const ui = createFrontend(fetchImpl);
  ui.controls.find((item) => item.name === 'city').value = '東京';
  ui.controls.find((item) => item.name === 'outingDate').value = '2026-10-29';
  await new Promise((resolve) => setImmediate(resolve));

  await ui.controls.find((item) => item.name === 'outingDate').listeners.get('change')();
  assert.equal(fetchCalls[1], '/api/weather?city=%E6%9D%B1%E4%BA%AC&date=2026-10-29');
  assert.equal(ui.weatherDetails.get('#weather-kind').textContent, '天気予報');
  assert.equal(ui.weatherDetails.get('#weather-result-icon').textContent, '🌧️');
  assert.equal(ui.weatherDetails.get('#weather-temperature').textContent, '');
  assert.equal(ui.weatherDetails.get('#weather-high-low').textContent, '最高 20°C / 最低 12°C');
  assert.equal(ui.weatherDetails.get('#weather-precipitation').textContent, '降水量 1.5mm');
});

test('保存済み記録の再表示では天気APIを呼ばず保存文字列を維持する', async () => {
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(String(url));
    return jsonResponse(200, [{ id: 1, outingDate: '2026-04-12', city: '京都市', destination: '嵐山', weather: '小雨' }]);
  };
  const ui = createFrontend(fetchImpl);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetchCalls, ['/api/trips']);
  assert.equal(ui.weatherResult.hidden, true);
  const texts = [];
  const collectText = (node) => {
    if (typeof node.textContent === 'string') texts.push(node.textContent);
    for (const child of node.children || []) collectText(child);
  };
  collectText(ui.list);
  assert.ok(texts.includes('小雨'), '保存済み天気をそのまま一覧に表示する');
});

test('天気タイムアウトは日本語で表示され、天気ボタン復帰後も記録を登録できる', async () => {
  const timeoutMessage = '天気情報の取得がタイムアウトしました。時間をおいて再度お試しください。';
  let postCount = 0;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).startsWith('/api/weather')) {
      return jsonResponse(504, { error: { code: 'WEATHER_TIMEOUT', message: timeoutMessage } });
    }
    if (options.method === 'POST') {
      postCount += 1;
      return jsonResponse(201, { id: '601' });
    }
    if (String(url) === '/api/trips') return jsonResponse(200, []);
    throw new Error(`Unexpected request: ${url}`);
  };
  const ui = createFrontend(fetchImpl);
  ui.controls.find((item) => item.name === 'city').value = '札幌市';
  ui.controls.find((item) => item.name === 'outingDate').value = '2026-10-28';
  ui.controls.find((item) => item.name === 'destination').value = '大通公園';
  await new Promise((resolve) => setImmediate(resolve));

  await ui.weatherLookup.listeners.get('click')();
  assert.equal(ui.weatherFeedback.dataset.kind, 'error');
  assert.equal(ui.weatherFeedback.textContent, timeoutMessage);
  assert.equal(ui.weatherLookup.disabled, false, 'タイムアウト後に天気取得ボタンを再有効化する');

  await ui.form.listeners.get('submit')(submitEvent());
  assert.equal(postCount, 1, '天気タイムアウト後も記録のPOSTを実行できる');
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.status.dataset.kind, 'success');
});
