"""
Authentication schemas for requests and responses
"""

from pydantic import BaseModel, EmailStr
from typing import Optional


class UserRegister(BaseModel):
    """Schema for user registration"""
    name: str
    email: str  # Will add EmailStr validation later
    password: str


class UserLogin(BaseModel):
    """Schema for user login"""
    email: str
    password: str


class Token(BaseModel):
    """Schema for JWT token response"""
    access_token: str
    token_type: str = "bearer"


class UserResponse(BaseModel):
    """Schema for user data in responses (without password)"""
    id: int
    name: str
    email: str
    is_active: bool

    class Config:
        from_attributes = True  # Allows conversion from SQLAlchemy models