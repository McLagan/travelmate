"""
AI edits of a trip: Claude proposes concrete changes as structured operations (tool use),
the backend finds coordinates for new stops/places itself (Nominatim) - the model's
coordinates are never trusted. The frontend shows the proposal and applies only what
the traveller ticks.
"""
from __future__ import annotations

import asyncio
import json
import math
from typing import Optional

import httpx

from app.config import settings
from app.services.ai_review import API_URL, AIReviewError

NOMINATIM = "https://nominatim.openstreetmap.org/search"
UA = "TravelMate/0.1 (https://github.com/McLagan/travelmate; personal trip planner)"

OPS = ["add_stop", "remove_stop", "move_stop", "set_stop_type", "set_nights", "set_leg_mode", "add_place"]

TOOL = {
    "name": "propose_changes",
    "description": "Propose concrete changes to the trip plan. Stop numbers refer to the CURRENT plan (field n).",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "1-2 sentences: what the changes achieve, in the traveller's language"},
            "changes": {
                "type": "array", "maxItems": 12,
                "items": {
                    "type": "object",
                    "properties": {
                        "op": {"type": "string", "enum": OPS,
                               "description": "add_stop: new stop after stop `after` (0 = before the first). "
                                              "remove_stop: remove stop `stop`. move_stop: move stop `stop` to right after stop `after`. "
                                              "set_stop_type: `stop` becomes `type`. set_nights: stop `stop` becomes overnight with `nights`. "
                                              "set_leg_mode: travel from stop `stop` to the next one by `mode`. "
                                              "add_place: a place to see at stop `stop` (sight, viewpoint, beach...)."},
                        "reason": {"type": "string", "description": "short why, in the traveller's language"},
                        "stop": {"type": "integer", "minimum": 1},
                        "after": {"type": "integer", "minimum": 0},
                        "name": {"type": "string", "description": "add_stop/add_place: name findable on OpenStreetMap, e.g. 'Ohrid' or 'Samuel's Fortress, Ohrid'"},
                        "country": {"type": "string", "description": "country of the new stop/place, in English"},
                        "type": {"type": "string", "enum": ["pass", "visit", "overnight"]},
                        "nights": {"type": "integer", "minimum": 1, "maximum": 14},
                        "mode": {"type": "string", "enum": ["road", "ferry", "flight"]},
                    },
                    "required": ["op", "reason"],
                },
            },
        },
        "required": ["summary", "changes"],
    },
}

SYSTEM = """You edit a traveller's road-trip plan. The plan comes as JSON (stops numbered by n, legs, days,
driving hours per day without breaks, budget). The traveller tells what to change; sometimes it is a previous
review of the plan whose suggestions should be applied.

Always answer by calling the tool propose_changes exactly once (no plain-text answer), with the smallest
set of changes that does what was asked. If nothing should change, call it with an empty changes list and say why in summary.
Rules:
- Stop numbers always refer to the CURRENT plan, never to positions after your own changes.
- Do not change the first and the last stop unless asked.
- New stops/places: real, well-known names that OpenStreetMap can find; always give the country.
- Prefer overnight stops so that driving stays within the traveller's limits; keep geography sensible (no zig-zags).
- Ferries: only propose set_leg_mode ferry where a real car-ferry line is commonly known to exist; say in the reason it must be checked.
- Do not invent schedules or prices. Write summary and reasons in the traveller's language (Russian if unclear)."""


