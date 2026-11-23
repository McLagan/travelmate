"""
AI review of a trip with the Claude API (Messages API over plain HTTPS, no SDK needed).

The frontend sends a compact description of the trip (stops by day, legs with distance/time,
lodging, picked places, budget) plus the traveller's wishes; Claude answers with a review
in markdown: score, what works, risks, concrete changes, what is missing.
"""
from __future__ import annotations

import json
from typing import Optional

import httpx

from app.config import settings

API_URL = "https://api.anthropic.com/v1/messages"

SYSTEM = """You are an experienced road-trip planner reviewing a traveller's trip plan.
The plan comes as JSON: days, stops (pass / visit / overnight), legs between stops (car, ferry, flight)
with distance and time, lodging, places picked at stops, and the budget the traveller entered.
Stops may carry "weather" for the day the traveller is there: a real forecast, or (kind "usual for these dates")
the average of past years; sea_temp is the sea surface temperature at coastal stops. Use it (beach days, rain on a
sightseeing day, mountain passes in snow) but do not invent weather for stops without it.

Write the review in the same language as the traveller's wishes (if there are none, in Russian).
Use markdown with exactly these sections:
## Оценка: N/10 — one line why
## Что хорошо
## Риски и проблемы — be concrete: too many hours driving on a day, late ferry arrival, border crossings,
   seasonality, nights missing, unrealistic timing, budget gaps (fuel, tolls/vignettes, ferries, parking)
## Что изменить — numbered, concrete changes to the plan (move/add/remove a night, reorder, add a stop)
## Чего не хватает — bookings, documents, places worth adding near the route

Rules:
- Base the review on the data; when you use general knowledge (ferry seasons, border rules, tolls, opening times),
  say it is general knowledge that may be outdated and should be checked. Never invent exact schedules or prices.
- Driving time in the data comes from a routing engine without breaks; add ~15 min per 2 h for breaks.
- Be brief: at most ~450 words. No preamble."""


class AIReviewError(Exception):
    pass


async def review_trip(trip: dict, wishes: Optional[str]) -> dict:
    if not settings.ANTHROPIC_API_KEY:
        raise AIReviewError("no ANTHROPIC_API_KEY in backend/.env")
    user = (
        "Traveller's wishes / context:\n"
        + (wishes.strip() if wishes and wishes.strip() else "(none)")
        + "\n\nTrip plan (JSON):\n"
        + json.dumps(trip, ensure_ascii=False, indent=1)
    )
    body = {
        "model": settings.ANTHROPIC_MODEL,
        "max_tokens": 2000,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": user}],
    }
    headers = {
        "x-api-key": settings.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
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
    text = "".join(b.get("text", "") for b in j.get("content", []) if b.get("type") == "text")
    usage = j.get("usage") or {}
    return {"review": text, "model": j.get("model"), "stop_reason": j.get("stop_reason"),
            "input_tokens": usage.get("input_tokens"), "output_tokens": usage.get("output_tokens")}
