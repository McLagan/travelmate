"""
Location schemas for search and responses
"""

from pydantic import BaseModel
from typing import Optional, List


class LocationSearch(BaseModel):
    """Schema for location search request"""
    query: str
    limit: Optional[int] = 5


class LocationResponse(BaseModel):
    """Schema for location data in responses"""
    name: str
    display_name: str
    latitude: float
    longitude: float
    place_type: str
    osm_id: Optional[str] = None

    class Config:
        from_attributes = True


class LocationSearchResults(BaseModel):
    """Schema for search results"""
    results: List[LocationResponse]
    query: str
    total_found: int