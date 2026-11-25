"""
Serbia: exact motorway tolls from the official price list of Putevi Srbije.

The list (PDF, made from Excel, text inside) is published at a fixed address and changes about twice a year.
It has blocks "from <origin station>, section X - Y" with the toll from the origin to every station of the
section, for categories K1-a..K4, in RSD and in EUR (euro amounts are the official ones for paying in euro).
A trip between two stations of one block costs |price(exit) - price(entry)| (prices grow with the distance;
the origin itself costs 0). Station coordinates come from OpenStreetMap (data/rs_toll_stations.json).

Daily check: download, compare the SHA-256 with the active list, parse, validate, then activate the new list.
A list that cannot be parsed is not activated - the admin page shows the error and the old list stays in use.
"""

import hashlib
import io
import json
import math
import os
import re
import unicodedata
from datetime import datetime, timezone
from typing import Dict, List, Optional

import httpx
from sqlalchemy.orm import Session

from app.models.toll import TollPriceList, DataImport
from app.services.fuel import UA

PRICE_URL = "https://www.putevi-srbije.rs/images/pdf/cene_putarina_eng.pdf"
SOURCE_PAGE = "https://www.putevi-srbije.rs/index.php/en/kategorizacija-vozila-cenovnik-putarine-2"
IMPORT_NAME = "tolls_rs"
CATS = ["K1-a", "K1", "K2", "K3", "K4"]
CAR = "K1"                     # passenger car (K1-a = motorcycles)
MATCH_KM = 0.7                 # a station "is on the route" when the route passes this close

_STATIONS_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "rs_toll_stations.json")
_SYN = {"SOUTH": "JUG", "NORTH": "SEVER", "EAST": "ISTOK", "WEST": "ZAPAD", "CENTER": "CENTAR"}
_FIX = {"BELA PALANK": "BELA PALANKA"}


def _now():
    return datetime.now(timezone.utc)


def station_key(name: str) -> str:
    s = unicodedata.normalize("NFD", name or "").encode("ascii", "ignore").decode().upper()
    s = re.sub(r"[^A-Z0-9]+", " ", s).strip()
    s = " ".join(_SYN.get(w, w) for w in s.split())
    return _FIX.get(s, s)


def stations() -> Dict[str, List[List[float]]]:
    with open(_STATIONS_FILE, encoding="utf-8") as f:
        return json.load(f)["stations"]


# ---------- parsing ----------

def _num(tok: str) -> Optional[float]:
    t = tok.strip()
    if re.fullmatch(r"\d{1,3}(\.\d{3})*", t):          # RSD: 1.010
        return float(t.replace(".", ""))
    if re.fullmatch(r"\d+,\d{2}", t):                   # EUR: 1,50
        return float(t.replace(",", "."))
    return None


def parse_lines(lines: List[List[tuple]]) -> dict:
    """lines: in reading order, each a list of (x, text) left to right. Returns
    {valid_from, blocks: [{origin, section, rows: [{name, rsd: {cat: v}, eur: {cat: v}}]}]}."""
    blocks, valid_from, pending_origin = [], None, None
    for words in lines:
        text = " ".join(t for _, t in words).strip()
        m = re.search(r"Valid as:\s*(.+?\d{4})", text)
        if m:
            valid_from = m.group(1).strip()
            continue
        m = re.match(r"(Section|Deonica):\s*(.+)$", text)
        if m and pending_origin:
            blocks.append({"origin": pending_origin, "section": m.group(2).strip(), "rows": []})
            pending_origin = None
            continue
        nums = [(x, _num(t)) for x, t in words if _num(t) is not None]
        names = [t for x, t in words if _num(t) is None]
        if len(nums) >= 10 and blocks:
            nums.sort()
            xs = [x for x, _ in nums]
            # left five = RSD, right five = EUR (the name sits between them)
            rsd, eur = [v for _, v in nums[:5]], [v for _, v in nums[-5:]]
            name = " ".join(t for x, t in words if _num(t) is None and xs[4] < x < xs[-5]).strip()
            if name and all(v is not None for v in rsd + eur):
                blocks[-1]["rows"].append({"name": name, "key": station_key(name),
                                           "rsd": dict(zip(CATS, rsd)), "eur": dict(zip(CATS, eur))})
            continue
        # an origin title: one short upper-case line without digits (BEOGRAD, STARA PAZOVA...)
        if (names and not nums and text.isupper() and len(text) <= 30 and not re.search(r"\d", text)
                and not re.search(r"ROAD|SPECIAL|TOLL|SECTION|DEONICA", text)):
            pending_origin = text
    return {"valid_from": valid_from, "blocks": blocks}


