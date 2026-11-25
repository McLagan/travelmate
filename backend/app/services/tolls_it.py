"""
Italy: ESTIMATED motorway tolls (no official free price matrix exists).

Italian tolls are km x unit rate of the concessionaire (class A, VAT and ANAS share included), rounded to 0.10 EUR
per ticket; a few roads charge a flat fee. So we need (1) which km of the route are on a tolled motorway and who
operates them, (2) the operator's rate.

(1) The tolled network comes from OpenStreetMap (highway=motorway + toll=yes, tags operator/ref), downloaded from
    Overpass in 9 tiles about once a month and rasterised into a grid of ~200 m cells -> operator. ODbL.
(2) Rates per operator: published 2026 class A rates where we found them (source in RATES); the rest use a default
    and are shown in the admin as "to review". Each operator gets a toll_items row (type rate_km / rate_flat), so the
    admin can set "Our €" with the usual tools.

Known simplifications: plain rate for operators that also have mountain sections (ASPI mountain is ~18% dearer),
link roads and free stretches around toll plazas are not counted, open-system barriers are priced by km.
"""

import asyncio
import json
import math
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import httpx
from sqlalchemy.orm import Session

from app.models.toll import TollItem, TollPriceList, DataImport
from app.services.fuel import UA

PRICE_URL = "https://overpass-api.de/api/interpreter"
MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
           "https://overpass.private.coffee/api/interpreter"]
SOURCE_PAGE = "https://www.autostrade.it/en/servizi-al-cliente/pedaggio/come-si-calcola-il-pedaggio"
IMPORT_NAME = "tolls_it"
ATTENTION = "operators priced with the default rate - set “Our €” for them below (type rate_km)"
CHECK_EVERY_H = 24 * 30
CELL = 0.002                                   # degrees (~220 m x 160 m in Italy)
BBOX = (35.4, 6.5, 47.2, 18.6)                 # s, w, n, e
MIN_RUN_KM = 2.0
GAP_KM = 1.0
DEFAULT_RATE = 0.085                           # EUR/km class A incl. VAT - rough national average (ART: ~0.069 excl. VAT, 2023)

# (operator regex, kind, class A EUR/km incl. VAT - or flat EUR, source, verified)
RATES: List[Tuple[str, str, float, str, bool]] = [
    (r"autostrade per l.? ?italia", "km", 0.07869, "autostrade.it 2026, plain (mountain 0.09315)", True),
    (r"satap", "km", 0.1400, "satapweb.it 2026: Torino-Novara Est 0.13794, Novara Est-Milano 0.14155", True),
    (r"brennero", "km", 0.0700, "autobrennero.it 2026: plain 0.06412, mountain 0.07592 (average)", True),
    (r"brebemi", "km", 0.23169, "brebemi.it (A35)", True),
    (r"raccordo autostradale valle|\brav\b", "km", 0.29354, "ravspa.it (mountain)", True),
    (r"ivrea torino piacenza|\bitp\b", "km", 0.083753, "itpspa.it A5/A55 plain 2026", True),
    (r"\bcav\b|concessioni autostradali venete", "km", 0.06577, "cavspa.it via calcolo.tools (A4 Padova-Mestre)", False),
    (r"salerno pompei napoli", "flat", 2.30, "salernopompeinapolispa.it flat class A", True),
    (r"tangenziale di napoli", "flat", 1.00, "default, not verified", False),
]


def _now():
    return datetime.now(timezone.utc)


def _rate_for(op: str) -> Tuple[str, float, str, bool]:
    for rx, kind, val, src, ok in RATES:
        if re.search(rx, op or "", re.I):
            return kind, val, src, ok
    return "km", DEFAULT_RATE, "default (national average), not verified", False


def canon_op(op: str) -> str:
    s = re.sub(r"\s+", " ", (op or "").replace("' ", "'")).strip(" .")
    return s or "unknown operator"


# ---------- network ----------

def _cell(lat: float, lng: float) -> str:
    return f"{math.floor(lng / CELL)}:{math.floor(lat / CELL)}"


def _km(a, b) -> float:
    return math.hypot((b[0] - a[0]) * math.cos(math.radians(a[1])) * 111.32, (b[1] - a[1]) * 110.57)


