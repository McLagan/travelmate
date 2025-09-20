"""
Route schemas for travel planning
"""

from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime


class RouteLocationPoint(BaseModel):
    """Schema for route point (start/end location)"""
    name: str = Field(..., description="Location name")
    latitude: float = Field(..., ge=-90, le=90, description="Latitude coordinate")
    longitude: float = Field(..., ge=-180, le=180, description="Longitude coordinate")


class RouteCreate(BaseModel):
    """Schema for creating a new route"""
    name: str = Field(..., min_length=1, max_length=200, description="Route name")
    description: Optional[str] = Field(None, max_length=1000, description="Route description")
    start_point: RouteLocationPoint = Field(..., description="Starting location")
    end_point: RouteLocationPoint = Field(..., description="Destination location")


class RouteUpdate(BaseModel):
    """Schema for updating an existing route"""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = Field(None, max_length=1000)
    start_point: Optional[RouteLocationPoint] = None
    end_point: Optional[RouteLocationPoint] = None


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