def parse_pdf(data: bytes) -> dict:
    import pdfplumber
    lines: List[List[tuple]] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            words = sorted(page.extract_words(keep_blank_chars=False, use_text_flow=False, x_tolerance=1.5),
                           key=lambda w: w["top"])
            cur, top = None, None
            for w in words:                    # words less than 3 pt apart vertically = one line
                if cur is not None and w["top"] - top <= 3:
                    cur.append((w["x0"], w["text"]))
                else:
                    cur, top = [(w["x0"], w["text"])], w["top"]
                    lines.append(cur)
    lines = [sorted(l) for l in lines]
    return parse_lines(lines)


def validate(parsed: dict) -> List[str]:
    """Problems that block activation (empty = OK)."""
    probs = []
    bl = parsed.get("blocks") or []
    if len(bl) < 4:
        probs.append(f"only {len(bl)} sections found (expected 6)")
    for b in bl:
        if len(b["rows"]) < 5:
            probs.append(f"section {b['section']}: only {len(b['rows'])} stations")
        for r in b["rows"]:
            if not (0 < r["rsd"][CAR] < 20000):
                probs.append(f"{r['name']}: implausible price {r['rsd'][CAR]}")
    return probs


def missing_coords(parsed: dict) -> List[str]:
    st = stations()
    names = {station_key(b["origin"]) for b in parsed.get("blocks", [])} | \
            {r["key"] for b in parsed.get("blocks", []) for r in b["rows"]}
    return sorted(n for n in names if n not in st)


async def check(db: Session, force: bool = False) -> dict:
    """Download the list; activate it when it is new and parses. Returns a short report."""
    st = db.get(DataImport, IMPORT_NAME) or DataImport(name=IMPORT_NAME)
    db.add(st)
    st.last_attempt_at = _now()
    db.commit()
    try:
        async with httpx.AsyncClient(timeout=60.0, headers={"User-Agent": UA}, follow_redirects=True) as client:
            r = await client.get(PRICE_URL)
            r.raise_for_status()
            data = r.content
        sha = hashlib.sha256(data).hexdigest()
        active = active_list(db)
        if active and active.sha256 == sha and not force:
            st.last_ok_at, st.last_error = _now(), None
            db.commit()
            return {"ok": True, "changed": False, "valid_from": active.valid_from}
        parsed = parse_pdf(data)
        probs = validate(parsed)
        if probs:
            raise ValueError("price list not understood: " + "; ".join(probs[:5]))
        if active and active.sha256 == sha:
            active.data = json.dumps(parsed, ensure_ascii=False)
            active.fetched_at = _now()
        else:
            db.query(TollPriceList).filter(TollPriceList.country == "RS", TollPriceList.active.is_(True)) \
              .update({"active": False}, synchronize_session=False)
            db.add(TollPriceList(country="RS", source_url=PRICE_URL, sha256=sha, valid_from=parsed["valid_from"],
                                 data=json.dumps(parsed, ensure_ascii=False), fetched_at=_now(), active=True))
        st.last_ok_at, st.last_error = _now(), None
        st.last_count = sum(len(b["rows"]) for b in parsed["blocks"])
        st.last_changes = 1
        db.commit()
        print(f"✓ Serbian toll price list activated: valid from {parsed['valid_from']}, {st.last_count} rows")
        return {"ok": True, "changed": True, "valid_from": parsed["valid_from"],
                "sections": len(parsed["blocks"]), "rows": st.last_count, "missing_coords": missing_coords(parsed)}
    except Exception as e:
        db.rollback()
        st = db.get(DataImport, IMPORT_NAME)
        st.last_error = f"{type(e).__name__}: {e}"[:500]
        db.commit()
        print(f"❌ Serbian toll price list: {type(e).__name__}")
        return {"ok": False, "error": st.last_error}


