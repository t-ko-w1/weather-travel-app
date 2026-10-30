-- Optional one-time ownership assignment for existing rows with user_id IS NULL.
-- Run only after confirming the intended Google account and obtaining its users.id.
-- In psql, set the reviewed ID first: \set owner_user_id 123
BEGIN;

SELECT set_config('app.legacy_owner_id', :'owner_user_id', false);

DO $migration$
DECLARE
    selected_owner_id BIGINT;
BEGIN
    selected_owner_id := current_setting('app.legacy_owner_id')::BIGINT;
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = selected_owner_id) THEN
        RAISE EXCEPTION 'Selected owner user ID does not exist';
    END IF;
END
$migration$;

UPDATE public.outing_records
SET user_id = current_setting('app.legacy_owner_id')::BIGINT
WHERE user_id IS NULL;

COMMIT;
