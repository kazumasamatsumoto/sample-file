# Embedded SDK用の設定
FEATURE_FLAGS = {
    "ALERT_REPORTS": True,
    "EMBEDDED_SUPERSET": True,
    "ROW_LEVEL_SECURITY": True,
}

GUEST_TOKEN_JWT_SECRET = "your-random-secret-key-here"
GUEST_TOKEN_JWT_ALGO = "HS256"
GUEST_TOKEN_JWT_EXP_SECONDS = 300
GUEST_TOKEN_JWT_AUDIENCE = "superset"

GUEST_ROLE_NAME = "Public"

# 開発環境用: Talismanを無効化  
TALISMAN_ENABLED = False

# CORS設定
CORS_OPTIONS = {
    "supports_credentials": True,
    "origins": ["http://localhost:4200"],
}

# Session設定
SESSION_COOKIE_SAMESITE = "None"
SESSION_COOKIE_SECURE = False
