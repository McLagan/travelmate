"""
Database models package
"""

from app.models.user import User
from app.models.route import Route, RouteWaypoint
from app.models.location import Location
from app.models.profile import VisitedCountry, UserPlace, PlaceImage

# Export all models
__all__ = ["User", "Route", "RouteWaypoint", "Location", "VisitedCountry", "UserPlace", "PlaceImage"]