def _km(a_lat, a_lon, b_lat, b_lon):
    p = math.pi / 180
    h = (math.sin((b_lat - a_lat) * p / 2) ** 2 +
         math.cos(a_lat * p) * math.cos(b_lat * p) * math.sin((b_lon - a_lon) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(h))


def _queries(name: str, country: Optional[str]) -> list:
    """Claude sometimes writes the country into the name ("X, Italia") and again into country ("Italy"):
    "X, Italia, Italy" finds nothing. Try a few spellings, most specific first."""
    base = name.strip()
    first = base.split(",")[0].strip()
    out = [base]
    if country and country.lower() not in base.lower():
        out.insert(0, f"{base}, {country}")
    if first != base:
        out += [f"{first}, {country}" if country else first, first]
    return list(dict.fromkeys(q for q in out if q))


async def _nominatim(client, q: str, near: Optional[tuple], box_deg: float) -> list:
    params = {"q": q, "format": "jsonv2", "limit": 3, "accept-language": "ru,en"}
    if near:
        lat, lon = near
        params["viewbox"] = f"{lon - box_deg},{lat + box_deg},{lon + box_deg},{lat - box_deg}"  # bias, not a hard limit
    r = await client.get(NOMINATIM, params=params)
    r.raise_for_status()
    return [{"lat": float(x["lat"]), "lng": float(x["lon"]), "found_name": x.get("display_name") or ""} for x in r.json()]


async def _photon(client, q: str, near: Optional[tuple]) -> list:
    """Second OpenStreetMap geocoder (komoot Photon, free): different search engine, finds other spellings."""
    params = {"q": q, "limit": 3}
    if near:
        params.update(lat=near[0], lon=near[1])
    r = await client.get("https://photon.komoot.io/api/", params=params)
    r.raise_for_status()
    out = []
    for f in r.json().get("features", []):
        lon, lat = f["geometry"]["coordinates"]
        p = f.get("properties", {})
        label = ", ".join(x for x in (p.get("name"), p.get("city"), p.get("state"), p.get("country")) if x)
        out.append({"lat": float(lat), "lng": float(lon), "found_name": label})
    return out


async def _geocode(client, name: str, country: Optional[str], near: Optional[tuple], box_deg: float) -> Optional[dict]:
    res = []
    for q in _queries(name, country):
        res = await _nominatim(client, q, near, box_deg)
        await asyncio.sleep(1.1)  # Nominatim usage policy: 1 request per second
        if res:
            break
    if not res:
        try:
            for q in _queries(name, country)[:2]:
                res = await _photon(client, q, near)
                if res:
                    break
        except Exception:
            res = []
    if not res:
        return None
    best = res[0]
    if near:  # several hits: take the closest to where it is expected
        best = min(res, key=lambda x: _km(near[0], near[1], x["lat"], x["lng"]))
    return {"lat": round(best["lat"], 6), "lng": round(best["lng"], 6), "found_name": best["found_name"][:160]}


async def propose_edits(trip: dict, request: str, coords: list) -> dict:
    """coords: [[lat, lng], ...] of the current stops (same order as trip.stops)."""
    if not settings.ANTHROPIC_API_KEY:
        raise AIReviewError("no ANTHROPIC_API_KEY in backend/.env")
    body = {
        "model": settings.ANTHROPIC_MODEL,
        "max_tokens": 8000,
        "system": SYSTEM,
        "tools": [TOOL],
        # forcing a tool ("tool"/"any") is not supported by every model: "auto" + an explicit instruction
        "tool_choice": {"type": "auto"},
        "messages": [{"role": "user", "content":
                      f"What to change:\n{request.strip()}\n\nCurrent trip plan (JSON):\n{json.dumps(trip, ensure_ascii=False, indent=1)}"}],
    }
    headers = {"x-api-key": settings.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=150.0) as client:
            r = await client.post(API_URL, json=body, headers=headers)
    except httpx.HTTPError as e:
        raise AIReviewError(f"Claude API unreachable: {type(e).__name__}")
    if r.status_code != 200:
        try:
            err = r.json().get("error", {})
            msg = f'{err.get("type", "error")}: {err.get("message", "")[:200]}'
        except ValueError:
            msg = r.text[:200]
        raise AIReviewError(f"Claude API HTTP {r.status_code} — {msg}")
    j = r.json()
    block = next((b for b in j.get("content", []) if b.get("type") == "tool_use"), None)
    if not block:
        text = "".join(b.get("text", "") for b in j.get("content", []) if b.get("type") == "text").strip()
        if text:  # answered in words instead of calling the tool: show it as the summary, no changes
            usage = j.get("usage") or {}
            return {"summary": text[:1500], "changes": [], "model": j.get("model"),
                    "input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens")}
        kinds = ", ".join(b.get("type", "?") for b in j.get("content", [])) or "empty"
        usage = j.get("usage") or {}
        raise AIReviewError(f"Claude did not return changes (stop_reason={j.get('stop_reason')}, "
                            f"content=[{kinds}], tokens {usage.get('input_tokens')}+{usage.get('output_tokens')})")
    data = block.get("input") or {}
    n = len(coords)

    # validate + geocode
    changes = []
    async with httpx.AsyncClient(timeout=15.0, headers={"User-Agent": UA}) as client:
        for c in (data.get("changes") or [])[:12]:
            op = c.get("op")
            c = {k: v for k, v in c.items() if k in ("op", "reason", "stop", "after", "name", "country", "type", "nights", "mode")}
            c["ok"], c["warning"] = True, None
            if op not in OPS:
                continue
            stop, after = c.get("stop"), c.get("after")
            needs_stop = op in ("remove_stop", "move_stop", "set_stop_type", "set_nights", "set_leg_mode", "add_place")
            if needs_stop and not (isinstance(stop, int) and 1 <= stop <= n):
                c["ok"], c["warning"] = False, f"stop number {stop} does not exist"
            if op in ("add_stop", "move_stop") and not (isinstance(after, int) and 0 <= after <= n):
                c["ok"], c["warning"] = False, f"position after {after} does not exist"
            if op == "set_leg_mode" and c.get("ok") and stop == n:
                c["ok"], c["warning"] = False, "the last stop has no leg after it"
            if op in ("add_stop", "add_place") and c["ok"]:
                if not c.get("name"):
                    c["ok"], c["warning"] = False, "no name"
                else:
                    if op == "add_place":
                        anchor = tuple(coords[stop - 1])
                    else:  # between the neighbours
                        a = coords[max(0, min(after, n) - 1)] if after > 0 else coords[0]
                        b = coords[min(after, n - 1)]
                        anchor = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                    try:
                        g = await _geocode(client, c["name"], c.get("country"), anchor, 0.4 if op == "add_place" else 2.5)
                    except Exception as e:
                        g, c["warning"] = None, f"search failed: {type(e).__name__}"
                    if not g:
                        c["ok"] = False
                        c["warning"] = c["warning"] or "not found on the map"
                    else:
                        c.update(lat=g["lat"], lng=g["lng"], found_name=g["found_name"])
                        d = _km(anchor[0], anchor[1], g["lat"], g["lng"])
                        limit = 40 if op == "add_place" else 400
                        if d > limit:
                            c["warning"] = f"found {round(d)} km away — check it is the right place"
            changes.append(c)
    usage = j.get("usage") or {}
    return {"summary": data.get("summary") or "", "changes": changes, "model": j.get("model"),
            "input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens")}
