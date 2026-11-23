"""
Route schemas for travel planning
"""

import json

from pydantic import BaseModel, Field, model_validator, field_validator
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


class RouteStopFields(BaseModel):
    """What happens at a stop: pass through, visit, or stay overnight (with lodging)"""
    stop_type: str = Field("pass", pattern="^(pass|visit|overnight)$")
    nights: Optional[int] = Field(None, ge=1, le=60)
    lodging_name: Optional[str] = Field(None, max_length=200)
    lodging_url: Optional[str] = Field(None, max_length=1000)
    lodging_price: Optional[float] = Field(None, ge=0, le=1_000_000)
    lodging_currency: Optional[str] = Field(None, max_length=5)
    lodging_booked: Optional[bool] = None
    lodging_paid: Optional[bool] = None


class StopSpot(BaseModel):
    """A place picked for a stop ("Popular here", a traveller's own spot, or added by hand)"""
    name: str = Field(..., min_length=1, max_length=200)
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    source: Optional[str] = Field(None, max_length=20)      # wiki | community | mine | custom
    ref: Optional[str] = Field(None, max_length=50)         # Wikidata id / user place id
    url: Optional[str] = Field(None, max_length=1000, pattern=r"^https?://")
    note: Optional[str] = Field(None, max_length=500)
    cost: Optional[float] = Field(None, ge=0, le=1_000_000)  # tickets etc., for the budget
    currency: Optional[str] = Field(None, max_length=5)
    done: Optional[bool] = None
    detour_min: Optional[int] = Field(None, ge=0, le=1000)   # places on the way: minutes there and back


class RouteMoneyFields(BaseModel):
    """Budget & booking of the leg from this stop to the next one, and spots chosen at this stop"""
    leg_cost: Optional[float] = Field(None, ge=0, le=1_000_000)   # ticket / toll, total
    leg_currency: Optional[str] = Field(None, max_length=5)
    leg_booked: Optional[bool] = None
    leg_paid: Optional[bool] = None
    leg_ref: Optional[str] = Field(None, max_length=300)          # booking number or link
    spots: Optional[List[StopSpot]] = Field(None, max_length=50)
    leg_spots: Optional[List[StopSpot]] = Field(None, max_length=50)   # places on the way to the next stop


class TripExtra(BaseModel):
    """Any other trip cost: insurance, vignette, food budget..."""
    label: str = Field(..., min_length=1, max_length=120)
    amount: float = Field(..., ge=0, le=10_000_000)
    currency: str = Field("EUR", max_length=5)
    booked: Optional[bool] = None


class TripBudgetFields(BaseModel):
    fuel_l_per_100km: Optional[float] = Field(None, gt=0, le=60)
    fuel_price: Optional[float] = Field(None, gt=0, le=100_000)    # per litre
    fuel_currency: Optional[str] = Field(None, max_length=5)
    budget_currency: Optional[str] = Field(None, max_length=5)     # show totals in this currency
    extras: Optional[List[TripExtra]] = Field(None, max_length=100)
    car_id: Optional[int] = None
    fuel_settings: Optional[dict] = None    # refuel plan: start_pct, reserve_pct, end


def _json_list(v):
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return []
    return v


class RouteWaypointIn(RouteLocationPoint, RouteLegFields, RouteStopFields, RouteMoneyFields):
    """A stop on a multi-point route"""
    note: Optional[str] = Field(None, max_length=1000)


class RouteCreate(TripBudgetFields):
    """Schema for creating a new route.

    Either pass `waypoints` (2+ ordered stops) or the legacy pair
    `start_point` + `end_point`.
    """
    name: str = Field(..., min_length=1, max_length=200, description="Route name")
    description: Optional[str] = Field(None, max_length=1000, description="Route description")
    start_date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$", description="Trip start date")
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


class RouteUpdate(TripBudgetFields):
    """Schema for updating an existing route. `waypoints` replaces all stops."""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=1000)
    start_date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
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
    stop_type: Optional[str] = "pass"
    nights: Optional[int] = None
    lodging_name: Optional[str] = None
    lodging_url: Optional[str] = None
    lodging_price: Optional[float] = None
    lodging_currency: Optional[str] = None
    lodging_booked: Optional[bool] = None
    lodging_paid: Optional[bool] = None
    leg_cost: Optional[float] = None
    leg_currency: Optional[str] = None
    leg_booked: Optional[bool] = None
    leg_paid: Optional[bool] = None
    leg_ref: Optional[str] = None
    spots: Optional[List[dict]] = None
    leg_spots: Optional[List[dict]] = None

    _spots = field_validator("spots", "leg_spots", mode="before")(_json_list)

    class Config:
        from_attributes = True


class RouteResponse(BaseModel):
    """Schema for route data in responses"""
    id: int
    name: str
    description: Optional[str]
    start_date: Optional[str] = None
    start_name: str
    start_latitude: float
    start_longitude: float
    end_name: str
    end_latitude: float
    end_longitude: float
    user_id: int
    waypoints: List[RouteWaypointOut] = []
    fuel_l_per_100km: Optional[float] = None
    fuel_price: Optional[float] = None
    fuel_currency: Optional[str] = None
    budget_currency: Optional[str] = None
    extras: Optional[List[dict]] = None
    car_id: Optional[int] = None
    fuel_settings: Optional[dict] = None
    created_at: datetime

    _extras = field_validator("extras", mode="before")(_json_list)

    @field_validator("fuel_settings", mode="before")
    @classmethod
    def _fs(cls, v):
        if isinstance(v, str):
            try:
                return json.loads(v)
            except ValueError:
                return None
        return v
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
