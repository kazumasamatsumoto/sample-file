# Apache Superset 5.0 Guest Token RLS - 設定手順と動作仕組み

## 概要

Apache Superset 5.0のEmbedded Dashboard機能において、Guest Tokenを使用したRow Level Security (RLS)を実装した際の設定手順と、その動作メカニズムをまとめたドキュメント。

---

## 1. 必要な設定

### 1.1 Superset設定 (`superset_config.py`)

```python
# Feature Flags
FEATURE_FLAGS = {
    "ALERT_REPORTS": True,
    "EMBEDDED_SUPERSET": True,  # 必須: Embedded Dashboard機能を有効化
    "ROW_LEVEL_SECURITY": True,  # 必須: RLS機能を有効化
}

# Guest Token JWT設定
GUEST_TOKEN_JWT_SECRET = "your-random-secret-key-here"  # NestJSと同じ秘密鍵
GUEST_TOKEN_JWT_ALGO = "HS256"
GUEST_TOKEN_JWT_EXP_SECONDS = 300
GUEST_TOKEN_JWT_AUDIENCE = "superset"  # NestJSと一致させる（重要）

# Guest Role設定
GUEST_ROLE_NAME = "Public"  # Guest Tokenで使用するロール名

# CORS設定
CORS_OPTIONS = {
    "supports_credentials": True,
    "allow_headers": ["*"],
    "resources": ["*"],
    "origins": ["http://localhost:4200"],  # フロントエンドのURL
}

# Talisman無効化（開発環境のみ）
TALISMAN_ENABLED = False

# CSRF設定
WTF_CSRF_ENABLED = True
WTF_CSRF_EXEMPT_LIST = ["superset.views.core.log"]

# Session設定
SESSION_COOKIE_SAMESITE = "Lax"  # "None"だとログインできない
SESSION_COOKIE_SECURE = False
SESSION_COOKIE_HTTPONLY = True
```

### 1.2 Publicロールの権限設定

Superset UIから以下の権限を付与：

1. Settings → List Roles → Public を編集
2. 以下の権限を追加：
   - `can read on Dashboard`
   - `can read on Chart`
   - `can read on Dataset`

### 1.3 Embedded Dashboardの作成

1. Settings → Embedded Dashboards
2. "+ Embedded Dashboard" をクリック
3. ダッシュボードを選択
4. Allowed Domains に `http://localhost:4200` を追加
5. 保存後、生成されたUUIDをメモ

### 1.4 NestJS API - Guest Token生成

```typescript
import { sign } from 'jsonwebtoken';

interface GuestTokenPayload {
  user: {
    username: string;
    first_name: string;
    last_name: string;
  };
  resources: Array<{
    type: string;
    id: string;
  }>;
  rls_rules: Array<{
    clause: string;
  }>;
  iat: number;
  exp: number;
  aud: string;
  type: string;
}

@Post('guest-token')
async getGuestToken(@Body() body: { dashboardId: string; username: string }) {
  const { dashboardId, username } = body;

  // ユーザーごとのRLSルールを定義
  const rlsRulesMap: Record<string, string> = {
    admin: '1=1',
    ships_sales: "productLine = 'Ships'",
    classic_cars_sales: "productLine = 'Classic Cars'",
    planes_sales: "productLine = 'Planes'",
  };

  const rlsRules = [
    {
      clause: rlsRulesMap[username] || '1=0',
    },
  ];

  const now = Math.floor(Date.now() / 1000);

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
    rls_rules: rlsRules,  // RLSルールをここで指定
    iat: now,
    exp: now + 300,
    aud: 'superset',  // superset_config.pyと一致させる
    type: 'guest',
  };

  const token = sign(payload, 'your-random-secret-key-here', {
    algorithm: 'HS256',
  });

  return { token };
}
```

### 1.5 Angular フロントエンド

```typescript
import { embedDashboard } from '@superset-ui/embedded-sdk';

private dashboardId = "078c015e-3464-46a3-b75b-0caefddafb6a";  // Embedded Dashboard UUID

async loadDashboard() {
  await embedDashboard({
    id: this.dashboardId,
    supersetDomain: 'http://localhost:8088',
    mountPoint: container,
    fetchGuestToken: () => this.fetchGuestToken(this.currentUser),
    dashboardUiConfig: {
      hideTitle: false,
      hideTab: false,
      hideChartControls: false,
    },
  });
}

async fetchGuestToken(username: string): Promise<string> {
  const response = await fetch('http://localhost:3000/api/superset/guest-token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': username,
    },
    body: JSON.stringify({
      dashboardId: this.dashboardId,
      username: username,
    }),
  });

  const data = await response.json();
  return data.token;
}
```

---

## 2. RLS動作メカニズム（仮説）

