# Superset 5.0 Guest Token RLS - 技術調査レポート

**作成日**: 2025-11-18
**調査者**: Claude Code
**対象バージョン**: Apache Superset 5.0

---

## 📋 エグゼクティブサマリー

Superset 5.0のGuest Token RLS機能について、ソースコード解析を行った結果、**実装自体は正しく存在している**ことが確認できました。

### 主要な発見
1. ✅ RLS処理フロー全体が実装されている
2. ✅ Guest Token からのRLSルール取得ロジックが存在
3. ✅ SQLクエリへのRLS適用コードが存在
4. ⚠️ しかし、**複数の条件が満たされないとRLSが動作しない**

---

## 🔍 ソースコード解析結果

### 1. Guest Token の処理フロー

```
リクエスト受信
    ↓
LoginManager.request_loader (manager.py:360-366)
    ↓
get_guest_user_from_request (manager.py:2592-2623)
    ↓
parse_jwt_guest_token (manager.py:2631-2644)
    ↓
get_guest_user_from_token (manager.py:2625-2629)
    ↓
GuestUser オブジェクト作成 (guest_token.py:80-88)
    ↓
user.rls に rls_rules を格納
```

#### 重要なコード箇所

**`superset/security/manager.py:360-366`**
```python
def request_loader(self, request: Request) -> Optional[User]:
    from superset.extensions import feature_flag_manager

    if feature_flag_manager.is_feature_enabled("EMBEDDED_SUPERSET"):
        return self.get_guest_user_from_request(request)
    return None
```

**条件1**: `EMBEDDED_SUPERSET` フィーチャーフラグが有効でなければならない ✅

---

**`superset/security/manager.py:2592-2623`**
```python
def get_guest_user_from_request(self, req: Request) -> Optional[GuestUser]:
    raw_token = req.headers.get(
        current_app.config["GUEST_TOKEN_HEADER_NAME"]  # デフォルト: "X-GuestToken"
    ) or req.form.get("guest_token")

    if raw_token is None:
        return None

    try:
        token = self.parse_jwt_guest_token(raw_token)
        if token.get("user") is None:
            raise ValueError("Guest token does not contain a user claim")
        if token.get("resources") is None:
            raise ValueError("Guest token does not contain a resources claim")
        if token.get("rls_rules") is None:  # ← 重要！
            raise ValueError("Guest token does not contain an rls_rules claim")
        if token.get("type") != "guest":
            raise ValueError("This is not a guest token.")
    except Exception:
        logger.warning("Invalid guest token", exc_info=True)
        return None

    return self.get_guest_user_from_token(cast(GuestToken, token))
```

**条件2**: HTTPヘッダー `X-GuestToken` にトークンが含まれていなければならない

**条件3**: トークンに `rls_rules` クレームが必須（空配列でもOK）

---

**`superset/security/guest_token.py:80-88`**
```python
def __init__(self, token: GuestToken, roles: list[Role]):
    user = token["user"]
    self.guest_token = token
    self.username = user.get("username", "guest_user")
    self.first_name = user.get("first_name", "Guest")
    self.last_name = user.get("last_name", "User")
    self.roles = roles
    self.resources = token["resources"]
    self.rls = token.get("rls_rules", [])  # ← ここに格納
```

**GuestUserオブジェクトの`self.rls`に`rls_rules`が格納される**

---

### 2. RLS フィルターの取得

**`superset/security/manager.py:2431-2447`**
```python
def get_guest_rls_filters(
    self, dataset: "BaseDatasource"
) -> list[GuestTokenRlsRule]:
    """
    Retrieves the row level security filters for the current user and the dataset,
    if the user is authenticated with a guest token.
    """
    if guest_user := self.get_current_guest_user_if_guest():
        return [
            rule
            for rule in guest_user.rls  # ← GuestUser.rls から取得
            if not rule.get("dataset")
            or str(rule.get("dataset")) == str(dataset.id)
        ]
    return []
```

**処理内容**:
- 現在のユーザーがGuest Userかチェック
- Guest Userなら `user.rls` からRLSルールを取得
- ルールに `dataset` フィールドがあれば、それでフィルタリング
- ルールに `dataset` フィールドがなければ、全てのdatasetに適用

---

