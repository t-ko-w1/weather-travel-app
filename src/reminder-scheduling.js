const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_HOUR_TOKYO = 10;
const TOKYO_TIME_ZONE = 'Asia/Tokyo';

function tokyoWallTimeToUtc(date, hour) {
  const [year, month, day] = date.split('-').map(Number);
  const desiredWallTime = Date.UTC(year, month - 1, day, hour);
  let candidate = desiredWallTime;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TOKYO_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .map(({ type, value }) => [type, value]));
    const representedWallTime = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    const correction = desiredWallTime - representedWallTime;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate).toISOString();
}

function scheduledAtForDate(outingDate) {
  if (typeof outingDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(outingDate)) {
    throw new TypeError('有効なYYYY-MM-DD形式の日付が必要です。');
  }
  const outingDay = new Date(`${outingDate}T00:00:00.000Z`);
  if (Number.isNaN(outingDay.valueOf()) || outingDay.toISOString().slice(0, 10) !== outingDate) {
    throw new TypeError('有効なYYYY-MM-DD形式の日付が必要です。');
  }
  outingDay.setUTCDate(outingDay.getUTCDate() - 7);
  const targetDate = outingDay.toISOString().slice(0, 10);
  // Convert the Tokyo wall-clock time explicitly; calendar math and conversion ignore the OS timezone.
  return tokyoWallTimeToUtc(targetDate, REMINDER_HOUR_TOKYO);
}

function tokyoDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isFutureInTokyo(outingDate, now = new Date()) {
  return outingDate > tokyoDate(now);
}

async function syncReminderJob(query, { trip, userId, enabled, now = new Date() }) {
  const existingResult = await query(`SELECT id, outing_date::text AS "outingDate", status, attempt_count AS "attemptCount"
    FROM public.reminder_jobs WHERE outing_record_id = $1 FOR UPDATE`, [trip.id]);
  const existing = existingResult.rows[0];

  if (!enabled) {
    if (existing && existing.status !== 'sent') {
      if (existing.status === 'processing') {
        await query(`UPDATE public.reminder_attempts SET status = 'unknown', finished_at = $2
          WHERE reminder_job_id = $1 AND status = 'started'`, [existing.id, now]);
      }
      await query(`UPDATE public.reminder_jobs SET status = 'cancelled', lock_expires_at = NULL,
        next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [existing.id]);
    }
    return;
  }
  if (existing?.status === 'sent') return;

  const scheduleAt = scheduledAtForDate(trip.outingDate);
  const schedulePassed = Date.parse(scheduleAt) <= now.getTime();
  if (!existing) {
    await query(`INSERT INTO public.reminder_jobs
      (outing_record_id, user_id, outing_date, destination_snapshot, scheduled_at, status)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [trip.id, userId, trip.outingDate, trip.destination, scheduleAt, schedulePassed ? 'missed' : 'pending']);
    return;
  }

  const dateChanged = existing.outingDate !== trip.outingDate;
  const reenabled = existing.status === 'cancelled';
  if (!dateChanged && !reenabled) return;
  if (existing.status === 'processing') {
    await query(`UPDATE public.reminder_attempts SET status = 'unknown', finished_at = $2
      WHERE reminder_job_id = $1 AND status = 'started'`, [existing.id, now]);
  }
  const status = schedulePassed ? 'missed' : Number(existing.attemptCount) >= 5 ? 'failed' : 'pending';
  await query(`UPDATE public.reminder_jobs SET outing_date = $2, destination_snapshot = $3,
    scheduled_at = $4, status = $5, next_attempt_at = NULL, lock_expires_at = NULL,
    last_error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
  [existing.id, trip.outingDate, trip.destination, scheduleAt, status]);
}

async function cancelReminderJob(query, { tripId, userId }) {
  await query(`WITH cancelled AS (
    UPDATE public.reminder_jobs SET status = 'cancelled', next_attempt_at = NULL,
    lock_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE outing_record_id = $1 AND user_id = $2 AND status <> 'sent' RETURNING id
    ) UPDATE public.reminder_attempts a SET status = 'unknown', finished_at = CURRENT_TIMESTAMP
      FROM cancelled c WHERE a.reminder_job_id = c.id AND a.status = 'started'`, [tripId, userId]);
}

module.exports = {
  DAY_MS, REMINDER_HOUR_TOKYO, TOKYO_TIME_ZONE, scheduledAtForDate,
  tokyoWallTimeToUtc, tokyoDate, isFutureInTokyo, syncReminderJob, cancelReminderJob,
};
