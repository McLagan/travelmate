"""
Countries with toll plazas on the motorway itself (Greece, North Macedonia, Albania, Montenegro): every plaza has
its own price and you pay when you pass it (frontal plazas on the main road, ramp/lateral plazas on some exits).

Prices come from the daily fuel-prices.eu import (toll_items type gate, CC BY 4.0) - so admin overrides/hiding
apply. Their coordinates are rough (often 0.01-0.1 degree), so once a day each plaza is matched to the nearest
OpenStreetMap toll booth (barrier=toll_booth, Overpass) within a radius that depends on the precision, preferring
a booth whose name looks like the plaza name (Greek names are transliterated). A route pays a plaza when it passes
within 150 m of a main-road plaza or 70 m of a ramp plaza.
"""

import json
import math
import re
import unicodedata
from datetime import datetime, timezone
from typing import Dict, List, Optional

import httpx
from sqlalchemy.orm import Session

from app.models.toll import TollItem, TollPriceList, DataImport
from app.services.fuel import UA
from app.services.tolls_km import MIRRORS
from app.services.tolls_rs import _pos_on_line

COUNTRIES = ["GR", "MK", "AL", "ME"]
NAMES = {"GR": "Greece", "MK": "North Macedonia", "AL": "Albania", "ME": "Montenegro"}
MAIN_KM, RAMP_KM = 0.15, 0.07
GREEK = dict(zip("αβγδεζηθικλμνξοπρσςτυφχψω", ["a", "v", "g", "d", "e", "z", "i", "th", "i", "k", "l", "m", "n", "x",
                                                   "o", "p", "r", "s", "s", "t", "y", "f", "ch", "ps", "o"]))
GREEK_DI = [("ου", "ou"), ("αυ", "av"), ("ευ", "ev"), ("μπ", "b"), ("ντ", "d"), ("γκ", "g")]
# Cyrillic -> the Latin letters left after stripping diacritics (ž -> z, č -> c ...), as in "Želino"/"Желино"
CYR = dict(zip("абвгдѓежзѕијклљмнњопрстќуфхцчџшћђ", ["a", "b", "v", "g", "d", "g", "e", "z", "z", "dz", "i", "j", "k",
                                                         "l", "lj", "m", "n", "nj", "o", "p", "r", "s", "t", "k", "u", "f",
                                                         "h", "c", "c", "dz", "s", "c", "dj"]))
SKIP_WORDS = {"toll", "station", "ramp", "lateral", "naplatna", "stanica", "diodia", "metopika", "metopikos", "plevrika", "plevrikos", "plevrikes", "pleyrika",
              "pleyrikos", "odos", "attiki", "entry", "exit", "patarina", "highway"}
# fuel-prices.eu name -> words of the OpenStreetMap booth (where the names have nothing in common)
ALIAS = {"princess xenia": "smokovac", "thumane kashar": "g2 infra"}
# records that are not one place on the map: left out on purpose (not "missing")
#   Attiki Odos (Athens Ring) - the general fare; the entries are separate records
#   Thermopyles Toll (A1)     - no toll booth of that name on OpenStreetMap near its rough location (27.11.2026)
NOT_A_PLACE = {"attiki odos (athens ring)", "thermopyles toll (a1)"}
# all plazas of one closed ring are paid once per trip (Attiki Odos: one fee per entry)
ONCE = {"attiki odos": "Attiki Odos"}


def _now():
    return datetime.now(timezone.utc)


def latin(s: str) -> str:
    t = unicodedata.normalize("NFD", (s or "").lower().replace("đ", "dj"))
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    t = re.sub(r"([αε])υ(?=[θκξπστφχψ])", lambda m: m.group(1) + "φ", t)   # ευ/αυ before a voiceless consonant: ef/af
    for a, b in GREEK_DI:
        t = t.replace(a, b)
    t = "".join(GREEK.get(c, CYR.get(c, c)) for c in t)
    t = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", t)).strip()
    for a, b in ALIAS.items():
        if a in t:
            t += " " + b
    return t


def _norm_word(w: str) -> str:
    """Spelling variants of transliterations: Messolonghi / Mesologgiou, Evaggelismos / Evangelismos."""
    w = w.replace("gh", "g").replace("ng", "g").replace("gk", "g")
    return re.sub(r"(.)\1+", r"\1", w)


def words(s: str) -> List[str]:
    return [_norm_word(w) for w in latin(s).split()
            if len(w) >= 3 and w not in SKIP_WORDS and not re.match(r"^[ae]\d", w)]


