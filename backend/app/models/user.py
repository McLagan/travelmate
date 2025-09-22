"""
User model for authentication and profiles
"""

from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    name = Column(String, nullable=False)
    password_hash = Column(String, nullable=False)
    is_active = Column(Boolean, default=True)

    # Profile information
    avatar_url = Column(String)  # URL to profile image
    bio = Column(Text)  # User bio/description

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    routes = relationship("Route", back_populates="user")
    visited_countries = relationship("VisitedCountry", back_populates="user")
    user_places = relationship("UserPlace", back_populates="user")