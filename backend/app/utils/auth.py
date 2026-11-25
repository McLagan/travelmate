"""
Authentication utilities: password hashing and policy, JWT tokens, current user, client IP
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import HTTPException, status, Depends, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.user import User

# Password hashing - support both bcrypt and pbkdf2_sha256 for compatibility
pwd_context = CryptContext(
    schemes=["bcrypt", "pbkdf2_sha256"],
    deprecated=["pbkdf2_sha256"]
)

# verified against when the email is unknown, so "no such user" takes as long as "wrong password"
_DUMMY_HASH = pwd_context.hash("timing-equaliser-not-a-real-password")

security = HTTPBearer()

PASSWORD_MIN = 10
PASSWORD_MAX_BYTES = 72   # bcrypt ignores everything after 72 bytes
_COMMON = {
    "1234567890", "12345678910", "0123456789", "qwertyuiop", "password12", "password123", "1q2w3e4r5t",
    "qwerty1234", "iloveyou12", "1111111111", "abcdefghij", "1234qwer!@", "qwerty12345", "passw0rd12",
    "zaq12wsxcde", "q1w2e3r4t5", "asdfghjkl1", "travelmate1", "travelmate",
}


def password_problem(password: str, email: str = "", name: str = "") -> Optional[str]:
    """Why the password is not acceptable, or None."""
    if len(password) < PASSWORD_MIN:
        return f"Password must be at least {PASSWORD_MIN} characters"
    if len(password.encode("utf-8")) > PASSWORD_MAX_BYTES:
        return "Password is too long (max 72 bytes)"
    if len(set(password)) < 4:
        return "Password is too simple"
    low = password.lower()
    if low in _COMMON:
        return "This password is too common"
    local = (email or "").split("@")[0].lower()
    if len(local) >= 4 and local in low:
        return "Password must not contain your email"
    if name and len(name.strip()) >= 4 and name.strip().lower() in low:
        return "Password must not contain your name"
    return None


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: Optional[str]) -> bool:
    """Constant-ish time: also burns a bcrypt round when there is no hash (unknown user)."""
    if not hashed_password:
        pwd_context.verify(plain_password, _DUMMY_HASH)
        return False
    try:
        return pwd_context.verify(plain_password, hashed_password)
    except (ValueError, TypeError):
        return False


def normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def find_user_by_email(db: Session, email: str) -> Optional[User]:
    """Case-insensitive: older accounts may have been stored with capitals."""
    return db.query(User).filter(func.lower(User.email) == normalize_email(email)).first()


def create_access_token(data: dict, expires_delta: timedelta = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=15))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm="HS256")


def token_for(user: User) -> str:
    """Session token: carries the user's token_version, so a password change logs out every other device."""
    return create_access_token({"sub": user.email, "ver": user.token_version or 0},
                               timedelta(hours=settings.ACCESS_TOKEN_EXPIRE_HOURS))


_UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Invalid authentication credentials",
    headers={"WWW-Authenticate": "Bearer"},
)


def verify_token(token: str) -> dict:
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
    except JWTError:
        raise _UNAUTHORIZED


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db)
) -> User:
    """Current user from the bearer token. Nothing about the token or the user is logged."""
    payload = verify_token(credentials.credentials)
    email = payload.get("sub")
    if not email:
        raise _UNAUTHORIZED
    user = db.query(User).filter(User.email == email).first()
    if user is None or not user.is_active:
        raise _UNAUTHORIZED
    if int(payload.get("ver", 0)) != (user.token_version or 0):
        raise _UNAUTHORIZED    # issued before the last password change / "log out everywhere"
    return user


def client_ip(request: Request) -> str:
    """Client IP for rate limits. X-Forwarded-For is trusted only behind our own proxy (it is trivial to fake)."""
    if settings.TRUST_PROXY_HEADERS:
        fwd = request.headers.get("X-Forwarded-For")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
