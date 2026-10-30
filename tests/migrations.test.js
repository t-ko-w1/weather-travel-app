const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationDirectory = path.join(__dirname, '..', 'db', 'migrations');
const authMigration = fs.readFileSync(path.join(migrationDirectory, '001_google_auth.sql'), 'utf8');
const ownershipMigration = fs.readFileSync(path.join(migrationDirectory, '002_assign_legacy_records.sql'), 'utf8');
const remindersMigration = fs.readFileSync(path.join(migrationDirectory, '003_reminders.sql'), 'utf8');

test('Google auth schema migration is additive and preserves outing rows', () => {
  assert.match(authMigration, /CREATE TABLE IF NOT EXISTS public\.users/);
  assert.match(authMigration, /ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES public\.users\(id\)/);
  assert.match(authMigration, /CREATE TABLE IF NOT EXISTS public\.user_sessions/);
  assert.doesNotMatch(authMigration, /\bDELETE\s+FROM\s+public\.outing_records/i);
  assert.doesNotMatch(authMigration, /\bUPDATE\s+public\.outing_records/i);
});

test('legacy record assignment requires an existing selected owner and only sets NULL user_id', () => {
  assert.match(ownershipMigration, /current_setting\('app\.legacy_owner_id'\)::BIGINT/);
  assert.match(ownershipMigration, /FROM public\.users WHERE id = selected_owner_id/);
  assert.match(ownershipMigration, /SET user_id = current_setting/);
  assert.match(ownershipMigration, /WHERE user_id IS NULL/);
  assert.doesNotMatch(ownershipMigration, /\bDELETE\s+FROM\s+public\.outing_records/i);
  assert.doesNotMatch(ownershipMigration, /SET\s+outing_date\s*=|SET\s+weather\s*=/i);
});

test('reminder migration adds an opt-in setting and durable, uniquely keyed send history', () => {
  assert.match(remindersMigration, /ADD COLUMN IF NOT EXISTS reminder_enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(remindersMigration, /outing_record_id BIGINT UNIQUE REFERENCES public\.outing_records\(id\) ON DELETE SET NULL/);
  assert.match(remindersMigration, /UNIQUE \(reminder_job_id, attempt_number\)/);
  assert.match(remindersMigration, /CREATE TABLE IF NOT EXISTS public\.reminder_attempts/);
  assert.match(remindersMigration, /status IN \('pending', 'retry_wait', 'processing', 'sent', 'cancelled', 'missed', 'failed'\)/);
  assert.doesNotMatch(remindersMigration, /\bDELETE\s+FROM\s+public\.outing_records/i);
  assert.doesNotMatch(remindersMigration, /\bUPDATE\s+public\.outing_records/i);
});
