"""
POI (Points of Interest) service using OpenTripMap API
"""

import httpx
import math
from typing import List, Optional, Tuple
from app.config import settings


class POIService:
    """Service for fetching and managing Points of Interest along routes"""

    # Transport speeds in km/h
    TRANSPORT_SPEEDS = {
        "walking": 5,
        "cycling": 20,
        "driving": 80
    }

    OPENTRIPMAP_BASE_URL = "https://api.opentripmap.com/0.1/en/places"

    def __init__(self):
        self.api_key = settings.OPENTRIPMAP_API_KEY

    @staticmethod
    def calculate_search_radius(transport: str, time_limit_minutes: int) -> int:
        """
        Calculate search radius based on transport type and time limit

        Args:
            transport: Type of transport (walking, cycling, driving)
            time_limit_minutes: Maximum time limit in minutes

        Returns:
            Radius in meters
        """
        speed_kmh = POIService.TRANSPORT_SPEEDS.get(transport.lower(), 5)

        # Formula: speed_kmh × (time_limit_minutes × 0.3) / 60
        radius_km = speed_kmh * (time_limit_minutes * 0.3) / 60
        radius_meters = int(radius_km * 1000)

        # Limit radius to reasonable bounds (100m - 50km)
        radius_meters = max(100, min(radius_meters, 50000))

        return radius_meters

    @staticmethod
    def _calculate_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """
        Calculate distance between two points using Haversine formula

        Returns:
            Distance in kilometers
        """
        R = 6371  # Earth radius in km

        lat1_rad = math.radians(lat1)
        lat2_rad = math.radians(lat2)
        delta_lat = math.radians(lat2 - lat1)
        delta_lon = math.radians(lon2 - lon1)

        a = (math.sin(delta_lat / 2) ** 2 +
             math.cos(lat1_rad) * math.cos(lat2_rad) *
             math.sin(delta_lon / 2) ** 2)
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

        return R * c

    @staticmethod
    def _point_to_line_distance(
        point_lat: float, point_lon: float,
        line_start: Tuple[float, float],
        line_end: Tuple[float, float]
    ) -> float:
        """
        Calculate perpendicular distance from point to line segment

        Returns:
            Distance in kilometers
        """
        # Convert to approximate Cartesian coordinates (works for short distances)
        px, py = point_lon, point_lat
        x1, y1 = line_start[1], line_start[0]
        x2, y2 = line_end[1], line_end[0]

        # Calculate line segment length
        line_length_sq = (x2 - x1) ** 2 + (y2 - y1) ** 2

        if line_length_sq == 0:
            # Start and end are the same point
            return POIService._calculate_distance_km(point_lat, point_lon, line_start[0], line_start[1])

        # Calculate projection parameter
        t = max(0, min(1, ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / line_length_sq))

        # Find closest point on line segment
        closest_x = x1 + t * (x2 - x1)
        closest_y = y1 + t * (y2 - y1)

        # Calculate distance from point to closest point on line
        return POIService._calculate_distance_km(point_lat, point_lon, closest_y, closest_x)

    @staticmethod
    def calculate_detour_time(
        poi_lat: float,
        poi_lon: float,
        route_start: Tuple[float, float],
        route_end: Tuple[float, float],
        transport_speed_kmh: float
    ) -> int:
        """
        Calculate detour time to visit a POI

        Args:
            poi_lat: POI latitude
            poi_lon: POI longitude
            route_start: Tuple of (lat, lon) for route start
            route_end: Tuple of (lat, lon) for route end
            transport_speed_kmh: Speed of transport in km/h

        Returns:
            Detour time in minutes
        """
        # Calculate perpendicular distance from POI to route line
        distance_km = POIService._point_to_line_distance(
            poi_lat, poi_lon, route_start, route_end
        )

        # Time = (distance_km × 2 for round trip) / speed + 20 minutes visit time
        travel_time_minutes = (distance_km * 2 * 60) / transport_speed_kmh
        visit_time_minutes = 20

        total_time = int(travel_time_minutes + visit_time_minutes)

        return total_time

    @staticmethod
    def _sample_route_points(
        start_lat: float, start_lon: float,
        end_lat: float, end_lon: float,
        num_points: int = 6
    ) -> List[Tuple[float, float]]:
        """
        Sample points along a straight line from start to end

        Args:
            start_lat, start_lon: Start coordinates
            end_lat, end_lon: End coordinates
            num_points: Number of points to sample (default 6)

        Returns:
            List of (lat, lon) tuples
        """
        points = []

        for i in range(num_points):
            t = i / (num_points - 1) if num_points > 1 else 0
            lat = start_lat + t * (end_lat - start_lat)
            lon = start_lon + t * (end_lon - start_lon)
            points.append((lat, lon))

        return points

    async def get_pois_along_route(
        self,
        start_lat: float,
        start_lon: float,
        end_lat: float,
        end_lon: float,
        radius_meters: int,
        categories: Optional[List[str]] = None,
        min_rate: int = 2,
        transport: str = "driving"
    ) -> List[dict]:
        """
        Get POIs along a route using OpenTripMap API

        Args:
            start_lat, start_lon: Start coordinates
            end_lat, end_lon: End coordinates
            radius_meters: Search radius in meters
            categories: Optional list of POI categories (kinds)
            min_rate: Minimum rating (1-3, where 3 is highest)
            transport: Transport type for detour calculation

        Returns:
            List of POI dictionaries with detour time
        """
        # Sample points along the route
        sample_points = self._sample_route_points(start_lat, start_lon, end_lat, end_lon)

        # Storage for all POIs (use dict to remove duplicates by xid)
        all_pois = {}

        # Get transport speed for detour calculation
        transport_speed = self.TRANSPORT_SPEEDS.get(transport.lower(), 80)

        async with httpx.AsyncClient(timeout=10.0) as client:
            for lat, lon in sample_points:
                try:
                    # Build API request parameters
                    params = {
                        "lat": lat,
                        "lon": lon,
                        "radius": radius_meters,
                        "rate": min_rate,
                        "apikey": self.api_key,
                        "format": "json"
                    }

                    # Add categories filter if provided
                    if categories:
                        params["kinds"] = ",".join(categories)

                    # Make API request
                    response = await client.get(
                        f"{self.OPENTRIPMAP_BASE_URL}/radius",
                        params=params
                    )

                    if response.status_code == 200:
                        data = response.json()

                        # Process POIs
                        if isinstance(data, list):
                            for poi in data:
                                xid = poi.get("xid")
                                if xid and xid not in all_pois:
                                    # Calculate detour time
                                    detour_time = self.calculate_detour_time(
                                        poi.get("point", {}).get("lat", 0),
                                        poi.get("point", {}).get("lon", 0),
                                        (start_lat, start_lon),
                                        (end_lat, end_lon),
                                        transport_speed
                                    )

                                    # Add enriched POI data
                                    all_pois[xid] = {
                                        "xid": xid,
                                        "name": poi.get("name", "Unknown"),
                                        "kinds": poi.get("kinds", ""),
                                        "lat": poi.get("point", {}).get("lat", 0),
                                        "lon": poi.get("point", {}).get("lon", 0),
                                        "rate": poi.get("rate", 0),
                                        "detour_time": detour_time,
                                        "osm": poi.get("osm"),
                                        "wikidata": poi.get("wikidata")
                                    }

                except httpx.TimeoutException:
                    print(f"Timeout fetching POIs near ({lat}, {lon})")
                    continue
                except httpx.RequestError as e:
                    print(f"Error fetching POIs near ({lat}, {lon}): {e}")
                    continue
                except Exception as e:
                    print(f"Unexpected error processing POIs: {e}")
                    continue

        # Convert to list and sort by detour time
        poi_list = list(all_pois.values())
        poi_list.sort(key=lambda x: x["detour_time"])

        return poi_list

    async def get_poi_details(self, xid: str) -> Optional[dict]:
        """
        Get detailed information about a specific POI

        Args:
            xid: OpenTripMap place identifier

        Returns:
            Dictionary with detailed POI information or None
        """
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{self.OPENTRIPMAP_BASE_URL}/xid/{xid}",
                    params={"apikey": self.api_key}
                )

                if response.status_code == 200:
                    return response.json()
                else:
                    print(f"Failed to get POI details: {response.status_code}")
                    return None

        except Exception as e:
            print(f"Error fetching POI details: {e}")
            return None


# Global instance
poi_service = POIService()
