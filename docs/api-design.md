# API設計

## 1. 共通仕様

- 記録APIベースパス：`/api/trips`
- 認証API：`/auth/google`、`/auth/google/callback`、`/api/auth/me`、`/api/auth/logout`
- 天気API：`GET /api/weather?city=...&date=...`
- 都市候補API：`GET /api/weather/locations?q=...`
- データ形式：JSON（UTF-8）
- 日付：`YYYY-MM-DD`
- 成功時は各エンドポイント記載のステータスとJSONを返す。削除成功は`204 No Content`。
- 不正な入力は`400`、認証がない場合は`401`、認可対象がない場合は`404`、CSRF検証失敗は`403`、予期しないサーバーエラーは`500`。
- `id`、`createdAt`、`updatedAt`はサーバー側で管理する。

## 2. エンドポイント一覧

| 用途 | メソッド・パス | 成功 |
|---|---|---:|
| 一覧取得 | `GET /api/trips` | 200 |
| ページ付き一覧取得 | `GET /api/trips?page=1&limit=10` | 200 |
| 1件取得 | `GET /api/trips/:id` | 200 |
| 新規作成 | `POST /api/trips` | 201 |
| 更新 | `PUT /api/trips/:id` | 200 |
| 削除 | `DELETE /api/trips/:id` | 204 |
| 選択日の天気取得 | `GET /api/weather?city=札幌市&date=2026-10-28` | 200 |
| 都市候補検索 | `GET /api/weather/locations?q=東京` | 200 |
| Googleログイン開始 | `GET /auth/google` | 302 |
| Googleログインcallback | `GET /auth/google/callback` | 302 |
| ログイン状態 | `GET /api/auth/me` | 200 |
| ログアウト | `POST /api/auth/logout` | 204 |

一覧は`outingDate`の降順、同日では`id`の降順とする。ページ付き一覧はPostgreSQLの`LIMIT`/`OFFSET`を使う。

## 2.1 認証と認可

- `/auth/google`とcallback以外のAPIはログイン必須。`/api/trips`、`/api/weather`、`/api/weather/locations`はログイン中のセッションがない場合`401 AUTHENTICATION_REQUIRED`。
- すべてのCRUD SQLに`user_id`を含め、他ユーザーまたは`user_id IS NULL`の記録を表示しない。所有者違いのIDは`404 NOT_FOUND`。
- POST、PUT、DELETEとログアウトにはセッションのCSRFトークンを`X-CSRF-Token`ヘッダーで必須とする。欠落・不一致は`403 CSRF_INVALID`。
- セッションCookieはHttpOnly、SameSite=Lax、7日有効。本番はSecureかつHTTPS。ログイン成功時にセッションIDを再発行する。

ログイン確認APIは表示可能なユーザー情報とCSRFトークンを返す。

```json
{
  "user": { "id": "42", "email": "user@example.com", "displayName": "旅人", "avatarUrl": null },
  "csrfToken": "session-bound-random-token"
}
```

ログアウトはCSRFヘッダーを検証してサーバー側セッションを破棄し、Cookieを消去する。

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
  "reminderEnabled": false,
  "createdAt": "2026-04-12T09:00:00.000Z",
  "updatedAt": "2026-04-12T09:00:00.000Z"
}
```

任意項目`activity`、`notes`、`weather`は、未入力時に`null`を返す。
`reminderEnabled`は常に真偽値を返し、未指定の登録では`false`とする。

## 4. リクエスト・レスポンス例

### ページ付き一覧取得

`GET /api/trips?page=1&limit=10`はログイン中のユーザーに属する記録だけを、日付降順・同日ではID降順で返す。`page`は1〜1,000,000の整数、`limit`は`5`、`10`、`20`のいずれか。省略値は1ページ目・10件。総件数取得と一覧取得の双方で`user_id`を条件にし、一覧はPostgreSQLの`LIMIT`/`OFFSET`を使う。指定ページが削除などで範囲外になった場合は最後のページへ補正する。

```json
{
  "data": [{ "id": "101", "outingDate": "2026-04-12", "city": "京都市", "destination": "嵐山", "activity": null, "notes": null, "weather": "晴れ" }],
  "pagination": { "page": 1, "limit": 10, "total": 23, "totalPages": 3 }
}
```

クエリパラメーターなしの従来の`GET /api/trips`は互換性のため、引き続き全件の配列を返す。クエリパラメーターを使うフロントエンドは上記のページ情報付き形式を受け取る。不正な`page`・`limit`は`400 INVALID_PAGINATION`。

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
  "weather": "晴れ",
  "reminderEnabled": true
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
  "weather": "曇り",
  "reminderEnabled": false
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
- `reminderEnabled`は省略可能なboolean。省略されたPOSTではfalse、PUTでは既存値を維持する。trueにする場合、予定日は東京時間で未来日でなければならない。
- メール送信ジョブはAPIレスポンスから直接処理せず、独立した`npm run reminders:run`ワーカーが実行する。通知ジョブの運用は[メールリマインダー手順](reminder-mail-setup.md)を参照する。

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

### 7.1 都市候補検索

`GET /api/weather/locations?q=Tokyo`はログイン必須。2〜100文字を受け付け、Open-Meteo Geocoding APIを日本語・英語・中国語の表示言語で検索し、同じ候補を統合して最大8件返す。レスポンスは`{ "results": [{ "id", "name", "region", "country", "latitude", "longitude", "timezone" }] }`。候補がない場合は空配列を返す。API通信に失敗した場合は共通エラー形式で返す。

候補を選んだ天気取得では`/api/weather`へ候補の`latitude`、`longitude`、`timezone`、`locationName`、任意の`region`・`country`を付ける。座標範囲と文字数を検証し、選択地点を使って天気APIを呼ぶ。従来どおり`city`と`date`だけを送るクライアントも利用でき、その場合はバックエンドが都市名をジオコーディングする。位置情報は記録DBには保存しない。
