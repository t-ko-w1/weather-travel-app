const form = document.querySelector('#trip-form');
const list = document.querySelector('#records-list');
const loading = document.querySelector('#records-loading');
const empty = document.querySelector('#records-empty');
const statusBox = document.querySelector('#app-status');
const count = document.querySelector('#record-count');
const submitButton = document.querySelector('#submit-button');
const submitLabel = submitButton.querySelector('span:last-child');
const cancelEditButton = document.querySelector('#cancel-edit');
const formTitle = document.querySelector('#form-title');
const weatherLookupButton = document.querySelector('#weather-lookup-button');
const weatherFeedback = document.querySelector('#weather-feedback');
const weatherResult = document.querySelector('#weather-result');
const weatherDateInput = document.querySelector('#outing-date');
const reminderCheckbox = document.querySelector('#reminder-enabled');
const reminderHelp = document.querySelector('#reminder-help');
const cityInput = document.querySelector('#city');
const citySuggestions = document.querySelector('#city-suggestions');
const cityFeedback = document.querySelector('#city-feedback');
const appContent = document.querySelector('#app-content');
const signedInUser = document.querySelector('#signed-in-user');
const logoutButton = document.querySelector('#logout-button');
const pageSizeSelect = document.querySelector('#page-size');
const paginationNav = document.querySelector('#records-pagination');
const previousPageButton = document.querySelector('#previous-page');
const nextPageButton = document.querySelector('#next-page');
const pageNumbers = document.querySelector('#page-numbers');
const pageSummary = document.querySelector('#page-summary');
let editingId = null;
let busy = false;
let weatherRequestId = 0;
let csrfToken = null;
let citySearchTimer = null;
let citySearchRequestId = 0;
let cityLocations = [];
let activeCityIndex = -1;
let selectedCity = null;
let currentPage = 1;
let pageSize = 10;
let totalRecords = 0;
let totalPages = 1;
let recordsRequestId = 0;

const fieldNames = {
  outingDate: 'お出かけした日', city: '都市・エリア', destination: '目的地',
  activity: '活動内容', notes: 'メモ', weather: '天気',
};

function showStatus(message, kind = 'success') {
  statusBox.textContent = message;
  statusBox.dataset.kind = kind;
  statusBox.hidden = false;
}

function clearStatus() {
  statusBox.hidden = true;
  statusBox.textContent = '';
  delete statusBox.dataset.kind;
}

