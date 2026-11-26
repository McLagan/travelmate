"""
Routes API endpoints for travel planning
"""

import json
import math
from typing import Optional

from pydantic import BaseModel, Field

from sqlalchemy import or_
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from typing import List

from app.database import get_db
from app.schemas.route import (
    RouteCreate,
    RouteUpdate,
    RouteResponse,
    RouteList,
    RouteDistance,
    RoutePlanRequest,
    RoutePlanResponse,
    POISearchRequest,
)
from app.schemas.osrm import (
    RouteRequest,
    ProcessedRoute,
    RouteWithNavigation,
    RouteAlternatives
)
from app.services.route import RouteService, plan_multi_stop_route
from app.services.poi_service import POIService
from app.services.poi_search import find_pois_along_route, find_popular_near, CATEGORIES as POI_CATEGORIES
from app.models.profile import UserPlace
from app.utils.auth import get_current_user
from app.models.user import User

router = APIRouter()


def get_route_service(db: Session = Depends(get_db)) -> RouteService:
    """Get route service instance"""
    return RouteService(db)


@router.post("/", response_model=RouteResponse, status_code=status.HTTP_201_CREATED)
async def create_route(
    route_data: RouteCreate,
    route_service: RouteService = Depends(get_route_service),
    current_user: User = Depends(get_current_user)
):
    """
    Create a new travel route

    - **name**: Route name (required)
    - **description**: Optional description
    - **start_point**: Starting location with coordinates
    - **end_point**: Destination location with coordinates
    """
    try:
        route = route_service.create_route(route_data, current_user.id)
        return route
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to create route: {str(e)}"
        )


@router.get("/", response_model=RouteList)
async def get_routes(
    skip: int = Query(0, ge=0, description="Number of routes to skip"),
    limit: int = Query(100, ge=1, le=100, description="Maximum number of routes to return"),
    route_service: RouteService = Depends(get_route_service),
    current_user: User = Depends(get_current_user)
):
    """
    Get user's routes with pagination

    - **skip**: Number of routes to skip (for pagination)
    - **limit**: Maximum number of routes to return (1-100)
    """
    routes = route_service.get_user_routes(current_user.id, skip, limit)
    total = route_service.get_routes_count(current_user.id)

    return RouteList(
        routes=routes,
        total=total,
        page=skip // limit + 1,
        size=len(routes)
    )


# OSRM Real Route Endpoints - Must be before parametrized routes

@router.post("/plan", response_model=RoutePlanResponse)
async def plan_route(
    plan_request: RoutePlanRequest,
    current_user: User = Depends(get_current_user)
):
    """
    Calculate a road route through 2+ ordered stops.

    Returns total distance/time, per-leg breakdown and GeoJSON geometry.
    """
    result = await plan_multi_stop_route(plan_request)
    if not result:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Routing service returned no route for these points"
        )
    return result


@router.get("/pois/categories")
async def poi_categories(current_user: User = Depends(get_current_user)):
    """Category keys accepted by POST /routes/pois"""
    return [{"key": k, "label": v["label"]} for k, v in POI_CATEGORIES.items()]


@router.post("/pois")
async def pois_along_route(
    req: POISearchRequest,
    current_user: User = Depends(get_current_user)
):
    """
    Interesting places along the real road route through all stops.

    Sources: Geoapify, OpenTripMap (each only if its API key is set) and Wikipedia
    (notability signal). Every place has a score and the reasons behind it;
    `stats` shows how many candidates each step kept.
    """
    try:
        return await find_pois_along_route(
            [{"lat": p.latitude, "lon": p.longitude, "name": p.name,
              "leg_mode": p.leg_mode, "leg_hours": p.leg_hours} for p in req.waypoints],
            req.profile, req.categories, req.max_detour_minutes, req.mode,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))


