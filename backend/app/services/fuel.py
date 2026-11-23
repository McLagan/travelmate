"""
Fuel for a trip: kilometres per country along the road, fuel price per country, cost.

- borders: Natural Earth 1:50m (public domain), simplified to ~100 m, data/countries_europe.json
- prices, EU countries: European Commission Weekly Oil Bulletin via fuel-prices.eu (free, no key,
  CC BY 4.0 - the attribution text must be shown next to the numbers); weekly national averages, EUR/L
- prices, other countries (Serbia, Albania, North Macedonia...): entered by the user, kept per user
"""
from __future__ import annotations

import json
import math
import os
import time
from typing import Dict, List, Optional, Tuple

import httpx

_BORDERS = None
_EU_CACHE: Dict[str, dict] = {}       # cc -> {"fetched": t, "data": {...} | None}
EU_TTL = 12 * 3600
ATTRIBUTION = {"text": "Data: fuel-prices.eu, CC BY 4.0", "url": "https://www.fuel-prices.eu/"}
UA = "TravelMate/0.1 (https://github.com/McLagan/travelmate; personal trip planner)"


def _borders():
    global _BORDERS
    if _BORDERS is None:
        path = os.path.join(os.path.dirname(__file__), "..", "data", "countries_europe.json")
        with open(path, encoding="utf-8") as f:
            _BORDERS = json.load(f)["countries"]
    return _BORDERS


def _in_ring(x: float, y: float, ring) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def country_at(lon: float, lat: float, hint: Optional[str] = None) -> Optional[str]:
    """ISO2 of the country containing the point (first ring = outline, others = holes)."""
    cs = _borders()
    order = sorted(cs, key=lambda c: c["cc"] != hint) if hint else cs  # the previous country first: usually right
    for c in order:
        b = c["bbox"]
        if not (b[0] <= lon <= b[2] and b[1] <= lat <= b[3]):
            continue
        for poly in c["polys"]:
            if _in_ring(lon, lat, poly[0]) and not any(_in_ring(lon, lat, h) for h in poly[1:]):
                return c["cc"]
    return None


def country_names() -> Dict[str, str]:
    return {c["cc"]: c["name"] for c in _borders()}


