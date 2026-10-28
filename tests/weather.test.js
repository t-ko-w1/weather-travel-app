const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { REQUEST_TIMEOUT_MS, WeatherError, createWeatherService } = require('../src/weather');
const { createApp } = require('../src/app');

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function geocodingResponse() {
  return { results: [{ name: '東京', admin1: '東京都', country: '日本', latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo' }] };
}

function createMockFetch(weatherResponse) {
  const urls = [];
  return {
    urls,
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return String(url).includes('geocoding-api') ? jsonResponse(geocodingResponse()) : jsonResponse(weatherResponse);
    },
  };
}

function dailyResponse(date = '2026-10-27') {
  return {
    timezone: 'Asia/Tokyo',
    daily: {
      time: [date], weather_code: [61], temperature_2m_max: [19.4], temperature_2m_min: [11.2], precipitation_sum: [2.3],
    },
    daily_units: { temperature_2m_max: '°C', temperature_2m_min: '°C', precipitation_sum: 'mm' },
  };
}

test('過去の日付は履歴APIから日別天気を取得し共通形式にする', async () => {
  const { fetchImpl, urls } = createMockFetch(dailyResponse());
  const getWeather = createWeatherService({ fetchImpl, now: () => new Date('2026-10-27T15:30:00.000Z') });
  const result = await getWeather('東京', '2026-10-27');
  assert.equal(urls[0].searchParams.get('name'), '東京');
  assert.equal(urls[1].hostname, 'archive-api.open-meteo.com');
  assert.equal(urls[1].searchParams.get('start_date'), '2026-10-27');
  assert.equal(urls[1].searchParams.get('end_date'), '2026-10-27');
  assert.equal(urls[1].searchParams.get('timezone'), 'Asia/Tokyo');
  assert.deepEqual({ dataType: result.dataType, targetDate: result.targetDate, weather: result.weather }, {
    dataType: 'historical', targetDate: '2026-10-27', weather: '弱い雨',
  });
  assert.equal(result.temperature, null);
  assert.deepEqual(result.temperatureMax, { value: 19.4, unit: '°C' });
  assert.deepEqual(result.temperatureMin, { value: 11.2, unit: '°C' });
  assert.deepEqual(result.precipitation, { value: 2.3, unit: 'mm' });
});

test('今日の判定は対象都市のタイムゾーンを使い、現在気温を日別気温と混同しない', async () => {
  const { fetchImpl, urls } = createMockFetch({
    timezone: 'Asia/Tokyo',
    current: { time: '2026-10-28T00:30', temperature_2m: 17, apparent_temperature: 16, relative_humidity_2m: 50, weather_code: 2, wind_speed_10m: 4 },
    current_units: { temperature_2m: '°C', apparent_temperature: '°C', relative_humidity_2m: '%', wind_speed_10m: 'km/h' },
  });
  const getWeather = createWeatherService({ fetchImpl, now: () => new Date('2026-10-27T15:30:00.000Z') });
  const result = await getWeather('東京', '2026-10-28');
  assert.equal(urls[1].hostname, 'api.open-meteo.com');
  assert.ok(urls[1].searchParams.has('current'));
  assert.equal(urls[1].searchParams.has('daily'), false);
  assert.equal(result.dataType, 'current');
  assert.deepEqual(result.temperature, { value: 17, unit: '°C' });
  assert.equal(result.temperatureMax, null);
  assert.equal(result.temperatureMin, null);
});

test('未来の予報可能日を取得し、予報日を共通形式へ変換する', async () => {
  const { fetchImpl, urls } = createMockFetch(dailyResponse('2026-10-29'));
  const result = await createWeatherService({ fetchImpl, now: () => new Date('2026-10-27T15:30:00Z') })('東京', '2026-10-29');
  assert.equal(urls[1].hostname, 'api.open-meteo.com');
  assert.equal(urls[1].searchParams.get('daily'), 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum');
  assert.equal(result.dataType, 'forecast');
  assert.equal(result.weather, '弱い雨');
});

test('予報範囲外の日付は外部予報APIを呼ばず理由を返す', async () => {
  let forecastCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('geocoding-api')) return jsonResponse(geocodingResponse());
    forecastCalls += 1;
    return jsonResponse({});
  };
  await assert.rejects(
    createWeatherService({ fetchImpl, now: () => new Date('2026-10-27T15:30:00Z') })('東京', '2026-11-13'),
    (error) => error.status === 422 && error.code === 'FORECAST_OUT_OF_RANGE' && /15日先/.test(error.message),
  );
  assert.equal(forecastCalls, 0);
});

test('履歴データが返らない場合は理由を示す', async () => {
  const { fetchImpl } = createMockFetch({ daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [] } });
  await assert.rejects(
    createWeatherService({ fetchImpl, now: () => new Date('2026-10-27T15:30:00Z') })('東京', '2026-10-26'),
    (error) => error.status === 422 && error.code === 'HISTORY_UNAVAILABLE' && /履歴天気データ/.test(error.message),
  );
});

test('都市なし・不正日付を識別し、都市なしでは天気APIを呼ばない', async () => {
  let calls = 0;
  const notFound = createWeatherService({ fetchImpl: async () => { calls += 1; return jsonResponse({ results: [] }); } });
  await assert.rejects(notFound('存在しない都市', '2026-10-28'), (error) => error.status === 404 && error.code === 'CITY_NOT_FOUND');
  assert.equal(calls, 1);
  await assert.rejects(notFound('東京', '2026-02-30'), (error) => error.status === 400 && error.code === 'INVALID_DATE');
});

test('天気APIタイムアウト後も記録一覧APIを利用できる', async () => {
  assert.equal(REQUEST_TIMEOUT_MS, 8000);
  const getWeather = createWeatherService({
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      const error = new Error('mock timeout'); error.name = 'AbortError'; reject(error);
    }, { once: true })),
    timeoutMs: 20,
  });
  let recordQueryCalls = 0;
  const server = createServer(createApp({ query: async () => { recordQueryCalls += 1; return { rows: [] }; }, weather: getWeather }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/weather?city=${encodeURIComponent('東京')}&date=2026-10-28`);
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'WEATHER_TIMEOUT');
    const trips = await fetch(`${base}/api/trips`);
    assert.equal(trips.status, 200);
    assert.deepEqual(await trips.json(), []);
    assert.equal(recordQueryCalls, 1);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test('天気API routeは都市・日付を渡し、日付不正を検証しCRUD queryを使わない', async () => {
  let queryCalls = 0;
  let args;
  const server = createServer(createApp({
    query: async () => { queryCalls += 1; return { rows: [] }; },
    weather: async (...values) => { args = values; return { dataType: 'forecast', weather: '晴れ' }; },
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/weather`;
    let response = await fetch(`${base}?city=${encodeURIComponent('東京')}&date=2026-10-29`);
    assert.equal(response.status, 200);
    assert.deepEqual(args, ['東京', '2026-10-29']);
    assert.deepEqual(await response.json(), { dataType: 'forecast', weather: '晴れ' });
    response = await fetch(`${base}?city=${encodeURIComponent('東京')}&date=nope`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_DATE');
    assert.equal(queryCalls, 0);
  } finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
