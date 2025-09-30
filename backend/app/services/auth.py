"""
Authentication service for user operations
"""

from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from fastapi import HTTPException, status

from app.models.user import User
from app.schemas.auth import UserRegister
from app.utils.auth import hash_password, verify_password


def create_user(db: Session, user_data: UserRegister) -> User:
    """Create new user in database"""
    try:
        hashed_password = hash_password(user_data.password)

        db_user = User(
            name=user_data.name,
            email=user_data.email,
            password_hash=hashed_password
        )

        db.add(db_user)
        db.commit()
        db.refresh(db_user)
        return db_user

    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="User with this email already exists"
        )


def authenticate_user(db: Session, email: str, password: str) -> User:
    """Authenticate user by email and password"""
    print(f"🔐 Login attempt: {email}")
    user = db.query(User).filter(User.email == email).first()

    if not user:
        print(f"❌ User not found")
        return None

    print(f"✅ User found, verifying password...")
    password_valid = verify_password(password, user.password_hash)
    print(f"🔓 Password valid: {password_valid}")

    if not password_valid:
        return None
    return user


def get_user_by_email(db: Session, email: str) -> User:
    """Get user by email"""
    return db.query(User).filter(User.email == email).first()