function setBusy(value, label = '') {
  busy = value;
  submitButton.disabled = value;
  cancelEditButton.disabled = value;
  submitLabel.textContent = label || (editingId === null ? '記録を保存する' : '変更を保存する');
  if (value) submitButton.querySelector('.button-icon').textContent = '…';
  else submitButton.querySelector('.button-icon').textContent = '↗';
}

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function tokyoToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function tokyoReminderTarget(outingDate) {
  const day = new Date(`${outingDate}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - 7);
  const targetDate = day.toISOString().slice(0, 10);
  const [year, month, date] = targetDate.split('-').map(Number);
  const desiredWallTime = Date.UTC(year, month - 1, date, 10);
  let candidate = desiredWallTime;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .map(({ type, value }) => [type, value]));
    const representedWallTime = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    const correction = desiredWallTime - representedWallTime;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate);
}

function updateReminderAvailability() {
  const date = weatherDateInput.value;
  const future = dateOnly(date) === date && date > tokyoToday();
  reminderCheckbox.disabled = !future;
  if (!future) {
    reminderCheckbox.checked = false;
    reminderHelp.textContent = '未来の日付の予定で通知を設定できます。';
  } else if (!reminderCheckbox.checked) {
    reminderHelp.textContent = '通知は初期状態で無効です。予定日の7日前、日本時間10:00にメールで通知します。';
  } else {
    const scheduled = tokyoReminderTarget(date);
    reminderHelp.textContent = scheduled.valueOf() <= Date.now()
      ? '通知予定時刻を過ぎているため、この予定には自動送信されません。'
      : '予定日の7日前、日本時間10:00にメールで通知します。';
  }
}

function resetForm() {
  form.reset();
  selectedCity = null;
  closeCitySuggestions();
  setCityFeedback('');
  document.querySelector('#outing-date').value = localToday();
  updateReminderAvailability();
  editingId = null;
  formTitle.textContent = 'お出かけを記録する';
  cancelEditButton.hidden = true;
  clearValidation();
  updateCounters();
  setBusy(false);
}

function clearValidation() {
  form.querySelectorAll('[aria-invalid="true"]').forEach((field) => field.removeAttribute('aria-invalid'));
  form.querySelectorAll('.field-error').forEach((node) => { node.textContent = ''; });
}

function setFieldError(name, message) {
  const input = form.elements.namedItem(name);
  const error = form.querySelector(`[data-error-for="${name}"]`);
  if (input) input.setAttribute('aria-invalid', 'true');
  if (error) error.textContent = message;
}

function updateCounters() {
  for (const name of ['activity', 'notes']) {
    const value = form.elements.namedItem(name).value;
    form.querySelector(`[data-count-for="${name}"]`).textContent = `${[...value].length} / 5000`;
  }
}

function dateOnly(value) {
  if (typeof value !== 'string') return '';
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value);
  if (!match) return '';
  const [year, month, day] = match[1].split('-').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return '';
  return match[1];
}

function validateForm() {
  clearValidation();
  const data = Object.fromEntries(new FormData(form));
  let valid = true;
  if (dateOnly(data.outingDate) !== data.outingDate) {
    setFieldError('outingDate', '日付を選択してください。'); valid = false;
  }
  for (const name of ['city', 'destination']) {
    if (!data[name].trim()) { setFieldError(name, `${fieldNames[name]}を入力してください。`); valid = false; }
  }
  if ([...data.city.trim()].length > 100) { setFieldError('city', '100文字以内で入力してください。'); valid = false; }
  if ([...data.destination.trim()].length > 200) { setFieldError('destination', '200文字以内で入力してください。'); valid = false; }
  if ([...data.activity].length > 5000) { setFieldError('activity', '5000文字以内で入力してください。'); valid = false; }
  if ([...data.notes].length > 5000) { setFieldError('notes', '5000文字以内で入力してください。'); valid = false; }
  if ([...data.weather.trim()].length > 50) { setFieldError('weather', '50文字以内で入力してください。'); valid = false; }
  if (!valid) {
    const firstInvalid = form.querySelector('[aria-invalid="true"]');
    firstInvalid?.focus();
  }
  return valid ? {
    outingDate: data.outingDate,
    city: data.city.trim(),
    destination: data.destination.trim(),
    activity: data.activity.trim() || null,
    notes: data.notes.trim() || null,
    weather: data.weather.trim() || null,
    reminderEnabled: reminderCheckbox.checked,
  } : null;
}

async function request(url, options = {}) {
  let response;
  try {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
    if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['X-CSRF-Token'] = csrfToken;
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch {
    throw new Error('サーバーに接続できません。起動状態を確認して、もう一度お試しください。');
  }
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.error?.details?.join(' ');
    const error = new Error(detail || body.error?.message || '処理に失敗しました。時間をおいて再度お試しください。');
    error.status = response.status;
    throw error;
  }
  return body;
}

function formatDate(value) {
  const normalized = dateOnly(value);
  if (!normalized) return '日付不明';
  const [year, month, day] = normalized.split('-').map(Number);
  return `${year}年${month}月${day}日`;
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = text;
  return element;
}

function renderPagination() {
  previousPageButton.disabled = currentPage <= 1;
  nextPageButton.disabled = currentPage >= totalPages;
  pageSummary.textContent = `${currentPage} / ${totalPages} ページ ・ 全 ${totalRecords} 件`;
  pageNumbers.replaceChildren();
  const visiblePages = new Set();
  if (totalPages <= 7) {
    for (let page = 1; page <= totalPages; page += 1) visiblePages.add(page);
  } else {
    visiblePages.add(1);
    visiblePages.add(totalPages);
    for (let page = Math.max(2, currentPage - 1); page <= Math.min(totalPages - 1, currentPage + 1); page += 1) visiblePages.add(page);
  }
  let previous = 0;
  for (const page of [...visiblePages].sort((a, b) => a - b)) {
    if (page - previous > 1) pageNumbers.append(makeElement('span', 'page-ellipsis', '…'));
    const button = makeElement('button', 'page-number', String(page));
    button.type = 'button';
    button.setAttribute('aria-label', `${page}ページ目`);
    if (page === currentPage) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => loadRecords({ page }));
    pageNumbers.append(button);
    previous = page;
  }
  paginationNav.hidden = false;
}

function renderRecords(payload) {
  const records = Array.isArray(payload) ? payload : payload.data;
  const pagination = Array.isArray(payload)
    ? { page: 1, limit: pageSize, total: records.length, totalPages: 1 }
    : payload.pagination;
  currentPage = pagination.page;
  pageSize = pagination.limit;
  totalRecords = pagination.total;
  totalPages = pagination.totalPages;
  pageSizeSelect.value = String(pageSize);
  list.replaceChildren();
  count.textContent = `${totalRecords} 件`;
  empty.hidden = totalRecords !== 0;

  for (const trip of records) {
    const card = makeElement('article', 'trip-card');
    const topline = makeElement('div', 'trip-topline');
    topline.append(makeElement('time', 'trip-date', formatDate(trip.outingDate)));
    const weather = makeElement('span', 'trip-weather');
    weather.append(
      makeElement('span', 'weather-icon', window.WeatherIcons.iconForWeather(trip.weather)),
      document.createTextNode(trip.weather || '未入力'),
    );
    weather.setAttribute('aria-label', trip.weather || '天気未入力');
    topline.append(weather);
    const title = makeElement('h3', '', trip.destination);
    const place = makeElement('p', 'trip-place', trip.city);
    card.append(topline, title, place);
    if (trip.activity) card.append(makeElement('p', 'trip-description', trip.activity));
    if (trip.notes) card.append(makeElement('p', 'trip-notes', `メモ：${trip.notes}`));
    if (trip.reminderEnabled) card.append(makeElement('p', 'trip-reminder', '✉ 7日前にメールで通知'));

    const actions = makeElement('div', 'trip-actions');
    const editButton = makeElement('button', 'text-button', '編集');
    editButton.type = 'button';
    editButton.setAttribute('aria-label', `${trip.destination}の記録を編集`);
    editButton.addEventListener('click', () => startEditing(trip));
    const deleteButton = makeElement('button', 'text-button delete', '削除');
    deleteButton.type = 'button';
    deleteButton.setAttribute('aria-label', `${trip.destination}の記録を削除`);
    deleteButton.addEventListener('click', () => deleteTrip(trip));
    actions.append(editButton, deleteButton);
    card.append(actions);
    list.append(card);
  }
  renderPagination();
}

async function loadRecords({ initial = false, page = currentPage } = {}) {
  const requestId = ++recordsRequestId;
  currentPage = page;
  if (initial) {
    loading.hidden = false;
    list.hidden = true;
    empty.hidden = true;
  }
  try {
    const result = await request(`/api/trips?page=${encodeURIComponent(page)}&limit=${encodeURIComponent(pageSize)}`);
    if (requestId !== recordsRequestId) return false;
    renderRecords(result);
    loading.hidden = true;
    list.hidden = false;
    return true;
  } catch (error) {
    if (requestId !== recordsRequestId) return false;
    loading.hidden = true;
    empty.hidden = true;
    showStatus(error.message, 'error');
    if (initial) list.hidden = true;
    return false;
  }
}

previousPageButton.addEventListener('click', () => {
  if (currentPage > 1) loadRecords({ page: currentPage - 1 });
});
nextPageButton.addEventListener('click', () => {
  if (currentPage < totalPages) loadRecords({ page: currentPage + 1 });
});
pageSizeSelect.addEventListener('change', () => {
  const selected = Number(pageSizeSelect.value);
  if (![5, 10, 20].includes(selected)) return;
  pageSize = selected;
  loadRecords({ page: 1 });
});

function startEditing(trip) {
  selectedCity = null;
  closeCitySuggestions();
  setCityFeedback('');
  editingId = trip.id;
  for (const name of Object.keys(fieldNames)) {
    const value = trip[name] ?? '';
    form.elements.namedItem(name).value = name === 'outingDate' ? dateOnly(value) : value;
  }
  reminderCheckbox.checked = trip.reminderEnabled === true;
  updateReminderAvailability();
  formTitle.textContent = '記録を編集する';
  cancelEditButton.hidden = false;
  clearValidation();
  updateCounters();
  clearStatus();
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelector('#outing-date').focus({ preventScroll: true });
}

async function deleteTrip(trip) {
  const accepted = window.confirm(`「${trip.destination}（${trip.city}）」の記録を削除しますか？\nこの操作は取り消せません。`);
  if (!accepted) return;
  clearStatus();
  showStatus('記録を削除しています…', 'loading');
  try {
    await request(`/api/trips/${encodeURIComponent(trip.id)}`, { method: 'DELETE' });
    if (String(editingId) === String(trip.id)) resetForm();
    const loaded = await loadRecords();
    showStatus(loaded ? '記録を削除しました。' : '削除しました。記録一覧を再読み込みできませんでした。', loaded ? 'success' : 'error');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

function formatRetrievedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

async function lookupWeather() {
  const city = cityInput.value.trim();
  const date = weatherDateInput.value;
  if (city.length < 2) {
    weatherResult.hidden = true;
    weatherFeedback.textContent = '都市・エリアを2文字以上入力してください。';
    weatherFeedback.dataset.kind = 'error';
    weatherFeedback.hidden = false;
    form.elements.namedItem('city').focus();
    return;
  }
  if (dateOnly(date) !== date) {
    weatherResult.hidden = true;
    weatherFeedback.textContent = '天気を取得する日付を選択してください。';
    weatherFeedback.dataset.kind = 'error';
    weatherFeedback.hidden = false;
    weatherDateInput.focus();
    return;
  }

  const requestId = ++weatherRequestId;
  weatherLookupButton.disabled = true;
  weatherLookupButton.textContent = '天気を取得しています…';
  weatherFeedback.textContent = '都市と選択日を確認しています…';
  weatherFeedback.dataset.kind = 'loading';
  weatherFeedback.hidden = false;
  weatherResult.hidden = true;

  try {
    const locationParams = selectedCity
      ? `&latitude=${encodeURIComponent(selectedCity.latitude)}&longitude=${encodeURIComponent(selectedCity.longitude)}&timezone=${encodeURIComponent(selectedCity.timezone)}&locationName=${encodeURIComponent(selectedCity.name)}&region=${encodeURIComponent(selectedCity.region || '')}&country=${encodeURIComponent(selectedCity.country || '')}`
      : '';
    const data = await request(`/api/weather?city=${encodeURIComponent(city)}&date=${encodeURIComponent(date)}${locationParams}`);
    if (requestId !== weatherRequestId) return;
    document.querySelector('#weather-location').textContent = [data.location.name, data.location.region, data.location.country].filter(Boolean).join('・');
    document.querySelector('#weather-condition').textContent = data.weather;
    document.querySelector('#weather-result-icon').textContent = window.WeatherIcons.iconForWeather(data.weather);
    const kindLabels = { historical: '過去の天気（履歴データ）', current: '現在の天気', forecast: '天気予報' };
    document.querySelector('#weather-kind').textContent = kindLabels[data.dataType] || '天気情報';
    const currentTemperature = data.temperature?.value;
    document.querySelector('#weather-temperature').textContent = currentTemperature == null ? '' : `${currentTemperature}${data.temperature.unit}`;
    document.querySelector('#weather-high-low').textContent = data.temperatureMax && data.temperatureMin
      ? `最高 ${data.temperatureMax.value}${data.temperatureMax.unit} / 最低 ${data.temperatureMin.value}${data.temperatureMin.unit}` : '';
    document.querySelector('#weather-precipitation').textContent = data.precipitation
      ? `降水量 ${data.precipitation.value}${data.precipitation.unit}` : '';
    document.querySelector('#weather-feels-like').textContent = data.apparentTemperature?.value == null ? '' : `体感 ${data.apparentTemperature.value}${data.apparentTemperature.unit}`;
    document.querySelector('#weather-humidity').textContent = data.humidity?.value == null ? '' : `湿度 ${data.humidity.value}${data.humidity.unit}`;
    document.querySelector('#weather-wind').textContent = data.windSpeed?.value == null ? '' : `風速 ${data.windSpeed.value} ${data.windSpeed.unit}`;
    document.querySelector('#weather-observed').textContent = data.dataType === 'current'
      ? `観測時刻：${data.observedAt.replace('T', ' ')}（${data.timezone || '現地時刻'}）`
      : `対象日：${data.targetDate}（${data.timezone || '現地時刻'}）`;
    document.querySelector('#weather-retrieved').textContent = `取得日時：${formatRetrievedAt(data.retrievedAt)}`;
    form.elements.namedItem('weather').value = data.weather.slice(0, 50);
    const weatherError = form.querySelector('[data-error-for="weather"]');
    if (weatherError) weatherError.textContent = '';
    form.elements.namedItem('weather').removeAttribute('aria-invalid');
    weatherResult.hidden = false;
    weatherFeedback.textContent = `${kindLabels[data.dataType] || '天気情報'}を取得しました。記録に保存する場合はフォームを保存してください。`;
    weatherFeedback.dataset.kind = 'success';
  } catch (error) {
    if (requestId !== weatherRequestId) return;
    weatherFeedback.textContent = error.message;
    weatherFeedback.dataset.kind = 'error';
  } finally {
    if (requestId === weatherRequestId) {
      weatherLookupButton.disabled = false;
      weatherLookupButton.textContent = '選択日の天気を取得';
    }
  }
}

weatherLookupButton.addEventListener('click', lookupWeather);
weatherDateInput.addEventListener('change', () => {
  updateReminderAvailability();
  if (cityInput.value.trim().length >= 2) return lookupWeather();
});
reminderCheckbox.addEventListener('change', updateReminderAvailability);

function closeCitySuggestions() {
  citySuggestions.hidden = true;
  cityInput.setAttribute('aria-expanded', 'false');
  cityInput.removeAttribute('aria-activedescendant');
  activeCityIndex = -1;
}

function setCityFeedback(message, kind = '') {
  cityFeedback.textContent = message;
  if (kind) cityFeedback.dataset.kind = kind;
  else delete cityFeedback.dataset.kind;
}

function renderCitySuggestions(locations) {
  cityLocations = locations;
  activeCityIndex = -1;
  citySuggestions.replaceChildren();
  if (!locations.length) {
    closeCitySuggestions();
    setCityFeedback('都市候補が見つかりません。別の表記でお試しください。', 'empty');
    return;
  }
  locations.forEach((location, index) => {
    const option = document.createElement('div');
    option.className = 'city-suggestion';
    option.id = `city-suggestion-${index}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    const name = document.createElement('span');
    name.className = 'city-suggestion-name';
    name.textContent = location.name;
    const detail = document.createElement('span');
    detail.className = 'city-suggestion-detail';
    detail.textContent = [location.region, location.country].filter(Boolean).join('・');
    option.append(name, detail);
    option.addEventListener('click', () => selectCity(index));
    citySuggestions.append(option);
  });
  citySuggestions.hidden = false;
  cityInput.setAttribute('aria-expanded', 'true');
  setCityFeedback('候補を選択してください。');
}

