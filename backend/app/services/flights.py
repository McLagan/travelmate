"""
Flights for flight legs via the public Kiwi.com MCP server (https://mcp.kiwi.com, no key).

Tool `search-flight` (documented schema): flyFrom / flyTo accept IATA codes, city or
airport names; departureDate is dd/mm/yyyy; each itinerary has price, priceFormatted,
totalDurationSeconds, bookingUrl and an `outbound` leg with route, stops, times, segments.
Stop names in other scripts (e.g. "Београд") are turned into English city names first.
"""

import re
import time
from datetime import date as _date
from typing import Dict, List, Optional
from urllib.parse import quote_plus

import httpx

from app.services.ferries import _mcp_call_tool, _ascii

KIWI_MCP_URL = "https://mcp.kiwi.com"
USER_AGENT = "TravelMate/0.1 (personal project)"
_cache: Dict[tuple, tuple] = {}
CACHE_TTL = 20 * 60


def _latin(s: str) -> bool:
    return bool(s) and all(ord(c) < 0x250 or not c.isalpha() for c in s)


async def english_place_name(name: str, lat: Optional[float], lon: Optional[float]) -> str:
    """City name usable by Kiwi: as given if Latin script, else Nominatim reverse in English."""
    base = name.split(",")[0].strip()
    if _latin(base):
        return _ascii(base) or base
    if lat is None or lon is None:
        return base
    try:
        async with httpx.AsyncClient(timeout=8.0, headers={"User-Agent": USER_AGENT}) as c:
            r = await c.get("https://nominatim.openstreetmap.org/reverse",
                            params={"lat": lat, "lon": lon, "format": "json", "zoom": 10,
                                    "addressdetails": 1, "accept-language": "en"})
        addr = r.json().get("address", {})
        city = next((addr[k] for k in ("city", "town", "village", "municipality", "county", "state") if addr.get(k)), None)
        return _ascii(city) if city else base
    except Exception:
        return base


def _hm(sec):
    if not sec:
        return None
    return round(sec / 3600, 1)


def fallback_links(a: str, b: str, d: str, codes: Optional[tuple] = None) -> List[dict]:
    links = [{"label": "Google Flights",
              "url": "https://www.google.com/travel/flights?q=" + quote_plus(f"Flights from {a} to {b} on {d}")}]
    if codes:
        o, t = codes
        y, m, dd = d.split("-")
        links.append({"label": "Skyscanner",
                      "url": f"https://www.skyscanner.net/transport/flights/{o.lower()}/{t.lower()}/{y[2:]}{m}{dd}/"})
        links.append({"label": "Aviasales", "url": f"https://www.aviasales.com/search/{o}{dd}{m}{t}1"})
    links.append({"label": "Kiwi.com", "url": "https://www.kiwi.com/"})
    return links


async def search_flights(from_name: str, to_name: str, date: str,
                         from_lat=None, from_lon=None, to_lat=None, to_lon=None,
                         adults: int = 1, flex_days: int = 0) -> dict:
    a = await english_place_name(from_name, from_lat, from_lon)
    b = await english_place_name(to_name, to_lat, to_lon)
    out = {"from": a, "to": b, "date": date, "options": [], "currency": None, "error": None,
           "source": "Kiwi.com MCP", "links": fallback_links(a, b, date)}
    try:
        if _date.fromisoformat(date) < _date.today():
            out["error"] = f"date {date} is in the past"
            return out
    except ValueError:
        out["error"] = "bad date"
        return out

    ck = (a.lower(), b.lower(), date, adults, flex_days)
    hit = _cache.get(ck)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]

    y, m, d = date.split("-")
    args = {"flyFrom": a, "flyTo": b, "departureDate": f"{d}/{m}/{y}", "adults": adults,
            "currency": "EUR", "locale": "en", "sort": "price"}
    if flex_days:
        args["departureDateFlexDays"] = flex_days
    try:
        data = await _mcp_call_tool("search-flight", args, url=KIWI_MCP_URL)
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {str(e)[:200]}"
        return out
    if not isinstance(data, dict):
        out["error"] = "unexpected answer"
        out["raw"] = str(data)[:3000]
        return out
    if data.get("error"):
        out["error"] = str(data["error"])[:200]
    out["currency"] = data.get("currency")

    codes = None
    for it in (data.get("itineraries") or [])[:15]:
        ob = it.get("outbound") or {}
        segs = ob.get("segments") or []
        carriers = list(dict.fromkeys(s.get("carrierName") or s.get("carrier") for s in segs if s.get("carrierName") or s.get("carrier")))
        route = ob.get("route") or []
        if not codes and ob.get("from") and ob.get("to"):
            codes = (ob["from"], ob["to"])
        out["options"].append({
            "id": it.get("id"),
            "departure": ob.get("departureTime"),
            "arrival": ob.get("arrivalTime"),
            "route": " → ".join(route) if route else f'{ob.get("from", "?")} → {ob.get("to", "?")}',
            "stops": ob.get("stops"),
            "hours": _hm(ob.get("durationSeconds") or it.get("totalDurationSeconds")),
            "carriers": carriers,
            "price": it.get("priceFormatted") or (f'{it.get("price")} {data.get("currency") or ""}'.strip() if it.get("price") is not None else None),
            "baggage": it.get("baggage"),
            "url": it.get("bookingUrl"),
        })
    out["links"] = fallback_links(a, b, date, codes)
    if not out["options"] and not out["error"]:
        out["raw"] = str(data)[:3000]
    _cache[ck] = (time.time(), out)
    return out
