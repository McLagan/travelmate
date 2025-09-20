"""
OSRM (Open Source Routing Machine) service for real road routing
"""

import httpx
from typing import List, Optional, Dict, Any
from app.config import settings


class OSRMService:
    """Service for OSRM routing operations"""

    def __init__(self):
        self.base_url = settings.OSRM_URL
        self.headers = {
            "User-Agent": "TravelMate/1.0"
        }

    async def get_route(
        self,
        start_lat: float,
        start_lon: float,
        end_lat: float,
        end_lon: float,
        profile: str = "driving",
        include_steps: bool = True,
        include_geometry: bool = True
    ) -> Optional[Dict[str, Any]]:
        """
        Get route from OSRM API

        Args:
            start_lat: Starting latitude
            start_lon: Starting longitude
            end_lat: End latitude
            end_lon: End longitude
            profile: Routing profile (driving, walking, cycling)
            include_steps: Include turn-by-turn instructions
            include_geometry: Include route geometry/polyline

        Returns:
            OSRM route response or None if error
        """

        # Format coordinates as required by OSRM: lon,lat;lon,lat
        coordinates = f"{start_lon},{start_lat};{end_lon},{end_lat}"

        # Build URL
        url = f"{self.base_url}/route/v1/{profile}/{coordinates}"

        # Build parameters - get alternatives for better route selection
        params = {
            "overview": "full" if include_geometry else "false",
            "geometries": "geojson",
            "steps": "true" if include_steps else "false",
            "alternatives": "true"  # Request alternative routes (public OSRM doesn't support number_of_alternatives parameter)
        }

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                print(f"OSRM Request: {url}")
                print(f"OSRM Params: {params}")

                response = await client.get(
                    url,
                    params=params,
                    headers=self.headers
                )

                print(f"OSRM Response Status: {response.status_code}")

                if response.status_code == 200:
                    data = response.json()
                    print(f"OSRM Response Code: {data.get('code')}")

                    if data.get("code") == "Ok":
                        return data
                    else:
                        print(f"OSRM Error: {data.get('message', 'Unknown error')}")
                        return None
                else:
                    print(f"OSRM HTTP Error: {response.status_code}")
                    return None

        except httpx.TimeoutException:
            print("OSRM API timeout")
            return None
        except httpx.RequestError as e:
            print(f"OSRM API request error: {e}")
            return None
        except Exception as e:
            print(f"OSRM API unexpected error: {e}")
            return None

    async def get_route_alternatives(
        self,
        start_lat: float,
        start_lon: float,
        end_lat: float,
        end_lon: float,
        profile: str = "driving",
        max_alternatives: int = 2
    ) -> Optional[Dict[str, Any]]:
        """
        Get route with alternatives from OSRM API
        """
        coordinates = f"{start_lon},{start_lat};{end_lon},{end_lat}"
        url = f"{self.base_url}/route/v1/{profile}/{coordinates}"

        params = {
            "overview": "full",
            "geometries": "geojson",
            "steps": "true",
            "alternatives": "true"
            # Note: public OSRM doesn't support number_of_alternatives parameter
        }

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.get(
                    url,
                    params=params,
                    headers=self.headers
                )

                if response.status_code == 200:
                    data = response.json()
                    if data.get("code") == "Ok":
                        return data

                return None

        except Exception as e:
            print(f"OSRM alternatives error: {e}")
            return None

    async def get_table(
        self,
        coordinates: List[tuple],
        profile: str = "driving"
    ) -> Optional[Dict[str, Any]]:
        """
        Get distance/duration matrix between multiple points

        Args:
            coordinates: List of (lat, lon) tuples
            profile: Routing profile

        Returns:
            OSRM table response with distance/duration matrices
        """
        if len(coordinates) < 2:
            return None

        # Format coordinates for OSRM: lon,lat;lon,lat;...
        coord_str = ";".join([f"{lon},{lat}" for lat, lon in coordinates])
        url = f"{self.base_url}/table/v1/{profile}/{coord_str}"

        params = {
            "annotations": "duration,distance"
        }

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.get(
                    url,
                    params=params,
                    headers=self.headers
                )

                if response.status_code == 200:
                    data = response.json()
                    if data.get("code") == "Ok":
                        return data

                return None

        except Exception as e:
            print(f"OSRM table error: {e}")
            return None

    @staticmethod
    def decode_polyline(encoded: str) -> List[List[float]]:
        """
        Decode OSRM polyline geometry to coordinates
        Note: OSRM returns GeoJSON format when geometries=geojson is used
        """
        # This method is kept for compatibility, but OSRM with geometries=geojson
        # returns coordinates directly in GeoJSON format
        return []

    @staticmethod
    def select_optimal_route(routes: List[Dict[str, Any]], profile: str) -> Dict[str, Any]:
        """
        Select optimal route based on transportation profile

        Args:
            routes: List of route options from OSRM
            profile: Transportation profile (driving, walking, cycling)

        Returns:
            The most optimal route for the given profile
        """
        if not routes:
            return {}

        if len(routes) == 1:
            return routes[0]

        # Different optimization strategies based on profile
        if profile == "driving":
            # For driving: prioritize fastest route (shortest duration)
            optimal_route = min(routes, key=lambda r: r.get("duration", float('inf')))

        elif profile == "cycling":
            # For cycling: balance between time and safety
            # Prefer routes that are not much longer but potentially safer
            # Weight: 70% time, 30% distance penalty for very long routes
            def cycling_score(route):
                duration = route.get("duration", float('inf'))
                distance = route.get("distance", float('inf'))
                # Penalize very long routes (more than 20% longer than shortest)
                min_distance = min(r.get("distance", float('inf')) for r in routes)
                distance_penalty = max(0, (distance - min_distance * 1.2) / min_distance) * 0.3
                return duration * (1 + distance_penalty)

            optimal_route = min(routes, key=cycling_score)

        elif profile == "walking":
            # For walking: prioritize shortest distance
            optimal_route = min(routes, key=lambda r: r.get("distance", float('inf')))

        else:
            # Default: fastest route
            optimal_route = min(routes, key=lambda r: r.get("duration", float('inf')))

        return optimal_route

    @staticmethod
    def extract_route_info(osrm_response: Dict[str, Any], profile: str = "driving") -> Dict[str, Any]:
        """
        Extract key route information from OSRM response with optimal route selection

        Args:
            osrm_response: OSRM API response
            profile: Transportation profile for route optimization

        Returns:
            Dict with distance_km, duration_minutes, geometry, steps
        """
        if not osrm_response or not osrm_response.get("routes"):
            return {}

        routes = osrm_response["routes"]

        # Select optimal route based on profile
        optimal_route = OSRMService.select_optimal_route(routes, profile)

        if not optimal_route:
            return {}

        return {
            "distance_km": round(optimal_route.get("distance", 0) / 1000, 2),
            "duration_minutes": round(optimal_route.get("duration", 0) / 60, 1),
            "geometry": optimal_route.get("geometry"),
            "steps": optimal_route.get("legs", [{}])[0].get("steps", []) if optimal_route.get("legs") else [],
            "waypoints": osrm_response.get("waypoints", []),
            "route_count": len(routes),
            "optimization": f"Optimized for {profile}"
        }


# Global instance
osrm_service = OSRMService()