function selectCity(index) {
  const location = cityLocations[index];
  if (!location) return;
  selectedCity = location;
  cityInput.value = location.name;
  closeCitySuggestions();
  setCityFeedback([location.region, location.country].filter(Boolean).join('・') + 'を選択しました。');
}

function setActiveCity(index) {
  if (!cityLocations.length) return;
  activeCityIndex = (index + cityLocations.length) % cityLocations.length;
  for (const [optionIndex, option] of [...citySuggestions.children].entries()) {
    const active = optionIndex === activeCityIndex;
    option.setAttribute('aria-selected', String(active));
    if (active) cityInput.setAttribute('aria-activedescendant', option.id);
  }
}

cityInput.addEventListener('input', () => {
  selectedCity = null;
  const query = cityInput.value.trim();
  clearTimeout(citySearchTimer);
  const requestId = ++citySearchRequestId;
  cityLocations = [];
  citySuggestions.replaceChildren();
  closeCitySuggestions();
  if ([...query].length < 2) {
    setCityFeedback(query ? '候補検索には2文字以上入力してください。' : '');
    return;
  }
  setCityFeedback('都市候補を検索しています…', 'loading');
  citySearchTimer = setTimeout(async () => {
    try {
      const result = await request(`/api/weather/locations?q=${encodeURIComponent(query)}`);
      if (requestId !== citySearchRequestId || cityInput.value.trim() !== query) return;
      renderCitySuggestions(result.results || []);
    } catch (error) {
      if (requestId !== citySearchRequestId) return;
      closeCitySuggestions();
      setCityFeedback(`都市候補を取得できませんでした。${error.message}`, 'error');
    }
  }, 300);
});

cityInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' && !citySuggestions.hidden) {
    event.preventDefault();
    setActiveCity(activeCityIndex + 1);
  } else if (event.key === 'ArrowUp' && !citySuggestions.hidden) {
    event.preventDefault();
    setActiveCity(activeCityIndex <= 0 ? cityLocations.length - 1 : activeCityIndex - 1);
  } else if (event.key === 'Enter' && !citySuggestions.hidden && activeCityIndex >= 0) {
    event.preventDefault();
    selectCity(activeCityIndex);
  } else if (event.key === 'Escape' && !citySuggestions.hidden) {
    closeCitySuggestions();
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const values = validateForm();
  if (!values) {
    showStatus('入力内容を確認してください。', 'error');
    return;
  }

  const wasEditing = editingId !== null;
  const targetId = editingId;
  clearStatus();
  setBusy(true, wasEditing ? '変更を保存しています…' : '記録を保存しています…');
  showStatus(wasEditing ? '記録を更新しています…' : '記録を登録しています…', 'loading');
  try {
    await request(wasEditing ? `/api/trips/${encodeURIComponent(targetId)}` : '/api/trips', {
      method: wasEditing ? 'PUT' : 'POST', body: JSON.stringify(values),
    });
    resetForm();
    if (!wasEditing) currentPage = 1;
    const loaded = await loadRecords();
    const action = wasEditing ? '更新' : '登録';
    showStatus(loaded ? `記録を${action}しました。` : `記録を${action}しましたが、一覧を再読み込みできませんでした。`, loaded ? 'success' : 'error');
  } catch (error) {
    setBusy(false);
    showStatus(error.message, 'error');
  }
});

