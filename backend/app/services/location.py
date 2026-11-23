"""
Location service for searching places via OpenStreetMap
"""

import asyncio
import math
import re

import httpx
from typing import List, Optional
from app.schemas.location import LocationResponse, LocationSearchResults


class LocationService:
    """Service for location operations"""

    def __init__(self):
        self.nominatim_url = "https://nominatim.openstreetmap.org"
        # Nominatim usage policy requires an identifying User-Agent
        self.headers = {"User-Agent": "TravelMate/0.1 (personal project)"}

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

    _rev_cache: dict = {}

    # administrative prefixes that hide the town name ("Δημοτική Ενότητα Θεσσαλονίκης" = municipal unit of Thessaloniki)
    _ADMIN_PREFIX = re.compile(r"^(Δημοτική Ενότητα|Δημοτική Κοινότητα|Δήμος|Municipal Unit of|Municipality of|"
                               r"Općina|Opština|Општина|Grad|Comune di|Gemeinde|Obec|Gmina|Kommune)\s+", re.I)

    _ADMIN_SUFFIX = re.compile(r"\s+(Municipal Unit|Municipality|Regional Unit|Municipal Community|District)$", re.I)

    def _clean(self, name: str) -> str:
        return self._ADMIN_SUFFIX.sub("", self._ADMIN_PREFIX.sub("", name or "")).strip()

    async def _town_name(self, client, lat, lon, lang, cc) -> Optional[str]:
        """Name of the town at this point in `lang`: English name of the place by coordinates, then a search
        for the settlement with that name nearby (its OSM object has the translations)."""
        try:
            await asyncio.sleep(1.0)  # Nominatim: 1 request per second
            en = await self._nominatim_reverse(client, lat, lon, 10, "en")
            en_name = self._clean((en or {}).get("name") or "")
            if not en_name:
                return None
            await asyncio.sleep(1.0)
            params = {"q": en_name, "format": "jsonv2", "limit": 5, "namedetails": 1, "featureType": "settlement",
                      "accept-language": f"{lang},en"}
            if cc:
                params["countrycodes"] = cc
            r = await client.get(f"{self.nominatim_url}/search", params=params, headers=self.headers, timeout=10.0)
            r.raise_for_status()
            best = None
            for x in r.json():
                d = math.dist((lat, lon * math.cos(math.radians(lat))),
                              (float(x["lat"]), float(x["lon"]) * math.cos(math.radians(lat)))) * 111
                if d <= 30 and (best is None or d < best[0]):
                    best = (d, x)
            if not best:
                return en_name if self._script_ok(en_name, lang) else None
            nd = best[1].get("namedetails") or {}
            for c in (nd.get(f"name:{lang}"), best[1].get("name"), nd.get("name:en"), en_name):
                if c and self._script_ok(c, lang):
                    return self._clean(c)
        except Exception as e:
            print(f"town name: {type(e).__name__}")
        return None

    @staticmethod
    def _script_ok(text: str, lang: str) -> bool:
        """Is the name readable for this language (no Greek/Arabic... letters for ru/en)?"""
        if lang in ("el",):
            return True
        foreign = re.search(r"[\u0370-\u03FF\u0590-\u06FF\u0E00-\u0E7F\u4E00-\u9FFF]", text or "")
        if foreign:
            return False
        if lang == "en" and re.search(r"[\u0400-\u04FF]", text or ""):
            return False
        return True

    async def _nominatim_reverse(self, client, lat, lon, zoom, lang, namedetails=False):
        params = {"lat": lat, "lon": lon, "format": "jsonv2", "zoom": zoom, "addressdetails": 1,
                  "accept-language": f"{lang},en" if lang else "en"}
        if namedetails:
            params["namedetails"] = 1
        r = await client.get(f"{self.nominatim_url}/reverse", params=params, headers=self.headers, timeout=10.0)
        r.raise_for_status()
        d = r.json()
        return None if not d or "error" in d else d

    async def reverse(self, lat: float, lon: float, lang: Optional[str] = None) -> Optional[dict]:
        """Short human-readable name for coordinates (town level), in `lang` when OpenStreetMap has it
        (ru: Салоники, en: Thessaloniki), otherwise English, otherwise the local name."""
        lang = (lang or "").lower()[:5] or None
        ck = (round(lat, 4), round(lon, 4), lang)
        if ck in self._rev_cache:
            return self._rev_cache[ck]
        try:
            async with httpx.AsyncClient() as client:
                data = await self._nominatim_reverse(client, lat, lon, 14, lang)
                if not data:
                    return None
                addr = data.get("address", {})
                short = next((addr[k] for k in ("city", "town", "village", "hamlet", "suburb", "municipality", "county", "state")
                              if addr.get(k)), None)
                country = addr.get("country")
                # admin-unit name or a script the user cannot read: find the town object itself by its English name
                if short and lang and (self._ADMIN_PREFIX.match(short) or self._ADMIN_SUFFIX.search(short)
                                       or not self._script_ok(short, lang)):
                    better = await self._town_name(client, lat, lon, lang, addr.get("country_code"))
                    if better:
                        short = better
                if short:
                    short = self._clean(short) or short
        except Exception as e:
            print(f"Reverse geocode error: {e}")
            return None
        name = ", ".join(x for x in (short, country) if x) or data.get("display_name", "")
        out = {"name": name, "short": short, "country": country, "display_name": data.get("display_name", ""),
               "latitude": lat, "longitude": lon, "lang": lang}
        self._rev_cache[ck] = out
        return out


# Global instance
location_service = LocationService()