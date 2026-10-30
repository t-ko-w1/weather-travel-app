'use strict';

const { withTransaction } = require('./db');

const MAX_ATTEMPTS = 5;
const LEASE_MS = 10 * 60 * 1000;
const RESTART_GRACE_MS = 24 * 60 * 60 * 1000;

function createReminderRepository(pool) {
  return {
    async recover(now) {
      return withTransaction(pool, async (query) => {
        const stale = await query(`SELECT id FROM public.reminder_jobs
          WHERE status = 'processing' AND lock_expires_at <= $1 FOR UPDATE SKIP LOCKED`, [now]);
        for (const { id } of stale.rows) {
          await query(`UPDATE public.reminder_attempts SET status = 'unknown', finished_at = $2
            WHERE reminder_job_id = $1 AND status = 'started'`, [id, now]);
          await query(`UPDATE public.reminder_jobs SET status = CASE
              WHEN scheduled_at < $2::timestamptz - interval '24 hours' THEN 'missed'
              WHEN attempt_count >= $3 THEN 'failed' ELSE 'retry_wait' END,
            next_attempt_at = CASE WHEN scheduled_at < $2::timestamptz - interval '24 hours' OR attempt_count >= $3 THEN NULL ELSE $2::timestamptz END,
            lock_expires_at = NULL,
            last_error_code = 'WORKER_LEASE_EXPIRED', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`, [id, now, MAX_ATTEMPTS]);
        }
        await query(`UPDATE public.reminder_jobs SET status = 'missed', next_attempt_at = NULL,
          last_error_code = 'REMINDER_WINDOW_EXPIRED', updated_at = CURRENT_TIMESTAMP
          WHERE status IN ('pending', 'retry_wait') AND scheduled_at < $1::timestamptz - interval '24 hours'`, [now]);
        await query(`UPDATE public.reminder_jobs j SET status = 'failed', next_attempt_at = NULL,
          last_error_code = 'NO_VERIFIED_EMAIL', updated_at = CURRENT_TIMESTAMP
          WHERE j.status IN ('pending', 'retry_wait') AND j.scheduled_at <= $1
            AND NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = j.user_id
              AND u.email_verified = TRUE AND char_length(btrim(u.email)) > 0)`, [now]);
      });
    },

    async claimDue(now, limit = 25, onlyJobId = null) {
      return withTransaction(pool, async (query) => {
        const selected = await query(`SELECT j.id
          FROM public.reminder_jobs j
          JOIN public.outing_records o ON o.id = j.outing_record_id AND o.user_id = j.user_id
          JOIN public.users u ON u.id = j.user_id AND u.email_verified = TRUE
          WHERE o.reminder_enabled = TRUE
            AND ((j.status = 'pending' AND j.scheduled_at <= $1)
              OR (j.status = 'retry_wait' AND j.next_attempt_at <= $1))
            AND j.attempt_count < $3
            AND ($4::bigint IS NULL OR j.id = $4::bigint)
          ORDER BY COALESCE(j.next_attempt_at, j.scheduled_at), j.id
          LIMIT $2 FOR UPDATE OF j SKIP LOCKED`, [now, limit, MAX_ATTEMPTS, onlyJobId]);
        const jobs = [];
        for (const { id } of selected.rows) {
          const updated = await query(`UPDATE public.reminder_jobs j SET status = 'processing',
            attempt_count = attempt_count + 1,
            lock_expires_at = $2::timestamptz + ($3::double precision * interval '1 millisecond'),
            recipient_email = u.email, next_attempt_at = NULL, updated_at = CURRENT_TIMESTAMP
            FROM public.users u, public.outing_records o
            WHERE j.id = $1 AND u.id = j.user_id AND u.email_verified = TRUE
              AND o.id = j.outing_record_id AND o.user_id = j.user_id AND o.reminder_enabled = TRUE
            RETURNING j.id, j.outing_record_id AS "outingRecordId", j.user_id AS "userId",
              j.attempt_count AS "attemptNumber", j.recipient_email AS "recipientEmail",
              j.scheduled_at AS "scheduledAt", o.outing_date::text AS "outingDate", o.destination, o.activity`, [id, now, LEASE_MS]);
          if (!updated.rows[0]) continue;
          const job = updated.rows[0];
          await query(`INSERT INTO public.reminder_attempts
            (reminder_job_id, attempt_number, status, recipient_email, attempted_at)
            VALUES ($1, $2, 'started', $3, $4)`, [job.id, job.attemptNumber, job.recipientEmail, now]);
          jobs.push(job);
        }
        return jobs;
      });
    },

    async isSendable(job) {
      const result = await pool.query(`SELECT 1 FROM public.reminder_jobs j
        JOIN public.outing_records o ON o.id = j.outing_record_id AND o.user_id = j.user_id
        JOIN public.users u ON u.id = j.user_id AND u.email_verified = TRUE
        WHERE j.id = $1 AND j.status = 'processing' AND j.attempt_count = $2
          AND j.recipient_email = u.email AND o.reminder_enabled = TRUE`, [job.id, job.attemptNumber]);
      return Boolean(result.rows[0]);
    },

    async markSent(job, messageId, now) {
      return withTransaction(pool, async (query) => {
        await query(`UPDATE public.reminder_attempts SET status = 'sent', provider_message_id = $3, finished_at = $4
          WHERE reminder_job_id = $1 AND attempt_number = $2 AND status = 'started'`, [job.id, job.attemptNumber, messageId || null, now]);
        await query(`UPDATE public.reminder_jobs SET status = 'sent', sent_at = $2,
          lock_expires_at = NULL, recipient_email = $3, last_error_code = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'processing' AND attempt_count = $4`,
        [job.id, now, job.recipientEmail, job.attemptNumber]);
      });
    },

    async markFailed(job, errorCode, now, retryDelayMs) {
      return withTransaction(pool, async (query) => {
        const retry = job.attemptNumber < MAX_ATTEMPTS && Date.parse(job.scheduledAt || now) + RESTART_GRACE_MS > now.getTime();
        const next = retry ? new Date(now.getTime() + retryDelayMs) : null;
        await query(`UPDATE public.reminder_attempts SET status = 'failed', error_code = $3, finished_at = $4
          WHERE reminder_job_id = $1 AND attempt_number = $2 AND status = 'started'`, [job.id, job.attemptNumber, errorCode, now]);
        await query(`UPDATE public.reminder_jobs SET status = $2, next_attempt_at = $3,
          lock_expires_at = NULL, last_error_code = $4, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'processing' AND attempt_count = $5`,
        [job.id, retry ? 'retry_wait' : 'failed', next, errorCode, job.attemptNumber]);
      });
    },

    async cancel(job, now) {
      return withTransaction(pool, async (query) => {
        await query(`UPDATE public.reminder_attempts SET status = 'unknown', finished_at = $3
          WHERE reminder_job_id = $1 AND attempt_number = $2 AND status = 'started'`, [job.id, job.attemptNumber, now]);
        await query(`UPDATE public.reminder_jobs SET status = 'cancelled', lock_expires_at = NULL,
          next_attempt_at = NULL, last_error_code = 'REMINDER_DISABLED', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND status = 'processing' AND attempt_count = $2`, [job.id, job.attemptNumber]);
      });
    },
  };
}

module.exports = { createReminderRepository, MAX_ATTEMPTS, LEASE_MS, RESTART_GRACE_MS };
