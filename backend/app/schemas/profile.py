"""
Pydantic schemas for profile-related operations
"""

from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, ConfigDict


# User Profile Schemas
class UserProfileUpdate(BaseModel):
    """Schema for updating user profile"""
    name: Optional[str] = None
    bio: Optional[str] = None
    avatar_url: Optional[str] = None


class UserProfileResponse(BaseModel):
    """Schema for user profile response"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    name: str
    bio: Optional[str] = None
    avatar_url: Optional[str] = None
    created_at: datetime


# Visited Country Schemas
class VisitedCountryCreate(BaseModel):
    """Schema for adding visited country"""
    country_code: str
    country_name: str


class VisitedCountryResponse(BaseModel):
    """Schema for visited country response"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    country_code: str
    country_name: str
    visited_at: datetime


# Place Image Schemas
class PlaceImageCreate(BaseModel):
    """Schema for creating place image"""
    image_url: str
    caption: Optional[str] = None
    is_primary: bool = False


class PlaceImageResponse(BaseModel):
    """Schema for place image response"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    image_url: str
    caption: Optional[str] = None
    is_primary: bool
    created_at: datetime


# User Place Schemas
class UserPlaceCreate(BaseModel):
    """Schema for creating user place"""
    name: str
    description: Optional[str] = None
    latitude: float
    longitude: float
    category: Optional[str] = None
    images: Optional[List[PlaceImageCreate]] = []


class UserPlaceUpdate(BaseModel):
    """Schema for updating user place"""
    name: Optional[str] = None
    description: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    category: Optional[str] = None


class UserPlaceResponse(BaseModel):
    """Schema for user place response"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: Optional[str] = None
    latitude: float
    longitude: float
    category: Optional[str] = None
    is_public: bool
    is_approved: bool
    created_at: datetime
    updated_at: Optional[datetime] = None
    images: List[PlaceImageResponse] = []


# Dashboard/Profile Summary Schemas
class ProfileSummaryResponse(BaseModel):
    """Schema for profile summary (dashboard)"""
    user: UserProfileResponse
    visited_countries: List[VisitedCountryResponse]
    user_places: List[UserPlaceResponse]
    total_routes: int
    total_places: int
    total_countries: int


# Countries list for frontend
class CountryOption(BaseModel):
    """Schema for country selection"""
    code: str
    name: str
    flag: str  # Unicode flag emoji