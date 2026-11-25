"""
Croatia: exact motorway tolls from the official price list of Hrvatske autoceste (HAC).

HAC publishes its whole entry x exit price list as open data (data.gov.hr, "Cjenik cestarine HAC",
Otvorena dozvola): GET https://www.hac.hr/api-tp/v1/toll-prices with the public token from the API description.
It covers HAC, Bina-Istra (A8/A9) and AZM (A2) - every closed system plus the single barriers (Bregana, Rupa).
Prices are in EUR per vehicle group; group I = car up to 1.90 m (a car towing a trailer is group II).

Daily check: download, compare SHA-256, validate, activate. A list that cannot be used is not activated.
From 1 March 2027 the barriers are replaced by free-flow tolling; prices stay distance based.
"""

import hashlib
import json
import re
import unicodedata
import os
from datetime import datetime, timezone
from typing import Dict, List, Optional

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models.toll import TollPriceList, DataImport
from app.services.fuel import UA
from app.services.tolls_rs import _pos_on_line

PRICE_URL = "https://www.hac.hr/api-tp/v1/toll-prices"
SOURCE_PAGE = "https://www.hac.hr/hr/cestarina/cjenik"
LICENCE = "HAC toll price list, open data (data.gov.hr, Otvorena dozvola)"
IMPORT_NAME = "tolls_hr"
CAR = "category_I"

_STATIONS_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "hr_toll_stations.json")


def _now():
    return datetime.now(timezone.utc)


def station_key(name: str) -> str:
    s = (name or "").replace("đ", "d").replace("Đ", "D")
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().upper()
    return re.sub(r"[^A-Z0-9]+", " ", s).strip()


def _stations_file() -> dict:
    with open(_STATIONS_FILE, encoding="utf-8") as f:
        return json.load(f)


def canon(name: str, aliases: Optional[dict] = None) -> str:
    k = station_key(name)
    aliases = aliases if aliases is not None else _stations_file()["aliases"]
    return aliases.get(k, k)


def parse(payload: dict) -> dict:
    """API answer -> {"pairs": {"ENTRY|EXIT": eur}, "names": {key: display name}, "open": [key]}"""
    al = _stations_file()["aliases"]
    pairs, names, open_ = {}, {}, set()
    for r in payload.get("results") or []:
        try:
            a, b = canon(r["entry"], al), canon(r["exit"], al)
            p = float(r["prices"]["EUR"][CAR])
        except (KeyError, TypeError, ValueError):
            continue
        if not a or not b or p < 0:
            continue
        pairs[f"{a}|{b}"] = p
        names.setdefault(a, r["entry"].strip())
        names.setdefault(b, r["exit"].strip())
        if a == b:
            open_.add(a)
    return {"pairs": pairs, "names": names, "open": sorted(open_)}


def validate(parsed: dict) -> List[str]:
    probs = []
    n = len(parsed.get("pairs") or {})
    if n < 500:
        probs.append(f"only {n} price pairs (expected ~2000)")
    zs = parsed["pairs"].get("ZAGREB|SPLIT")
    if zs is None or not (10 < zs < 60):
        probs.append(f"Zagreb-Split price implausible: {zs}")
    return probs


def missing_coords(parsed: dict) -> List[str]:
    st = _stations_file()["stations"]
    return sorted(k for k in parsed.get("names", {}) if k not in st)


def active_list(db: Session) -> Optional[TollPriceList]:
    return db.query(TollPriceList).filter(TollPriceList.country == "HR", TollPriceList.active.is_(True)) \
             .order_by(TollPriceList.id.desc()).first()


async def check(db: Session, force: bool = False) -> dict:
    st = db.get(DataImport, IMPORT_NAME) or DataImport(name=IMPORT_NAME)
    db.add(st)
    st.last_attempt_at = _now()
    db.commit()
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True,
                                     headers={"User-Agent": UA, "Accept": "application/json",
                                              "Authorization": f"Bearer {settings.HAC_API_TOKEN}"}) as client:
            r = await client.get(PRICE_URL)
            r.raise_for_status()
            raw = r.content
        sha = hashlib.sha256(raw).hexdigest()
        active = active_list(db)
        if active and active.sha256 == sha and not force:
            st.last_ok_at, st.last_error = _now(), None
            db.commit()
            return {"ok": True, "changed": False, "pairs": None}
        parsed = parse(json.loads(raw))
        probs = validate(parsed)
        if probs:
            raise ValueError("price list not understood: " + "; ".join(probs))
        valid = _now().date().isoformat()
        if active and active.sha256 == sha:
            active.data, active.fetched_at = json.dumps(parsed, ensure_ascii=False), _now()
        else:
            db.query(TollPriceList).filter(TollPriceList.country == "HR", TollPriceList.active.is_(True)) \
              .update({"active": False}, synchronize_session=False)
            db.add(TollPriceList(country="HR", source_url=PRICE_URL, sha256=sha, valid_from=f"price list checked {valid}",
                                 data=json.dumps(parsed, ensure_ascii=False), fetched_at=_now(), active=True))
        st.last_ok_at, st.last_error = _now(), None
        st.last_count, st.last_changes = len(parsed["pairs"]), 1
        db.commit()
        print(f"✓ Croatian toll price list activated: {len(parsed['pairs'])} pairs")
        return {"ok": True, "changed": True, "pairs": len(parsed["pairs"]), "stations": len(parsed["names"]),
                "missing_coords": missing_coords(parsed)}
    except Exception as e:
        db.rollback()
        st = db.get(DataImport, IMPORT_NAME)
        st.last_error = f"{type(e).__name__}: {e}"[:500]
        db.commit()
        print(f"❌ Croatian toll price list: {type(e).__name__}")
        return {"ok": False, "error": st.last_error}


def trip_tolls(db: Session, legs: List[dict]) -> Optional[dict]:
    """Stations the route passes, in order; a ticket runs from the first station to the farthest later station that
    the price list pairs with it (same closed system). Single barriers (Bregana, Rupa) are charged on their own."""
    pl = active_list(db)
    if not pl:
        return None
    data = json.loads(pl.data)
    pairs, names, open_ = data["pairs"], data["names"], set(data["open"])
    st = _stations_file()["stations"]
    runs, total = [], 0.0
    for leg in legs:
        hits = []
        for key, pts in st.items():
            if key not in names:
                continue
            pos = [p for p in (_pos_on_line([lng, lat], leg["coords"]) for lat, lng in pts) if p is not None]
            if pos:
                hits.append((min(pos), key))
        hits.sort()
        i = 0
        while i < len(hits):
            a = hits[i][1]
            if a in open_:
                p = pairs.get(f"{a}|{a}", 0.0)
                runs.append({"from": names[a], "to": None, "eur": p, "day": leg["day"], "km": 0})
                total += p
                i += 1
                continue
            j = max((k for k in range(i + 1, len(hits)) if f"{a}|{hits[k][1]}" in pairs), default=None)
            if j is None:
                i += 1
                continue
            z = hits[j][1]
            p = pairs[f"{a}|{z}"]
            runs.append({"from": names[a], "to": names[z], "eur": p, "day": leg["day"], "km": round(hits[j][0] - hits[i][0])})
            total += p
            i = j + 1
    return {"country": "HR", "runs": runs, "total_eur": round(total, 2), "currency": "EUR",
            "valid_from": pl.valid_from, "source": SOURCE_PAGE,
            "note": "Official HAC price list (incl. Bina-Istra and AZM), group I (car up to 1.90 m; with a trailer: group II)."}


def summary(data: dict) -> str:
    return f"{len(data['pairs'])} entry/exit prices, {len(data['names'])} stations"
