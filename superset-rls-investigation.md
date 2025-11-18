了解しました！ドキュメントを出力しますので、コピー&保存してClaude Code CLIに渡してください。

```markdown
# Superset 5.0 Guest Token RLS 調査ドキュメント

**作成日**: 2025-11-17  
**目的**: Superset 5.0でGuest Token経由のRow Level Security (RLS)が動作しない問題を調査・解決する

---

## 📋 目次
1. [環境構成](#環境構成)
2. [現在の状況](#現在の状況)
3. [実装済みの内容](#実装済みの内容)
4. [問題点](#問題点)
5. [検証結果](#検証結果)
6. [次に調査すべきポイント](#次に調査すべきポイント)
7. [技術スタック](#技術スタック)
8. [参考情報](#参考情報)

---

## 環境構成

```
┌─────────────────────────────────────────────────────────────────┐
│                     開発環境全体構成                               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  Angular App    │      │  NestJS API     │      │  Superset 5.0   │
│  (Port 4200)    │─────▶│  (Port 3000)    │─────▶│  (Port 8088)    │
│                 │      │                 │      │                 │
│ - User選択UI    │      │ - Guest Token   │      │ - Dashboard表示 │
│ - Dashboard表示 │      │   生成API       │      │ - RLS処理??     │
│ - SDK統合       │      │ - RLS Mapping   │      │ - PostgreSQL    │
└─────────────────┘      └─────────────────┘      └─────────────────┘
         │                        │                        │
         │                        │                        │
         └────────────────────────┴────────────────────────┘
                    localhost開発環境


【実際のファイルパス】
/Users/kazu/coding/nx-play/
├── test-superset-embed/    → Angular (埋め込みUI)
├── superset-api/           → NestJS (Token API)
└── superset/               → Superset本体 + Docker環境
```

---

## 現在の状況

### ✅ 動作しているもの
- Superset 5.0 Embedded Dashboard の表示
- NestJS Guest Token API の実装と動作
- Angular アプリケーションとの統合
- Guest Token の生成とデコード
- Feature Flags の設定 (`EMBEDDED_SUPERSET`, `ROW_LEVEL_SECURITY`)

### ❌ 動作していないもの
- **Guest Token経由のRLS適用**
  - Token内にRLSルールは含まれている
  - しかし、SQLクエリに`WHERE`句が追加されない
  - ダッシュボードに全データが表示される

---

## 実装済みの内容

### 1. NestJS Backend (Guest Token API)

**ファイル**: `superset-api/src/app.controller.ts`
**エンドポイント**: `POST /api/superset/guest-token`

**実装内容**:
```typescript
// superset-api/src/app.controller.ts:107-125
const payload: GuestTokenPayload = {
  user: {
    username: username,
    first_name: username.split('_')[0] || username,
    last_name: 'User',
  },
  resources: [
    {
      type: 'dashboard',
      id: dashboardId,
    },
  ],
  rls_rules: rlsRules,  // ユーザーごとのRLSルール
  iat: now,
  exp: now + 300, // 5分間有効
  aud: 'superset',
  type: 'guest',
};

// JWT生成 (app.controller.ts:128-130)
const token = jwt.sign(payload, secret, {
  algorithm: 'HS256',
});
```

**ユーザーとRLSのマッピング例** (app.controller.ts:28-68):
```typescript
const USER_RLS_MAPPING: Record<string, string[]> = {
  'ships_sales': ["product_line = 'Ships'"],
  'admin': [],  // 全データ表示
  // ... 他のユーザー
};
```

**リクエスト例**:
```json
POST http://localhost:3000/api/superset/guest-token
Headers:
  Content-Type: application/json
  x-user-id: ships_sales