def name_score(a: str, b_names: List[str]) -> int:
    """Longest common prefix of any meaningful word pair (>= 4 letters counts)."""
    best = 0
    wa = words(a)
    for bn in b_names:
        for x in wa:
            for y in words(bn):
                n = 0
                while n < min(len(x), len(y)) and x[n] == y[n]:
                    n += 1
                if n >= 4 or (n == 3 and len(x) == 3):          # short names (Rio) must match as a whole word start
                    best = max(best, n)
    return best


def gate_kind(name: str) -> str:
    return "ramp" if re.search(r"ramp|lateral|entry", name or "", re.I) else "main"


def booth_kind(names: List[str]) -> Optional[str]:
    """Greek booths say it in the name: Πλευρικά (lateral, on the ramp) / Μετωπικά (frontal, across the road)."""
    t = latin(" ".join(names))
    if re.search(r"plevrik|pleyrik|lateral|ramp", t):
        return "ramp"
    if re.search(r"metopik|frontal|mainline", t):
        return "main"
    return None


def _decimals(v: float) -> int:
    for d in range(0, 5):
        if abs(round(v, d) - v) < 1e-9:
            return d
    return 5


def _km(a, b) -> float:
    return math.hypot((b[1] - a[1]) * math.cos(math.radians(a[0])) * 111.32, (b[0] - a[0]) * 110.57)


async def fetch_booths(cc: str) -> Optional[List[dict]]:
    from app.services.fuel import _borders
    b = next((c["bbox"] for c in _borders() if c["cc"] == cc), None)
    if not b:
        return []
    q = (f'[out:json][timeout:90];(node["barrier"="toll_booth"]({b[1]},{b[0]},{b[3]},{b[2]});'
         f'way["barrier"="toll_booth"]({b[1]},{b[0]},{b[3]},{b[2]}););out center tags;')
    async with httpx.AsyncClient(timeout=120.0, headers={"User-Agent": UA}) as client:
        for url in MIRRORS:
            try:
                r = await client.post(url, data={"data": q})
                if r.status_code == 200 and r.text.lstrip().startswith("{"):
                    out = []
                    for e in r.json().get("elements", []):
                        lat = e.get("lat", (e.get("center") or {}).get("lat"))
                        lng = e.get("lon", (e.get("center") or {}).get("lon"))
                        t = e.get("tags") or {}
                        if lat is None:
                            continue
                        out.append({"lat": lat, "lng": lng, "names": [v for k, v in t.items() if k.startswith("name") or k == "operator"]})
                    return out
            except Exception:
                pass
    return None


def match(gates: List[TollItem], booths: List[dict], cc: str) -> dict:
    """The coordinates of fuel-prices.eu are often several km off (even with 4 decimals), so the booth is found by
    name (up to 30 km away; a weak name match only within 8 km); a booth without a name match only within 0.5 km.
    Each booth (a plaza = all booths within 300 m) goes to one gate only, best matches first."""
    from app.services.fuel import country_at
    booths = [b for b in booths if country_at(b["lng"], b["lat"], cc) in (cc, None)]   # None: coast, outside the 1:50m outline
    cands = []
    for gi, g in enumerate(gates):
        for bi, b in enumerate(booths):
            d = _km((g.lat, g.lng), (b["lat"], b["lng"]))
            if d > 30:
                continue
            sc = name_score(re.sub(r"\(.*?\)", " ", g.name), b["names"])   # "(Patras)" is context, not the name
            if (sc == 0 and d > 0.5) or (0 < sc < 5 and d > 8):
                continue
            bk = booth_kind(b["names"])
            cands.append((-sc, 1 if bk and bk != gate_kind(g.name) else 0, d, gi, bi))
    cands.sort()
    used, done, out = set(), set(), []
    for nsc, _mm, d, gi, bi in cands:
        if gi in done or bi in used:
            continue
        g, b = gates[gi], booths[bi]
        done.add(gi)
        for k, o in enumerate(booths):
            if _km((b["lat"], b["lng"]), (o["lat"], o["lng"])) < 0.3:
                used.add(k)
        out.append({"id": g.source_id, "name": g.name, "lat": round(b["lat"], 6), "lng": round(b["lng"], 6),
                    "ramp": (booth_kind(b["names"]) or gate_kind(g.name)) == "ramp", "dist_km": round(d, 2),
                    "osm": (b["names"] or [""])[0], "by_name": nsc < 0})
    unmatched = []
    for gi, g in enumerate(gates):
        if gi in done or g.name.lower() in NOT_A_PLACE:
            continue
        if min(_decimals(g.lat), _decimals(g.lng)) >= 3:      # no booth on the map, but a fairly precise location
            out.append({"id": g.source_id, "name": g.name, "lat": g.lat, "lng": g.lng, "ramp": gate_kind(g.name) == "ramp",
                        "dist_km": 0, "osm": "", "by_name": False, "approx": True})
        else:
            unmatched.append(g.name)
    return {"gates": out, "unmatched": sorted(unmatched)}


