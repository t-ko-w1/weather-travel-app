'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertMailpitConfig, futureOutingDateTokyo, configuredDatabaseName } = require('../scripts/mailpit-reminder');
const { scheduledAtForDate } = require('../src/reminder-scheduling');

test('Mailpit integration script refuses non-local SMTP and secure-mode changes', () => {
  const safe = { MAIL_HOST: '127.0.0.1', MAIL_PORT: '1025', MAIL_SECURE: 'false', MAIL_FROM: 'Test <test@example.test>' };
  assert.doesNotThrow(() => assertMailpitConfig(safe));
  assert.throws(() => assertMailpitConfig({ ...safe, MAIL_HOST: 'smtp.example.com' }), /安全確認/);
  assert.throws(() => assertMailpitConfig({ ...safe, MAIL_PORT: '587' }), /安全確認/);
  assert.throws(() => assertMailpitConfig({ ...safe, MAIL_SECURE: 'true' }), /安全確認/);
});

test('Mailpit fixture date yields a future outing and injects exactly its seven-day 10:00 JST target', () => {
  const base = new Date('2026-10-30T02:00:00.000Z');
  const outingDate = futureOutingDateTokyo(14, base);
  assert.equal(outingDate, '2026-11-13');
  assert.equal(scheduledAtForDate(outingDate), '2026-11-06T01:00:00.000Z');
});

test('Mailpit script accepts only weather_travel_db as configured database', () => {
  assert.equal(configuredDatabaseName({ PGDATABASE: 'weather_travel_db' }), 'weather_travel_db');
  assert.equal(configuredDatabaseName({ DATABASE_URL: 'postgres://local:secret@127.0.0.1:5432/weather_travel_db' }), 'weather_travel_db');
  assert.throws(() => {
    if (configuredDatabaseName({ PGDATABASE: 'production' }) !== 'weather_travel_db') throw new Error('refused');
  }, /refused/);
});
