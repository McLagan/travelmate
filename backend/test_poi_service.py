"""
Test script for POI Service
"""

import asyncio
from app.services.poi_service import POIService


async def test_poi_service():
    """Test POI service functionality"""

    poi_service = POIService()

    print("=" * 60)
    print("Testing POI Service")
    print("=" * 60)

    # Test 1: Calculate search radius
    print("\n1. Testing calculate_search_radius():")
    print("-" * 60)

    for transport in ["walking", "cycling", "driving"]:
        for time_limit in [30, 60, 120]:
            radius = poi_service.calculate_search_radius(transport, time_limit)
            print(f"{transport.capitalize():10} @ {time_limit:3} min -> {radius:6} meters ({radius/1000:.1f} km)")

    # Test 2: Get POIs along route
    print("\n2. Testing get_pois_along_route():")
    print("-" * 60)

    # Example: Kyiv to Lviv (partial route)
    start_lat, start_lon = 50.4501, 30.5234  # Kyiv
    end_lat, end_lon = 50.0755, 30.8025      # Nearby point

    radius = poi_service.calculate_search_radius("driving", 60)

    print(f"Route: ({start_lat}, {start_lon}) -> ({end_lat}, {end_lon})")
    print(f"Search radius: {radius} meters")
    print(f"Fetching POIs...\n")

    pois = await poi_service.get_pois_along_route(
        start_lat=start_lat,
        start_lon=start_lon,
        end_lat=end_lat,
        end_lon=end_lon,
        radius_meters=radius,
        min_rate=2,
        transport="driving"
    )

    print(f"Found {len(pois)} POIs:")
    print()

    for i, poi in enumerate(pois[:10], 1):  # Show first 10
        print(f"{i}. {poi['name']}")
        print(f"   Location: ({poi['lat']:.4f}, {poi['lon']:.4f})")
        print(f"   Categories: {poi['kinds']}")
        print(f"   Rating: {poi['rate']}")
        print(f"   Detour time: {poi['detour_time']} minutes")
        print()

    # Test 3: Get POI details
    if pois:
        print("\n3. Testing get_poi_details():")
        print("-" * 60)

        first_poi_xid = pois[0]["xid"]
        print(f"Fetching details for: {pois[0]['name']} (xid: {first_poi_xid})")
        print()

        details = await poi_service.get_poi_details(first_poi_xid)

        if details:
            print("Details retrieved:")
            print(f"  Name: {details.get('name', 'N/A')}")
            print(f"  Address: {details.get('address', {}).get('road', 'N/A')}")
            print(f"  Description: {details.get('wikipedia_extracts', {}).get('text', 'N/A')[:200]}...")
            print(f"  Image: {details.get('preview', {}).get('source', 'N/A')}")
        else:
            print("Could not fetch details")

    print("\n" + "=" * 60)
    print("Testing complete!")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(test_poi_service())