class GateCountry:
    PRICE_URL = "https://www.fuel-prices.eu/api/toll/get_json.php"
    SOURCE_PAGE = "https://www.fuel-prices.eu/tolls/"
    CHECK_EVERY_H = 24 * 7
    RETRY_H = 3
    ATTENTION = "plazas not found on the map (not priced)"

    def __init__(self, cc: str):
        self.cc = cc
        self.IMPORT_NAME = f"tolls_gates_{cc.lower()}"

    def _gates(self, db: Session) -> List[TollItem]:
        return db.query(TollItem).filter(TollItem.country == self.cc, TollItem.type == "gate",
                                         TollItem.gone.is_(False), TollItem.lat.isnot(None)).all()

    def active_list(self, db: Session) -> Optional[TollPriceList]:
        return db.query(TollPriceList).filter(TollPriceList.country == self.cc, TollPriceList.active.is_(True)) \
                 .order_by(TollPriceList.id.desc()).first()

    async def check(self, db: Session, force: bool = False) -> dict:
        st = db.get(DataImport, self.IMPORT_NAME) or DataImport(name=self.IMPORT_NAME)
        db.add(st)
        st.last_attempt_at = _now()
        db.commit()
        try:
            gates = self._gates(db)
            if not gates:
                raise ValueError("no toll plazas for this country in the fuel-prices.eu import yet")
            booths = await fetch_booths(self.cc)
            if booths is None:
                raise RuntimeError("Overpass (OpenStreetMap) busy or unreachable, try later")
            res = match(gates, booths, self.cc)
            db.query(TollPriceList).filter(TollPriceList.country == self.cc, TollPriceList.active.is_(True)) \
              .update({"active": False}, synchronize_session=False)
            db.add(TollPriceList(country=self.cc, source_url=self.PRICE_URL, valid_from=f"matched {_now().date().isoformat()}",
                                 data=json.dumps(res, ensure_ascii=False), fetched_at=_now(), active=True))
            st.last_ok_at, st.last_error = _now(), None
            st.last_count, st.last_changes = len(res["gates"]), 1
            db.commit()
            return {"ok": True, "changed": True, "matched": len(res["gates"]), "unmatched": res["unmatched"]}
        except Exception as e:
            db.rollback()
            st = db.get(DataImport, self.IMPORT_NAME)
            st.last_error = f"{type(e).__name__}: {e}"[:500]
            db.commit()
            return {"ok": False, "error": st.last_error}

    def summary(self, data: dict) -> str:
        return f"{len(data['gates'])} toll plazas placed on the map ({sum(1 for g in data['gates'] if g['by_name'])} by name)"

    def missing_coords(self, data: dict) -> List[str]:
        return data.get("unmatched", [])

    def trip_tolls(self, db: Session, legs: List[dict]) -> Optional[dict]:
        pl = self.active_list(db)
        if not pl:
            return None
        placed = {g["id"]: g for g in json.loads(pl.data)["gates"]}
        items = {t.source_id: t for t in db.query(TollItem).filter(TollItem.country == self.cc, TollItem.type == "gate",
                                                                   TollItem.hidden.is_(False), TollItem.gone.is_(False))}
        runs, total = [], 0.0
        for leg in legs:
            hits = []
            for sid, g in placed.items():
                t = items.get(sid)
                if not t:
                    continue
                price = t.override_price_eur if t.override_price_eur is not None else t.price_eur
                if price is None:
                    continue
                p = _pos_on_line([g["lng"], g["lat"]], leg["coords"], RAMP_KM if g["ramp"] else MAIN_KM)
                if p is not None:
                    hits.append((p, t.name, price))
            once = set()
            for p, name, price in sorted(hits):
                grp = next((v for k, v in ONCE.items() if k in name.lower()), None)
                if grp:
                    if grp in once:
                        continue
                    once.add(grp)
                runs.append({"from": grp or re.sub(r"\s*\((A\d+|E\d+)[^)]*\)", "", name), "to": None, "eur": price,
                             "day": leg["day"], "km": 0})
                total += price
        return {"country": self.cc, "runs": runs, "total_eur": round(total, 2), "currency": "EUR",
                "valid_from": pl.valid_from, "source": self.SOURCE_PAGE + NAMES[self.cc].lower().replace(" ", "-") + "/",
                "note": f"Toll plazas on the road ({NAMES[self.cc]}), car. Data: fuel-prices.eu, CC BY 4.0; locations: OpenStreetMap."}


_providers: Dict[str, GateCountry] = {}


def provider(cc: str) -> GateCountry:
    if cc not in _providers:
        _providers[cc] = GateCountry(cc)
    return _providers[cc]