ログが取得できなかったため、ソースコード分析と動作確認に基づく仮説。

### 2.1 全体フロー

```
┌─────────────┐
│ Angular App │
│ (Port 4200) │
└──────┬──────┘
       │ 1. ユーザー選択してダッシュボード表示
       ↓
┌─────────────┐
│  NestJS API │
│ (Port 3000) │
└──────┬──────┘
       │ 2. Guest Token生成（RLSルール含む）
       │    {
       │      user: { username: "ships_sales", ... },
       │      resources: [{ type: "dashboard", id: "..." }],
       │      rls_rules: [{ clause: "productLine = 'Ships'" }]
       │    }
       ↓
┌─────────────┐
│   Superset  │
│ (Port 8088) │
└─────────────┘
       │
       ├─ 3. /embedded/<uuid> へアクセス
       │    ├─ embedded/view.py: login_user(AnonymousUserMixin())
       │    └─ HTMLレスポンス（iframe内でダッシュボード表示）
       │
       ├─ 4. /api/v1/chart/data へチャートデータリクエスト
       │    ├─ ヘッダー: X-GuestToken: <JWT token>
       │    │
       │    ├─ security/manager.py: get_guest_user_from_request()
       │    │    ├─ JWTトークンをパース
       │    │    ├─ トークン検証（署名、有効期限、audience）
       │    │    └─ GuestUserオブジェクト作成
       │    │         └─ self.rls = token.get("rls_rules", [])
       │    │
       │    ├─ Flask-Login: request_loader
       │    │    └─ g.user = GuestUser (リクエストスコープで保持)
       │    │
       │    ├─ connectors/sqla/models.py: get_sqla_row_level_filters()
       │    │    │
       │    │    ├─ 通常のRLSフィルター処理
       │    │    │    └─ security_manager.get_rls_filters(self)
       │    │    │
       │    │    └─ Guest Token RLS処理（EMBEDDED_SUPERSET有効時）
       │    │         ├─ security_manager.get_guest_rls_filters(self)
       │    │         │    ├─ get_current_guest_user_if_guest()
       │    │         │    │    └─ return g.user if is_guest_user() else None
       │    │         │    │
       │    │         │    └─ guest_user.rls からdataset IDに一致するルールを抽出
       │    │         │         return [
       │    │         │           rule for rule in guest_user.rls
       │    │         │           if not rule.get("dataset") or
       │    │         │              str(rule.get("dataset")) == str(dataset.id)
       │    │         │         ]
       │    │         │
       │    │         └─ 各ルールのclauseをSQL WHERE句に変換
       │    │              clause = self.text(
       │    │                f"({template_processor.process_template(rule['clause'])})"
       │    │              )
       │    │
       │    └─ SQLクエリ実行
       │         SELECT ... FROM products
       │         WHERE ... AND (productLine = 'Ships')  ← RLSフィルター適用
       │
       └─ 5. フィルタリングされたデータをレスポンス
```

### 2.2 重要なコンポーネント

#### A. GuestUserクラス (`superset/security/guest_token.py`)

```python
class GuestUser:
    def __init__(self, token: GuestToken, roles: list[Role]):
        user = token["user"]
        self.guest_token = token
        self.username = user.get("username", "guest_user")
        self.first_name = user.get("first_name", "Guest")
        self.last_name = user.get("last_name", "User")
        self.roles = roles
        self.resources = token["resources"]
        self.rls = token.get("rls_rules", [])  # ← RLSルールをここに格納
        self.is_guest_user = True
```

**ポイント**: Guest TokenのペイロードからRLSルールを抽出し、`self.rls` に格納。

#### B. Flask-Login request_loader (`superset/security/manager.py`)

```python
@self.lm.request_loader
def load_user_from_request(request: Request) -> Optional[User]:
    user = self.get_user_from_session()
    if user and not user.is_anonymous:
        return user

    user = self.get_oauth_user_info("access_token")
    if user:
        return self.load_user(user["id"])

    user = self.get_guest_user_from_request(request)  # ← Guest Token処理
    if user:
        return user

    user = self.get_basic_auth_user()
    if user:
        return user

    return None
```

**ポイント**: リクエストごとに認証を試み、Guest Tokenが存在すればGuestUserを返す。

#### C. get_guest_rls_filters() (`superset/security/manager.py`)

```python
def get_guest_rls_filters(self, dataset: "BaseDatasource") -> list[GuestTokenRlsRule]:
    """
    Retrieves RLS filters from the guest token.

    :param dataset: The dataset to check against
    :return: A list of filters
    """
    if guest_user := self.get_current_guest_user_if_guest():
        return [
            rule
            for rule in guest_user.rls
            if not rule.get("dataset")
            or str(rule.get("dataset")) == str(dataset.id)
        ]
    return []
```