Body:
{
  "dashboardId": "26060ee1-386e-4695-bd27-86518236229f",
  "username": "ships_sales"
}
```

**レスポンス例**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### 2. Angular Frontend

**ファイル**: `test-superset-embed/src/app/app.ts`

**実装内容**:
- ユーザー選択UI (admin, ships_sales, etc.)
- Superset Embedded SDKの統合
- Guest Tokenの取得とDashboard表示

**Dashboard埋め込み** (app.ts:72-82):
```typescript
await embedDashboard({
  id: '26060ee1-386e-4695-bd27-86518236229f',
  supersetDomain: 'http://localhost:8088',
  mountPoint: container,
  fetchGuestToken: () => this.fetchGuestToken(this.currentUser),
  dashboardUiConfig: {
    hideTitle: false,
    hideTab: false,
    hideChartControls: false,
  },
});
```

**Guest Token取得** (app.ts:112-134):
```typescript
private async fetchGuestToken(username: string): Promise<string> {
  const response = await fetch('http://localhost:3000/api/superset/guest-token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': username,
    },
    body: JSON.stringify({
      dashboardId: '26060ee1-386e-4695-bd27-86518236229f',
      username: username,
    }),
  });

  const data = await response.json();
  return data.token;
}
```

### 3. Superset Configuration

**ファイル**: `superset/docker/pythonpath_dev/superset_config.py`

**Feature Flags**:
```python
FEATURE_FLAGS = {
    "ALERT_REPORTS": True,
    "EMBEDDED_SUPERSET": True,
    "ROW_LEVEL_SECURITY": True,
}
```

**JWT設定**:
```python
GUEST_TOKEN_JWT_SECRET = "your-random-secret-key-here"
GUEST_TOKEN_JWT_ALGO = "HS256"
GUEST_TOKEN_JWT_EXP_SECONDS = 300
GUEST_TOKEN_JWT_AUDIENCE = "superset"

GUEST_ROLE_NAME = "Public"
```

**CORS・セキュリティ設定**:
```python
TALISMAN_ENABLED = False  # 開発環境用

CORS_OPTIONS = {
    "supports_credentials": True,
    "origins": ["http://localhost:4200"],
}

