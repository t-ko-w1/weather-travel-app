# API設計

## 1. 共通仕様

- ベースパス：`/api/outing-records`
- データ形式：JSON（UTF-8）
- 日付：`YYYY-MM-DD`
- 成功時は各エンドポイント記載のステータスとJSONを返す。削除成功は`204 No Content`。
- 不正な入力は`400`、対象IDがない場合は`404`、予期しないサーバーエラーは`500`。
- `id`、`createdAt`、`updatedAt`はサーバー側で管理する。

## 2. エンドポイント一覧

| 用途 | メソッド・パス | 成功 |
|---|---|---:|
| 一覧取得 | `GET /api/outing-records` | 200 |
| 1件取得 | `GET /api/outing-records/:id` | 200 |
| 新規作成 | `POST /api/outing-records` | 201 |
| 更新 | `PUT /api/outing-records/:id` | 200 |
| 削除 | `DELETE /api/outing-records/:id` | 204 |

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

`GET /api/outing-records`

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

`GET /api/outing-records/12`はデータ形式の1件を`200`で返す。IDが存在しない場合：

```json
{ "error": { "code": "NOT_FOUND", "message": "記録が見つかりません。" } }
```

### 新規作成

`POST /api/outing-records`

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

`PUT /api/outing-records/12`

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

`DELETE /api/outing-records/12`

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
- 天気取得用のAPIや自動補完は設けない。
