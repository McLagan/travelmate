"""
Authentication service: users, one-time link tokens (password reset, email verification)
"""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from fastapi import HTTPException, status

from app.models.user import User, AuthToken
from app.schemas.auth import UserRegister
from app.utils.auth import hash_password, verify_password, password_problem, find_user_by_email

RESET_MINUTES = 60
VERIFY_HOURS = 48


def _bad_request(detail: str):
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def check_password(password: str, email: str = "", name: str = ""):
    problem = password_problem(password, email, name)
    if problem:
        raise _bad_request(problem)


def create_user(db: Session, user_data: UserRegister) -> Optional[User]:
    """New user, or None when the email is taken (the caller answers the same way in both cases)."""
    check_password(user_data.password, user_data.email, user_data.name)
    hashed = hash_password(user_data.password)      # also for a taken email: same time either way
    if find_user_by_email(db, user_data.email):
        return None
    try:
        user = User(name=user_data.name, email=user_data.email, password_hash=hashed)
        db.add(user)
        db.commit()
        db.refresh(user)
        return user
    except IntegrityError:
        db.rollback()
        return None


def authenticate_user(db: Session, email: str, password: str) -> Optional[User]:
    """User for valid credentials, else None. Takes the same time whether the email exists or not."""
    user = find_user_by_email(db, email)
    ok = verify_password(password, user.password_hash if user else None)
    if not user or not ok or not user.is_active:
        return None
    return user


def get_user_by_email(db: Session, email: str) -> Optional[User]:
    return find_user_by_email(db, email)


# ---------- one-time link tokens ----------

def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _now():
    return datetime.now(timezone.utc)


def issue_token(db: Session, user: User, purpose: str) -> str:
    """New link token; older unused ones of the same purpose stop working. Only the hash is stored."""
    db.query(AuthToken).filter(AuthToken.user_id == user.id, AuthToken.purpose == purpose,
                               AuthToken.used_at.is_(None)).update({"used_at": _now()}, synchronize_session=False)
    token = secrets.token_urlsafe(32)
    ttl = timedelta(minutes=RESET_MINUTES) if purpose == "reset" else timedelta(hours=VERIFY_HOURS)
    db.add(AuthToken(user_id=user.id, purpose=purpose, token_hash=_hash(token), expires_at=_now() + ttl))
    db.commit()
    return token


def use_token(db: Session, token: str, purpose: str) -> User:
    """Validate and spend a link token; 400 with one generic message for unknown/expired/used."""
    row = db.query(AuthToken).filter(AuthToken.token_hash == _hash(token), AuthToken.purpose == purpose).first()
    expires = row.expires_at if row else None
    if expires is not None and expires.tzinfo is None:          # SQLite returns naive datetimes
        expires = expires.replace(tzinfo=timezone.utc)
    if not row or row.used_at is not None or expires < _now():
        raise _bad_request("This link is invalid or has expired. Request a new one.")
    user = db.query(User).filter(User.id == row.user_id).first()
    if not user or not user.is_active:
        raise _bad_request("This link is invalid or has expired. Request a new one.")
    row.used_at = _now()
    return user


def reset_password(db: Session, token: str, new_password: str) -> User:
    row_user = use_token(db, token, "reset")
    check_password(new_password, row_user.email, row_user.name)
    row_user.password_hash = hash_password(new_password)
    row_user.token_version = (row_user.token_version or 0) + 1   # every existing session is logged out
    row_user.email_verified = True                               # the link came to this inbox
    db.query(AuthToken).filter(AuthToken.user_id == row_user.id, AuthToken.purpose == "reset",
                               AuthToken.used_at.is_(None)).update({"used_at": _now()}, synchronize_session=False)
    db.commit()
    return row_user


def verify_email(db: Session, token: str) -> User:
    user = use_token(db, token, "verify")
    user.email_verified = True
    db.commit()
    return user


def change_password(db: Session, user: User, current: str, new: str) -> User:
    if not verify_password(current, user.password_hash):
        raise _bad_request("Current password is wrong")
    check_password(new, user.email, user.name)
    if verify_password(new, user.password_hash):
        raise _bad_request("The new password is the same as the old one")
    user.password_hash = hash_password(new)
    user.token_version = (user.token_version or 0) + 1
    db.commit()
    db.refresh(user)
    return user


def logout_everywhere(db: Session, user: User) -> User:
    user.token_version = (user.token_version or 0) + 1
    db.commit()
    db.refresh(user)
    return user