@router.get("/popular")
async def popular_near_stop(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    radius_km: float = Query(6, ge=1, le=10),
    categories: str = Query("sights,museums,viewpoints,nature"),
    limit: int = Query(30, ge=5, le=60),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    "Popular here" for one stop: the most notable places around it (Wikipedia/Wikidata popularity,
    Geoapify, OpenTripMap) plus spots shared by travellers (public user places) and your own spots.
    """
    res = await find_popular_near(lat, lon, radius_km, [c.strip() for c in categories.split(",") if c.strip()], limit)

    # travellers' spots: public places of anyone + all of mine, inside the search box
    dlat = radius_km / 111.0
    dlon = radius_km / (111.0 * max(0.1, math.cos(math.radians(lat))))
    rows = (db.query(UserPlace)
            .filter(UserPlace.latitude.between(lat - dlat, lat + dlat),
                    UserPlace.longitude.between(lon - dlon, lon + dlon))
            .filter(or_(UserPlace.is_public.is_(True), UserPlace.user_id == current_user.id))
            .limit(100).all())
    community = []
    for p in rows:
        img = next((i.image_url for i in p.images if i.is_primary), p.images[0].image_url if p.images else None)
        community.append({
            "id": p.id, "name": p.name, "description": p.description, "lat": p.latitude, "lon": p.longitude,
            "category": p.category, "website": p.website, "photo": img,
            "mine": p.user_id == current_user.id, "is_public": bool(p.is_public), "is_approved": bool(p.is_approved),
            "distance_km": round(math.dist((lat, lon * math.cos(math.radians(lat))),
                                           (p.latitude, p.longitude * math.cos(math.radians(lat)))) * 111.0, 2),
        })
    community.sort(key=lambda x: x["distance_km"])
    res["community"] = community
    return res


class AIReviewRequest(BaseModel):
    trip: dict
    wishes: Optional[str] = Field(None, max_length=2000)


@router.post("/ai-review")
async def ai_review(req: AIReviewRequest, current_user: User = Depends(get_current_user)):
    """Review of the trip plan by Claude (needs ANTHROPIC_API_KEY in backend/.env)."""
    from app.services.ai_review import review_trip, AIReviewError
    if len(json.dumps(req.trip, ensure_ascii=False)) > 60_000:
        raise HTTPException(status_code=413, detail="Trip description too large")
    try:
        return await review_trip(req.trip, req.wishes)
    except AIReviewError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))


class AIEditRequest(BaseModel):
    trip: dict
    request: str = Field(..., min_length=3, max_length=6000)
    coords: List[List[float]] = Field(..., min_length=2, max_length=30)


@router.post("/ai-edit")
async def ai_edit(req: AIEditRequest, current_user: User = Depends(get_current_user)):
    """Claude proposes concrete changes to the plan; new stops/places are geocoded here."""
    from app.services.ai_edit import propose_edits
    from app.services.ai_review import AIReviewError
    if len(json.dumps(req.trip, ensure_ascii=False)) > 60_000:
        raise HTTPException(status_code=413, detail="Trip description too large")
    try:
        return await propose_edits(req.trip, req.request, req.coords)
    except AIReviewError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))


class BookingExtractRequest(BaseModel):
    text: Optional[str] = Field(None, max_length=30_000)
    file_b64: Optional[str] = Field(None, max_length=7_000_000)
    media_type: Optional[str] = Field(None, max_length=40)


@router.post("/booking-extract")
async def booking_extract(req: BookingExtractRequest, current_user: User = Depends(get_current_user)):
    """Booking confirmation (text / screenshot / PDF) -> fields for the trip. Nothing is stored."""
    from app.services.booking_extract import extract
    from app.services.ai_review import AIReviewError
    from app.utils.ratelimit import check_and_record
    check_and_record(f"booking-extract:{current_user.id}", 40, 24 * 3600)
    try:
        return await extract(req.text, req.file_b64, req.media_type)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except AIReviewError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))


_rates_cache: dict = {}


@router.get("/rates")
async def exchange_rates(
    base: str = Query("EUR", pattern="^[A-Z]{3}$"),
    current_user: User = Depends(get_current_user),
):
    """Daily exchange rates for the trip budget (open.er-api.com, free, no key; cached 12 h).
    `rates[X]` = how many X for 1 `base`."""
    import time
    import httpx
    hit = _rates_cache.get(base)
    if hit and time.time() - hit["fetched"] < 12 * 3600:
        return hit["data"]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(f"https://open.er-api.com/v6/latest/{base}")
            r.raise_for_status()
            j = r.json()
        if j.get("result") != "success":
            raise ValueError(j.get("error-type") or "bad answer")
        data = {"base": base, "rates": j.get("rates") or {}, "updated": j.get("time_last_update_utc"),
                "source": "open.er-api.com (ExchangeRate-API)"}
        _rates_cache[base] = {"fetched": time.time(), "data": data}
        return data
    except Exception as e:
        if hit:
            return {**hit["data"], "stale": True}
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Exchange rates unavailable: {type(e).__name__}")


@router.post("/real-route", response_model=ProcessedRoute)
async def get_real_route(
    route_request: RouteRequest,
    route_service: RouteService = Depends(get_route_service),
    current_user: User = Depends(get_current_user)
):
    """
    Get real route using OSRM with actual roads

    - **start_lat**: Starting latitude
    - **start_lon**: Starting longitude
    - **end_lat**: Ending latitude
    - **end_lon**: Ending longitude
    - **profile**: Transportation profile (driving, walking, cycling)
    """
    try:
        real_route = await route_service.get_real_route(
            start_lat=route_request.start_lat,
            start_lon=route_request.start_lon,
            end_lat=route_request.end_lat,
            end_lon=route_request.end_lon,
            profile=route_request.profile
        )

        if not real_route:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No route found between the specified points"
            )

        return real_route

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to calculate route: {str(e)}"
        )


@router.get("/real-route", response_model=ProcessedRoute)
async def get_real_route_get(
    start_lat: float = Query(..., ge=-90, le=90, description="Starting latitude"),
    start_lon: float = Query(..., ge=-180, le=180, description="Starting longitude"),
    end_lat: float = Query(..., ge=-90, le=90, description="Ending latitude"),
    end_lon: float = Query(..., ge=-180, le=180, description="Ending longitude"),
    profile: str = Query("driving", description="Transportation profile"),
    route_service: RouteService = Depends(get_route_service),
    current_user: User = Depends(get_current_user)
):
    """
    Get real route using OSRM with actual roads (GET version)
    """
    try:
        real_route = await route_service.get_real_route(
            start_lat=start_lat,
            start_lon=start_lon,
            end_lat=end_lat,
            end_lon=end_lon,
            profile=profile
        )

        if not real_route:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No route found between the specified points"
            )

        return real_route

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to calculate route: {str(e)}"
        )


@router.get("/navigation", response_model=RouteWithNavigation)
async def get_route_with_navigation_get(
    start_lat: float = Query(..., ge=-90, le=90, description="Starting latitude"),
    start_lon: float = Query(..., ge=-180, le=180, description="Starting longitude"),
    end_lat: float = Query(..., ge=-90, le=90, description="Ending latitude"),
    end_lon: float = Query(..., ge=-180, le=180, description="Ending longitude"),
    profile: str = Query("driving", description="Transportation profile"),
    route_service: RouteService = Depends(get_route_service),
    current_user: User = Depends(get_current_user)
):
    """
    Get route with detailed turn-by-turn navigation instructions
    """
    try:
        navigation_route = await route_service.get_route_with_navigation(
            start_lat=start_lat,
            start_lon=start_lon,
            end_lat=end_lat,
            end_lon=end_lon,
            profile=profile
        )

        if not navigation_route:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No route found between the specified points"
            )

        return navigation_route

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to get navigation route: {str(e)}"
        )


@router.get("/{route_id}", response_model=RouteResponse)
async def get_route(
    route_id: int,
    route_service: RouteService = Depends(get_route_service),
    current_user: User = Depends(get_current_user)
):
    """
    Get a specific route by ID

    - **route_id**: Unique identifier of the route
    """
    route = route_service.get_route(route_id, current_user.id)
    if not route:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Route not found"
        )
    return route


@router.put("/{route_id}", response_model=RouteResponse)
async def update_route(
    route_id: int,
    route_update: RouteUpdate,
    route_service: RouteService = Depends(get_route_service),
    current_user: User = Depends(get_current_user)
):
    """
    Update an existing route

    - **route_id**: Unique identifier of the route
    - **route_update**: Fields to update (only provided fields will be updated)
    """
    route = route_service.update_route(route_id, current_user.id, route_update)
    if not route:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Route not found"
        )
    return route


@router.delete("/{route_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_route(
    route_id: int,
    route_service: RouteService = Depends(get_route_service),
    current_user: User = Depends(get_current_user)
):
    """
    Delete a route

    - **route_id**: Unique identifier of the route to delete
    """
    success = route_service.delete_route(route_id, current_user.id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Route not found"
        )


@router.get("/distance/calculate", response_model=RouteDistance)
async def calculate_quick_distance(
    start_lat: float = Query(..., ge=-90, le=90, description="Start latitude"),
    start_lon: float = Query(..., ge=-180, le=180, description="Start longitude"),
    end_lat: float = Query(..., ge=-90, le=90, description="End latitude"),
    end_lon: float = Query(..., ge=-180, le=180, description="End longitude"),
):
    """
    Calculate distance between two points without creating a route

    - **start_lat**: Starting point latitude
    - **start_lon**: Starting point longitude
    - **end_lat**: End point latitude
    - **end_lon**: End point longitude
    """
    distance_km = RouteService._haversine_distance(start_lat, start_lon, end_lat, end_lon)
    duration_minutes = int((distance_km / 80) * 60) if distance_km > 0 else 0

    return RouteDistance(
        distance_km=round(distance_km, 2),
        duration_minutes=duration_minutes,
        route_type="direct"
    )


@router.get("/{route_id}/distance", response_model=RouteDistance)
async def calculate_route_distance(
    route_id: int,
    route_service: RouteService = Depends(get_route_service),
    current_user: User = Depends(get_current_user)
):
    """
    Calculate distance and estimated travel time for a route

    - **route_id**: Unique identifier of the route

    Returns direct distance using Haversine formula and estimated travel time.
    """
    distance_info = route_service.calculate_distance(route_id, current_user.id)
    if not distance_info:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Route not found"
        )
    return distance_info


@router.get("/explore-pois", response_model=List[dict])
async def explore_pois_along_route(
    start_lat: float = Query(..., ge=-90, le=90, description="Starting latitude"),
    start_lon: float = Query(..., ge=-180, le=180, description="Starting longitude"),
    end_lat: float = Query(..., ge=-90, le=90, description="Ending latitude"),
    end_lon: float = Query(..., ge=-180, le=180, description="Ending longitude"),
    transport: str = Query("driving", description="Transportation type (walking, cycling, driving)"),
    time_limit: int = Query(60, ge=1, le=300, description="Time limit in minutes for POI detours"),
    min_rate: int = Query(2, ge=1, le=3, description="Minimum POI rating (1-3, where 3 is highest)"),
    current_user: User = Depends(get_current_user)
):
    """
    Explore Points of Interest along a route

    - **start_lat**: Starting point latitude
    - **start_lon**: Starting point longitude
    - **end_lat**: End point latitude
    - **end_lon**: End point longitude
    - **transport**: Transportation type (walking, cycling, driving)
    - **time_limit**: Maximum time limit in minutes for detours (default: 60)
    - **min_rate**: Minimum POI rating 1-3 (default: 2)

    Returns list of POIs along the route sorted by detour time, including:
    - POI name, location, categories
    - Rating and estimated detour time
    - OpenStreetMap and Wikidata references
    """
    try:
        # Initialize POI service
        poi_service = POIService()

        # Calculate search radius based on transport and time limit
        radius_meters = POIService.calculate_search_radius(transport, time_limit)

        # Get POIs along route
        pois = await poi_service.get_pois_along_route(
            start_lat=start_lat,
            start_lon=start_lon,
            end_lat=end_lat,
            end_lon=end_lon,
            radius_meters=radius_meters,
            min_rate=min_rate,
            transport=transport
        )

        return pois

    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to fetch POIs: {str(e)}"
        )