def active_list(db: Session) -> Optional[TollPriceList]:
    return db.query(TollPriceList).filter(TollPriceList.country == "RS", TollPriceList.active.is_(True)) \
             .order_by(TollPriceList.id.desc()).first()


# ---------- trip ----------

def _seg_km(p, a, b):
    k = math.cos(math.radians(p[1])) * 111.32
    ax, ay, bx, by, px, py = a[0] * k, a[1] * 110.57, b[0] * k, b[1] * 110.57, p[0] * k, p[1] * 110.57
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t


def _pos_on_line(p, coords) -> Optional[float]:
    """km along the line of the closest approach to p, if within MATCH_KM."""
    best, pos, along = None, None, 0.0
    for a, b in zip(coords, coords[1:]):
        seg = math.hypot((b[0] - a[0]) * math.cos(math.radians(a[1])) * 111.32, (b[1] - a[1]) * 110.57)
        if min(a[0], b[0]) - 0.02 <= p[0] <= max(a[0], b[0]) + 0.02 and min(a[1], b[1]) - 0.02 <= p[1] <= max(a[1], b[1]) + 0.02:
            d, t = _seg_km(p, a, b)
            if d <= MATCH_KM and (best is None or d < best):
                best, pos = d, along + t * seg
        along += seg
    return pos


def trip_tolls(db: Session, legs: List[dict]) -> Optional[dict]:
    """Toll stations the route passes, cut into runs that stay inside one price-list section; each run costs
    |price(last) - price(first)|. None when there is no active price list."""
    pl = active_list(db)
    if not pl:
        return None
    data = json.loads(pl.data)
    st = stations()
    # station -> {block index: (rsd, eur)}  (origin of a block = 0)
    where: Dict[str, Dict[int, tuple]] = {}
    for i, b in enumerate(data["blocks"]):
        where.setdefault(station_key(b["origin"]), {})[i] = (0.0, 0.0)
        for r in b["rows"]:
            where.setdefault(r["key"], {})[i] = (r["rsd"][CAR], r["eur"][CAR])
    runs_out, total_rsd, total_eur = [], 0.0, 0.0
    for leg in legs:
        hits = []
        for key, pts in st.items():
            if key not in where:
                continue
            pos = [p for p in (_pos_on_line([lng, lat], leg["coords"]) for lat, lng in pts) if p is not None]
            if pos:
                hits.append((min(pos), key))
        hits.sort()
        # greedy runs: keep going while the stations share a section
        i = 0
        while i < len(hits):
            blocks = set(where[hits[i][1]])
            j = i
            while j + 1 < len(hits) and blocks & set(where[hits[j + 1][1]]):
                blocks &= set(where[hits[j + 1][1]])
                j += 1
            if j > i:
                b = min(blocks)
                a, z = where[hits[i][1]][b], where[hits[j][1]][b]
                rsd, eur = abs(z[0] - a[0]), abs(z[1] - a[1])
                if rsd > 0:
                    runs_out.append({"from": hits[i][1].title(), "to": hits[j][1].title(), "section": data["blocks"][b]["section"],
                                     "rsd": rsd, "eur": eur, "day": leg["day"], "km": round(hits[j][0] - hits[i][0])})
                    total_rsd += rsd
                    total_eur += eur
            i = j + 1
    return {"country": "RS", "runs": runs_out, "total_rsd": total_rsd, "total_eur": round(total_eur, 2),
            "valid_from": pl.valid_from, "source": SOURCE_PAGE,
            "note": "Official price list of Putevi Srbije, category K1 (car). Paying in euro uses the euro amounts of the list."}
