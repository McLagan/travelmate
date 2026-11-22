"""
Route schemas for travel planning
"""

from pydantic import BaseModel, Field, model_validator
from typing import Optional, List
from datetime import datetime


class RouteLocationPoint(BaseModel):
    """Schema for route point (start/end location)"""
    name: str = Field(..., description="Location name")
    latitude: float = Field(..., ge=-90, le=90, description="Latitude coordinate")
    longitude: float = Field(..., ge=-180, le=180, description="Longitude coordinate")


MAX_WAYPOINTS = 25  # public OSRM accepts more, but keep requests reasonable


class RouteLegFields(BaseModel):
    """How to travel from this stop to the next one"""
    leg_mode: str = Field("road", pattern="^(road|ferry|flight)$")
    leg_hours: Optional[float] = Field(None, gt=0, le=72, description="Ferry/flight time, hours")
    leg_date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$", description="Planned ferry date")


class RouteWaypointIn(RouteLocationPoint, RouteLegFields):
    """A stop on a multi-point route"""
    note: Optional[str] = Field(None, max_length=1000)


class RouteCreate(BaseModel):
    """Schema for creating a new route.

    Either pass `waypoints` (2+ ordered stops) or the legacy pair
    `start_point` + `end_point`.
    """
    name: str = Field(..., min_length=1, max_length=200, description="Route name")
    description: Optional[str] = Field(None, max_length=1000, description="Route description")
    waypoints: Optional[List[RouteWaypointIn]] = Field(
        None, min_length=2, max_length=MAX_WAYPOINTS, description="Ordered stops, first = start, last = finish"
    )
    start_point: Optional[RouteLocationPoint] = Field(None, description="Starting location (legacy)")
    end_point: Optional[RouteLocationPoint] = Field(None, description="Destination location (legacy)")

    @model_validator(mode="after")
    def _normalize_points(self):
        if not self.waypoints:
            if not (self.start_point and self.end_point):
                raise ValueError("Provide either 'waypoints' (2+) or both 'start_point' and 'end_point'")
            self.waypoints = [
                RouteWaypointIn(**self.start_point.model_dump()),
                RouteWaypointIn(**self.end_point.model_dump()),
            ]
        return self


class RouteUpdate(BaseModel):
    """Schema for updating an existing route. `waypoints` replaces all stops."""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=1000)
    waypoints: Optional[List[RouteWaypointIn]] = Field(None, min_length=2, max_length=MAX_WAYPOINTS)
    start_point: Optional[RouteLocationPoint] = None
    end_point: Optional[RouteLocationPoint] = None


class RouteWaypointOut(BaseModel):
    position: int
    name: str
    latitude: float
    longitude: float
    note: Optional[str] = None
    leg_mode: Optional[str] = "road"
    leg_hours: Optional[float] = None
    leg_date: Optional[str] = None

    class Config:
        from_attributes = True


class RouteResponse(BaseModel):
    """Schema for route data in responses"""
    id: int
    name: str
    description: Optional[str]
    start_name: str
    start_latitude: float
    start_longitude: float
    end_name: str
    end_latitude: float
    end_longitude: float
    user_id: int
    waypoints: List[RouteWaypointOut] = []
    created_at: datetime
    updated_at: Optional[datetime]

    class Config:
        from_attributes = True


class RouteList(BaseModel):
    """Schema for list of routes"""
    routes: List[RouteResponse]
    total: int
    page: int
    size: int


class RouteDistance(BaseModel):
    """Schema for route distance calculation"""
    distance_km: float = Field(..., description="Distance in kilometers")
    duration_minutes: Optional[int] = Field(None, description="Estimated travel time in minutes")
    route_type: str = Field(default="direct", description="Type of route calculation")

class RoutePlanRequest(BaseModel):
    """Calculate a road route through several ordered stops"""
    waypoints: List[RouteWaypointIn] = Field(..., min_length=2, max_length=MAX_WAYPOINTS)
    profile: str = Field("driving", pattern="^(driving|walking|cycling)$")


class RoutePlanLeg(BaseModel):
    from_index: int
    to_index: int
    from_name: str
    to_name: str
    distance_km: float
    duration_minutes: int
    mode: str = "road"
    hours_given: Optional[bool] = None


class RoutePlanResponse(BaseModel):
    profile: str
    distance_km: float
    duration_minutes: int
    legs: List[RoutePlanLeg]
    geometry: dict  # GeoJSON LineString, coordinates are [lon, lat]
    snapped_waypoints: List[List[float]] = []  # [lat, lon] of each stop snapped to the road network
    segments: List[dict] = []  # [{"mode": "road"|"ferry", "coordinates": [[lon, lat], ...]}]


class POISearchRequest(BaseModel):
    """Find interesting places along a multi-stop route"""
    waypoints: List[RouteWaypointIn] = Field(..., min_length=2, max_length=MAX_WAYPOINTS)
    profile: str = Field("driving", pattern="^(driving|walking|cycling)$")
    categories: List[str] = Field(default_factory=lambda: ["sights", "museums", "viewpoints", "nature"])
    max_detour_minutes: int = Field(30, ge=5, le=180)
    mode: str = Field("top", pattern="^(top|all)$")


class FerrySearchRequest(BaseModel):
    from_name: str = Field(..., min_length=2, max_length=120)
    to_name: str = Field(..., min_length=2, max_length=120)
    date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