cancelEditButton.addEventListener('click', () => {
  resetForm();
  clearStatus();
});

for (const input of form.querySelectorAll('input, textarea')) {
  input.addEventListener('input', () => {
    if (input.hasAttribute('aria-invalid')) {
      input.removeAttribute('aria-invalid');
      const error = form.querySelector(`[data-error-for="${input.name}"]`);
      if (error) error.textContent = '';
    }
    clearStatus();
  });
}
for (const name of ['activity', 'notes']) {
  form.elements.namedItem(name).addEventListener('input', updateCounters);
}

document.querySelector('#outing-date').value = localToday();
updateCounters();
updateReminderAvailability();

if (logoutButton) {
  logoutButton.addEventListener('click', async () => {
    logoutButton.disabled = true;
    try {
      await request('/api/auth/logout', { method: 'POST' });
      window.location.assign('/login.html');
    } catch (error) {
      logoutButton.disabled = false;
      showStatus(error.message, 'error');
    }
  });
}

async function initializeApp() {
  try {
    const auth = await request('/api/auth/me');
    csrfToken = auth.csrfToken;
    if (signedInUser) {
      signedInUser.textContent = auth.user.displayName || auth.user.email;
      signedInUser.hidden = false;
    }
    if (logoutButton) logoutButton.hidden = false;
    if (appContent) appContent.hidden = false;
    await loadRecords({ initial: true });
  } catch (error) {
    if (error.status === 401) {
      window.location.assign('/login.html');
      return;
    }
    loading.hidden = true;
    showStatus(error.message, 'error');
  }
}

initializeApp();
