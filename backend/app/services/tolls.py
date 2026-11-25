"""
Vignettes and toll tunnels/bridges for a trip.

Data: fuel-prices.eu toll dataset (https://www.fuel-prices.eu/api/toll/get_json.php), CC BY 4.0 -
"Data: fuel-prices.eu, CC BY 4.0" with a link must be shown next to the numbers. Imported once a day
into toll_items; admin overrides / hidden records are respected. Prices are for a passenger car.

- vignettes: countries the road legs pass through, on which days; the cheapest set of vignettes that
  covers those days (e.g. two 10-day vignettes for the way out and back instead of a yearly one)
- tunnels / bridges / passes: the record's point lies within ~400 m of the route line
"""

import asyncio
import json
import math
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional

import httpx
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.toll import TollItem, DataImport
from app.services.fuel import country_runs, country_names, UA

SOURCE_URL = "https://www.fuel-prices.eu/api/toll/get_json.php"
ATTRIBUTION = {"text": "Data: fuel-prices.eu, CC BY 4.0", "url": "https://www.fuel-prices.eu/"}
IMPORT_NAME = "tolls_fpeu"
IMPORT_EVERY_H = 20


def _now():
    return datetime.now(timezone.utc)


def _aware(d):
    return d.replace(tzinfo=timezone.utc) if d is not None and d.tzinfo is None else d


# ---------- import ----------

async def fetch_source() -> List[dict]:
    async with httpx.AsyncClient(timeout=30.0, headers={"User-Agent": UA}) as client:
        r = await client.get(SOURCE_URL)
        r.raise_for_status()
        return r.json().get("data") or []


def apply_import(db: Session, rows: List[dict]) -> dict:
    """Upsert the source rows. A changed price keeps the old one and goes back to 'to review'."""
    now = _now()
    existing = {t.source_id: t for t in db.query(TollItem).filter(TollItem.source == "fpeu")}
    first = not existing            # the very first import is the baseline: nothing to review yet
    seen, new, changed = set(), 0, 0
    for r in rows:
        sid = r.get("id")
        if sid is None or not r.get("country_code") or not r.get("type"):
            continue
        seen.add(sid)
        price = r.get("price_eur")
        t = existing.get(sid)
        if t is None:
            t = TollItem(source="fpeu", source_id=sid, reviewed=first)
            db.add(t)
            new += 1
        elif (t.price_eur or 0) != (price or 0):
            t.prev_price_eur, t.changed_at, t.reviewed = t.price_eur, now, False
            changed += 1
        t.country, t.type, t.barrier_type = r["country_code"].upper()[:2], r["type"], r.get("barrier_type")
        t.name, t.price_eur, t.price_local = r.get("name") or "?", price, r.get("price_local")
        t.currency, t.info, t.lat, t.lng = r.get("currency"), r.get("info"), r.get("lat"), r.get("lng")
        t.gone, t.fetched_at = False, now
    gone = 0
    for sid, t in existing.items():
        if sid not in seen and not t.gone:
            t.gone, t.reviewed = True, False
            gone += 1
    db.commit()
    return {"count": len(seen), "new": new, "changed": changed, "gone": gone}


def _state(db: Session) -> DataImport:
    st = db.get(DataImport, IMPORT_NAME)
    if not st:
        st = DataImport(name=IMPORT_NAME)
        db.add(st)
        db.commit()
    return st


async def run_import(db: Session) -> dict:
    st = _state(db)
    st.last_attempt_at = _now()
    db.commit()
    try:
        rows = await fetch_source()
        res = apply_import(db, rows)
        st = _state(db)
        st.last_ok_at, st.last_error, st.last_count = _now(), None, res["count"]
        st.last_changes = res["new"] + res["changed"] + res["gone"]
        db.commit()
        print(f"✓ tolls import: {res}")
        return {"ok": True, **res}
    except Exception as e:
        db.rollback()
        st = _state(db)
        st.last_error = f"{type(e).__name__}: {e}"[:500]
        db.commit()
        print(f"❌ tolls import failed: {type(e).__name__}")
        return {"ok": False, "error": st.last_error}


def road_toll_providers() -> dict:
    """Countries whose motorway tolls are priced per trip (entry/exit or per km) - module per country."""
    from app.services import tolls_rs, tolls_hr, tolls_it
    return {"RS": tolls_rs, "HR": tolls_hr, "IT": tolls_it}


async def import_loop():
    """Background task: import when the last good import is older than IMPORT_EVERY_H hours."""
    await asyncio.sleep(20)
    while True:
        db = SessionLocal()
        try:
            st = _state(db)
            last = _aware(st.last_ok_at)
            if not last or (_now() - last).total_seconds() > IMPORT_EVERY_H * 3600:
                await run_import(db)
            for mod in road_toll_providers().values():
                rs = db.get(DataImport, mod.IMPORT_NAME)
                last = _aware(rs.last_attempt_at) if rs else None
                if not last or (_now() - last).total_seconds() > getattr(mod, "CHECK_EVERY_H", IMPORT_EVERY_H) * 3600:
                    await mod.check(db)
        except Exception as e:
            print(f"❌ tolls loop: {type(e).__name__}")
        finally:
            db.close()
        await asyncio.sleep(3600)


# ---------- trip estimate ----------

_SKIP = re.compile(r"weekend|county|regional|class 2a|truck|hgv|motorcycle", re.I)


