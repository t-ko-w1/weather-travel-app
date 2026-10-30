const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduledAtForDate, tokyoDate, isFutureInTokyo, syncReminderJob, cancelReminderJob } = require('../src/reminder-scheduling');

test('reminder target is 10:00 Asia/Tokyo exactly seven calendar days before the outing', () => {
  assert.equal(scheduledAtForDate('2026-04-20'), '2026-04-13T01:00:00.000Z');
  assert.equal(tokyoDate(new Date('2026-04-01T15:30:00.000Z')), '2026-04-02');
  assert.equal(isFutureInTokyo('2026-04-02', new Date('2026-04-01T15:30:00.000Z')), false);
  assert.equal(isFutureInTokyo('2026-04-03', new Date('2026-04-01T15:30:00.000Z')), true);
  assert.equal(scheduledAtForDate('2026-01-07'), '2025-12-31T01:00:00.000Z', 'calendar year changes independently of OS timezone');
  assert.equal(scheduledAtForDate('2024-03-07'), '2024-02-29T01:00:00.000Z', 'leap day is handled');
});

test('reminder schedule does not change with the process timezone', () => {
  const originalTimezone = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    const honoluluProcessResult = scheduledAtForDate('2026-04-20');
    process.env.TZ = 'Europe/Paris';
    const parisProcessResult = scheduledAtForDate('2026-04-20');
    assert.equal(honoluluProcessResult, '2026-04-13T01:00:00.000Z');
    assert.equal(parisProcessResult, honoluluProcessResult);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test('the exact 10:00 Tokyo boundary determines whether a new reminder is pending or missed', async () => {
  const statuses = [];
  const query = async (sql, params) => {
    if (/SELECT id, outing_date::text/.test(sql)) return { rows: [] };
    if (/INSERT INTO public\.reminder_jobs/.test(sql)) statuses.push(params[5]);
    return { rows: [] };
  };
  const trip = { id: '56', outingDate: '2026-04-20', destination: '公園' };
  await syncReminderJob(query, { trip, userId: '7', enabled: true, now: new Date('2026-04-13T00:59:59.999Z') });
  await syncReminderJob(query, { trip: { ...trip, id: '57' }, userId: '7', enabled: true, now: new Date('2026-04-13T01:00:00.000Z') });
  assert.deepEqual(statuses, ['pending', 'missed']);
});

test('new reminders due in the future stay pending; already-passed reminder dates are missed', async () => {
  const insertParams = [];
  const query = async (sql, params) => {
    if (/SELECT id, outing_date::text/.test(sql)) return { rows: [] };
    if (/INSERT INTO public\.reminder_jobs/.test(sql)) { insertParams.push(params); return { rows: [] }; }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const trip = { id: '55', outingDate: '2026-04-20', destination: '公園' };
  await syncReminderJob(query, { trip, userId: '7', enabled: true, now: new Date('2026-04-01T00:00:00Z') });
  await syncReminderJob(query, { trip: { ...trip, outingDate: '2026-04-08' }, userId: '7', enabled: true, now: new Date('2026-04-01T03:00:00Z') });
  assert.equal(insertParams[0][5], 'pending');
  assert.equal(insertParams[1][5], 'missed');
});

test('date edits recalculate unsent schedules, disabling cancels, and sent jobs never reopen', async () => {
  const statements = [];
  let existing = { id: '8', outingDate: '2026-04-20', status: 'pending', attemptCount: 0 };
  const query = async (sql, params) => {
    statements.push([sql, params]);
    if (/SELECT id, outing_date::text/.test(sql)) return { rows: [existing] };
    return { rows: [] };
  };
  const now = new Date('2026-04-01T00:00:00Z');
  await syncReminderJob(query, { trip: { id: '55', outingDate: '2026-04-25', destination: '新目的地' }, userId: '7', enabled: true, now });
  assert.match(statements[1][0], /UPDATE public\.reminder_jobs/);
  assert.deepEqual(statements[1][1].slice(1), ['2026-04-25', '新目的地', '2026-04-18T01:00:00.000Z', 'pending']);

  statements.length = 0;
  await syncReminderJob(query, { trip: { id: '55', outingDate: '2026-04-25', destination: '新目的地' }, userId: '7', enabled: false, now });
  assert.match(statements[1][0], /status = 'cancelled'/);

  existing = { ...existing, outingDate: '2026-04-20', status: 'sent' };
  statements.length = 0;
  await syncReminderJob(query, { trip: { id: '55', outingDate: '2026-04-25', destination: '新目的地' }, userId: '7', enabled: true, now });
  assert.equal(statements.length, 1, '送信済みジョブは予定変更でも更新しない');
});

test('reenabling a cancelled reminder schedules at 10:00 Asia/Tokyo on the new target date', async () => {
  const statements = [];
  const query = async (sql, params) => {
    statements.push([sql, params]);
    if (/SELECT id, outing_date::text/.test(sql)) {
      return { rows: [{ id: '9', outingDate: '2026-04-20', status: 'cancelled', attemptCount: 0 }] };
    }
    return { rows: [] };
  };
  await syncReminderJob(query, {
    trip: { id: '58', outingDate: '2026-04-20', destination: '公園' },
    userId: '7', enabled: true, now: new Date('2026-04-01T00:00:00Z'),
  });
  assert.equal(statements[1][1][3], '2026-04-13T01:00:00.000Z');
  assert.equal(statements[1][1][4], 'pending');
});

test('deleting an outing cancels only its user-scoped unsent reminder', async () => {
  let params;
  await cancelReminderJob(async (_sql, values) => { params = values; return { rows: [] }; }, { tripId: '55', userId: '7' });
  assert.deepEqual(params, ['55', '7']);
});