**ポイント**:
- `g.user` がGuestUserかチェック
- GuestUserの場合、`guest_user.rls` からフィルターを取得
- dataset IDが指定されている場合は一致するもののみ、指定がない場合は全てのルールを返す

#### D. get_sqla_row_level_filters() (`superset/connectors/sqla/models.py`)

```python
def get_sqla_row_level_filters(
    self,
    template_processor: Optional[BaseTemplateProcessor] = None,
) -> list[TextClause]:
    template_processor = template_processor or self.get_template_processor()

    all_filters: list[TextClause] = []
    filter_groups: dict[Union[int, str], list[TextClause]] = defaultdict(list)

    try:
        # 通常のRLSフィルター（UI設定）
        for filter_ in security_manager.get_rls_filters(self):
            clause = self.text(
                f"({template_processor.process_template(filter_.clause)})"
            )
            if filter_.group_key:
                filter_groups[filter_.group_key].append(clause)
            else:
                all_filters.append(clause)

        # Guest Token RLS（EMBEDDED_SUPERSET有効時のみ）
        if is_feature_enabled("EMBEDDED_SUPERSET"):
            for rule in security_manager.get_guest_rls_filters(self):
                clause = self.text(
                    f"({template_processor.process_template(rule['clause'])})"
                )
                all_filters.append(clause)

        grouped_filters = [or_(*clauses) for clauses in filter_groups.values()]
        all_filters.extend(grouped_filters)

        return all_filters
    except TemplateError as ex:
        raise QueryObjectValidationError(...) from ex
```

**ポイント**:
- 通常のRLS（UI設定）とGuest Token RLS（JWT）の両方を処理
- `EMBEDDED_SUPERSET` フィーチャーフラグが有効な場合のみGuest Token RLSを適用
- 各ルールの`clause`をテンプレート処理してSQLのWHERE句に変換

### 2.3 認証フロー（仮説）

```
リクエスト
  ↓
Flask-Login request_loader
  ↓
get_guest_user_from_request()
  ├─ X-GuestToken ヘッダーからJWT取得
  ├─ JWT検証（署名、有効期限、audience）
  ├─ GuestUserオブジェクト作成
  │   └─ self.rls = token["rls_rules"]
  └─ return GuestUser
  ↓
g.user = GuestUser （リクエストスコープで保持）
  ↓
チャートデータクエリ実行
  ↓
get_sqla_row_level_filters()
  ├─ get_guest_rls_filters(dataset)
  │   ├─ get_current_guest_user_if_guest()
  │   │   └─ return g.user if is_guest_user() else None
  │   └─ return guest_user.rls (datasetでフィルタリング)
  ↓
SQL WHERE句に変換
  └─ WHERE ... AND (productLine = 'Ships')
```

### 2.4 重要な発見

#### 発見1: セッション認証との優先順位

`/embedded/<uuid>` エンドポイントでは `login_user(AnonymousUserMixin(), force=True)` が実行されるが、その後のチャートデータリクエストでは `request_loader` が再度実行され、Guest Tokenが優先される。

#### 発見2: dataset ID指定は任意

Guest TokenのRLSルールでは、`dataset` キーは任意：
```typescript
// 特定のdatasetのみに適用
rls_rules: [{ clause: "...", dataset: 123 }]

// 全てのdatasetに適用
rls_rules: [{ clause: "..." }]
```

#### 発見3: テンプレート処理

RLSルールの`clause`は Jinja2 テンプレートとして処理される。これにより、動的なフィルタリングが可能：
```python
# 例: ユーザー情報を使った動的フィルタリング
clause = "country = '{{ current_user.country }}'"
```

ただし、Guest Tokenの場合は静的な文字列が推奨される。

---

## 3. トラブルシューティング

### 3.1 401 UNAUTHORIZED

**原因**: JWT audienceの不一致

**解決策**:
```python
# superset_config.py
GUEST_TOKEN_JWT_AUDIENCE = "superset"
```

```typescript
// NestJS
payload.aud = "superset"  // 同じ値
```

### 3.2 403 FORBIDDEN

**原因**: Publicロールの権限不足

**解決策**: Settings → List Roles → Public に以下の権限を追加
- can read on Dashboard
- can read on Chart
- can read on Dataset

### 3.3 ログインループ

**原因**: `SESSION_COOKIE_SAMESITE = "None"` が非HTTPSで動作しない

**解決策**:
```python
SESSION_COOKIE_SAMESITE = "Lax"  # または "Strict"
```

### 3.4 RLSが適用されない

