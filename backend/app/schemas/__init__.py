"""
Schemas package
"""

from app.schemas.auth import UserRegister, UserLogin, Token, UserResponse
from app.schemas.location import LocationSearch, LocationResponse, LocationSearchResults
from app.schemas.profile import (
    UserProfileUpdate, UserProfileResponse,
    VisitedCountryCreate, VisitedCountryResponse,
    UserPlaceCreate, UserPlaceUpdate, UserPlaceResponse,
    PlaceImageCreate, PlaceImageResponse,
    ProfileSummaryResponse, CountryOption
)

__all__ = [
    "UserRegister", "UserLogin", "Token", "UserResponse",
    "LocationSearch", "LocationResponse", "LocationSearchResults",
    "UserProfileUpdate", "UserProfileResponse",
    "VisitedCountryCreate", "VisitedCountryResponse",
    "UserPlaceCreate", "UserPlaceUpdate", "UserPlaceResponse",
    "PlaceImageCreate", "PlaceImageResponse",
    "ProfileSummaryResponse", "CountryOption"
]