"""
Build a multi-stop route where some legs are ferries.

Road legs that follow each other are routed in one OSRM call; a ferry leg is not
routed at all (public OSRM handles many ferry lines badly): it is drawn as a line
over the sea and its duration comes from the user (hours) or a default speed.
"""

import math
from typing import List, Optional, Sequence

from app.services.osrm import osrm_service

FERRY_DEFAULT_KMH = 30.0   # used only when the user did not enter hours
FLIGHT_DEFAULT_KMH = 750.0  # flight time only, without airport time


def _great_circle(a, b, steps):
    """Points along the great circle a->b (lat, lon in degrees) - flights look curved on the map."""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    v1 = (math.cos(la1) * math.cos(lo1), math.cos(la1) * math.sin(lo1), math.sin(la1))
    v2 = (math.cos(la2) * math.cos(lo2), math.cos(la2) * math.sin(lo2), math.sin(la2))
    dot = max(-1.0, min(1.0, sum(x * y for x, y in zip(v1, v2))))
    om = math.acos(dot)
    if om < 1e-9:
        return [a, b]
    pts = []
    for t in range(steps + 1):
        f = t / steps
        k1, k2 = math.sin((1 - f) * om) / math.sin(om), math.sin(f * om) / math.sin(om)
        x, y, z = (k1 * p + k2 * q for p, q in zip(v1, v2))
        pts.append((math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))))
    return pts


def _hav_km(a, b):
    r = 6371.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


async def build_route(points: Sequence[dict], profile: str) -> Optional[dict]:
    """
    points: [{"lat", "lon", "name", "leg_mode": "road"|"ferry", "leg_hours": float|None}, ...]
            leg_mode/leg_hours of point i describe the leg i -> i+1 (ignored on the last point).
    Returns {"segments": [{"mode", "coords": [(lat, lon)], "from_index", "to_index"}],
             "legs": [{"mode", "distance_km", "duration_min"}], "distance_km", "duration_min"}
    or None when a road part cannot be routed.
    """
    n = len(points)
    modes = [(points[i].get("leg_mode") or "road") for i in range(n - 1)]
    segments, legs = [], [None] * (n - 1)

    i = 0
    while i < n - 1:
        if modes[i] in ("ferry", "flight"):
            mode = modes[i]
            a, b = (points[i]["lat"], points[i]["lon"]), (points[i + 1]["lat"], points[i + 1]["lon"])
            km = _hav_km(a, b)
            hours = points[i].get("leg_hours")
            speed = FLIGHT_DEFAULT_KMH if mode == "flight" else FERRY_DEFAULT_KMH
            minutes = hours * 60 if hours else km / speed * 60
            if mode == "flight":
                coords = _great_circle(a, b, max(8, int(km // 50)))
            else:
                steps = max(2, int(km // 5))
                coords = [(a[0] + (b[0] - a[0]) * t / steps, a[1] + (b[1] - a[1]) * t / steps) for t in range(steps + 1)]
            segments.append({"mode": mode, "coords": coords, "from_index": i, "to_index": i + 1})
            legs[i] = {"mode": mode, "distance_km": km, "duration_min": minutes, "hours_given": bool(hours)}
            i += 1
            continue
        j = i
        while j < n - 1 and modes[j] not in ("ferry", "flight"):
            j += 1
        group = [(points[k]["lat"], points[k]["lon"]) for k in range(i, j + 1)]
        data = await osrm_service.get_multi_route(group, profile=profile)
        if not data:
            return None
        route = data["routes"][0]
        coords = [(c[1], c[0]) for c in route["geometry"]["coordinates"]]
        segments.append({"mode": "road", "coords": coords, "from_index": i, "to_index": j})
        for k, leg in enumerate(route.get("legs", [])):
            legs[i + k] = {"mode": "road", "distance_km": leg.get("distance", 0) / 1000,
                           "duration_min": leg.get("duration", 0) / 60}
        i = j

    if any(l is None for l in legs):
        return None
    return {
        "segments": segments,
        "legs": legs,
        "distance_km": sum(l["distance_km"] for l in legs),
        "duration_min": sum(l["duration_min"] for l in legs),
    }