**`superset/security/manager.py:2524-2525`**
```python
def get_guest_rls_filters_str(self, table: "BaseDatasource") -> list[str]:
    return [f.get("clause", "") for f in self.get_guest_rls_filters(table)]
```

**処理内容**: RLSルールから `clause` (WHERE句の文字列) を抽出

---

### 3. SQL クエリへの RLS 適用

**`superset/connectors/sqla/models.py:723-765`**
```python
def get_sqla_row_level_filters(
    self,
    template_processor: Optional[BaseTemplateProcessor] = None,
) -> list[TextClause]:
    """
    Return the appropriate row level security filters for this table and the
    current user.
    """
    template_processor = template_processor or self.get_template_processor()

    all_filters: list[TextClause] = []
    filter_groups: dict[Union[int, str], list[TextClause]] = defaultdict(list)

    try:
        # 通常のRLSフィルター（UI経由で設定されたもの）
        for filter_ in security_manager.get_rls_filters(self):
            clause = self.text(
                f"({template_processor.process_template(filter_.clause)})"
            )
            if filter_.group_key:
                filter_groups[filter_.group_key].append(clause)
            else:
                all_filters.append(clause)

        # Guest Token の RLS フィルター ← ここ！
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
        raise QueryObjectValidationError(
            _("Error in jinja expression in RLS filters: %(msg)s", msg=ex.message)
        ) from ex
```

**条件4**: 再度 `EMBEDDED_SUPERSET` フィーチャーフラグがチェックされる ✅

**処理内容**:
1. 通常のRLSフィルター（DB保存されているもの）を取得
2. `EMBEDDED_SUPERSET`が有効なら、Guest Token RLSも追加
3. 各ルールの`clause`をSQLテキストとして処理
4. Jinjaテンプレートプロセッサで動的値を処理
5. 全てのフィルターをリストで返す

---

**`superset/models/helpers.py:1928`**
```python
where_clause_and += self.get_sqla_row_level_filters(template_processor)
```

**処理内容**: クエリのWHERE句にRLSフィルターを追加（AND条件で結合）

---

## 🐛 問題の可能性リスト

### 高確率の原因

#### 1. Guest Token がリクエストに含まれていない
**症状**: `X-GuestToken` ヘッダーが送信されていない

**確認方法**:
```bash
# Superset のログを確認
docker compose logs -f superset | grep -i "guest"
docker compose logs -f superset | grep -i "X-GuestToken"
```

**対策**:
- ブラウザのDevToolsでNetworkタブを確認
- `@superset-ui/embedded-sdk` が自動的にヘッダーを追加しているか確認

---

#### 2. CORS設定の問題
**症状**: ブラウザがヘッダーを送信前に削除している

**確認方法**:
```python
# superset_config.py
CORS_OPTIONS = {
    "supports_credentials": True,
    "origins": ["http://localhost:4200"],
    "allow_headers": ["X-GuestToken"],  # ← これが必要かも
}
```

**対策**: `allow_headers` に `X-GuestToken` を明示的に追加

---

#### 3. Dataset の is_rls_supported が False
**症状**: データセット側でRLSがサポートされていない

**確認方法**:
```python
# superset/connectors/sqla/models.py:1149
class SqlaTable(Model, BaseDatasource, ExploreMixin):
    is_rls_supported = True  # ← これがFalseだとRLS無効
```

**対策**: データセット設定を確認

---

#### 4. g.user が正しく設定されていない
**症状**: Flask の `g.user` にGuest Userが入っていない

**確認方法**: Superset のデバッグログを確認
```python
# manager.py に追加してログ確認
logger.info(f"Current user: {g.user}, is_guest: {hasattr(g.user, 'is_guest_user')}")
```

---

### 中確率の原因

#### 5. キャッシュの問題
**症状**: 古いクエリ結果がキャッシュされている

**対策**:
```bash
# Redisキャッシュをクリア
docker compose exec superset superset cache clear
```

---

#### 6. Token の署名不一致
**症状**: NestJS と Superset で異なる SECRET を使用

**確認方法**:
```bash
# NestJS側
echo $GUEST_TOKEN_JWT_SECRET

# Superset側
docker compose exec superset python -c "from superset import app; print(app.config['GUEST_TOKEN_JWT_SECRET'])"
```

---

#### 7. Jinja テンプレート処理のエラー
**症状**: RLS clause に Jinja エラーがある

