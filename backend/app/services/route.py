"""
Route service for travel planning operations
"""

import json
import math
from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import desc, or_
from fastapi import HTTPException, status

from app.models.route import Route, RouteWaypoint, RouteMember
from app.models.user import User
from app.models.car import Car
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

    # ---- sharing / access ------------------------------------------------

    def _member_ids(self, user_id: int):
        return self.db.query(RouteMember.route_id).filter(RouteMember.user_id == user_id,
                                                          RouteMember.status == "accepted")

    def access(self, route_id: int, user_id: int):
        """(route, role) for this user: owner / editor / viewer; (None, None) when they have no access.
        A pending or declined invitation gives no access."""
        db_route = self.db.query(Route).filter(Route.id == route_id).first()
        if not db_route:
            return None, None
        if db_route.user_id == user_id:
            return db_route, "owner"
        m = self.db.query(RouteMember).filter(RouteMember.route_id == route_id, RouteMember.user_id == user_id,
                                              RouteMember.status == "accepted").first()
        return (db_route, m.role) if m else (None, None)

    def _decorate(self, response: RouteResponse, db_route: Route, role: Optional[str]) -> RouteResponse:
        response.my_role = role
        response.version = db_route.version or 1
        owner = db_route.user
        response.owner_name = owner.name if owner else None
        if db_route.updated_by:
            u = self.db.query(User).filter(User.id == db_route.updated_by).first()
            response.updated_by_name = u.name if u else None
        if role == "owner":
            response.shared_count = self.db.query(RouteMember).filter(
                RouteMember.route_id == db_route.id, RouteMember.status.in_(("accepted", "pending"))).count()
        if db_route.car_id:
            car = self.db.query(Car).filter(Car.id == db_route.car_id, Car.user_id == db_route.user_id).first()
            if car:
                response.car = {k: getattr(car, k) for k in ("id", "name", "make", "model", "year", "fuel_type",
                                                             "consumption", "tank_l")}
        return response

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
                          leg_date=p.get("leg_date"),
                          stop_type=p.get("stop_type") or "pass", nights=p.get("nights"),
                          lodging_name=p.get("lodging_name"), lodging_url=p.get("lodging_url"),
                          lodging_price=p.get("lodging_price"), lodging_currency=p.get("lodging_currency"),
                          lodging_booked=p.get("lodging_booked"), lodging_paid=p.get("lodging_paid"),
                          leg_cost=p.get("leg_cost"), leg_currency=p.get("leg_currency"),
                          leg_booked=p.get("leg_booked"), leg_paid=p.get("leg_paid"), leg_ref=p.get("leg_ref"),
                          spots=json.dumps(p["spots"], ensure_ascii=False) if p.get("spots") else None,
                          leg_spots=json.dumps(p["leg_spots"], ensure_ascii=False) if p.get("leg_spots") else None)
            for i, p in enumerate(points)
        ]
        first, last = points[0], points[-1]
        db_route.start_name, db_route.start_latitude, db_route.start_longitude = first["name"], first["latitude"], first["longitude"]
        db_route.end_name, db_route.end_latitude, db_route.end_longitude = last["name"], last["latitude"], last["longitude"]

    @staticmethod
    def _apply_budget(db_route: Route, data: dict) -> None:
        for f in ("fuel_l_per_100km", "fuel_price", "fuel_currency", "budget_currency", "car_id"):
            if f in data:
                setattr(db_route, f, data[f])
        if "fuel_settings" in data:
            fs = data["fuel_settings"]
            db_route.fuel_settings = json.dumps({k: fs[k] for k in ("start_pct", "reserve_pct", "end") if k in fs}) if fs else None
        if "extras" in data:
            db_route.extras = json.dumps(data["extras"], ensure_ascii=False) if data["extras"] else None

    # ---- CRUD ----------------------------------------------------------

    def create_route(self, route_data: RouteCreate, user_id: int) -> RouteResponse:
        """Create a new route with ordered waypoints"""
        db_route = Route(user_id=user_id, name=route_data.name, description=route_data.description,
                         start_date=route_data.start_date)
        self._apply_budget(db_route, route_data.model_dump(exclude_unset=True))
        self._apply_waypoints(db_route, route_data.waypoints)

        db_route.updated_by = user_id
        self.db.add(db_route)
        self.db.commit()
        self.db.refresh(db_route)

        return self._decorate(self._to_response(db_route), db_route, "owner")

    def get_route(self, route_id: int, user_id: int) -> Optional[RouteResponse]:
        """A route the user owns or was shared with (accepted)."""
        db_route, role = self.access(route_id, user_id)
        if db_route:
            return self._decorate(self._to_response(db_route), db_route, role)
        return None

    def get_user_routes(
        self,
        user_id: int,
        skip: int = 0,
        limit: int = 100
    ) -> List[RouteResponse]:
        """Own routes and routes shared with the user (accepted), newest first"""
        db_routes = self.db.query(Route).filter(
            or_(Route.user_id == user_id, Route.id.in_(self._member_ids(user_id)))
        ).order_by(desc(Route.created_at)).offset(skip).limit(limit).all()
        roles = {m.route_id: m.role for m in self.db.query(RouteMember).filter(
            RouteMember.user_id == user_id, RouteMember.status == "accepted")}
        return [self._decorate(self._to_response(r), r, "owner" if r.user_id == user_id else roles.get(r.id))
                for r in db_routes]

    def update_route(
        self,
        route_id: int,
        user_id: int,
        route_update: RouteUpdate
    ) -> Optional[RouteResponse]:
        """Update a route: owner or editor. A save based on an older version is refused with 409."""
        db_route, role = self.access(route_id, user_id)
        if not db_route:
            return None
        if role == "viewer":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="You can only view this trip - ask the owner for edit rights.")

        # Update only provided fields
        update_data = route_update.model_dump(exclude_unset=True)
        base = update_data.pop("version", None)
        if base is not None and base != (db_route.version or 1):
            who = self.db.query(User).filter(User.id == db_route.updated_by).first() if db_route.updated_by else None
            name = "You (in another tab)" if db_route.updated_by == user_id else (who.name if who else "Someone")
            raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                detail=f"{name} changed this trip meanwhile. Reload it to see the changes.")
        if role != "owner":
            update_data.pop("car_id", None)      # the car is the owner's

        if 'name' in update_data:
            db_route.name = update_data['name']
        if 'description' in update_data:
            db_route.description = update_data['description']
        if 'start_date' in update_data:
            db_route.start_date = update_data['start_date']
        self._apply_budget(db_route, update_data)
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

        db_route.version = (db_route.version or 1) + 1
        db_route.updated_by = user_id
        self.db.commit()
        self.db.refresh(db_route)

        return self._decorate(self._to_response(db_route), db_route, role)

    def delete_route(self, route_id: int, user_id: int) -> bool:
        """Delete a route: owner only (members leave the trip instead)"""
        db_route, role = self.access(route_id, user_id)
        if db_route and role != "owner":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="Only the owner can delete this trip. You can leave it instead.")

        if db_route:
            self.db.delete(db_route)
            self.db.commit()
            return True
        return False

    def calculate_distance(self, route_id: int, user_id: int) -> Optional[RouteDistance]:
        """Calculate distance between start and end points using Haversine formula"""
        db_route, _ = self.access(route_id, user_id)

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
        return self.db.query(Route).filter(
            or_(Route.user_id == user_id, Route.id.in_(self._member_ids(user_id)))).count()

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
