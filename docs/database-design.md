# データベース設計案

## 1. 方針

PostgreSQLに`users`、`outing_records`、`user_sessions`を作成する。既存DBではマイグレーションSQLで追加変更し、既存のお出かけ記録は削除・上書きしない。

## 2. テーブル定義

### `users`（Googleログイン利用者）

| カラム | 型 | NULL | 制約・既定値 | 説明 |
|---|---|---:|---|---|
| `id` | `BIGINT` | 不可 | 主キー、identity | アプリ内部ユーザーID |
| `google_sub` | `VARCHAR(255)` | 不可 | UNIQUE | Google OIDCの安定したユーザー識別子 |
| `email` | `VARCHAR(320)` | 不可 | — | Googleで検証済みのメール |
| `email_verified` | `BOOLEAN` | 不可 | `TRUE` | 検証状態 |
| `display_name` | `VARCHAR(200)` | 可 | — | 表示名 |
| `avatar_url` | `TEXT` | 可 | — | プロフィール画像URL |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | 不可 | `CURRENT_TIMESTAMP` | 作成・更新日時 |

### `user_sessions`（ログインセッション）

`sid VARCHAR PRIMARY KEY`、`sess JSON NOT NULL`、`expire TIMESTAMP NOT NULL`。有効期限インデックスを設定し、期限切れセッションを掃除できるようにする。

### `outing_records`（お出かけ記録）

| カラム | 型 | NULL | 制約・既定値 | 説明 |
|---|---|---:|---|---|
| `id` | `BIGINT` | 不可 | 主キー、生成される連番 | 記録ID |
| `outing_date` | `DATE` | 不可 | — | お出かけ日 |
| `city` | `VARCHAR(100)` | 不可 | 空文字不可（アプリ側で空白のみも拒否） | 都市 |
| `destination` | `VARCHAR(200)` | 不可 | 空文字不可（アプリ側で空白のみも拒否） | 目的地 |
| `activity` | `TEXT` | 可 | — | 活動内容 |
| `notes` | `TEXT` | 可 | — | 備考 |
| `weather` | `VARCHAR(50)` | 可 | — | 天気状況（手入力または仮データ） |
| `user_id` | `BIGINT` | 移行中は可 | `users.id`への外部キー | 所有ユーザー。新規作成時は認証ユーザーIDを設定 |
| `created_at` | `TIMESTAMPTZ` | 不可 | `CURRENT_TIMESTAMP` | 作成日時 |
| `updated_at` | `TIMESTAMPTZ` | 不可 | `CURRENT_TIMESTAMP` | 最終更新日時 |
| `reminder_enabled` | `BOOLEAN` | 不可 | `FALSE` | 予定日の7日前メール通知を明示的に有効化する設定 |

### `reminder_jobs`（通知予定・現在状態）

記録ごとに一意なジョブを保持する。対象記録と所有ユーザーを結び、予定日・送信日時・状態・最大5回の試行数・リース期限・次回試行時刻を保存する。状態は`pending`、`retry_wait`、`processing`、`sent`、`cancelled`、`missed`、`failed`。記録削除はジョブの外部キーをNULL化し、送信履歴を残す。所有ユーザー削除は履歴がある間はRESTRICTする。

### `reminder_attempts`（通知送信履歴）

ジョブと試行番号の組み合わせに一意制約を設け、試行開始・成功・失敗・結果不明、宛先、プロバイダーのメッセージID、安全なエラーコードを保存する。メール本文やSMTP認証情報は保存しない。

既存DBへの`003_reminders.sql`は通知列をFALSEで追加し、履歴テーブルとインデックスを作る追加型マイグレーションである。既存出行レコードを削除・更新しない。適用前に接続先とバックアップを確認し、運用者が明示的に実行する。

`activity`と`notes`は任意の長さの文章を想定する。画面/APIで過度な入力を避けるため、必要に応じてアプリ側で上限を設定する（例：各5,000文字）。`updated_at`は追加時に設定し、更新時にアプリケーションが現在時刻へ更新する。

天気検索の詳細（最高・最低気温、降水量、取得時刻、データ種別）は画面上の取得結果として扱い、初期実装ではDBへ保存しない。記録へ保存する天気文字列は`weather`、対象日は`outing_date`で保持する。記録再表示では保存済み文字列を表示し、天気APIを呼び直さない。詳細値やデータ種別も後から再表示する要件が出た場合は、既存行を保持できるNULL許容カラム追加などの移行を別途設計する。

## 4. インデックス

- 主キーの`id`インデックスは自動作成される。
- 一覧の新しい日付順表示に備え、`outing_date DESC, id DESC`の複合インデックスを推奨する。データ量が少ない初期段階では省略してもよい。
- 所有者別一覧用に`user_id, outing_date DESC, id DESC`を作成する。

## 5. データ整合性と既存行の移行

- 必須項目の欠落はAPIで検証する。空白だけの都市・目的地も拒否する。
- `weather`は自由入力とし、選択肢をDB制約に固定しない。
- APIは全CRUDで`user_id`を条件に含め、他ユーザーの記録を取得・更新・削除できないようにする。所有者が異なるIDは404として扱う。
- 既存行は`user_id = NULL`で残す。通常APIの`WHERE user_id = $currentUserId`に一致しないため、ログイン後も割当までは表示されない。
- 後日、本人のGoogleアカウントと`users.id`を確認してから、`db/migrations/002_assign_legacy_records.sql`を一度だけ実行し、未割当行をそのユーザーへ割り当てる。ユーザーIDの確認前に実行してはならない。移行後にNULL行がなくなった段階で、必要なら`NOT NULL`制約を追加する。
- ユーザー削除は初期版では提供しない。外部キーは`ON DELETE RESTRICT`とする。
- IDはDBで採番し、API利用者からの指定を受け付けない。

## 6. 例示データ（設計例）

| outing_date | city | destination | activity | notes | weather |
|---|---|---|---|---|---|
| 2026-04-12 | 京都市 | 嵐山 | 散策、写真撮影 | 午前中に訪問 | 晴れ |

この行は形式を示すだけの仮データであり、実DBへの登録は行わない。