**確認方法**: Superset のログで `TemplateError` を検索

---

### 低確率の原因

#### 8. データセットが仮想テーブル（Virtual Dataset）
**症状**: Virtual Datasetの場合、RLS適用が複雑

**対策**: Physical Tableで試す

---

#### 9. Dashboard の権限設定
**症状**: Dashboard自体にアクセス制限がある

**対策**: Embedded Dashboard設定で `Public` ロールに権限付与

---

## 🧪 デバッグ手順

### ステップ1: Guest Token の受信確認

**Supersetコンテナ内でログを追加**:

```python
# superset/security/manager.py:2592 の直後に追加
def get_guest_user_from_request(self, req: Request) -> Optional[GuestUser]:
    logger.info("=== Guest Token Request ===")
    logger.info(f"Headers: {dict(req.headers)}")

    raw_token = req.headers.get(
        current_app.config["GUEST_TOKEN_HEADER_NAME"]
    ) or req.form.get("guest_token")

    logger.info(f"Raw token: {raw_token[:50] if raw_token else None}...")
    # ... 以下続く
```

---

### ステップ2: RLS フィルター取得確認

```python
# superset/connectors/sqla/models.py:749 の直後に追加
if is_feature_enabled("EMBEDDED_SUPERSET"):
    guest_filters = security_manager.get_guest_rls_filters(self)
    logger.info(f"=== Guest RLS Filters ===")
    logger.info(f"Dataset: {self.id} ({self.table_name})")
    logger.info(f"Filters: {guest_filters}")

    for rule in guest_filters:
        clause = self.text(
            f"({template_processor.process_template(rule['clause'])})"
        )
        logger.info(f"Applied clause: {clause}")
        all_filters.append(clause)
```

---

### ステップ3: 最終SQL確認

```python
# superset/models/helpers.py:1928 の直後に追加
rls_filters = self.get_sqla_row_level_filters(template_processor)
logger.info(f"=== RLS Filters Applied ===")
logger.info(f"Count: {len(rls_filters)}")
logger.info(f"Clauses: {rls_filters}")
where_clause_and += rls_filters
```

---

### ステップ4: 実行されるSQLを確認

```bash
# Supersetのログでクエリ確認
docker compose logs -f superset | grep "SELECT.*FROM cleaned_sales_data"
```

期待される出力:
```sql
SELECT * FROM cleaned_sales_data WHERE (product_line = 'Ships')
```

---

## ✅ 検証チェックリスト

### 設定の確認
- [ ] `superset_config.py` で `EMBEDDED_SUPERSET: True`
- [ ] `superset_config.py` で `ROW_LEVEL_SECURITY: True`
- [ ] `GUEST_TOKEN_JWT_SECRET` が NestJS と Superset で一致
- [ ] `GUEST_TOKEN_JWT_ALGO` が "HS256"
- [ ] `GUEST_TOKEN_JWT_AUDIENCE` が "superset"
- [ ] `GUEST_ROLE_NAME` が "Public"

### CORS設定の確認
- [ ] `CORS_OPTIONS` で `origins` に Angular アプリのURLを追加
- [ ] `CORS_OPTIONS` で `supports_credentials: True`
- [ ] `CORS_OPTIONS` で `allow_headers` に `X-GuestToken` を追加（必要なら）

### Token の確認
- [ ] NestJS API が正しく Token を生成
- [ ] Token に `rls_rules` が含まれている
- [ ] Token に `type: "guest"` が含まれている
- [ ] Token の署名が正しい

### ネットワークの確認
- [ ] ブラウザの DevTools で `X-GuestToken` ヘッダーが送信されているか
- [ ] CORS エラーが発生していないか
- [ ] Token が途中で削除されていないか

### Superset の確認
- [ ] Dashboard が Embedded Dashboard として設定されている
- [ ] Dataset (Table) の `is_rls_supported` が True
- [ ] `Public` ロールが Dashboard にアクセス可能
- [ ] キャッシュがクリアされている

---

## 🎯 推奨される次のアクション

### 優先度1: ログ追加による原因特定

1. **Superset にログを追加**
   ```bash
   cd /Users/kazu/coding/nx-play/superset
   ```

2. **上記デバッグ手順のログを追加**
   - `manager.py:2592`
   - `models.py:749`
   - `helpers.py:1928`

