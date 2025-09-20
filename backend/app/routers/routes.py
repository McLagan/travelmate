"""
Routes API endpoints for travel planning
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from typing import List

from app.database import get_db
from app.schemas.route import (
    RouteCreate,
    RouteUpdate,
    RouteResponse,
    RouteList,
    RouteDistance
)
from app.schemas.osrm import (
    RouteRequest,
    ProcessedRoute,
    RouteWithNavigation,
    RouteAlternatives
)
from app.services.route import RouteService
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