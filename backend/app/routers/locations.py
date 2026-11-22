"""
Location routes for searching places
"""

from fastapi import APIRouter, Query, HTTPException, Depends
from app.schemas.location import LocationSearchResults
from app.services.location import location_service
from app.utils.auth import get_current_user
from app.models.user import User

router = APIRouter()


@router.get("/search", response_model=LocationSearchResults)
async def search_locations(
        query: str = Query(..., description="Search query for places"),
        limit: int = Query(5, ge=1, le=20, description="Maximum number of results"),
        current_user: User = Depends(get_current_user)
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
        address: str = Query(..., description="Address to geocode"),
        current_user: User = Depends(get_current_user)
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


@router.get("/reverse")
async def reverse_geocode(
        lat: float = Query(..., ge=-90, le=90),
        lon: float = Query(..., ge=-180, le=180),
        current_user: User = Depends(get_current_user)
):
    """Coordinates -> short place name (used to label route stops picked on the map)"""
    result = await location_service.reverse(lat, lon)
    if not result:
        return {"name": f"{lat:.4f}, {lon:.4f}", "display_name": "", "latitude": lat, "longitude": lon}
    return result



@router.get("/wiki-summary")
async def wiki_summary_endpoint(
        lang: str = Query(..., min_length=2, max_length=12),
        title: str = Query(..., min_length=1, max_length=300),
        current_user: User = Depends(get_current_user)
):
    """Description and photo of a place from Wikipedia (used in the places panel)"""
    from app.services.poi_search import wiki_summary
    try:
        res = await wiki_summary(lang, title)
    except Exception as e:
        print(f"wiki summary error: {e}")
        res = None
    if not res:
        raise HTTPException(status_code=404, detail="No summary")
    return res
