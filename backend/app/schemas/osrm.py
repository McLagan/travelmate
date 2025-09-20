"""
OSRM response schemas
"""

from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any, Union


class OSRMCoordinate(BaseModel):
    """OSRM coordinate pair [longitude, latitude]"""
    longitude: float = Field(..., ge=-180, le=180)
    latitude: float = Field(..., ge=-90, le=90)


class OSRMManeuver(BaseModel):
    """OSRM turn maneuver information"""
    type: str = Field(..., description="Maneuver type (turn, depart, arrive, etc.)")
    modifier: Optional[str] = Field(None, description="Direction modifier (left, right, straight, etc.)")
    location: List[float] = Field(..., description="[longitude, latitude] of maneuver")
    bearing_before: Optional[int] = Field(None, description="Bearing before maneuver")
    bearing_after: Optional[int] = Field(None, description="Bearing after maneuver")
    instruction: Optional[str] = Field(None, description="Human-readable instruction")


class OSRMStep(BaseModel):
    """OSRM route step with turn-by-turn instructions"""
    distance: float = Field(..., description="Distance of step in meters")
    duration: float = Field(..., description="Duration of step in seconds")
    geometry: Optional[Dict[str, Any]] = Field(None, description="Step geometry in GeoJSON format")
    name: Optional[str] = Field(None, description="Name of the road/street")
    mode: str = Field(default="driving", description="Mode of transportation")
    maneuver: OSRMManeuver = Field(..., description="Maneuver information")
    intersections: Optional[List[Dict[str, Any]]] = Field(None, description="Intersection details")
    driving_side: Optional[str] = Field(None, description="Driving side (left/right)")


class OSRMLeg(BaseModel):
    """OSRM route leg between waypoints"""
    distance: float = Field(..., description="Distance of leg in meters")
    duration: float = Field(..., description="Duration of leg in seconds")
    steps: List[OSRMStep] = Field(default=[], description="Turn-by-turn steps")
    summary: Optional[str] = Field(None, description="Summary of the leg")


class OSRMRoute(BaseModel):
    """OSRM route information"""
    distance: float = Field(..., description="Total route distance in meters")
    duration: float = Field(..., description="Total route duration in seconds")
    geometry: Optional[Dict[str, Any]] = Field(None, description="Route geometry in GeoJSON format")
    legs: List[OSRMLeg] = Field(default=[], description="Route legs")
    weight: Optional[float] = Field(None, description="Route weight (OSRM-specific)")
    weight_name: Optional[str] = Field(None, description="Weight type")


class OSRMWaypoint(BaseModel):
    """OSRM waypoint information"""
    location: List[float] = Field(..., description="[longitude, latitude] of waypoint")
    name: Optional[str] = Field(None, description="Name of the location")
    hint: Optional[str] = Field(None, description="OSRM routing hint")
    distance: Optional[float] = Field(None, description="Distance from input coordinate")


class OSRMResponse(BaseModel):
    """Complete OSRM API response"""
    code: str = Field(..., description="Response code (Ok, NoRoute, etc.)")
    message: Optional[str] = Field(None, description="Error message if any")
    routes: List[OSRMRoute] = Field(default=[], description="Found routes")
    waypoints: List[OSRMWaypoint] = Field(default=[], description="Waypoint information")


class ProcessedRoute(BaseModel):
    """Processed route data for frontend consumption"""
    distance_km: float = Field(..., description="Distance in kilometers")
    duration_minutes: float = Field(..., description="Duration in minutes")
    geometry: Optional[Dict[str, Any]] = Field(None, description="Route geometry for map display")
    steps: List[Dict[str, Any]] = Field(default=[], description="Simplified turn-by-turn instructions")
    route_type: str = Field(default="osrm", description="Type of route calculation")
    profile: str = Field(default="driving", description="Transportation profile used")


class RouteRequest(BaseModel):
    """Request schema for route calculation"""
    start_lat: float = Field(..., ge=-90, le=90, description="Starting latitude")
    start_lon: float = Field(..., ge=-180, le=180, description="Starting longitude")
    end_lat: float = Field(..., ge=-90, le=90, description="Ending latitude")
    end_lon: float = Field(..., ge=-180, le=180, description="Ending longitude")
    profile: str = Field(default="driving", description="Transportation profile")
    include_steps: bool = Field(default=True, description="Include turn-by-turn instructions")
    include_alternatives: bool = Field(default=False, description="Include alternative routes")


class RouteAlternatives(BaseModel):
    """Multiple route options"""
    primary_route: ProcessedRoute = Field(..., description="Main/fastest route")
    alternatives: List[ProcessedRoute] = Field(default=[], description="Alternative routes")
    total_routes: int = Field(..., description="Total number of routes found")


class NavigationStep(BaseModel):
    """Simplified navigation step for frontend"""
    instruction: str = Field(..., description="Human-readable instruction")
    distance: float = Field(..., description="Distance for this step in meters")
    duration: float = Field(..., description="Time for this step in seconds")
    maneuver_type: str = Field(..., description="Type of maneuver")
    maneuver_modifier: Optional[str] = Field(None, description="Direction of maneuver")
    road_name: Optional[str] = Field(None, description="Name of the road")


class RouteWithNavigation(BaseModel):
    """Route with detailed navigation instructions"""
    route_info: ProcessedRoute = Field(..., description="Basic route information")
    navigation_steps: List[NavigationStep] = Field(..., description="Turn-by-turn navigation")
    total_steps: int = Field(..., description="Total number of navigation steps")