def rasterise(elements: List[dict]) -> dict:
    ops, refs, cells, km_by_op = [], [], {}, {}
    oi, ri = {}, {}
    for e in elements:
        if e.get("type") != "way" or not e.get("geometry"):
            continue
        tags = e.get("tags") or {}
        op = canon_op(tags.get("operator", ""))
        ref = (tags.get("ref") or "").split(";")[0].strip()
        if op not in oi:
            oi[op] = len(ops); ops.append(op)
        if ref not in ri:
            ri[ref] = len(refs); refs.append(ref)
        pts = [(g["lon"], g["lat"]) for g in e["geometry"]]
        for a, b in zip(pts, pts[1:]):
            d = _km(a, b)
            km_by_op[op] = km_by_op.get(op, 0) + d
            n = max(1, int(d / 0.05))
            for k in range(n + 1):
                t = k / n
                c = _cell(a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t)
                cells.setdefault(c, [oi[op], ri[ref]])
    return {"ops": ops, "refs": refs, "cells": cells, "km_by_op": {k: round(v / 2) for k, v in km_by_op.items()}}


def _tiles(n=3):
    s, w, nn, e = BBOX
    for i in range(n):
        for j in range(n):
            yield (s + (nn - s) * i / n, w + (e - w) * j / n, s + (nn - s) * (i + 1) / n, w + (e - w) * (j + 1) / n)


async def fetch_network() -> List[dict]:
    elements = []
    async with httpx.AsyncClient(timeout=200.0, headers={"User-Agent": UA}) as client:
        for (s, w, n, e) in _tiles():
            q = (f'[out:json][timeout:180];area["ISO3166-1"="IT"][admin_level=2]->.a;'
                 f'way(area.a)["highway"="motorway"]["toll"="yes"]({s:.3f},{w:.3f},{n:.3f},{e:.3f});out tags geom;')
            last = None
            for url in MIRRORS:
                try:
                    r = await client.post(url, data={"data": q})
                    if r.status_code == 200 and r.text.lstrip().startswith("{"):
                        elements += r.json().get("elements", [])
                        last = None
                        break
                    last = f"{url} HTTP {r.status_code}"
                except Exception as ex:
                    last = f"{url} {type(ex).__name__}"
                await asyncio.sleep(5)
            if last:
                raise RuntimeError(f"Overpass unavailable for a tile: {last}")
            await asyncio.sleep(3)
    return elements


def validate(net: dict) -> List[str]:
    total = sum(net["km_by_op"].values())
    probs = []
    if total < 4000:
        probs.append(f"only {total} km of tolled motorway (expected ~6000)")
    if not any(re.search("autostrade per", o, re.I) for o in net["ops"]):
        probs.append("Autostrade per l'Italia missing")
    return probs


def sync_rate_items(db: Session, ops: List[str]):
    """One toll_items row per operator so the admin can review/override the rate."""
    have = {t.source_id: t for t in db.query(TollItem).filter(TollItem.source == "it_rate")}
    for op in ops:
        kind, val, src, ok = _rate_for(op)
        t = have.get(op)
        if not t:
            db.add(TollItem(source="it_rate", source_id=op, country="IT", type="rate_" + kind, name=op, price_eur=val,
                            currency="EUR", info=f"Class A, VAT incl. Source: {src}", reviewed=ok, hidden=False,
                            gone=False, fetched_at=_now()))
        elif t.price_eur != val:
            t.prev_price_eur, t.price_eur, t.reviewed, t.changed_at = t.price_eur, val, False, _now()
            t.info = f"Class A, VAT incl. Source: {src}"


def active_list(db: Session) -> Optional[TollPriceList]:
    return db.query(TollPriceList).filter(TollPriceList.country == "IT", TollPriceList.active.is_(True)) \
             .order_by(TollPriceList.id.desc()).first()


_cache: Dict[int, dict] = {}


def _net(pl: TollPriceList) -> dict:
    if pl.id not in _cache:
        _cache.clear()
        _cache[pl.id] = json.loads(pl.data)
    return _cache[pl.id]


async def check(db: Session, force: bool = False) -> dict:
    st = db.get(DataImport, IMPORT_NAME) or DataImport(name=IMPORT_NAME)
    db.add(st)
    st.last_attempt_at = _now()
    db.commit()
    try:
        net = rasterise(await fetch_network())
        probs = validate(net)
        if probs:
            raise ValueError("network not usable: " + "; ".join(probs))
        db.query(TollPriceList).filter(TollPriceList.country == "IT", TollPriceList.active.is_(True)) \
          .update({"active": False}, synchronize_session=False)
        db.add(TollPriceList(country="IT", source_url="OpenStreetMap via Overpass", sha256=None,
                             valid_from=f"network {_now().date().isoformat()}",
                             data=json.dumps(net, ensure_ascii=False, separators=(",", ":")), fetched_at=_now(), active=True))
        sync_rate_items(db, net["ops"])
        st.last_ok_at, st.last_error = _now(), None
        st.last_count, st.last_changes = len(net["cells"]), 1
        db.commit()
        print(f"✓ Italian tolled network: {sum(net['km_by_op'].values())} km, {len(net['ops'])} operators")
        return {"ok": True, "changed": True, "km": sum(net["km_by_op"].values()), "operators": len(net["ops"])}
    except Exception as e:
        db.rollback()
        st = db.get(DataImport, IMPORT_NAME)
        st.last_error = f"{type(e).__name__}: {e}"[:500]
        db.commit()
        print(f"❌ Italian tolled network: {type(e).__name__}")
        return {"ok": False, "error": st.last_error}