**チェックリスト**:
1. `FEATURE_FLAGS["EMBEDDED_SUPERSET"] = True` が設定されているか
2. `FEATURE_FLAGS["ROW_LEVEL_SECURITY"] = True` が設定されているか
3. Guest Tokenの`rls_rules`が正しく設定されているか
4. NestJSとSupersetで同じJWT秘密鍵を使用しているか
5. Publicロールに必要な権限があるか

---

## 4. 検証方法

### 4.1 Guest Tokenの内容確認

```bash
# JWT Tokenをデコード（jwt.ioでも可能）
echo "<token>" | cut -d. -f2 | base64 -d | jq .
```

期待される出力:
```json
{
  "user": {
    "username": "ships_sales",
    "first_name": "ships",
    "last_name": "User"
  },
  "resources": [
    {
      "type": "dashboard",
      "id": "078c015e-3464-46a3-b75b-0caefddafb6a"
    }
  ],
  "rls_rules": [
    {
      "clause": "productLine = 'Ships'"
    }
  ],
  "iat": 1700000000,
  "exp": 1700000300,
  "aud": "superset",
  "type": "guest"
}
```

### 4.2 ブラウザDevToolsでの確認

1. Network タブで `/api/v1/chart/data` リクエストを確認
2. Request Headers に `X-GuestToken` が含まれているか確認
3. Response の data が期待通りフィルタリングされているか確認

### 4.3 異なるユーザーでのテスト

| ユーザー名 | RLSルール | 期待されるTotal Revenue |
|-----------|----------|------------------------|
| admin | `1=1` (全データ) | $10,032,628.85 |
| ships_sales | `productLine = 'Ships'` | $714,437.13 |
| classic_cars_sales | `productLine = 'Classic Cars'` | $3,919,615.66 |
| planes_sales | `productLine = 'Planes'` | $975,003.57 |

---

## 5. まとめ

### 5.1 Guest Token RLSの動作原理（仮説）

1. **認証**: リクエストごとにFlask-Loginの`request_loader`がGuest Tokenを検証し、GuestUserオブジェクトを作成
2. **RLS格納**: GuestUserの`self.rls`にJWTペイロードの`rls_rules`を格納
3. **フィルター適用**: SQLクエリ生成時に`get_sqla_row_level_filters()`が呼ばれ、Guest Token RLSを抽出
4. **SQL変換**: RLSルールの`clause`をWHERE句に変換してクエリに追加
5. **実行**: フィルタリングされたSQLクエリを実行し、結果を返す

### 5.2 重要なポイント

- **リクエストスコープ**: GuestUserは`g.user`に格納され、リクエストごとに再作成される
- **セキュリティ**: JWT署名検証により、改ざんされたトークンは拒否される
- **柔軟性**: dataset指定により、特定のデータセットのみにRLSを適用可能
- **統合**: 通常のRLS（UI設定）とGuest Token RLS（JWT）を併用可能

### 5.3 制限事項

- ログが取得できなかったため、一部は仮説に基づく
- 実際の処理順序や内部状態は確認できていない
- パフォーマンスへの影響は未検証

---

## 付録A: 関連ソースコード

### A.1 主要ファイル

| ファイル | 役割 |
|---------|------|
| `superset/security/guest_token.py` | GuestUser, GuestTokenクラス定義 |
| `superset/security/manager.py` | Guest Token認証、RLSフィルター取得 |
| `superset/connectors/sqla/models.py` | SQLクエリ生成、RLSフィルター適用 |
| `superset/embedded/view.py` | Embedded Dashboardビュー |
| `superset/charts/data/api.py` | チャートデータAPI |

### A.2 重要な関数

```python
# superset/security/manager.py
- get_guest_user_from_request(req: Request) -> Optional[GuestUser]
- get_guest_rls_filters(dataset: BaseDatasource) -> list[GuestTokenRlsRule]
- get_current_guest_user_if_guest() -> Optional[GuestUser]
- is_guest_user() -> bool

# superset/connectors/sqla/models.py
- get_sqla_row_level_filters(template_processor) -> list[TextClause]

# Flask-Login
- @lm.request_loader
```

---

## 付録B: 起動手順

### B.1 Superset起動

```bash
cd /Users/kazu/coding/nx-play/superset
docker compose -f docker-compose-image-tag.yml up -d
```

### B.2 NestJS API起動

```bash
cd /Users/kazu/coding/nx-play/superset-api
npm start
```

### B.3 Angular App起動

```bash
cd /Users/kazu/coding/nx-play/test-superset-embed
npm run start
```

### B.4 停止

```bash
# Docker
cd /Users/kazu/coding/nx-play/superset
docker compose -f docker-compose-image-tag.yml down

# NestJS & Angular（バックグラウンドプロセスをKill）
```

---

**作成日**: 2025-11-18
**バージョン**: Superset 5.0
**ステータス**: 動作確認済み（ログ取得未完了）