def _km(a, b) -> float:
    p = math.pi / 180
    h = (math.sin((b[1] - a[1]) * p / 2) ** 2 +
         math.cos(a[1] * p) * math.cos(b[1] * p) * math.sin((b[0] - a[0]) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(h))


def km_by_country(lines: List[List[List[float]]], step_km: float = 2.0) -> Dict[str, float]:
    """lines: road parts as [[lon, lat], ...]. Points are checked every ~step_km; each piece of road
    counts for the country of its middle point. Points at sea / outside the map count as '??'."""
    out: Dict[str, float] = {}
    hint = None
    for coords in lines:
        if len(coords) < 2:
            continue
        acc, prev = 0.0, coords[0]
        piece_start = coords[0]
        for pt in coords[1:]:
            d = _km(prev, pt)
            acc += d
            prev = pt
            if acc >= step_km:
                mid = ((piece_start[0] + pt[0]) / 2, (piece_start[1] + pt[1]) / 2)
                cc = country_at(mid[0], mid[1], hint) or "??"
                hint = cc if cc != "??" else hint
                out[cc] = out.get(cc, 0.0) + acc
                acc, piece_start = 0.0, pt
        if acc > 0:
            mid = ((piece_start[0] + prev[0]) / 2, (piece_start[1] + prev[1]) / 2)
            cc = country_at(mid[0], mid[1], hint) or "??"
            out[cc] = out.get(cc, 0.0) + acc
    return {k: round(v, 1) for k, v in sorted(out.items(), key=lambda kv: -kv[1])}


async def eu_price(cc: str) -> Optional[dict]:
    """Latest weekly national average (EUR/L) for an EU country, or None (not in the bulletin / unreachable)."""
    cc = cc.upper()
    hit = _EU_CACHE.get(cc)
    if hit and time.time() - hit["fetched"] < EU_TTL:
        return hit["data"]
    data = None
    try:
        async with httpx.AsyncClient(timeout=10.0, headers={"User-Agent": UA}) as client:
            r = await client.get("https://www.fuel-prices.eu/lang/api/country-history.php", params={"cc": cc})
        j = r.json() if r.status_code == 200 else {}
        if j.get("labels") and j.get("e95") and j.get("diesel"):
            def last(arr):
                return next((v for v in reversed(arr) if isinstance(v, (int, float))), None)
            data = {"petrol": last(j["e95"]), "diesel": last(j["diesel"]), "date": j["labels"][-1],
                    "currency": "EUR", "source": "eu_bulletin"}
    except Exception as e:
        print(f"fuel price {cc}: {type(e).__name__}")
        if hit:
            return hit["data"]
        _EU_CACHE[cc] = {"fetched": time.time() - EU_TTL + 600, "data": None}  # network error: retry in 10 min
        return None
    _EU_CACHE[cc] = {"fetched": time.time(), "data": data}
    return data


# ---------------------------------------------------------------------------
# refuel plan: where and how much to fill so the whole trip costs least
# ---------------------------------------------------------------------------

_RATES = {"fetched": 0.0, "rates": None}


async def eur_rates() -> Optional[Dict[str, float]]:
    """1 EUR = rates[X] X (open.er-api.com, cached 12 h)."""
    if _RATES["rates"] and time.time() - _RATES["fetched"] < 12 * 3600:
        return _RATES["rates"]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get("https://open.er-api.com/v6/latest/EUR")
        j = r.json()
        if j.get("result") == "success":
            _RATES.update(fetched=time.time(), rates=j["rates"])
    except Exception as e:
        print(f"rates: {type(e).__name__}")
    return _RATES["rates"]


def country_runs(lines: List[List[List[float]]], step_km: float = 2.0) -> List[dict]:
    """Road in order, cut into runs of one country: [{cc, start, end, pt_start, pt_end}] (km along the road;
    ferry/flight gaps are not counted - fuel is carried over)."""
    runs: List[dict] = []
    pos, hint = 0.0, None
    for coords in lines:
        if len(coords) < 2:
            continue
        acc, prev, piece_start = 0.0, coords[0], coords[0]
        pts = coords[1:]
        for k, pt in enumerate(pts):
            acc += _km(prev, pt)
            prev = pt
            if acc >= step_km or k == len(pts) - 1:
                mid = ((piece_start[0] + pt[0]) / 2, (piece_start[1] + pt[1]) / 2)
                cc = country_at(mid[0], mid[1], hint) or "??"
                hint = cc if cc != "??" else hint
                if runs and runs[-1]["cc"] == cc and abs(runs[-1]["end"] - pos) < 1e-6:
                    runs[-1]["end"] = pos + acc
                    runs[-1]["pt_end"] = pt
                else:
                    runs.append({"cc": cc, "start": pos, "end": pos + acc, "pt_start": piece_start, "pt_end": pt})
                pos += acc
                acc, piece_start = 0.0, pt
    return runs


def _lerp_point(run, km):
    """Approximate point at km inside a run (straight between its ends - only for labels/markers)."""
    span = max(run["end"] - run["start"], 1e-6)
    t = min(1.0, max(0.0, (km - run["start"]) / span))
    a, b = run["pt_start"], run["pt_end"]
    return [round(a[0] + (b[0] - a[0]) * t, 5), round(a[1] + (b[1] - a[1]) * t, 5)]


def plan_refuels(runs: List[dict], price_eur: Dict[str, Optional[float]], consumption: float, tank_l: float,
                 start_l: float, reserve_l: float, end_l: float, every_km: float = 80.0) -> dict:
    """Classic fixed-route refuelling: at each station, if a cheaper one is reachable buy just enough to get
    there, otherwise fill up. Stations: entry and exit of each country run (+ every `every_km` inside it).
    Countries without a price are treated as the most expensive known price (buy there only if forced).
    The end of the trip is a station with the price of the last country where the tank is brought to end_l,
    so leaving with an empty tank is not counted as a saving."""
    known = [p for p in price_eur.values() if p]
    worst = max(known) if known else None
    per_km = consumption / 100.0
    total = runs[-1]["end"] if runs else 0.0

    stations = []
    for r in runs:
        if r["cc"] == "??":
            continue
        p = price_eur.get(r["cc"]) or worst
        if p is None:
            continue
        kms = [r["start"]]
        k = r["start"] + every_km
        while k < r["end"] - 5:
            kms.append(k)
            k += every_km
        kms.append(max(r["start"], r["end"] - 0.5))   # last chance before the border
        for km in kms:
            stations.append({"km": round(km, 1), "cc": r["cc"], "price": p, "assumed": not price_eur.get(r["cc"]),
                             "pt": _lerp_point(r, km)})
    stations.sort(key=lambda s: s["km"])
    last_price = stations[-1]["price"] if stations else (worst or 0)
    end_station = {"km": round(total, 1), "cc": runs[-1]["cc"] if runs else "??", "price": last_price, "end": True,
                   "pt": runs[-1]["pt_end"] if runs else None}

    def simulate(smart: bool):
        fuel, pos, cost, buys, warnings = start_l, 0.0, 0.0, [], []
        usable_range = (tank_l - reserve_l) / per_km
        pts = stations + [end_station]
        for i, st in enumerate(pts):
            fuel -= (st["km"] - pos) * per_km
            pos = st["km"]
            if fuel < reserve_l - 0.5:
                warnings.append(f"below reserve at km {round(pos)} ({st['cc']})")
            if st.get("end"):
                need = end_l - fuel
                if need > 0.05:
                    buys.append({**st, "litres": round(need, 1), "why": "end"})
                    cost += need * st["price"]
                    fuel = end_l
                break
            nxt = pts[i + 1]
            buy = 0.0
            if smart and nxt["cc"] == st["cc"] and abs(nxt["price"] - st["price"]) < 1e-9 and not nxt.get("end") \
                    and nxt["km"] - pos <= usable_range and fuel - (nxt["km"] - pos) * per_km >= reserve_l:
                # same price further on and the tank lasts until there: decide there
                # (one fill-up per country, just before the border)
                buy, why = 0.0, ("wait", None)
            elif smart:
                cheaper = next((s for s in pts[i + 1:] if s["km"] - pos <= usable_range and s["price"] < st["price"] - 1e-9
                                and not s.get("end")), None)
                if cheaper:
                    buy = max(0.0, reserve_l + (cheaper["km"] - pos) * per_km - fuel)
                    why = ("to_cheaper", cheaper)
                elif end_station["km"] - pos <= usable_range and end_station["price"] <= st["price"] + 1e-9:
                    buy = max(0.0, reserve_l + (end_station["km"] - pos) * per_km - fuel)
                    why = ("to_end", end_station)
                else:
                    buy = tank_l - fuel
                    why = ("fill", None)
            else:  # naive: fill up only when the next station would be below the reserve
                if fuel - (nxt["km"] - pos) * per_km < reserve_l:
                    buy = tank_l - fuel
                    why = ("low", None)
            # never buy more than needed to finish the trip with end_l (leftover fuel would be paid for nothing)
            buy = min(buy, max(0.0, end_l + (total - pos) * per_km - fuel))
            if buy > 0.5:
                buys.append({**st, "litres": round(buy, 1), "why": why[0],
                             "target": ({"cc": why[1]["cc"], "km": why[1]["km"], "price": why[1]["price"]} if why[1] else None)})
                cost += buy * st["price"]
                fuel += buy
        return {"cost": round(cost, 2), "buys": buys, "warnings": warnings}

    smart, naive = simulate(True), simulate(False)
    # merge buys at the same place (entry + exit of a short run are close)
    merged = []
    for b in smart["buys"]:
        if merged and merged[-1]["cc"] == b["cc"] and abs(merged[-1]["km"] - b["km"]) < 1 and merged[-1]["why"] != "end":
            merged[-1]["litres"] = round(merged[-1]["litres"] + b["litres"], 1)
        else:
            merged.append(b)
    for b in merged:
        b["cost"] = round(b["litres"] * b["price"], 2)
        # what is ahead: the next more expensive country (why filling here pays off)
        ahead = next((s for s in stations if s["km"] > b["km"] + 1 and s["cc"] != b["cc"]), None)
        b["next_cc"], b["next_price"] = (ahead["cc"], ahead["price"]) if ahead else (None, None)
    return {"stops": merged, "cost_eur": smart["cost"], "naive_cost_eur": naive["cost"],
            "saving_eur": round(naive["cost"] - smart["cost"], 2), "warnings": smart["warnings"],
            "total_km": round(total, 1)}