SESSION_COOKIE_SAMESITE = "None"
SESSION_COOKIE_SECURE = False
```

---

## 問題点

### 主要な問題: RLSが適用されない

**期待される動作**:
```sql
-- ships_salesユーザーの場合
SELECT * FROM cleaned_sales_data WHERE product_line = 'Ships'
```

**実際の動作**:
```sql
-- WHERE句が追加されない
SELECT * FROM cleaned_sales_data
```

### 検証済みの事項

#### ✅ Token内容の確認
```javascript
// Tokenをデコードした結果
{
  user: { username: 'ships_sales', first_name: 'ships', last_name: 'User' },
  resources: [ { type: 'dashboard', id: '26060ee1-386e-4695-bd27-86518236229f' } ],
  rls_rules: [ { clause: "product_line = 'Ships'" } ],
  iat: 1763382953,
  exp: 1763383253,
  aud: 'superset',
  type: 'guest'
}
```
→ **RLSルールは正しく含まれている**

#### ✅ SQLログの確認
```bash
docker compose logs -f superset | grep "SELECT.*FROM cleaned_sales_data"
```

**結果**:
```sql
SELECT DISTINCT product_line FROM cleaned_sales_data
SELECT * FROM cleaned_sales_data LIMIT 10
```
→ **WHERE句が追加されていない**

#### ✅ Superset設定の確認
- `EMBEDDED_SUPERSET`: True
- `ROW_LEVEL_SECURITY`: True
- `GUEST_ROLE_NAME`: "Public"
→ **設定は正しい**

---

## 検証結果

### 試したこと

1. **Supersetからログアウト**
   - 結果: 変化なし
   
2. **Token構造の確認**
   - `rls_rules` vs `rls` の違いを検証
   - 結果: どちらも動作せず
   
3. **Feature Flagsの確認**
   - Python内部で設定を確認
   - 結果: 正しく有効化されている
   
4. **SQLログの監視**
   - リアルタイムでクエリを監視
   - 結果: WHERE句が追加されない

### 仮説

#### 仮説1: Superset 5.0の実装変更
Superset 5.0でGuest Token RLSの実装が変更された可能性がある。

**根拠**:
- 公式ドキュメントの方法で動作しない
- SQLログにWHERE句が追加されない
- Token内のRLSルールが無視されている

#### 仮説2: 追加の設定が必要
Guest Token RLS以外に、データベースやダッシュボード側で追加設定が必要な可能性がある。

**調査すべき点**:
- Dataset設定
- Dashboard権限設定
- Database接続設定

#### 仮説3: バグまたは未実装
Superset 5.0でGuest Token RLSがまだ完全に実装されていない可能性がある。

**確認方法**:
- GitHubのIssuesを検索
- Supersetのソースコードを確認
- 公式Slackで質問

---

## 次に調査すべきポイント

### 🔍 優先度: 高

#### 1. Superset 5.0のソースコード調査
**対象ファイル**:
- `superset/security/guest_token.py`
- `superset/connectors/sqla/models.py`
- `superset/security/manager.py`

**調査内容**:
- Guest TokenのRLSルール処理フロー
- `rls_rules`が実際にSQLに適用される箇所
- Superset 5.0でのRLS実装の変更点

#### 2. GitHub Issues検索
**検索クエリ**:
- `guest token rls 5.0`
- `embedded rls not working`
- `rls_rules guest token`

**確認事項**:
- 既知のバグがないか
- 回避策が提案されているか
- 実装予定の機能か

#### 3. 公式ドキュメントの再確認
**確認箇所**:
- [Embedded Dashboards](https://superset.apache.org/docs/embedding-superset)
- [Row Level Security](https://superset.apache.org/docs/security/)
- 最新のAPI仕様

### 🔍 優先度: 中

#### 4. Superset UI経由のRLS設定
**手順**:
1. Settings → Row Level Security
2. 手動でRLSルールを追加
3. Guest Roleに適用
4. 動作確認

**目的**: UI経由のRLSは動作するか確認

#### 5. Superset 4.xとの比較
**調査内容**:
- Superset 4.xでGuest Token RLSは動作するか
- 実装の違い
- マイグレーションパス

#### 6. データベースビューの検討
**代替案**:
```sql
CREATE VIEW ships_sales_view AS
SELECT * FROM cleaned_sales_data WHERE product_line = 'Ships';
```

**メリット**:
- 確実にデータをフィルタリングできる
- Superset側の実装に依存しない

**デメリット**:
- 各ユーザーごとにビューを作成する必要がある
- 動的なフィルタリングができない

### 🔍 優先度: 低

#### 7. 別のEmbedded SDK設定
- `dashboardUiConfig`の他のオプション
- `guestToken`以外の認証方法

#### 8. Supersetのログレベル変更
```python
# superset_config.py
LOGGING_CONFIGURATOR.setLevel('DEBUG')
```

---

## 技術スタック

### Backend (superset-api/)
- **NestJS**: v11.0.1
- **TypeScript**: v5.7.3
- **jsonwebtoken**: v9.0.2
- **Port**: 3000

### Frontend (test-superset-embed/)
- **Angular**: v20.3.0
- **@superset-ui/embedded-sdk**: v0.2.0
- **Port**: 4200

### BI Platform (superset/)
- **Apache Superset**: v5.0.0
- **PostgreSQL**: 14.x (メタデータDB)
- **Redis**: キャッシュ
- **Docker Compose**: コンテナ環境
- **Port**: 8088

### Development
- **Docker Compose**: ローカル開発環境
- **macOS**: Darwin 24.6.0

---

## 参考情報

### 公式ドキュメント
- [Superset Embedding](https://superset.apache.org/docs/embedding-superset)
- [Row Level Security](https://superset.apache.org/docs/security/)
- [Guest Tokens](https://superset.apache.org/docs/api/)

### GitHub
- [Superset Repository](https://github.com/apache/superset)
- [Issues: RLS](https://github.com/apache/superset/issues?q=is%3Aissue+rls)
- [Pull Requests: Guest Token](https://github.com/apache/superset/pulls?q=guest+token)

### コミュニティ
- [Superset Slack](https://apache-superset.slack.com/)
- [Stack Overflow: superset](https://stackoverflow.com/questions/tagged/superset)

### 関連ファイル
```
プロジェクト構造:
/Users/kazu/coding/nx-play/
├── superset-api/                    # NestJS Backend
│   └── src/
│       ├── app.controller.ts        # Guest Token API実装
│       ├── app.service.ts
│       ├── app.module.ts
│       └── main.ts
├── test-superset-embed/             # Angular Frontend
│   └── src/
│       ├── app/
│       │   ├── app.ts               # Dashboard埋め込み実装
│       │   ├── app.html             # ユーザー選択UI
│       │   ├── app.css
│       │   ├── app.config.ts
│       │   └── app.routes.ts
│       ├── main.ts
│       └── index.html
├── superset/                        # Superset 5.0 (Docker環境)
│   ├── docker-compose.yml
│   ├── docker/
│   │   ├── .env                     # 環境変数
│   │   ├── pythonpath_dev/
│   │   │   └── superset_config.py   # Superset設定
│   │   └── pythonpath_docker/
│   └── superset/                    # Supersetソースコード
│       └── security/
│           └── guest_token.py       # 調査対象
└── superset-rls-investigation.md    # このドキュメント
```

---

## Claude Codeへの依頼内容

### 調査タスク

#### タスク1: ソースコード解析
**目的**: Superset 5.0でGuest Token RLSがどのように処理されるか理解する

**調査対象ファイル**:
- `/Users/kazu/coding/nx-play/superset/superset/security/guest_token.py` (2658 bytes)
- `/Users/kazu/coding/nx-play/superset/superset/security/manager.py` (99083 bytes)
- `/Users/kazu/coding/nx-play/superset/superset/security/api.py` (6109 bytes)

**手順**:
1. ✅ Superset 5.0のソースコードは既にローカルにある (`/Users/kazu/coding/nx-play/superset/`)
2. `superset/security/guest_token.py`を解析
3. `rls_rules`の処理フローを追跡
4. SQLクエリ生成部分でRLSがどう適用されるか確認
5. `manager.py`でのRLS適用ロジックを確認

**期待される出力**:
- RLS適用のコールスタック
- Superset 5.0での実装状況
- 必要な設定や前提条件
- バグや未実装の箇所の特定

#### タスク2: GitHub Issues調査
**目的**: 既知の問題や回避策を見つける

**手順**:
1. `guest token rls`で検索
2. Superset 5.0に関連するIssueをフィルタ
3. CloseされたIssueとOpenなIssueを確認
4. コミュニティの解決策をまとめる

**期待される出力**:
- 関連Issueのリスト
- 提案されている回避策
- 開発チームの対応予定

#### タスク3: 実装の比較
**目的**: Superset 4.xと5.0の違いを理解する

**手順**:
1. Superset 4.x最終版のguest_token.pyを取得
2. Superset 5.0との差分を確認
3. RLS関連の変更を抽出
4. 移行に必要な変更点をリストアップ

**期待される出力**:
- 主要な変更点
- 後方互換性の情報
- 移行ガイド

#### タスク4: 代替実装の検討
**目的**: Guest Token RLS以外の方法でRLSを実現する

**手順**:
1. Superset UIでのRLS設定方法を調査
2. データベースビューを使う方法を検討
3. カスタムSQLベースの方法を検討
4. それぞれの実装手順をまとめる

**期待される出力**:
- 各方法のメリット・デメリット
- 実装手順
- コード例

---

## 成果物

### 期待される調査結果ドキュメント

1. **技術調査レポート** (`superset-rls-technical-investigation.md`)
   - ソースコード解析結果
   - RLS処理フロー図
   - 実装の詳細説明

2. **既知の問題まとめ** (`superset-rls-known-issues.md`)
   - GitHub Issuesリスト
   - コミュニティの議論
   - 回避策

3. **実装ガイド** (`superset-rls-implementation-guide.md`)
   - 動作する実装方法
   - 設定手順
   - サンプルコード

4. **代替案の検討** (`superset-rls-alternatives.md`)
   - 各方法の比較表
   - 推奨アプローチ
   - 実装例

---

## 備考

### 重要な観察事項

1. **Token生成は成功している**
   - NestJSからのTokenは正しい形式
   - デコード結果も期待通り

2. **Superset側でTokenを受け取っている**
   - Dashboard表示は成功
   - 認証は通っている

3. **RLSルールだけが適用されない**
   - 他の機能は正常
   - RLS処理のみが機能していない

### 推測される根本原因

Superset 5.0では、Guest Token内の`rls_rules`を読み取って実際のSQLクエリに適用する部分が:
- 実装されていない
- バグがある
- 別の設定が必要

いずれかの状態にある可能性が高い。

### 次のアクション

Claude Codeによる調査後、以下を決定する:
1. Superset 5.0でGuest Token RLSが動作する方法があるか
2. ない場合、代替実装を選択
3. 最終的な実装方針を決定

---

**作成者**: Claude (Anthropic)  
**最終更新**: 2025-11-17
```