3. **Superset を再起動**
   ```bash
   docker compose restart superset
   ```

4. **Angular アプリでダッシュボードを開く**

5. **ログを確認**
   ```bash
   docker compose logs -f superset | grep "==="
   ```

---

### 優先度2: CORS設定の修正

**`superset/docker/pythonpath_dev/superset_config.py`** に追加:

```python
CORS_OPTIONS = {
    "supports_credentials": True,
    "origins": ["http://localhost:4200"],
    "allow_headers": [
        "Content-Type",
        "X-GuestToken",  # ← 追加
    ],
}
```

---

### 優先度3: Embedded SDK の動作確認

**ブラウザの DevTools で確認**:
1. Network タブを開く
2. Angular アプリでダッシュボードを開く
3. Superset へのリクエストを確認
4. **Request Headers** に `X-GuestToken` があるか確認

なければ、Embedded SDK のバージョンや設定を確認。

---

### 優先度4: 最小テストケースの作成

**curl で直接テストする**:

```bash
# 1. NestJS で Token 取得
TOKEN=$(curl -X POST http://localhost:3000/api/superset/guest-token \
  -H "Content-Type: application/json" \
  -H "x-user-id: ships_sales" \
  -d '{"dashboardId":"26060ee1-386e-4695-bd27-86518236229f","username":"ships_sales"}' \
  | jq -r '.token')

echo "Token: $TOKEN"

# 2. Token を使って Superset API を直接呼ぶ
curl -X GET "http://localhost:8088/api/v1/chart/data" \
  -H "X-GuestToken: $TOKEN" \
  -H "Content-Type: application/json"
```

これで Superset が Token を認識しているか確認できる。

---

## 📊 コールスタック図

```
[Angular App]
    │
    │ embedDashboard()
    │
    ▼
[@superset-ui/embedded-sdk]
    │
    │ fetchGuestToken()
    │
    ▼
[NestJS API]
    │
    │ POST /api/superset/guest-token
    │ Returns: JWT with rls_rules
    │
    ▼
[Angular App]
    │
    │ Set X-GuestToken header
    │
    ▼
[Superset - LoginManager]
    │
    │ request_loader()
    ├─► is_feature_enabled("EMBEDDED_SUPERSET")? ──No──► Return None
    │                                             Yes
    ▼
[Superset - SecurityManager]
    │
    │ get_guest_user_from_request()
    ├─► Read X-GuestToken header ──None──► Return None
    │                               Found
    │ parse_jwt_guest_token()
    ├─► Decode JWT ──Invalid──► Return None
    │               Valid
    │ Check rls_rules claim ──Missing──► Raise Error
    │                         Present
    │ get_guest_user_from_token()
    │
    ▼
[GuestUser Object]
    │
    │ self.rls = token["rls_rules"]
    │
    ▼
[Flask Global: g.user]
    │
    │ g.user = GuestUser instance
    │
    ▼
[Query Processing]
    │
    │ get_sqla_row_level_filters()
    ├─► is_feature_enabled("EMBEDDED_SUPERSET")? ──No──► Skip guest RLS
    │                                             Yes
    │ get_guest_rls_filters()
    ├─► is g.user a GuestUser? ──No──► Return []
    │                           Yes
    │ Return user.rls filtered by dataset
    │
    ▼
[SQL Query Builder]
    │
    │ where_clause_and += RLS filters
    │
    ▼
[Final SQL]

    SELECT * FROM cleaned_sales_data WHERE (product_line = 'Ships')
```

---

## 📝 まとめ

### 実装状況
✅ **Superset 5.0 には Guest Token RLS の完全な実装が存在する**

### 動作条件
以下の全ての条件が満たされる必要がある:
1. `EMBEDDED_SUPERSET` フィーチャーフラグが有効
2. `ROW_LEVEL_SECURITY` フィーチャーフラグが有効
3. リクエストに `X-GuestToken` ヘッダーが含まれる
4. Token に `rls_rules` クレームが含まれる（空配列でもOK）
5. Token が正しく署名されている
6. Dataset が RLS をサポートしている

### 次のステップ
1. **ログ追加**によるデバッグ（最優先）
2. CORS 設定の確認・修正
3. Embedded SDK の動作確認
4. 最小テストケースでの検証

### 結論
実装に問題はない。**設定またはリクエストの問題**である可能性が高い。
