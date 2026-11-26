"""
Norway: toll stations (bomstasjoner) from NVDB, the national road database of Statens vegvesen - open data (NLOD),
object type 45 "Bomstasjon", with location and the AutoPASS price for a small car.

Trip price = sum of the stations the route passes, with the "hour rule" (within a passing group only the first
passage in 60 minutes is charged - approximated as once per group per ~60 km of driving). Stations that charge one
direction only usually come in pairs (northbound/southbound) at one place - such pairs are charged once.
Rush-hour prices, EV discounts and AutoPASS agreement discounts are not applied (the ordinary car price is used).
Ferry toll points are left out (ferries are separate legs).
"""

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional

import httpx
from sqlalchemy.orm import Session

from app.models.toll import TollPriceList, DataImport
from app.services.fuel import UA, eur_rates
from app.services.tolls_rs import _pos_on_line

PRICE_URL = "https://nvdbapiles.atlas.vegvesen.no/vegobjekter/45?inkluder=egenskaper,geometri,metadata&srid=4326&antall=1000"
SOURCE_PAGE = "https://data.norge.no/en/datasets/49113c39-fefe-4141-b901-b1139d2cc767"
LICENCE = "Contains data from NVDB, Statens vegvesen (NLOD)"
IMPORT_NAME = "tolls_no"
CHECK_EVERY_H = 24 * 7
HOUR_KM = 60.0
PAIR_KM = 0.25
MATCH_KM = 0.08                                 # city toll rings are dense: the route must really pass the station


def _now():
    return datetime.now(timezone.utc)


def _val(o: dict, name: str):
    for e in o.get("egenskaper", []):
        if e.get("navn") == name:
            return e.get("verdi")
    return None


def parse(objects: List[dict]) -> dict:
    out = []
    for o in objects:
        if _val(o, "Bomstasjonstype") == "Ferjeinnkrevingspunkt":
            continue
        price = _val(o, "Takst liten bil")
        wkt = (o.get("geometri") or {}).get("wkt") or ""
        m = re.search(r"POINT(?: Z)?\s*\(\s*([-\d.]+)\s+([-\d.]+)", wkt)
        if price is None or not m:
            continue
        lat, lng = float(m.group(1)), float(m.group(2))        # EPSG:4326 in NVDB: latitude first
        if not (57 < lat < 72 and 4 < lng < 32):
            continue
        out.append({"id": o.get("id"), "name": _val(o, "Navn bomstasjon") or "?", "facility": _val(o, "Navn bompengeanlegg"),
                    "nok": float(price), "rush_nok": _val(o, "Rushtidstakst liten bil"), "ev_nok": _val(o, "Takst liten elbil"),
                    "group": _val(o, "Timesregel, passeringsgruppe") if _val(o, "Timesregel") == "Første passering gjelder" else None,
                    "one_way": _val(o, "Innkrevningsretning") in ("Med metrering", "Mot metrering"),
                    "lat": round(lat, 6), "lng": round(lng, 6)})
    return {"stations": out}


def validate(parsed: dict) -> List[str]:
    n = len(parsed.get("stations") or [])
    return [] if n >= 200 else [f"only {n} toll stations (expected ~400)"]


def missing_coords(parsed: dict) -> List[str]:
    return []


def summary(parsed: dict) -> str:
    st = parsed.get("stations", [])
    return f"{len(st)} toll stations, car price {min((s['nok'] for s in st), default=0):.0f}–{max((s['nok'] for s in st), default=0):.0f} NOK"


def active_list(db: Session) -> Optional[TollPriceList]:
    return db.query(TollPriceList).filter(TollPriceList.country == "NO", TollPriceList.active.is_(True)) \
             .order_by(TollPriceList.id.desc()).first()


