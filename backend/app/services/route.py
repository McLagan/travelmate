"""
Route service for travel planning operations
"""

import math
from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.models.route import Route
from app.schemas.route import RouteCreate, RouteUpdate, RouteResponse, RouteDistance
from app.schemas.osrm import ProcessedRoute, RouteWithNavigation, NavigationStep
from app.services.osrm import osrm_service


class RouteService:
    """Service for route operations"""

    def __init__(self, db: Session):
        self.db = db

    def create_route(self, route_data: RouteCreate, user_id: int) -> RouteResponse:
        """Create a new route"""
        db_route = Route(
            user_id=user_id,
            name=route_data.name,
            description=route_data.description,
            start_name=route_data.start_point.name,
            start_latitude=route_data.start_point.latitude,
            start_longitude=route_data.start_point.longitude,
            end_name=route_data.end_point.name,
            end_latitude=route_data.end_point.latitude,
            end_longitude=route_data.end_point.longitude,
        )

        self.db.add(db_route)
        self.db.commit()
        self.db.refresh(db_route)

        return RouteResponse.model_validate(db_route)

    def get_route(self, route_id: int, user_id: int) -> Optional[RouteResponse]:
        """Get a specific route by ID"""
        db_route = self.db.query(Route).filter(
            Route.id == route_id,
            Route.user_id == user_id
        ).first()

        if db_route:
            return RouteResponse.model_validate(db_route)
        return None

    def get_user_routes(
        self,
        user_id: int,
        skip: int = 0,
        limit: int = 100
    ) -> List[RouteResponse]:
        """Get all routes for a user with pagination"""
        db_routes = self.db.query(Route).filter(
            Route.user_id == user_id
        ).order_by(desc(Route.created_at)).offset(skip).limit(limit).all()

        return [RouteResponse.model_validate(route) for route in db_routes]

    def update_route(
        self,
        route_id: int,
        user_id: int,
        route_update: RouteUpdate
    ) -> Optional[RouteResponse]:
        """Update an existing route"""
        db_route = self.db.query(Route).filter(
            Route.id == route_id,
            Route.user_id == user_id
        ).first()

        if not db_route:
            return None

        # Update only provided fields
        update_data = route_update.model_dump(exclude_unset=True)

        if 'name' in update_data:
            db_route.name = update_data['name']
        if 'description' in update_data:
            db_route.description = update_data['description']
        if 'start_point' in update_data:
            start_point = update_data['start_point']
            db_route.start_name = start_point['name']
            db_route.start_latitude = start_point['latitude']
            db_route.start_longitude = start_point['longitude']
        if 'end_point' in update_data:
            end_point = update_data['end_point']
            db_route.end_name = end_point['name']
            db_route.end_latitude = end_point['latitude']
            db_route.end_longitude = end_point['longitude']

        self.db.commit()
        self.db.refresh(db_route)

        return RouteResponse.model_validate(db_route)

    def delete_route(self, route_id: int, user_id: int) -> bool:
        """Delete a route"""
        db_route = self.db.query(Route).filter(
            Route.id == route_id,
            Route.user_id == user_id
        ).first()

        if db_route:
            self.db.delete(db_route)
            self.db.commit()
            return True
        return False

    def calculate_distance(self, route_id: int, user_id: int) -> Optional[RouteDistance]:
        """Calculate distance between start and end points using Haversine formula"""
        db_route = self.db.query(Route).filter(
            Route.id == route_id,
            Route.user_id == user_id
        ).first()

        if not db_route:
            return None

        distance_km = self._haversine_distance(
            db_route.start_latitude,
            db_route.start_longitude,
            db_route.end_latitude,
            db_route.end_longitude
        )

        # Estimate travel time (assuming average speed of 80 km/h)
        duration_minutes = int((distance_km / 80) * 60) if distance_km > 0 else 0

        return RouteDistance(
            distance_km=round(distance_km, 2),
            duration_minutes=duration_minutes,
            route_type="direct"
        )

    def get_routes_count(self, user_id: int) -> int:
        """Get total count of user's routes"""
        return self.db.query(Route).filter(Route.user_id == user_id).count()

    async def get_real_route(
        self,
        start_lat: float,
        start_lon: float,
        end_lat: float,
        end_lon: float,
        profile: str = "driving"
    ) -> Optional[ProcessedRoute]:
        """
        Get real route using OSRM API with actual roads

        Args:
            start_lat: Starting latitude
            start_lon: Starting longitude
            end_lat: Ending latitude
            end_lon: Ending longitude
            profile: Transportation profile (driving, walking, cycling)

        Returns:
            Processed route with real road geometry
        """
        try:
            # Get route from OSRM
            osrm_response = await osrm_service.get_route(
                start_lat=start_lat,
                start_lon=start_lon,
                end_lat=end_lat,
                end_lon=end_lon,
                profile=profile,
                include_steps=True,
                include_geometry=True
            )

            if not osrm_response:
                return None

            # Extract route information with profile optimization
            route_info = osrm_service.extract_route_info(osrm_response, profile)

            return ProcessedRoute(
                distance_km=route_info.get("distance_km", 0),
                duration_minutes=route_info.get("duration_minutes", 0),
                geometry=route_info.get("geometry"),
                steps=route_info.get("steps", []),
                route_type="osrm",
                profile=profile
            )

        except Exception as e:
            print(f"Error getting real route: {e}")
            return None

    async def get_route_with_navigation(
        self,
        start_lat: float,
        start_lon: float,
        end_lat: float,
        end_lon: float,
        profile: str = "driving"
    ) -> Optional[RouteWithNavigation]:
        """
        Get route with detailed turn-by-turn navigation instructions
        """
        try:
            # Get route from OSRM
            osrm_response = await osrm_service.get_route(
                start_lat=start_lat,
                start_lon=start_lon,
                end_lat=end_lat,
                end_lon=end_lon,
                profile=profile,
                include_steps=True,
                include_geometry=True
            )

            if not osrm_response:
                return None

            # Extract basic route info with profile optimization
            route_info = osrm_service.extract_route_info(osrm_response, profile)

            processed_route = ProcessedRoute(
                distance_km=route_info.get("distance_km", 0),
                duration_minutes=route_info.get("duration_minutes", 0),
                geometry=route_info.get("geometry"),
                steps=route_info.get("steps", []),
                route_type="osrm",
                profile=profile
            )

            # Convert OSRM steps to navigation steps
            navigation_steps = []
            for step in route_info.get("steps", []):
                maneuver = step.get("maneuver", {})
                nav_step = NavigationStep(
                    instruction=self._generate_instruction(step),
                    distance=step.get("distance", 0),
                    duration=step.get("duration", 0),
                    maneuver_type=maneuver.get("type", "unknown"),
                    maneuver_modifier=maneuver.get("modifier"),
                    road_name=step.get("name", "")
                )
                navigation_steps.append(nav_step)

            return RouteWithNavigation(
                route_info=processed_route,
                navigation_steps=navigation_steps,
                total_steps=len(navigation_steps)
            )

        except Exception as e:
            print(f"Error getting route with navigation: {e}")
            return None

    def _generate_instruction(self, step: dict) -> str:
        """
        Generate human-readable instruction from OSRM step
        """
        maneuver = step.get("maneuver", {})
        maneuver_type = maneuver.get("type", "")
        modifier = maneuver.get("modifier", "")
        road_name = step.get("name", "")
        distance = step.get("distance", 0)

        # Basic instruction generation
        if maneuver_type == "depart":
            if road_name:
                return f"Start on {road_name}"
            return "Start your journey"
        elif maneuver_type == "arrive":
            return "Arrive at destination"
        elif maneuver_type == "turn":
            direction = "left" if modifier == "left" else "right" if modifier == "right" else ""
            if direction and road_name:
                return f"Turn {direction} onto {road_name}"
            elif direction:
                return f"Turn {direction}"
        elif maneuver_type == "continue":
            if road_name:
                return f"Continue on {road_name}"
            return "Continue straight"
        elif maneuver_type == "merge":
            return f"Merge onto {road_name}" if road_name else "Merge"
        elif maneuver_type == "roundabout":
            return f"Take the roundabout onto {road_name}" if road_name else "Take the roundabout"

        # Fallback
        return f"Continue for {int(distance)} meters"

    @staticmethod
    def _haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """
        Calculate the great circle distance between two points
        on the earth (specified in decimal degrees)
        Returns distance in kilometers
        """
        # Convert decimal degrees to radians
        lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])

        # Haversine formula
        dlat = lat2 - lat1
        dlon = lon2 - lon1
        a = math.sin(dlat/2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon/2)**2
        c = 2 * math.asin(math.sqrt(a))

        # Radius of earth in kilometers
        r = 6371

        return c * r