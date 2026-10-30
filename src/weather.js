const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const REQUEST_TIMEOUT_MS = 8000;
const FORECAST_DAYS = 16;

const WEATHER_DESCRIPTIONS_JA = {
  0: '快晴', 1: 'おおむね晴れ', 2: '一部曇り', 3: '曇り',
  45: '霧', 48: '着氷性の霧', 51: '弱い霧雨', 53: '霧雨', 55: '強い霧雨',
  56: '弱い着氷性の霧雨', 57: '強い着氷性の霧雨',
  61: '弱い雨', 63: '雨', 65: '強い雨', 66: '弱い着氷性の雨', 67: '強い着氷性の雨',
  71: '弱い雪', 73: '雪', 75: '強い雪', 77: '霧雪',
  80: '弱いにわか雨', 81: 'にわか雨', 82: '強いにわか雨',
  85: '弱いにわか雪', 86: '強いにわか雪',
  95: '雷雨', 96: 'ひょうを伴う雷雨', 99: '強いひょうを伴う雷雨',
};

class WeatherError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function dateInTimezone(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    throw new WeatherError(502, 'WEATHER_PROVIDER_ERROR', '都市のタイムゾーンを確認できませんでした。');
  }
}

function dateDistance(from, to) {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
}

function createWeatherService({ fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS, now = () => new Date() } = {}) {
  async function fetchJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new WeatherError(502, 'WEATHER_PROVIDER_ERROR', '天気情報サービスから応答を取得できませんでした。');
      }
      try { return await response.json(); } catch {
        throw new WeatherError(502, 'WEATHER_PROVIDER_ERROR', '天気情報サービスの応答を読み取れませんでした。');
      }
    } catch (error) {
      if (error instanceof WeatherError) throw error;
      if (error.name === 'AbortError') {
        throw new WeatherError(504, 'WEATHER_TIMEOUT', '天気情報の取得がタイムアウトしました。時間をおいて再度お試しください。');
      }
      throw new WeatherError(502, 'WEATHER_UNAVAILABLE', '天気情報サービスに接続できませんでした。');
    } finally { clearTimeout(timeout); }
  }

  async function searchLocations(query) {
    const cleanQuery = typeof query === 'string' ? query.trim() : '';
    if ([...cleanQuery].length < 2 || [...cleanQuery].length > 100) {
      throw new WeatherError(400, 'INVALID_QUERY', '都市名は2文字以上100文字以内で入力してください。');
    }
    const terms = locationSearchTerms(cleanQuery);
    const responses = await Promise.all(['ja', 'en', 'zh'].map(async (language) => {
      const results = [];
      for (const term of terms) {
        const url = new URL(GEOCODING_URL);
        url.search = new URLSearchParams({ name: term, count: '5', language, format: 'json' });
        const payload = await fetchJson(url);
        results.push(...(Array.isArray(payload?.results) ? payload.results : []));
      }
      return results;
    }));
    const unique = new Map();
    for (const location of responses.flat()) {
      if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude) || typeof location.timezone !== 'string') continue;
      const key = location.id ?? `${location.latitude},${location.longitude}`;
      if (!unique.has(key)) unique.set(key, location);
    }
    return [...unique.values()].slice(0, 8).map((location) => ({
      id: location.id ?? null,
      name: location.name,
      region: location.admin1 || null,
      country: location.country || null,
      latitude: location.latitude,
      longitude: location.longitude,
      timezone: location.timezone,
    }));
  }

  async function getWeather(city, targetDate, selectedLocation = null) {
    const cleanCity = typeof city === 'string' ? city.trim() : '';
    if (cleanCity.length < 2 || [...cleanCity].length > 100) {
      throw new WeatherError(400, 'INVALID_CITY', '都市名は2文字以上100文字以内で入力してください。');
    }
    if (!validDate(targetDate)) {
      throw new WeatherError(400, 'INVALID_DATE', '日付は有効なYYYY-MM-DD形式で指定してください。');
    }

    let location = selectedLocation;
    if (!location) {
      const geocodingUrl = new URL(GEOCODING_URL);
      geocodingUrl.search = new URLSearchParams({ name: cleanCity, count: '1', language: 'ja', format: 'json' });
      const geocoding = await fetchJson(geocodingUrl);
      location = geocoding?.results?.[0];
    }
    if (!location) throw new WeatherError(404, 'CITY_NOT_FOUND', '都市が見つかりません。都市名を変えてお試しください。');
    if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude) || typeof location.timezone !== 'string') {
      throw new WeatherError(502, 'WEATHER_PROVIDER_ERROR', '都市の位置情報を取得できませんでした。');
    }

    const today = dateInTimezone(now(), location.timezone);
    const dataType = targetDate < today ? 'historical' : targetDate > today ? 'forecast' : 'current';
    if (dataType === 'historical' && targetDate < '1940-01-01') {
      throw new WeatherError(422, 'HISTORY_UNAVAILABLE', '履歴天気データは1940年以降の日付が対象です。');
    }
    if (dataType === 'forecast' && dateDistance(today, targetDate) >= FORECAST_DAYS) {
      throw new WeatherError(422, 'FORECAST_OUT_OF_RANGE', `天気予報は今日から${FORECAST_DAYS - 1}日先まで取得できます。`);
    }

    const url = new URL(dataType === 'historical' ? ARCHIVE_URL : FORECAST_URL);
    const params = {
      latitude: String(location.latitude), longitude: String(location.longitude),
      temperature_unit: 'celsius', precipitation_unit: 'mm', timezone: location.timezone,
    };
    if (dataType === 'current') {
      params.current = 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m';
    } else {
      params.start_date = targetDate;
      params.end_date = targetDate;
      params.daily = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum';
    }
    url.search = new URLSearchParams(params);
    const payload = await fetchJson(url);
    const retrievedAt = now().toISOString();
    const common = {
      dataType, targetDate,
      location: { name: location.name, region: location.region || location.admin1 || null, country: location.country || null },
      timezone: location.timezone,
      attribution: 'Weather data by Open-Meteo',
      retrievedAt,
      temperatureMax: null, temperatureMin: null, precipitation: null,
      apparentTemperature: null, humidity: null, windSpeed: null,
    };

    if (dataType === 'current') {
      const current = payload?.current;
      const units = payload?.current_units;
      if (!current || !units || typeof current.time !== 'string' || !Number.isFinite(current.weather_code)) {
        throw new WeatherError(502, 'WEATHER_PROVIDER_ERROR', '現在の天気情報を取得できませんでした。');
      }
      return {
        ...common,
        weather: WEATHER_DESCRIPTIONS_JA[current.weather_code] || '天気情報なし',
        temperature: { value: current.temperature_2m ?? null, unit: units.temperature_2m || '°C' },
        apparentTemperature: { value: current.apparent_temperature ?? null, unit: units.apparent_temperature || '°C' },
        humidity: { value: current.relative_humidity_2m ?? null, unit: units.relative_humidity_2m || '%' },
        windSpeed: { value: current.wind_speed_10m ?? null, unit: units.wind_speed_10m || 'km/h' },
        observedAt: current.time,
      };
    }

    const daily = payload?.daily;
    const index = Array.isArray(daily?.time) ? daily.time.indexOf(targetDate) : -1;
    if (index < 0) {
      if (dataType === 'historical') {
        throw new WeatherError(422, 'HISTORY_UNAVAILABLE', 'この日付の履歴天気データはまだ提供されていないか、対象期間外です。');
      }
      throw new WeatherError(422, 'FORECAST_OUT_OF_RANGE', '選択した日付の予報データは提供されていません。');
    }
    const code = daily.weather_code?.[index];
    const max = daily.temperature_2m_max?.[index];
    const min = daily.temperature_2m_min?.[index];
    const precipitation = daily.precipitation_sum?.[index];
    if (!Number.isFinite(code) || !Number.isFinite(max) || !Number.isFinite(min) || !Number.isFinite(precipitation)) {
      if (dataType === 'historical') {
        throw new WeatherError(422, 'HISTORY_UNAVAILABLE', 'この日付の履歴天気データを取得できませんでした。');
      }
      throw new WeatherError(422, 'FORECAST_OUT_OF_RANGE', '選択した日付の予報データは提供されていません。');
    }
    return {
      ...common,
      weather: WEATHER_DESCRIPTIONS_JA[code] || '天気情報なし',
      temperature: null,
      temperatureMax: { value: max, unit: dailyUnits(payload, 'temperature_2m_max', '°C') },
      temperatureMin: { value: min, unit: dailyUnits(payload, 'temperature_2m_min', '°C') },
      precipitation: { value: precipitation, unit: dailyUnits(payload, 'precipitation_sum', 'mm') },
      observedAt: targetDate,
    };
  }

  getWeather.searchLocations = searchLocations;
  return getWeather;
}

function locationSearchTerms(query) {
  const folded = query.normalize('NFKC').trim().toLocaleLowerCase();
  const tokyoAliases = new Set(['tokyo-to', 'tokyo to']);
  return tokyoAliases.has(folded) ? ['Tokyo'] : [query];
}

function dailyUnits(payload, name, fallback) {
  return payload?.daily_units?.[name] || fallback;
}

const getWeather = createWeatherService();

module.exports = { REQUEST_TIMEOUT_MS, FORECAST_DAYS, WeatherError, createWeatherService, getWeather };
