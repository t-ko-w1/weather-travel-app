-- Database: weather_travel_db
-- Purpose: insert sample outing records into the application's table.
-- This file inserts data only; it creates or alters no database objects.
-- Run only after schema.sql has been applied to the intended target database.
-- Running this file repeatedly inserts duplicate sample records.

INSERT INTO public.outing_records
    (outing_date, city, destination, activity, notes, weather)
VALUES
    ('2026-04-12', '京都市', '嵐山', '散策、写真撮影', '午前中に訪問', '晴れ'),
    ('2026-05-03', '鎌倉市', '長谷寺', '寺院を見学', 'あじさいの時期に再訪したい', '曇り'),
    ('2026-06-14', '札幌市', '大通公園', '公園を散策', NULL, '小雨');
