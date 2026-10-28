# API設計

## 1. 共通仕様

- 記録APIベースパス：`/api/trips`
- 天気API：`GET /api/weather`
- データ形式：JSON（UTF-8）
- 日付：`YYYY-MM-DD`
- 成功時は各エンドポイント記載のステータスとJSONを返す。削除成功は`204 No Content`。
- 不正な入力は`400`、対象IDがない場合は`404`、予期しないサーバーエラーは`500`。
- `id`、`createdAt`、`updatedAt`はサーバー側で管理する。

## 2. エンドポイント一覧

| 用途 | メソッド・パス | 成功 |
|---|---|---:|
| 一覧取得 | `GET /api/trips` | 200 |
| 1件取得 | `GET /api/trips/:id` | 200 |
| 新規作成 | `POST /api/trips` | 201 |
| 更新 | `PUT /api/trips/:id` | 200 |
| 削除 | `DELETE /api/trips/:id` | 204 |
| 選択日の天気取得 | `GET /api/weather?city=札幌市&date=2026-10-28` | 200 |

一覧は`outingDate`の降順、同日では`id`の降順とする。ページネーションや検索条件は初期版では設けない。

## 3. データ形式

```json
{
  "id": 12,
  "outingDate": "2026-04-12",
  "city": "京都市",
  "destination": "嵐山",
  "activity": "散策、写真撮影",
  "notes": "午前中に訪問",
  "weather": "晴れ",
  "createdAt": "2026-04-12T09:00:00.000Z",
  "updatedAt": "2026-04-12T09:00:00.000Z"
}
```

任意項目`activity`、`notes`、`weather`は、未入力時に`null`を返す。

## 4. リクエスト・レスポンス例

### 一覧取得

`GET /api/trips`

```json
[
  {
    "id": 12,
    "outingDate": "2026-04-12",
    "city": "京都市",
    "destination": "嵐山",
    "activity": "散策、写真撮影",
    "notes": "午前中に訪問",
    "weather": "晴れ",
    "createdAt": "2026-04-12T09:00:00.000Z",
    "updatedAt": "2026-04-12T09:00:00.000Z"
  }
]
```

データがない場合は`200`と空配列`[]`を返す。

### 1件取得

`GET /api/trips/12`はデータ形式の1件を`200`で返す。IDが存在しない場合：

```json
{ "error": { "code": "NOT_FOUND", "message": "記録が見つかりません。" } }
```

### 新規作成

`POST /api/trips`

```json
{
  "outingDate": "2026-04-12",
  "city": "京都市",
  "destination": "嵐山",
  "activity": "散策、写真撮影",
  "notes": "午前中に訪問",
  "weather": "晴れ"
}
```

作成された全項目（採番ID・日時を含む）を`201 Created`で返す。

### 更新

`PUT /api/trips/12`

```json
{
  "outingDate": "2026-04-12",
  "city": "京都市",
  "destination": "渡月橋",
  "activity": "散策",
  "notes": null,
  "weather": "曇り"
}
```

全編集可能項目を送る置換更新とする。成功時は更新後の全項目を`200`で返す。対象なしは`404`。

### 削除

`DELETE /api/trips/12`

成功時は本文なしの`204 No Content`。対象なしは`404`。

## 5. 入力エラー

必須項目不足、日付形式不正、文字数上限超過、数値でないIDなどは`400 Bad Request`。例：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "入力内容を確認してください。",
    "details": ["cityは必須です。", "outingDateはYYYY-MM-DD形式で指定してください。"]
  }
}
```

## 6. 実装時の注意

- IDは正の整数として検証する。
- `PUT`は全項目必須（任意項目は`null`または空文字を許容し、保存時に`null`へ正規化してよい）。
- DBクエリーはプレースホルダーを使う。
- 天気API呼び出しはバックエンドから行い、外部APIのキーをブラウザーへ返さない。

## 7. 選択日の天気API

`GET /api/weather?city=札幌市&date=2026-10-28`は都市名から座標とタイムゾーンを検索し、対象日の現地日付に基づいて履歴・現在・予報を選ぶ。外部APIキーや座標はフロントエンドに渡さない。

- 過去：Open-Meteo Historical Weather APIの日別天気コード、最高・最低気温、降水量。
- 今日：既存Forecast APIの`current`。現在の天気・気温を返し、日別最高・最低気温は返さない。
- 未来：Forecast APIの`daily`。今日を含む最大16日分の範囲を扱い、範囲外は取得不可として返す。
- `dataType`は`historical`、`current`、`forecast`のいずれか。全形式で`targetDate`、都市の`timezone`、`retrievedAt`を返す。

成功時の履歴データ例：

```json
{
  "dataType": "historical",
  "targetDate": "2026-10-27",
  "location": { "name": "札幌市", "region": "北海道", "country": "日本" },
  "weather": "弱い雨",
  "temperature": null,
  "temperatureMax": { "value": 14.2, "unit": "°C" },
  "temperatureMin": { "value": 8.1, "unit": "°C" },
  "precipitation": { "value": 2.3, "unit": "mm" },
  "timezone": "Asia/Tokyo",
  "observedAt": "2026-10-27",
  "retrievedAt": "2026-10-28T01:00:00.000Z"
}
```

現在データでは`temperature`に現在気温を入れ、日別の3項目は`null`とする。履歴・予報データでは`temperature`は`null`、日別3項目を返す。未対応都市は404、入力不正は400、履歴データ未提供は422 `HISTORY_UNAVAILABLE`、予報範囲外は422 `FORECAST_OUT_OF_RANGE`、外部API障害は502、タイムアウトは504。エラー時も記録APIやDBを呼び出さず、CRUDは独立して利用できる。

Open-Meteo Geocoding API（`name`, `count`, `language`, `format`）、Forecast API（`current`または`daily`）、Historical Weather API（`start_date`, `end_date`, `daily`）を使う。履歴データは観測所の直接測定値とは限らず、再解析による推定を含む。履歴対象は1940年以降で、データセットにより更新遅延がある。一般利用ではAPIキー不要だが、無料APIは非商用利用向け。天気データはCC BY 4.0の帰属表示を行い、商用利用では契約条件を確認する。

取得結果から記録フォームへ反映するのは天気状況の文字列のみ。記録には既存の`outing_date`と`weather`を保存し、詳細値やデータ種別はDBに保存しない。記録再表示で天気APIを呼び直さないため、保存済み天気を現在天気で上書きしない。