def vignette_days(name: str) -> Optional[int]:
    """Validity in days from the record name; None = not usable for a car trip by days."""
    if _SKIP.search(name or ""):
        return None
    n = name.lower()
    if re.search(r"annual|1-year|365-day|yearly", n):
        return 365
    m = re.search(r"(\d+)-month", n)
    if m:
        return 30 * int(m.group(1))
    m = re.search(r"(\d+)-day", n)
    if m:
        return int(m.group(1))
    return None


def official_url(info: str) -> Optional[str]:
    m = re.search(r"Official:\s*([a-z0-9.-]+\.[a-z]{2,}(/[^\s|]*)?)", info or "", re.I)
    return f"https://{m.group(1)}" if m else None


def verified_on(info: str) -> Optional[str]:
    m = re.search(r"verified\s+(\d{4}-\d{2}-\d{2})", info or "", re.I)
    return m.group(1) if m else None


def cover_days(days: List[int], options: List[dict]) -> List[dict]:
    """Cheapest list of vignettes (each = consecutive days from its first day) covering all `days`."""
    d = sorted(set(days))
    best = [0.0] + [math.inf] * len(d)
    pick: List[Optional[tuple]] = [None] * (len(d) + 1)
    for j in range(1, len(d) + 1):
        for i in range(1, j + 1):
            span = d[j - 1] - d[i - 1] + 1
            fits = [o for o in options if o["days"] >= span]
            if not fits:
                continue
            o = min(fits, key=lambda x: x["price_eur"])
            if best[i - 1] + o["price_eur"] < best[j]:
                best[j], pick[j] = best[i - 1] + o["price_eur"], (i, o)
    out, j = [], len(d)
    while j > 0 and pick[j]:
        i, o = pick[j]
        out.append({**o, "first_day": d[i - 1], "last_day": d[j - 1]})
        j = i - 1
    return list(reversed(out))


def _seg_km(p, a, b):
    """Distance in km from point p to segment a-b (lon/lat, local equirectangular)."""
    k = math.cos(math.radians(p[1])) * 111.32
    ax, ay, bx, by, px, py = a[0] * k, a[1] * 110.57, b[0] * k, b[1] * 110.57, p[0] * k, p[1] * 110.57
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _near_line(p, coords, km=0.4) -> bool:
    for a, b in zip(coords, coords[1:]):
        if min(a[0], b[0]) - 0.02 <= p[0] <= max(a[0], b[0]) + 0.02 and \
           min(a[1], b[1]) - 0.02 <= p[1] <= max(a[1], b[1]) + 0.02 and _seg_km(p, a, b) <= km:
            return True
    return False


def _price(t: TollItem) -> Optional[float]:
    return t.override_price_eur if t.override_price_eur is not None else t.price_eur


def estimate(db: Session, legs: List[dict]) -> dict:
    """legs: [{day: int (1-based day of the trip), coords: [[lon, lat], ...]}] - road legs only."""
    items = db.query(TollItem).filter(TollItem.hidden.is_(False), TollItem.gone.is_(False)).all()
    names = country_names()
    # countries per day
    days_in: Dict[str, set] = {}
    for leg in legs:
        for run in country_runs([leg["coords"]]):
            if run["cc"] != "??" and run["end"] - run["start"] >= 1.0:   # ignore < 1 km clips at borders
                days_in.setdefault(run["cc"], set()).add(int(leg["day"]))
    vignettes, total = [], 0.0
    for cc, days in sorted(days_in.items()):
        opts = [{"name": t.name, "days": vignette_days(t.name), "price_eur": _price(t), "id": t.id,
                 "url": official_url(t.info), "verified": verified_on(t.info), "info": t.info}
                for t in items if t.country == cc and t.type == "vignette"]
        opts = [o for o in opts if o["days"] and o["price_eur"] is not None]
        if not opts:
            continue
        chosen = cover_days(sorted(days), opts)
        cost = round(sum(o["price_eur"] for o in chosen), 2)
        total += cost
        vignettes.append({"cc": cc, "country": names.get(cc, cc), "days": sorted(days), "cost_eur": cost,
                          "chosen": chosen, "url": next((o["url"] for o in opts if o["url"]), None),
                          "verified": max((o["verified"] for o in opts if o["verified"]), default=None)})
    crossings = []
    for t in items:
        if t.type not in ("tunnel", "bridge") or t.lat is None or t.lng is None or _price(t) is None:
            continue
        for k, leg in enumerate(legs):
            if _near_line([t.lng, t.lat], leg["coords"]):
                crossings.append({"id": t.id, "cc": t.country, "type": t.type, "name": t.name, "price_eur": _price(t),
                                  "price_local": t.price_local, "currency": t.currency, "info": t.info,
                                  "day": leg["day"], "lat": t.lat, "lng": t.lng})
                total += _price(t)
    road_tolls = []
    for cc, mod in road_toll_providers().items():
        if cc not in days_in:
            continue
        try:
            res = mod.trip_tolls(db, legs)
            if res and res["runs"]:
                road_tolls.append(res)
                total += res["total_eur"]
        except Exception as e:
            print(f"❌ {cc} tolls: {type(e).__name__}: {e}")
    return {"vignettes": vignettes, "crossings": crossings, "road_tolls": road_tolls, "total_eur": round(total, 2),
            "attribution": ATTRIBUTION,
            "note": "Passenger car. Vignettes are needed on motorways in most countries and on all national roads "
                    "in some (e.g. Romania, Bulgaria). Motorway tolls of Serbia and Croatia follow the official price lists, "
                    "Italy is estimated; France, Greece, North Macedonia... are not included yet."}
