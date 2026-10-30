(function attachWeatherIcons(root, createIcons) {
  const weatherIcons = createIcons();
  if (typeof module === 'object' && module.exports) module.exports = weatherIcons;
  if (root) root.WeatherIcons = weatherIcons;
})(typeof globalThis === 'undefined' ? this : globalThis, function createIcons() {
  function iconForWeather(description) {
    if (typeof description !== 'string' || description.trim() === '') return '🌡️';

    const weather = description.trim();
    if (/雷|かみなり/.test(weather)) return '⛈️';
    if (/雪/.test(weather)) return '❄️';
    if (/雨/.test(weather)) return '🌧️';
    if (/曇|くもり|雲/.test(weather)) return '☁️';
    if (/晴|快晴/.test(weather)) return '☀️';
    return '🌡️';
  }

  return { iconForWeather };
});
