# Googleログイン設定

## Google Cloud Consoleで行う設定

1. Google Cloud Consoleでプロジェクトを選択、または作成する。
2. Google Auth Platformの同意画面でアプリ名、サポートメール、利用者の対象範囲を設定する。テスト中はAudienceをTestingにし、試験するGoogleアカウントをTest usersに追加する。
3. ClientsからOAuth Client IDを作成し、Application typeをWeb applicationにする。
4. Authorized redirect URIsに、開発用の`http://localhost:3000/auth/google/callback`を登録する。本番では`https://<アプリのホスト名>/auth/google/callback`も登録する。URIは`GOOGLE_REDIRECT_URI`と完全一致させる。
5. このサーバー側認証フローではAuthorized JavaScript originsは使用しない。別のブラウザー認証機能を追加しない限り空欄のままでよい。
6. Client IDとClient Secretを手元の`.env`または本番ホスティングのSecret管理へ登録する。リポジトリ、ログ、ブラウザーコードへClient Secretを置かない。

Google OAuthのscopeは`openid email profile`のみ。公開利用に切り替える場合は、Google Cloud Consoleで同意画面の対象をProductionにし、Googleの現行verification要件を確認する。

## ローカル環境変数

`.env.example`を`.env`へコピーして、次の値を設定する。

- `GOOGLE_CLIENT_ID`：OAuth Web clientのClient ID
- `GOOGLE_CLIENT_SECRET`：Client Secret（秘密情報）
- `GOOGLE_REDIRECT_URI`：登録したcallback URI
- `SESSION_SECRET`：32文字以上の十分にランダムな秘密値。Node.jsで作る場合の例は`node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`。値はGitへ追加しない。
- `TRUST_PROXY`：信頼できるリバースプロキシを1段経由するときだけ`true`

## 既存DBの移行

1. 対象DBとバックアップを確認してから`db/migrations/001_google_auth.sql`を適用する。このSQLはusers、user_sessions、user_id列、インデックスを追加し、既存行の値は変更しない。
2. Googleでログイン後、`GET /api/auth/me`のユーザーIDとアカウントを確認する。
3. 既存行をそのアカウントに割り当てると決めた場合に限り、psqlで`\set owner_user_id <確認したID>`を設定し、`db/migrations/002_assign_legacy_records.sql`を確認して一度だけ実行する。すべての`user_id IS NULL`行を指定ユーザーに割り当てる。アカウント確認前に実行しない。
4. 割当をしない場合、NULL行はDBに保持され続け、通常のユーザーAPIには表示されない。