async def fetch_all() -> List[dict]:
    objs, url = [], PRICE_URL
    async with httpx.AsyncClient(timeout=60.0, headers={"User-Agent": UA, "Accept": "application/json",
                                                         "X-Client": "TravelMate trip planner"}) as client:
        for _ in range(20):
            r = await client.get(url)
            r.raise_for_status()
            j = r.json()
            objs += j.get("objekter", [])
            meta = j.get("metadata") or {}
            nxt = (meta.get("neste") or {}).get("href")
            if not meta.get("returnert") or not nxt or meta.get("returnert", 0) < meta.get("sidestørrelse", 1):
                break
            url = nxt
    return objs


async def check(db: Session, force: bool = False) -> dict:
    st = db.get(DataImport, IMPORT_NAME) or DataImport(name=IMPORT_NAME)
    db.add(st)
    st.last_attempt_at = _now()
    db.commit()
    try:
        parsed = parse(await fetch_all())
        probs = validate(parsed)
        if probs:
            raise ValueError("data not usable: " + "; ".join(probs))
        rates = await eur_rates()
        parsed["nok_per_eur"] = (rates or {}).get("NOK") or 11.7
        raw = json.dumps(parsed["stations"], sort_keys=True)
        sha = hashlib.sha256(raw.encode()).hexdigest()
        active = active_list(db)
        if active and active.sha256 == sha and not force:
            st.last_ok_at, st.last_error = _now(), None
            db.commit()
            return {"ok": True, "changed": False}
        db.query(TollPriceList).filter(TollPriceList.country == "NO", TollPriceList.active.is_(True)) \
          .update({"active": False}, synchronize_session=False)
        db.add(TollPriceList(country="NO", source_url=PRICE_URL, sha256=sha, valid_from=f"NVDB {_now().date().isoformat()}",
                             data=json.dumps(parsed, ensure_ascii=False), fetched_at=_now(), active=True))
        st.last_ok_at, st.last_error = _now(), None
        st.last_count, st.last_changes = len(parsed["stations"]), 1
        db.commit()
        return {"ok": True, "changed": True, "stations": len(parsed["stations"])}
    except Exception as e:
        db.rollback()
        st = db.get(DataImport, IMPORT_NAME)
        st.last_error = f"{type(e).__name__}: {e}"[:500]
        db.commit()
        return {"ok": False, "error": st.last_error}


def _km(a, b):
    return math.hypot((b[1] - a[1]) * math.cos(math.radians(a[0])) * 111.32, (b[0] - a[0]) * 110.57)


def trip_tolls(db: Session, legs: List[dict]) -> Optional[dict]:
    pl = active_list(db)
    if not pl:
        return None
    data = json.loads(pl.data)
    rate = data.get("nok_per_eur") or 11.7
    stations = data["stations"]
    runs, total = [], 0.0
    for leg in legs:
        hits = []
        for s in stations:
            p = _pos_on_line([s["lng"], s["lat"]], leg["coords"], MATCH_KM)
            if p is not None:
                hits.append((p, s))
        hits.sort(key=lambda h: h[0])
        charged, last_group_km = [], {}
        for p, s in hits:
            # one-direction pair at the same place: charge once
            if any(_km((s["lat"], s["lng"]), (c["lat"], c["lng"])) < PAIR_KM for _, c in charged[-3:]):
                continue
            g = s["group"]
            if g is not None and g in last_group_km and p - last_group_km[g] < HOUR_KM:
                continue
            if g is not None:
                last_group_km[g] = p
            charged.append((p, s))
        for p, s in charged:
            eur = round(s["nok"] / rate, 2)
            runs.append({"from": s["name"], "to": None, "nok": s["nok"], "eur": eur, "day": leg["day"], "km": 0,
                         "one_way": s["one_way"]})
            total += eur
    return {"country": "NO", "runs": runs, "total_eur": round(total, 2), "currency": "NOK",
            "valid_from": pl.valid_from, "source": SOURCE_PAGE,
            "note": "AutoPASS car price without agreement discount; rush hours and electric cars differ. " + LICENCE + "."}
