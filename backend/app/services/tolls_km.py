"""
Per-km toll ESTIMATES for countries without a free official entry/exit price list (Italy, France).

toll ≈ km on the operator's tolled motorway × the operator's rate for a car (VAT included), rounded per ticket.
(1) The tolled network comes from OpenStreetMap (highway=motorway + toll=yes, tags operator/ref), downloaded from
    Overpass tile by tile (the public servers are often overloaded: progress is saved after every tile and the next
    attempt continues) and rasterised into ~200 m cells -> operator/ref. ODbL.
(2) Rates per operator: published rates where found (RATES of the country), the rest use a default; every operator
    gets a toll_items row (type rate_km / rate_flat) so the admin can set "Our €" with the usual tools.
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

MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter",
           "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]
CELL = 0.002                    # degrees (~150-220 m)
TILE = 1.5                      # degrees; small tiles = light queries for the busy public servers
ATTEMPT_S = 240                 # one attempt works at most ~4 min, then saves progress
MIN_RUN_KM = 2.0
GAP_KM = 1.0


def _now():
    return datetime.now(timezone.utc)


def canon_op(op: str) -> str:
    s = re.sub(r"\s+", " ", (op or "").replace("' ", "'")).strip(" .")
    return s or "unknown operator"


def _cell(lat: float, lng: float) -> str:
    return f"{math.floor(lng / CELL)}:{math.floor(lat / CELL)}"


def _km(a, b) -> float:
    return math.hypot((b[0] - a[0]) * math.cos(math.radians(a[1])) * 111.32, (b[1] - a[1]) * 110.57)


def empty_net() -> dict:
    return {"ops": [], "refs": [], "cells": {}, "km_by_op": {}}


def merge(net: dict, elements: List[dict], only_cc: Optional[str] = None, seen: Optional[set] = None) -> int:
    """Add tolled motorway ways to the grid (ways outside the country - neighbours in the same tile - skipped)."""
    from app.services.fuel import country_at
    ops, refs, cells, km_by_op = net["ops"], net["refs"], net["cells"], net["km_by_op"]
    oi = {o: k for k, o in enumerate(ops)}
    ri = {r: k for k, r in enumerate(refs)}
    added = 0
    for e in elements:
        if e.get("type") != "way" or not e.get("geometry"):
            continue
        if seen is not None:                  # a way crossing a tile border comes twice
            if e.get("id") in seen:
                continue
            seen.add(e.get("id"))
        g = e["geometry"]
        mid = g[len(g) // 2]
        if only_cc and country_at(mid["lon"], mid["lat"], only_cc) not in (only_cc, None):   # None: coast (1:50m outline)
            continue
        tags = e.get("tags") or {}
        op = canon_op(tags.get("operator", ""))
        ref = (tags.get("ref") or "").split(";")[0].strip()
        if op not in oi:
            oi[op] = len(ops); ops.append(op)
        if ref not in ri:
            ri[ref] = len(refs); refs.append(ref)
        pts = [(p["lon"], p["lat"]) for p in g]
        for a, b in zip(pts, pts[1:]):
            d = _km(a, b)
            km_by_op[op] = km_by_op.get(op, 0) + d / 2          # two carriageways per motorway
            n = max(1, int(d / 0.05))
            for k in range(n + 1):
                t = k / n
                cells.setdefault(_cell(a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t), [oi[op], ri[ref]])
        added += 1
    return added


def rasterise(elements: List[dict]) -> dict:
    net = empty_net()
    merge(net, elements)
    net["km_by_op"] = {k: round(v) for k, v in net["km_by_op"].items()}
    return net


def _round_to(x: float, step: float) -> float:
    return math.floor(x / step + 0.5) * step


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


async def fetch_tile(client: httpx.AsyncClient, tile) -> Tuple[Optional[List[dict]], List[str]]:
    s, w, n, e = tile
    q = f'[out:json][timeout:120];way["highway"="motorway"]["toll"="yes"]({s},{w},{n},{e});out tags geom;'
    errs = []
    for url in MIRRORS:
        host = url.split("/")[2]
        try:
            r = await client.post(url, data={"data": q})
            if r.status_code == 200 and r.text.lstrip().startswith("{"):
                return r.json().get("elements", []), errs
            errs.append(f"{host} HTTP {r.status_code}")
        except Exception as ex:
            errs.append(f"{host} {type(ex).__name__}")
        await asyncio.sleep(3)
    return None, errs


class KmTolls:
    PRICE_URL = MIRRORS[0]
    CHECK_EVERY_H = 24 * 30
    RETRY_H = 1                  # unfinished download: continue every hour
    ATTENTION = "operators priced with the default rate - set “Our €” for them below (type rate_km)"

    def __init__(self, cc: str, name: str, bbox, rates, default_rate: float, source_page: str, note: str,
                 min_km_total: float, must_have: str, round_step: float = 0.1, rate_source: Optional[str] = None):
        self.cc, self.name, self.bbox, self.rates, self.default_rate = cc, name, bbox, rates, default_rate
        self.SOURCE_PAGE, self.note, self.min_km_total, self.must_have = source_page, note, min_km_total, must_have
        self.round_step = round_step
        self.IMPORT_NAME = f"tolls_{cc.lower()}"
        self.rate_source = rate_source or f"{cc.lower()}_rate"
        self._cache: Dict[int, dict] = {}

    # ---------- rates ----------
    def rate_for(self, op: str) -> Tuple[str, float, str, bool]:
        for rx, kind, val, src, ok in self.rates:
            if re.search(rx, op or "", re.I):
                return kind, val, src, ok
        return "km", self.default_rate, "default (national average), not verified", False

    def sync_rate_items(self, db: Session, ops: List[str]):
        have = {t.source_id: t for t in db.query(TollItem).filter(TollItem.source == self.rate_source)}
        for op in ops:
            kind, val, src, ok = self.rate_for(op)
            t = have.get(op)
            if not t:
                db.add(TollItem(source=self.rate_source, source_id=op, country=self.cc, type="rate_" + kind, name=op,
                                price_eur=val, currency="EUR", info=f"Car, VAT incl. Source: {src}", reviewed=ok,
                                hidden=False, gone=False, fetched_at=_now()))
            elif t.price_eur != val:
                t.prev_price_eur, t.price_eur, t.reviewed, t.changed_at = t.price_eur, val, False, _now()
                t.info = f"Car, VAT incl. Source: {src}"

    def _rates(self, db: Session) -> Dict[str, Tuple[str, float, bool]]:
        out = {}
        for t in db.query(TollItem).filter(TollItem.source == self.rate_source, TollItem.hidden.is_(False)):
            own = t.override_price_eur is not None
            out[t.source_id] = ("flat" if t.type == "rate_flat" else "km", t.override_price_eur if own else t.price_eur,
                                own or self.rate_for(t.source_id)[3])
        return out

    # ---------- network ----------
    def tiles(self) -> List[Tuple[float, float, float, float]]:
        from app.services.fuel import country_at
        s0, w0, n0, e0 = self.bbox
        out, lat = [], s0
        while lat < n0:
            lon = w0
            while lon < e0:
                if any(country_at(lon + TILE * i / 6, lat + TILE * j / 6, self.cc) == self.cc for i in range(7) for j in range(7)):
                    out.append((round(lat, 3), round(lon, 3), round(min(lat + TILE, n0), 3), round(min(lon + TILE, e0), 3)))
                lon += TILE
            lat += TILE
        return out

    def validate(self, net: dict) -> List[str]:
        total = sum(net["km_by_op"].values())
        probs = []
        if total < self.min_km_total:
            probs.append(f"only {total} km of tolled motorway (expected more than {self.min_km_total})")
        if not any(re.search(self.must_have, o, re.I) for o in net["ops"]):
            probs.append(f"operator {self.must_have} missing")
        return probs

    def active_list(self, db: Session) -> Optional[TollPriceList]:
        return db.query(TollPriceList).filter(TollPriceList.country == self.cc, TollPriceList.active.is_(True)) \
                 .order_by(TollPriceList.id.desc()).first()

    def _partial(self, db: Session) -> Optional[TollPriceList]:
        return db.query(TollPriceList).filter(TollPriceList.country == self.cc, TollPriceList.active.is_(False),
                                              TollPriceList.valid_from == "partial").order_by(TollPriceList.id.desc()).first()

    def _net(self, pl: TollPriceList) -> dict:
        if pl.id not in self._cache:
            self._cache.clear()
            self._cache[pl.id] = json.loads(pl.data)
        return self._cache[pl.id]

    async def check(self, db: Session, force: bool = False) -> dict:
        st = db.get(DataImport, self.IMPORT_NAME) or DataImport(name=self.IMPORT_NAME)
        db.add(st)
        st.last_attempt_at = _now()
        db.commit()
        try:
            all_tiles = self.tiles()
            part = self._partial(db)
            if not part:
                part = TollPriceList(country=self.cc, source_url="OpenStreetMap via Overpass", valid_from="partial",
                                     active=False, data=json.dumps({"done": [], "net": empty_net()}), fetched_at=_now())
                db.add(part)
                db.commit()
            state = json.loads(part.data)
            done = set(map(tuple, state["done"]))
            seen = set(state.get("seen", []))
            todo = [t for t in all_tiles if t not in done]
            loop = asyncio.get_event_loop()
            t0, stopped = loop.time(), None
            async with httpx.AsyncClient(timeout=150.0, headers={"User-Agent": UA}) as client:
                for t in todo:
                    if loop.time() - t0 > ATTEMPT_S:
                        stopped = "time limit of one attempt"
                        break
                    els, errs = await fetch_tile(client, t)
                    if els is None:
                        stopped = "Overpass busy: " + "; ".join(errs)
                        break
                    merge(state["net"], els, only_cc=self.cc, seen=seen)
                    state["done"].append(list(t))
                    state["seen"] = sorted(x for x in seen if x is not None)
                    part.data = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
                    part.fetched_at = _now()
                    db.commit()
                    await asyncio.sleep(2)
            n_done = len(state["done"])
            if n_done < len(all_tiles):
                st.last_error = (f"In progress: {n_done}/{len(all_tiles)} map tiles downloaded ({stopped}). "
                                 f"Continues automatically every hour, or press Check now.")[:500]
                db.commit()
                return {"ok": False, "error": st.last_error, "done": n_done, "tiles": len(all_tiles)}
            net = state["net"]
            net["km_by_op"] = {k: round(v) for k, v in net["km_by_op"].items()}
            probs = self.validate(net)
            if probs:
                db.delete(part)
                db.commit()
                raise ValueError("network not usable: " + "; ".join(probs))
            db.query(TollPriceList).filter(TollPriceList.country == self.cc, TollPriceList.active.is_(True)) \
              .update({"active": False}, synchronize_session=False)
            part.data = json.dumps(net, ensure_ascii=False, separators=(",", ":"))
            part.valid_from = f"network {_now().date().isoformat()}"
            part.active = True
            self.sync_rate_items(db, net["ops"])
            st.last_ok_at, st.last_error = _now(), None
            st.last_count, st.last_changes = len(net["cells"]), 1
            db.commit()
            print(f"✓ {self.name} tolled network: {sum(net['km_by_op'].values())} km, {len(net['ops'])} operators")
            return {"ok": True, "changed": True, "km": sum(net["km_by_op"].values()), "operators": len(net["ops"])}
        except Exception as e:
            db.rollback()
            st = db.get(DataImport, self.IMPORT_NAME)
            st.last_error = f"{type(e).__name__}: {e}"[:500]
            db.commit()
            print(f"❌ {self.name} tolled network: {type(e).__name__}")
            return {"ok": False, "error": st.last_error}

    def summary(self, net: dict) -> str:
        return f"{sum(net['km_by_op'].values())} km of tolled motorway, {len(net['ops'])} operators (OpenStreetMap, ODbL)"

    def missing_coords(self, net: dict) -> List[str]:
        """For the admin: operators priced with the default rate."""
        return [op for op in net.get("ops", []) if not self.rate_for(op)[3] and net["km_by_op"].get(op, 0) >= 5]

    # ---------- trip ----------
    def trip_tolls(self, db: Session, legs: List[dict]) -> Optional[dict]:
        pl = self.active_list(db)
        if not pl:
            return None
        net = self._net(pl)
        cells, ops, refs = net["cells"], net["ops"], net["refs"]
        rates = self._rates(db)
        runs, total = [], 0.0
        for leg in legs:
            pts = leg["coords"]
            cur, gap, segs = None, 0.0, []
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
                    kind, val, ok = r if r else (self.rate_for(op)[0], self.rate_for(op)[1], self.rate_for(op)[3])
                    cost += val if kind == "flat" else km * val
                    unverified |= not ok
                eur = round(_round_to(cost, self.round_step), 2)
                seen = []
                for r in sgm["refs"]:
                    if r not in seen:
                        seen.append(r)
                runs.append({"from": " → ".join(seen[:4]) or "motorway", "to": None, "eur": eur, "day": leg["day"],
                             "km": round(sgm["len"]), "operators": sorted(sgm["km"], key=lambda o: -sgm["km"][o]),
                             "rate_checked": not unverified})
                total += eur
        return {"country": self.cc, "estimate": True, "runs": runs, "total_eur": round(total, 2), "currency": "EUR",
                "valid_from": pl.valid_from, "source": self.SOURCE_PAGE, "note": self.note}
