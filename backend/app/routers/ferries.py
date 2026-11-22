"""Ferry sailings search (Ferryhopper MCP) for ferry legs of a route"""

from fastapi import APIRouter, Depends

from app.models.user import User
from app.schemas.route import FerrySearchRequest
from fastapi import HTTPException, Query

from app.services.ferries import search_sailings, booking_link
from app.utils.auth import get_current_user

router = APIRouter()


@router.post("/search")
async def ferry_search(req: FerrySearchRequest, current_user: User = Depends(get_current_user)):
    """Sailings between two ports on a date, with booking links. Errors are returned in `error`."""
    return await search_sailings(req.from_name, req.to_name, req.date)


@router.get("/link")
async def ferry_link(trip_id: str = Query(..., min_length=1, max_length=200),
                     current_user: User = Depends(get_current_user)):
    """Booking link for one sailing (via trip_details) when search results had none"""
    try:
        url = await booking_link(trip_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"{type(e).__name__}: {str(e)[:150]}")
    if not url:
        raise HTTPException(status_code=404, detail="No booking link")
    return {"url": url}
