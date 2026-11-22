"""Flight search (Kiwi.com MCP) for flight legs of a route"""

from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.models.user import User
from app.services.flights import search_flights
from app.utils.auth import get_current_user

router = APIRouter()


class FlightSearchRequest(BaseModel):
    from_name: str = Field(..., min_length=2, max_length=120)
    to_name: str = Field(..., min_length=2, max_length=120)
    date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    from_lat: Optional[float] = None
    from_lon: Optional[float] = None
    to_lat: Optional[float] = None
    to_lon: Optional[float] = None
    adults: int = Field(1, ge=1, le=9)
    flex_days: int = Field(0, ge=0, le=3)


@router.post("/search")
async def flight_search(req: FlightSearchRequest, current_user: User = Depends(get_current_user)):
    """Flights between two places on a date with Kiwi.com booking links. Errors come back in `error`."""
    return await search_flights(req.from_name, req.to_name, req.date, req.from_lat, req.from_lon,
                                req.to_lat, req.to_lon, req.adults, req.flex_days)
