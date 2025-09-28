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


# Custom Field Schema
class CustomField(BaseModel):
    """Schema for custom field"""
    name: str
    value: str


# User Place Schemas
class UserPlaceCreate(BaseModel):
    """Schema for creating user place"""
    name: str
    description: Optional[str] = None
    latitude: float
    longitude: float
    category: Optional[str] = None
    website: Optional[str] = None
    is_public: bool = False
    customFields: Optional[List[CustomField]] = []
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
    website: Optional[str] = None
    is_public: bool
    is_approved: bool
    customFields: Optional[List[CustomField]] = []
    images: List[PlaceImageResponse] = []
    created_at: datetime
    updated_at: Optional[datetime] = None

    @classmethod
    def from_orm_with_custom_fields(cls, place):
        """Create response with custom fields parsed from JSON"""
        import json

        # Convert to dict first
        place_dict = {
            'id': place.id,
            'name': place.name,
            'description': place.description,
            'latitude': place.latitude,
            'longitude': place.longitude,
            'category': place.category,
            'website': place.website,
            'is_public': place.is_public,
            'is_approved': place.is_approved,
            'created_at': place.created_at,
            'updated_at': place.updated_at,
            'images': place.images,
            'customFields': []
        }

        # Parse custom fields
        if place.custom_fields:
            try:
                custom_fields_data = json.loads(place.custom_fields)
                place_dict['customFields'] = [CustomField(**field) for field in custom_fields_data]
            except (json.JSONDecodeError, TypeError):
                place_dict['customFields'] = []

        return cls(**place_dict)


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