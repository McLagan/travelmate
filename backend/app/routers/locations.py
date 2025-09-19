"""
Location routes for searching places
"""

from fastapi import APIRouter, Query, HTTPException
from app.schemas.location import LocationSearchResults
from app.services.location import location_service

router = APIRouter()


@router.get("/search", response_model=LocationSearchResults)
async def search_locations(
        query: str = Query(..., description="Search query for places"),
        limit: int = Query(5, ge=1, le=20, description="Maximum number of results")
):
    """
    Search for places using OpenStreetMap

    - **query**: Place name, address, or point of interest
    - **limit**: Number of results to return (1-20)
    """
    if not query.strip():
        raise HTTPException(status_code=400, detail="Query cannot be empty")

    results = await location_service.search_places(query, limit)
    return results


@router.get("/geocode")
async def geocode_address(
        address: str = Query(..., description="Address to geocode")
):
    """
    Convert address to coordinates
    """
    results = await location_service.search_places(address, limit=1)

    if not results.results:
        raise HTTPException(status_code=404, detail="Location not found")

    location = results.results[0]
    return {
        "address": address,
        "latitude": location.latitude,
        "longitude": location.longitude,
        "display_name": location.display_name
    }