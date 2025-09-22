"""
Database models package
"""

from app.models.user import User
from app.models.route import Route
from app.models.location import Location
from app.models.profile import VisitedCountry, UserPlace, PlaceImage

# Export all models
__all__ = ["User", "Route", "Location", "VisitedCountry", "UserPlace", "PlaceImage"]