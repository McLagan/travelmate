"""
Bosnia and Herzegovina (Federation): exact tolls on motorway A1 from the official price list of JP Autoceste FBiH
(PDF linked from https://www.jpautoceste.ba/cjenovnik/, changes rarely - last on 1 Nov 2026).
The PDF lists, per direction, every "from station -> to station" price for classes Ia, I, II, III, IV in KM (BAM)
with VAT; class I = car. Svilaj (border with Croatia) is a single barrier: one price per passage.
Prices are converted to EUR at the fixed currency-board rate 1 EUR = 1.95583 KM.
Station locations: OpenStreetMap toll booths matched by name (Overpass), refreshed with each check.
Not covered yet: motorways of Republika Srpska (Autoputevi RS: Banja Luka - Gradiška, Banja Luka - Doboj).
"""

import hashlib
import io
import json
import re
import unicodedata
from datetime import datetime, timezone
from typing import Dict, List, Optional

import httpx
from sqlalchemy.orm import Session

from app.models.toll import TollPriceList, DataImport
from app.services.fuel import UA
from app.services.tolls_rs import _pos_on_line

PAGE = "https://www.jpautoceste.ba/cjenovnik/"
PRICE_URL = PAGE
SOURCE_PAGE = PAGE
IMPORT_NAME = "tolls_ba"
KM_PER_EUR = 1.95583
CLASSES = ["Ia", "I", "II", "III", "IV"]
ATTENTION = "stations not found on the map (not priced)"
RETRY_H = 3
CHECK_EVERY_H = 72


def _now():
    return datetime.now(timezone.utc)


def key(name: str) -> str:
    s = (name or "").replace("đ", "dj").replace("Đ", "DJ")
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().upper()
    s = re.sub(r"\b(BNM|CNM|NM)\b", " ", s)
    return re.sub(r"[^A-Z0-9]+", " ", s).strip()


def _title(s: str) -> str:
    s = re.sub(r"^(BNM|ČNM)\s+", "", s.strip()).title()
    return re.sub(r"\b(Ii|Iii|Iv)\b", lambda m: m.group(1).upper(), s)


_NUM = re.compile(r"^\d{1,4}(\.\d+)?$")


def parse_lines(lines: List[List[str]]) -> dict:
    """lines: tokens of each text line in reading order."""
    pairs, names, open_ = {}, {}, {}
    origin = None
    for toks in lines:
        if "km" in toks and "Ia" in toks:                      # "BNM KAKANJ II km Ia I II III IV" = new origin
            nm = " ".join(toks[:toks.index("km")])
            if not key(nm):
                continue                                        # header row printed apart from the name
            origin = key(nm)
            names.setdefault(origin, _title(nm))
            continue
        nums = [t for t in toks if _NUM.match(t)]
        words = [t for t in toks if not _NUM.match(t)]
        if len(nums) == 6 and not words and origin:             # single barrier: "km Ia I II III IV" values only
            open_[origin] = float(nums[2])
            continue
        if len(nums) == 6 and words and origin and _NUM.match(toks[-1]):
            nm = " ".join(words)
            dest = key(nm)
            if not dest or dest == origin:
                continue
            names.setdefault(dest, re.sub(r"^(BNM|ČNM)\s+", "", nm))
            pairs[f"{origin}|{dest}"] = float(nums[2])          # km, Ia, I, ... -> class I
            continue
        t = " ".join(toks)
        if re.match(r"^(ČNM|BNM)\s+\S", t) and not nums:          # origin without the header row (single barrier)
            origin = key(t)
            names.setdefault(origin, _title(t))
    return {"pairs": pairs, "open": open_, "names": names}


def parse_pdf(data: bytes) -> dict:
    import pdfplumber
    lines = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages:
            words = sorted(page.extract_words(x_tolerance=1.5), key=lambda w: w["top"])
            cur, top = None, None
            for w in words:
                if cur is not None and w["top"] - top <= 3:
                    cur.append(w)
                else:
                    cur, top = [w], w["top"]
                    lines.append(cur)
    return parse_lines([[w["text"] for w in sorted(l, key=lambda w: w["x0"])] for l in lines])


def validate(parsed: dict) -> List[str]:
    probs = []
    if len(parsed["pairs"]) < 40:
        probs.append(f"only {len(parsed['pairs'])} price pairs (expected ~90)")
    p = parsed["pairs"].get("SARAJEVO SJEVER|ZEPCE")
    if p is None or not (5 < p < 30):
        probs.append(f"Sarajevo sjever - Zepce price implausible: {p}")
    return probs


# Stations that OpenStreetMap does not have under their price-list name (checked 27.11.2026):
# ŽEPČE - the booth is mapped as "Naplatna postaja Golubinja" (44.38786, 17.98589), 20 km after Zenica sjever as in
# the price list; TEŠANJ and USORA have no booths on the map - the motorway junctions Medakovo and Karuše are used
# (the route passes them on the motorway, which is what matters for pricing).
MANUAL = {"ZEPCE": [44.38786, 17.98589], "TESANJ": [44.65223, 18.01834], "USORA": [44.70321, 18.04256]}


