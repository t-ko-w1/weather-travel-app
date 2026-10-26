
BEGIN;

UPDATE public.outing_records
SET city = '京都市',
    destination = '嵐山',
    activity = '散策、写真撮影',
    notes = '午前中に訪問',
    weather = '晴れ'
WHERE id = 1
  AND outing_date = DATE '2026-04-12';

UPDATE public.outing_records
SET city = '鎌倉市',
    destination = '長谷寺',
    activity = '寺院を見学',
    notes = 'あじさいの時期に再訪したい',
    weather = '曇り'
WHERE id = 2
  AND outing_date = DATE '2026-05-03';

UPDATE public.outing_records
SET city = '札幌市',
    destination = '大通公園',
    activity = '公園を散策',
    notes = NULL,
    weather = '小雨'
WHERE id = 3
  AND outing_date = DATE '2026-06-14';

COMMIT;
