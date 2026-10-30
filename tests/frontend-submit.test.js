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
    this.checked = false;
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.attributes = new Set();
    this.listeners = new Map();
    this.children = [];
  }
  addEventListener(type, callback) {
    const previous = this.listeners.get(type);
    this.listeners.set(type, previous ? (...args) => { previous(...args); callback(...args); } : callback);
  }
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
    for (const control of this.controls) { control.value = ''; control.checked = false; }
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
  const names = ['outingDate', 'city', 'destination', 'activity', 'weather', 'notes', 'reminderEnabled'];
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
  const cityFeedback = new MockElement('city-feedback');
  const reminderHelp = new MockElement('reminder-help');
  const citySuggestions = new MockElement('city-suggestions');
  citySuggestions.hidden = true;
  const weatherResult = new MockElement('weather-result');
  weatherResult.hidden = true;
  const weatherDetails = new Map(['weather-result-icon', 'weather-location', 'weather-kind', 'weather-condition', 'weather-temperature', 'weather-high-low', 'weather-precipitation', 'weather-feels-like', 'weather-humidity', 'weather-wind', 'weather-observed', 'weather-retrieved'].map((id) => [`#${id}`, new MockElement(id)]));
  const list = new MockElement('list');
  const loading = new MockElement('loading');
  const empty = new MockElement('empty');
  const count = new MockElement('count');
  const title = new MockElement('title');
  const pageSize = new MockElement('page-size');
  pageSize.value = '10';
  const pagination = new MockElement('records-pagination');
  const previousPage = new MockElement('previous-page');
  const nextPage = new MockElement('next-page');
  const pageNumbers = new MockElement('page-numbers');
  const pageSummary = new MockElement('page-summary');
  const appContent = new MockElement('app-content');
  appContent.hidden = true;
  const signedInUser = new MockElement('signed-in-user');
  const logoutButton = new MockElement('logout-button');
  const elements = new Map([
    ['#trip-form', form], ['#records-list', list], ['#records-loading', loading],
    ['#records-empty', empty], ['#app-status', status], ['#record-count', count],
    ['#submit-button', button], ['#cancel-edit', cancel], ['#form-title', title],
    ['#weather-lookup-button', weatherLookup], ['#weather-feedback', weatherFeedback], ['#weather-result', weatherResult],
    ['#outing-date', form.elements.namedItem('outingDate')],
    ['#reminder-enabled', form.elements.namedItem('reminderEnabled')], ['#reminder-help', reminderHelp],
    ['#city', form.elements.namedItem('city')], ['#city-feedback', cityFeedback], ['#city-suggestions', citySuggestions],
    ['#page-size', pageSize], ['#records-pagination', pagination], ['#previous-page', previousPage],
    ['#next-page', nextPage], ['#page-numbers', pageNumbers], ['#page-summary', pageSummary],
    ['#app-content', appContent], ['#signed-in-user', signedInUser], ['#logout-button', logoutButton],
  ]);
  for (const [selector, element] of weatherDetails) elements.set(selector, element);
  const document = {
    querySelector: (selector) => elements.get(selector) || null,
    createElement: () => new MockElement(),
    createTextNode: (text) => ({ textContent: text }),
  };
  const context = {
    document,
    window: { confirm: () => true, WeatherIcons: weatherIcons, location: { assign() {} } },
    fetch: (url, options) => String(url) === '/api/auth/me'
      ? Promise.resolve(jsonResponse(200, { user: { displayName: 'テストユーザー', email: 'test@example.com' }, csrfToken: 'test-csrf-token' }))
      : fetchImpl(url, options),
    FormData: MockFormData,
    Date,
    console,
    encodeURIComponent,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(frontendScript, context, { filename: 'public/app.js' });
  return { form, controls, button, label, icon, cancel, status, weatherLookup, weatherFeedback, cityFeedback, citySuggestions, weatherResult, weatherDetails, list, appContent, signedInUser, logoutButton, pageSize, pagination, previousPage, nextPage, pageNumbers, pageSummary, reminderHelp };
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

test('未来日でのみ通知を選択でき、登録APIへ明示的な設定値を送る', async () => {
  let payload;
  const ui = createFrontend(async (url, options = {}) => {
    if (options.method === 'POST') { payload = JSON.parse(options.body); return jsonResponse(201, { id: '502' }); }
    return jsonResponse(200, []);
  });
  ui.controls.find((item) => item.name === 'outingDate').value = '2099-01-01';
  ui.controls.find((item) => item.name === 'outingDate').listeners.get('change')();
  const reminder = ui.controls.find((item) => item.name === 'reminderEnabled');
  assert.equal(reminder.disabled, false);
  reminder.checked = true;
  ui.controls.find((item) => item.name === 'city').value = '札幌市';
  ui.controls.find((item) => item.name === 'destination').value = '大通公園';
  await new Promise((resolve) => setImmediate(resolve));
  await ui.form.listeners.get('submit')(submitEvent());
  assert.equal(payload.reminderEnabled, true);
});

test('通知予定の説明は日本時間10:00と表示する', async () => {
  const ui = createFrontend(async () => jsonResponse(200, []));
  const date = ui.controls.find((item) => item.name === 'outingDate');
  date.value = '2099-01-01';
  date.listeners.get('change')();
  assert.match(ui.reminderHelp.textContent, /日本時間10:00/);
});

test('ログイン後に所有画面を表示し、ログアウト時はCSRFヘッダーを送る', async () => {
  let logoutRequest;
  const ui = createFrontend(async (url, options = {}) => {
    if (String(url).startsWith('/api/trips')) return jsonResponse(200, []);
    if (url === '/api/auth/logout') { logoutRequest = options; return { status: 204, ok: true }; }
    throw new Error(`Unexpected request: ${url}`);
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.appContent.hidden, false);
  assert.equal(ui.signedInUser.textContent, 'テストユーザー');
  assert.equal(ui.logoutButton.hidden, false);
  await ui.logoutButton.listeners.get('click')();
  assert.equal(logoutRequest.method, 'POST');
  assert.equal(logoutRequest.headers['X-CSRF-Token'], 'test-csrf-token');
});

test('記録一覧はサーバー側ページネーションを使い、ページと表示件数を更新する', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const address = new URL(String(url), 'http://localhost');
    if (address.pathname === '/api/trips') {
      calls.push(`${address.searchParams.get('page')}/${address.searchParams.get('limit')}`);
      const limit = Number(address.searchParams.get('limit'));
      const page = Number(address.searchParams.get('page'));
      const totalPages = Math.ceil(25 / limit);
      return jsonResponse(200, { data: [], pagination: { page, limit, total: 25, totalPages } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const ui = createFrontend(fetchImpl);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['1/10']);
  assert.equal(ui.pageSummary.textContent, '1 / 3 ページ ・ 全 25 件');
  assert.equal(ui.previousPage.disabled, true);

  ui.nextPage.listeners.get('click')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['1/10', '2/10']);
  assert.equal(ui.pageSummary.textContent, '2 / 3 ページ ・ 全 25 件');
  assert.equal(ui.previousPage.disabled, false);
  assert.equal(ui.nextPage.disabled, false);

  ui.pageSize.value = '5';
  ui.pageSize.listeners.get('change')();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['1/10', '2/10', '1/5']);
  assert.equal(ui.pageSummary.textContent, '1 / 5 ページ ・ 全 25 件');
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
    if (String(url).startsWith('/api/trips')) return jsonResponse(200, []);
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
  assert.deepEqual(fetchCalls, ['/api/trips?page=1&limit=10', '/api/weather?city=%E6%9D%B1%E4%BA%AC&date=2026-10-28']);
  assert.equal(ui.weatherLookup.disabled, false);
  assert.equal(ui.weatherResult.hidden, false);
  assert.equal(ui.weatherDetails.get('#weather-condition').textContent, '晴れ');
  assert.equal(ui.weatherDetails.get('#weather-kind').textContent, '現在の天気');
  assert.equal(ui.weatherDetails.get('#weather-temperature').textContent, '20°C');
  assert.match(ui.weatherDetails.get('#weather-observed').textContent, /Asia\/Tokyo/);
  assert.equal(ui.controls.find((item) => item.name === 'weather').value, '晴れ');
});

test('都市候補は300ms後に検索し、Enterで選択した座標を天気取得に使う', async () => {
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).startsWith('/api/trips')) return jsonResponse(200, []);
    if (String(url).startsWith('/api/weather/locations')) return jsonResponse(200, { results: [{
      id: 1850147, name: '東京', region: '東京都', country: '日本', latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo',
    }] });
    return jsonResponse(200, {
      location: { name: '東京', region: '東京都', country: '日本' }, dataType: 'current', targetDate: '2026-10-28',
      weather: '晴れ', temperature: { value: 20, unit: '°C' }, apparentTemperature: null, humidity: null, windSpeed: null,
      observedAt: '2026-10-28T09:00', timezone: 'Asia/Tokyo', retrievedAt: '2026-10-28T00:00:00Z',
    });
  };
  const ui = createFrontend(fetchImpl);
  const city = ui.controls.find((item) => item.name === 'city');
  city.value = 'Tokyo';
  city.listeners.get('input')();
  city.value = 'Tokyo-to';
  city.listeners.get('input')();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(fetchCalls.filter((url) => url.startsWith('/api/weather/locations')).length, 1, '連続入力はデバウンスする');
  assert.equal(ui.citySuggestions.hidden, false);
  assert.equal(ui.citySuggestions.children.length, 1);

  city.listeners.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.equal(ui.citySuggestions.hidden, true, 'Escapeで候補を閉じる');
  city.listeners.get('input')();
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(ui.citySuggestions.hidden, false);
  city.listeners.get('keydown')({ key: 'ArrowDown', preventDefault() {} });
  city.listeners.get('keydown')({ key: 'ArrowUp', preventDefault() {} });
  city.listeners.get('keydown')({ key: 'Enter', preventDefault() {} });
  assert.equal(city.value, '東京');
  city.value = '東京';
  ui.controls.find((item) => item.name === 'outingDate').value = '2026-10-28';
  await ui.weatherLookup.listeners.get('click')();
  const weatherUrl = new URL(fetchCalls.find((url) => url.startsWith('/api/weather?')), 'http://localhost');
  assert.equal(weatherUrl.searchParams.get('latitude'), '35.68');
  assert.equal(weatherUrl.searchParams.get('longitude'), '139.69');
  assert.equal(weatherUrl.searchParams.get('timezone'), 'Asia/Tokyo');
});

test('日付変更で予報を再取得し、天気種別と日別値を区別して表示する', async () => {
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).startsWith('/api/trips')) return jsonResponse(200, []);
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
  assert.deepEqual(fetchCalls, ['/api/trips?page=1&limit=10']);
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
    if (String(url).startsWith('/api/trips')) return jsonResponse(200, []);
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
