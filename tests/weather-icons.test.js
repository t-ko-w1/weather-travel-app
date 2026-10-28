const test = require('node:test');
const assert = require('node:assert/strict');
const { iconForWeather } = require('../public/weather-icons');

test('天気文字列ごとに対応するアイコンを返す', () => {
  const cases = [
    ['晴れ', '☀️'],
    ['快晴', '☀️'],
    ['曇り', '☁️'],
    ['小雨', '🌧️'],
    ['雨', '🌧️'],
    ['雪', '❄️'],
    ['雷雨', '⛈️'],
  ];
  for (const [weather, expected] of cases) assert.equal(iconForWeather(weather), expected, weather);
});

test('複合表現では雷・雪・雨・曇りを晴れより優先する', () => {
  assert.equal(iconForWeather('晴れ時々曇り'), '☁️');
  assert.equal(iconForWeather('晴れのち小雨'), '🌧️');
  assert.equal(iconForWeather('雨のち雷'), '⛈️');
});

test('未入力や未知の天気には中立アイコンを返す', () => {
  assert.equal(iconForWeather(null), '🌡️');
  assert.equal(iconForWeather(''), '🌡️');
  assert.equal(iconForWeather('不明'), '🌡️');
  assert.equal(iconForWeather('快適'), '🌡️');
});