def match_names(names: Dict[str, str], booths: List[dict]) -> Dict[str, List[float]]:
    """Booth whose (transliterated) name contains every word of the station name; the longest such name wins."""
    from app.services.fuel import country_at
    from app.services.tolls_gates import latin
    booths = [b for b in booths if country_at(b["lng"], b["lat"], "BA") in ("BA", None)]
    out = {}
    for k in names:
        ws = latin(k).split()
        best = None
        for b in booths:
            for n in b["names"]:
                bw = latin(n).split()
                if all(w in bw for w in ws):
                    extra = len(bw) - len(ws)
                    if best is None or extra < best[0]:
                        best = (extra, b)
        if best:
            out[k] = [round(best[1]["lat"], 6), round(best[1]["lng"], 6)]
        elif k in MANUAL:
            out[k] = MANUAL[k]
    return out


def active_list(db: Session) -> Optional[TollPriceList]:
    return db.query(TollPriceList).filter(TollPriceList.country == "BA", TollPriceList.active.is_(True)) \
             .order_by(TollPriceList.id.desc()).first()


async def check(db: Session, force: bool = False) -> dict:
    from app.services.tolls_gates import fetch_booths
    st = db.get(DataImport, IMPORT_NAME) or DataImport(name=IMPORT_NAME)
    db.add(st)
    st.last_attempt_at = _now()
    db.commit()
    try:
        async with httpx.AsyncClient(timeout=60.0, headers={"User-Agent": UA}, follow_redirects=True) as client:
            html = (await client.get(PAGE)).text
            links = re.findall(r'href="([^"]+Cjenovnik[^"]*\.pdf)"', html, re.I)
            if not links:
                raise ValueError("no price list PDF link on the page")
            pdf_url = links[0]
            r = await client.get(pdf_url)
            r.raise_for_status()
            data = r.content
        parsed = parse_pdf(data)
        probs = validate(parsed)
        if probs:
            raise ValueError("price list not understood: " + "; ".join(probs))
        active = active_list(db)
        old = json.loads(active.data) if active else {}
        booths = await fetch_booths("BA")
        coords = match_names(parsed["names"], booths) if booths else {}
        if not coords and old.get("coords"):
            coords = old["coords"]                               # Overpass busy: keep last known locations
        for k, v in MANUAL.items():
            if k in parsed["names"] and k not in coords:
                coords[k] = v
        parsed["coords"] = coords
        parsed["pdf"] = pdf_url
        sha = hashlib.sha256(data).hexdigest()
        db.query(TollPriceList).filter(TollPriceList.country == "BA", TollPriceList.active.is_(True)) \
          .update({"active": False}, synchronize_session=False)
        m = re.search(r"od-(\d+)\.(\d+)\.(\d{4})", pdf_url)
        valid = f"valid from {m.group(1)}.{m.group(2)}.{m.group(3)}" if m else "official price list"
        db.add(TollPriceList(country="BA", source_url=pdf_url, sha256=sha, valid_from=valid,
                             data=json.dumps(parsed, ensure_ascii=False), fetched_at=_now(), active=True))
        st.last_ok_at = _now()
        st.last_error = None if coords else "Prices OK, station locations pending (Overpass busy) - retried automatically"
        st.last_count, st.last_changes = len(parsed["pairs"]), 1
        db.commit()
        return {"ok": True, "changed": True, "pairs": len(parsed["pairs"]), "missing_coords": missing_coords(parsed)}
    except Exception as e:
        db.rollback()
        st = db.get(DataImport, IMPORT_NAME)
        st.last_error = f"{type(e).__name__}: {e}"[:500]
        db.commit()
        return {"ok": False, "error": st.last_error}


def summary(data: dict) -> str:
    return f"{len(data['pairs'])} entry/exit prices, {len(data['names'])} stations, {len(data.get('coords', {}))} on the map"


def missing_coords(data: dict) -> List[str]:
    return sorted(data["names"][k] for k in data["names"] if k not in data.get("coords", {}))


def trip_tolls(db: Session, legs: List[dict]) -> Optional[dict]:
    pl = active_list(db)
    if not pl:
        return None
    data = json.loads(pl.data)
    pairs, names, open_, coords = data["pairs"], data["names"], data["open"], data.get("coords", {})
    runs, total = [], 0.0
    for leg in legs:
        hits = []
        for k, (lat, lng) in coords.items():
            p = _pos_on_line([lng, lat], leg["coords"])
            if p is not None:
                hits.append((p, k))
        hits.sort()
        i = 0
        while i < len(hits):
            a = hits[i][1]
            if a in open_:
                km_ = open_[a]
                runs.append({"from": names[a], "to": None, "km_bam": km_, "eur": round(km_ / KM_PER_EUR, 2), "day": leg["day"], "km": 0})
                total += km_ / KM_PER_EUR
                i += 1
                continue
            j = max((k for k in range(i + 1, len(hits)) if f"{a}|{hits[k][1]}" in pairs), default=None)
            if j is None:
                i += 1
                continue
            z = hits[j][1]
            p = pairs[f"{a}|{z}"]
            runs.append({"from": names[a], "to": names[z], "km_bam": p, "eur": round(p / KM_PER_EUR, 2), "day": leg["day"],
                         "km": round(hits[j][0] - hits[i][0])})
            total += p / KM_PER_EUR
            i = j + 1
    return {"country": "BA", "runs": runs, "total_eur": round(total, 2), "currency": "BAM",
            "valid_from": pl.valid_from, "source": PAGE,
            "note": "Official price list of JP Autoceste FBiH (motorway A1), class I (car). Republika Srpska motorways not included yet."}