def summary(net: dict) -> str:
    return f"{sum(net['km_by_op'].values())} km of tolled motorway, {len(net['ops'])} operators (OpenStreetMap, ODbL)"


def missing_coords(net: dict) -> List[str]:
    """For the admin: operators priced with the default rate."""
    return [op for op in net.get("ops", []) if not _rate_for(op)[3] and net["km_by_op"].get(op, 0) >= 5]


# ---------- trip ----------

def _rates(db: Session) -> Dict[str, Tuple[str, float, bool]]:
    """operator -> (kind, value, checked); checked = source rate verified or set by the admin."""
    out = {}
    for t in db.query(TollItem).filter(TollItem.source == "it_rate", TollItem.hidden.is_(False)):
        own = t.override_price_eur is not None
        out[t.source_id] = ("flat" if t.type == "rate_flat" else "km", t.override_price_eur if own else t.price_eur,
                            own or _rate_for(t.source_id)[3])
    return out


def _round10(x: float) -> float:
    return math.floor(x * 10 + 0.5) / 10


def _lookup(cells: dict, lat: float, lng: float):
    ix, iy = math.floor(lng / CELL), math.floor(lat / CELL)
    c = cells.get(f"{ix}:{iy}")
    if c:
        return c
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            c = cells.get(f"{ix + dx}:{iy + dy}")
            if c:
                return c
    return None


def trip_tolls(db: Session, legs: List[dict]) -> Optional[dict]:
    pl = active_list(db)
    if not pl:
        return None
    net = _net(pl)
    cells, ops, refs = net["cells"], net["ops"], net["refs"]
    rates = _rates(db)
    runs, total = [], 0.0
    for leg in legs:
        pts = leg["coords"]
        cur, gap = None, 0.0
        segs = []
        for a, b in zip(pts, pts[1:]):
            d = _km(a, b)
            n = max(1, int(d / 0.1))
            for k in range(n):
                t = (k + 0.5) / n
                hit = _lookup(cells, a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t)
                step = d / n
                if hit:
                    if cur is None:
                        cur = {"km": {}, "refs": [], "len": 0.0}
                    op = ops[hit[0]]
                    cur["km"][op] = cur["km"].get(op, 0) + step + gap
                    cur["len"] += step + gap
                    gap = 0.0
                    r = refs[hit[1]]
                    if r and (not cur["refs"] or cur["refs"][-1] != r):
                        cur["refs"].append(r)
                elif cur is not None:
                    gap += step
                    if gap > GAP_KM:
                        segs.append(cur); cur, gap = None, 0.0
        if cur is not None:
            segs.append(cur)
        for sgm in segs:
            if sgm["len"] < MIN_RUN_KM:
                continue
            cost, unverified = 0.0, False
            for op, km in sgm["km"].items():
                r = rates.get(op)
                kind, val, ok = r if r else (_rate_for(op)[0], _rate_for(op)[1], _rate_for(op)[3])
                cost += val if kind == "flat" else km * val
                unverified |= not ok
            eur = _round10(cost)
            seen = []
            for r in sgm["refs"]:
                if r not in seen:
                    seen.append(r)
            runs.append({"from": " → ".join(seen[:4]) or "motorway", "to": None, "eur": eur, "day": leg["day"],
                         "km": round(sgm["len"]), "operators": sorted(sgm["km"], key=lambda o: -sgm["km"][o]),
                         "rate_checked": not unverified})
            total += eur
    return {"country": "IT", "estimate": True, "runs": runs, "total_eur": round(total, 2), "currency": "EUR",
            "valid_from": pl.valid_from, "source": SOURCE_PAGE,
            "note": "Estimate: km on tolled motorways (OpenStreetMap) x 2026 class A rate of each operator; "
                    "mountain sections and open-system barriers can differ."}
