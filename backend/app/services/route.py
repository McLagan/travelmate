"""
Route service for travel planning operations
"""

import math
from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.models.route import Route, RouteWaypoint
from app.schemas.route import (
    RouteCreate, RouteUpdate, RouteResponse, RouteDistance,
    RouteWaypointOut, RoutePlanRequest, RoutePlanResponse, RoutePlanLeg,
)
from app.schemas.osrm import ProcessedRoute, RouteWithNavigation, NavigationStep
from app.services.osrm import osrm_service


class RouteService:
    """Service for route operations"""

    def __init__(self, db: Session):
        self.db = db

    # ---- helpers -------------------------------------------------------

    @staticmethod
    def _to_response(db_route: Route) -> RouteResponse:
        """Build response; routes saved before waypoints existed fall back to start/end."""
        response = RouteResponse.model_validate(db_route)
        if not response.waypoints:
            response.waypoints = [
                RouteWaypointOut(position=0, name=db_route.start_name,
                                 latitude=db_route.start_latitude, longitude=db_route.start_longitude),
                RouteWaypointOut(position=1, name=db_route.end_name,
                                 latitude=db_route.end_latitude, longitude=db_route.end_longitude),
            ]
        return response

    @staticmethod
    def _apply_waypoints(db_route: Route, waypoints) -> None:
        """Replace stops and keep legacy start/end columns in sync."""
        points = [w if isinstance(w, dict) else w.model_dump() for w in waypoints]
        db_route.waypoints = [
            RouteWaypoint(position=i, name=p["name"], latitude=p["latitude"],
                          longitude=p["longitude"], note=p.get("note"),
                          leg_mode=p.get("leg_mode") or "road", leg_hours=p.get("leg_hours"),
                          leg_date=p.get("leg_date"))
            for i, p in enumerate(points)
        ]
        first, last = points[0], points[-1]
        db_route.start_name, db_route.start_latitude, db_route.start_longitude = first["name"], first["latitude"], first["longitude"]
        db_route.end_name, db_route.end_latitude, db_route.end_longitude = last["name"], last["latitude"], last["longitude"]

    # ---- CRUD ----------------------------------------------------------

    def create_route(self, route_data: RouteCreate, user_id: int) -> RouteResponse:
        """Create a new route with ordered waypoints"""
        db_route = Route(user_id=user_id, name=route_data.name, description=route_data.description)
        self._apply_waypoints(db_route, route_data.waypoints)

        self.db.add(db_route)
        self.db.commit()
        self.db.refresh(db_route)

        return self._to_response(db_route)

    def get_route(self, route_id: int, user_id: int) -> Optional[RouteResponse]:
        """Get a specific route by ID"""
        db_route = self.db.query(Route).filter(
            Route.id == route_id,
            Route.user_id == user_id
        ).first()

        if db_route:
            return self._to_response(db_route)
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

        return [self._to_response(route) for route in db_routes]

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
        if update_data.get('waypoints'):
            self._apply_waypoints(db_route, update_data['waypoints'])
        else:
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
            if ('start_point' in update_data or 'end_point' in update_data) and db_route.waypoints:
                # legacy update on a multi-stop route: rewrite first/last stop only
                pts = [dict(name=w.name, latitude=w.latitude, longitude=w.longitude, note=w.note) for w in db_route.waypoints]
                pts[0].update(name=db_route.start_name, latitude=db_route.start_latitude, longitude=db_route.start_longitude)
                pts[-1].update(name=db_route.end_name, latitude=db_route.end_latitude, longitude=db_route.end_longitude)
                self._apply_waypoints(db_route, pts)

        self.db.commit()
        self.db.refresh(db_route)

        return self._to_response(db_route)

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

async def plan_multi_stop_route(request: RoutePlanRequest) -> Optional[RoutePlanResponse]:
    """Route through all stops in order; ferry legs are not road-routed (see route_builder)."""
    from app.services.route_builder import build_route

    pts = [{"lat": p.latitude, "lon": p.longitude, "name": p.name,
            "leg_mode": p.leg_mode, "leg_hours": p.leg_hours} for p in request.waypoints]
    built = await build_route(pts, request.profile)
    if not built:
        return None

    names = [p.name for p in request.waypoints]
    legs = [
        RoutePlanLeg(
            from_index=i, to_index=i + 1, from_name=names[i], to_name=names[i + 1],
            distance_km=round(l["distance_km"], 1), duration_minutes=round(l["duration_min"]),
            mode=l["mode"], hours_given=l.get("hours_given"),
        )
        for i, l in enumerate(built["legs"])
    ]
    all_coords = [[lon, lat] for seg in built["segments"] for lat, lon in seg["coords"]]
    return RoutePlanResponse(
        profile=request.profile,
        distance_km=round(built["distance_km"], 1),
        duration_minutes=round(built["duration_min"]),
        legs=legs,
        geometry={"type": "LineString", "coordinates": all_coords},
        segments=[{"mode": seg["mode"], "coordinates": [[lon, lat] for lat, lon in seg["coords"]]}
                  for seg in built["segments"]],
    )
