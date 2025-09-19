"""
Location service for searching places via OpenStreetMap
"""

import httpx
from typing import List, Optional
from app.schemas.location import LocationResponse, LocationSearchResults


class LocationService:
    """Service for location operations"""

    def __init__(self):
        self.nominatim_url = "https://nominatim.openstreetmap.org"
        self.headers = {}

    async def search_places(self, query: str, limit: int = 5) -> LocationSearchResults:
        print(f"=== SEARCH START: {query} ===")
        """Search for places using OpenStreetMap Nominatim API"""

        params = {
            "q": query,
            "format": "json",
            "limit": limit,
            "addressdetails": 1,
            "extratags": 1
        }

        async with httpx.AsyncClient() as client:
            try:
                print(f"Making request to OpenStreetMap...")
                response = await client.get(
                    f"{self.nominatim_url}/search",
                    params=params,
                    headers=self.headers,
                    timeout=10.0
                )
                print(f"Got response: {response.status_code}")
                response.raise_for_status()
                data = response.json()
                print(f"JSON data length: {len(data)}")

                # Convert OpenStreetMap data to our format
                results = []
                for item in data:
                    location = LocationResponse(
                        name=item.get("name", item.get("display_name", "Unknown")),
                        display_name=item.get("display_name", ""),
                        latitude=float(item.get("lat", 0)),
                        longitude=float(item.get("lon", 0)),
                        place_type=item.get("type", "unknown"),
                        osm_id=str(item.get("osm_id")) if item.get("osm_id") else None
                    )
                    results.append(location)

                return LocationSearchResults(
                    results=results,
                    query=query,
                    total_found=len(results)
                )

            except httpx.RequestError as e:
                # Return empty results on network error
                return LocationSearchResults(
                    results=[],
                    query=query,
                    total_found=0
                )
            except Exception as e:
                print(f"Network error: {e}")
                # Return empty results on any other error
                return LocationSearchResults(
                    results=[],
                    query=query,
                    total_found=0
                )


# Global instance
location_service = LocationService()