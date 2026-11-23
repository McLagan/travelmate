"""
Weather for a stop on the day of arrival (Open-Meteo: free for non-commercial use, no key, CC BY 4.0 -
"Weather data by Open-Meteo.com" must be shown next to the data).

- date within 16 days: real forecast (Forecast API)
- later: "usual for these days" from the last 10 complete years (Archive API, one request per point),
  dates +-3 days around the same day of the year
- sea surface temperature for coastal stops (Marine API): forecast within ~7 days, otherwise the
  average of the same dates in past years (archive from 2022). A stop counts as coastal if the
  nearest sea cell of the marine model is within 20 km.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import math
import time
from typing import Dict, List, Optional, Tuple

import httpx

UA = "TravelMate/0.1 (https://github.com/McLagan/travelmate; personal trip planner)"
ATTRIBUTION = {"text": "Weather data by Open-Meteo.com", "url": "https://open-meteo.com/"}
_cache: Dict[tuple, Tuple[float, object]] = {}
_sem = asyncio.Semaphore(4)


def _get(key, ttl):
    hit = _cache.get(key)
    return hit[1] if hit and time.time() - hit[0] < ttl else None


def _put(key, val):
    _cache[key] = (time.time(), val)
    return val


def sky(code: Optional[int]) -> Tuple[str, str]:
    """WMO weather code -> (icon, label)."""
    if code is None:
        return "·", "unknown"
    c = int(code)
    if c == 0:
        return "☀️", "sunny"
    if c == 1:
        return "🌤", "mostly sunny"
    if c == 2:
        return "⛅", "partly cloudy"
    if c == 3:
        return "☁️", "cloudy"
    if c in (45, 48):
        return "🌫", "fog"
    if 51 <= c <= 57:
        return "🌦", "drizzle"
    if 61 <= c <= 67 or 80 <= c <= 82:
        return "🌧", "rain"
    if 71 <= c <= 77 or 85 <= c <= 86:
        return "🌨", "snow"
    if c >= 95:
        return "⛈", "thunderstorm"
    return "·", "unknown"


async def _json(client, url, params):
    async with _sem:
        for attempt in (1, 2):
            r = await client.get(url, params=params)
            if r.status_code == 429 and attempt == 1:
                await asyncio.sleep(2)
                continue
            r.raise_for_status()
            return r.json()


def _km(a_lat, a_lon, b_lat, b_lon):
    p = math.pi / 180
    h = (math.sin((b_lat - a_lat) * p / 2) ** 2 +
         math.cos(a_lat * p) * math.cos(b_lat * p) * math.sin((b_lon - a_lon) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(h))


async def _forecast(client, lat, lon, day: dt.date) -> Optional[dict]:
    key = ("fc", round(lat, 2), round(lon, 2), day.isoformat())
    if (hit := _get(key, 3 * 3600)) is not None:
        return hit
    j = await _json(client, "https://api.open-meteo.com/v1/forecast", {
        "latitude": lat, "longitude": lon, "timezone": "auto", "start_date": day.isoformat(), "end_date": day.isoformat(),
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"})
    d = j.get("daily") or {}
    if not d.get("time"):
        return None
    icon, label = sky(d["weather_code"][0])
    return _put(key, {"mode": "forecast", "tmax": d["temperature_2m_max"][0], "tmin": d["temperature_2m_min"][0],
                      "rain_prob": d.get("precipitation_probability_max", [None])[0], "icon": icon, "sky": label})


async def _archive_daily(client, lat, lon) -> Optional[dict]:
    """10 complete years of daily data for the point (one request, cached for a day)."""
    key = ("arch", round(lat, 1), round(lon, 1))
    if (hit := _get(key, 24 * 3600)) is not None:
        return hit
    last = dt.date.today().year - 1
    j = await _json(client, "https://archive-api.open-meteo.com/v1/archive", {
        "latitude": lat, "longitude": lon, "timezone": "auto",
        "start_date": f"{last - 9}-01-01", "end_date": f"{last}-12-31",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum"})
    return _put(key, j.get("daily") or {})


async def _climate(client, lat, lon, day: dt.date) -> Optional[dict]:
    d = await _archive_daily(client, lat, lon)
    if not d or not d.get("time"):
        return None
    target = day.timetuple().tm_yday
    tmax, tmin, rainy, n, codes = [], [], 0, 0, {}
    for k, t in enumerate(d["time"]):
        yd = dt.date.fromisoformat(t).timetuple().tm_yday
        if min(abs(yd - target), 366 - abs(yd - target)) > 3:
            continue
        if d["temperature_2m_max"][k] is None:
            continue
        n += 1
        tmax.append(d["temperature_2m_max"][k])
        tmin.append(d["temperature_2m_min"][k])
        if (d["precipitation_sum"][k] or 0) >= 1:
            rainy += 1
        lbl = sky(d["weather_code"][k])
        codes[lbl] = codes.get(lbl, 0) + 1
    if not n:
        return None
    icon, label = max(codes.items(), key=lambda kv: kv[1])[0]
    return {"mode": "climate", "tmax": round(sum(tmax) / n, 1), "tmin": round(sum(tmin) / n, 1),
            "rainy_share": round(rainy / n, 2), "icon": icon, "sky": label, "years": len({t[:4] for t in d["time"]})}


async def _sea_cell(client, lat, lon) -> Optional[Tuple[float, float]]:
    """Nearest sea cell of the marine model within 20 km, or None (inland)."""
    key = ("cell", round(lat, 2), round(lon, 2))
    hit = _get(key, 30 * 24 * 3600)
    if hit is not None:
        return hit or None
    j = await _json(client, "https://marine-api.open-meteo.com/v1/marine", {
        "latitude": lat, "longitude": lon, "hourly": "sea_surface_temperature", "forecast_days": 1})
    vals = [v for v in (j.get("hourly") or {}).get("sea_surface_temperature") or [] if v is not None]
    cell = (j.get("latitude"), j.get("longitude"))
    ok = vals and cell[0] is not None and _km(lat, lon, cell[0], cell[1]) <= 20
    _put(key, cell if ok else False)
    return cell if ok else None


async def _sea(client, lat, lon, day: dt.date) -> Optional[dict]:
    cell = await _sea_cell(client, lat, lon)
    if not cell:
        return None
    today = dt.date.today()
    if 0 <= (day - today).days <= 6:
        key = ("seafc", cell, day.isoformat())
        if (hit := _get(key, 3 * 3600)) is None:
            j = await _json(client, "https://marine-api.open-meteo.com/v1/marine", {
                "latitude": cell[0], "longitude": cell[1], "hourly": "sea_surface_temperature",
                "start_date": day.isoformat(), "end_date": day.isoformat()})
            vals = [v for v in (j.get("hourly") or {}).get("sea_surface_temperature") or [] if v is not None]
            hit = _put(key, {"mode": "forecast", "temp": round(sum(vals) / len(vals), 1)} if vals else {})
        return hit or None
    key = ("seacl", cell, day.strftime("%m-%d"))
    if (hit := _get(key, 7 * 24 * 3600)) is None:
        vals = []
        for year in range(2022, today.year):
            try:
                d = day.replace(year=year)
            except ValueError:          # 29 February
                d = day.replace(year=year, day=28)
            j = await _json(client, "https://marine-api.open-meteo.com/v1/marine", {
                "latitude": cell[0], "longitude": cell[1], "hourly": "sea_surface_temperature",
                "start_date": (d - dt.timedelta(days=3)).isoformat(), "end_date": (d + dt.timedelta(days=3)).isoformat()})
            vals += [v for v in (j.get("hourly") or {}).get("sea_surface_temperature") or [] if v is not None]
        hit = _put(key, {"mode": "climate", "temp": round(sum(vals) / len(vals), 1)} if vals else {})
    return hit or None


async def day_weather(lat: float, lon: float, date: str) -> dict:
    day = dt.date.fromisoformat(date)
    ahead = (day - dt.date.today()).days
    out = {"date": date, "air": None, "sea": None, "errors": []}
    async with httpx.AsyncClient(timeout=20.0, headers={"User-Agent": UA}) as client:
        try:
            out["air"] = await (_forecast(client, lat, lon, day) if 0 <= ahead <= 15 else _climate(client, lat, lon, day))
        except Exception as e:
            out["errors"].append(f"air: {type(e).__name__}")
        try:
            out["sea"] = await _sea(client, lat, lon, day)
        except Exception as e:
            out["errors"].append(f"sea: {type(e).__name__}")
    return out


async def days_weather(points: List[dict]) -> List[dict]:
    return list(await asyncio.gather(*(day_weather(p["lat"], p["lon"], p["date"]) for p in points)))
