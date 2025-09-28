"""
Profile-related models for user personalization
"""

from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, Float, ForeignKey
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship

from app.database import Base


class VisitedCountry(Base):
    """Countries that user has visited"""
    __tablename__ = "visited_countries"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    country_code = Column(String(2), nullable=False)  # ISO 2-letter country code
    country_name = Column(String, nullable=False)
    visited_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationship
    user = relationship("User", back_populates="visited_countries")


class UserPlace(Base):
    """User-created tourist places"""
    __tablename__ = "user_places"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    # Place information
    name = Column(String, nullable=False)
    description = Column(Text)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    website = Column(String)  # Official website or source

    # Metadata
    category = Column(String)  # restaurant, attraction, hotel, etc.
    is_public = Column(Boolean, default=False)  # Will be used for moderation later
    is_approved = Column(Boolean, default=False)  # Admin approval status
    custom_fields = Column(Text)  # JSON string for custom fields

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    user = relationship("User", back_populates="user_places")
    images = relationship("PlaceImage", back_populates="place", cascade="all, delete-orphan")


class PlaceImage(Base):
    """Images for user places"""
    __tablename__ = "place_images"

    id = Column(Integer, primary_key=True, index=True)
    place_id = Column(Integer, ForeignKey("user_places.id"), nullable=False)
    image_url = Column(String, nullable=False)
    caption = Column(String)
    is_primary = Column(Boolean, default=False)  # Main image for the place

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationship
    place = relationship("UserPlace", back_populates="images")