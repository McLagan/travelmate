"""
Points of interest along a multi-stop route.

Pipeline
  1. Build the real road route through all stops (OSRM) -> polyline.
  2. Put search circles along the polyline (spacing ~1.6 x radius).
  3. Query every configured source for every circle (in parallel, cached):
       - Geoapify Places      (key GEOAPIFY_API_KEY)     - OSM-based, good categories
       - OpenTripMap          (key OPENTRIPMAP_API_KEY)  - tourism focus, own popularity rate
       - Wikipedia geosearch  (no key)                   - used only as a "notable" signal,
                                                           not as a standalone POI source
     A source without a key is skipped and reported in `stats`.
  4. Merge duplicates (same Wikidata id, or similar name within ~250 m).
  5. Score every place and explain the score (`reasons`), estimate detour.
  6. Mode "top": score threshold + max N per 50 km of route; mode "all": everything named.

The scoring weights are deliberately simple and live in one place (SCORING) so
they are easy to tune while getting a feel for the data.
"""

from __future__ import annotations

import asyncio
import math
import re
import time
import unicodedata
from urllib.parse import quote
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import httpx

from app.config import settings
from app.services.osrm import osrm_service

USER_AGENT = "TravelMate/0.1 (https://github.com/McLagan/travelmate; personal trip planner)"

# --------------------------------------------------------------------------
# Categories: one UI key -> what to ask each source for
# --------------------------------------------------------------------------

CATEGORIES: Dict[str, dict] = {
    "sights": {
        "label": "Sights & history",
        "geoapify": "tourism.sights,heritage,building.historic",
        "otm": "historic,architecture,fortifications",
        "base": 2.0,
    },
    "museums": {
        "label": "Museums & culture",
        "geoapify": "entertainment.museum,entertainment.culture",
        "otm": "museums,theatres_and_entertainments",
        "base": 2.0,
    },
    "viewpoints": {
        "label": "Viewpoints",
        "geoapify": "tourism.attraction.viewpoint",
        "otm": "view_points",
        "base": 2.0,
    },
    "nature": {
        "label": "Nature & parks",
        "geoapify": "national_park,natural.protected_area,leisure.park.nature_reserve,natural.water.hot_spring,natural.mountain.cave_entrance",
        "otm": "natural",
        "base": 1.5,
    },
    "beaches": {
        "label": "Beaches",
        "geoapify": "beach",
        "otm": "beaches",
        "base": 1.5,
    },
    "family": {
        "label": "Family fun",
        "geoapify": "entertainment.zoo,entertainment.aquarium,entertainment.theme_park,entertainment.water_park",
        "otm": "amusements",
        "base": 1.5,
    },
    "food": {
        "label": "Food",
        "geoapify": "catering.restaurant",
        "otm": "foods",
        "base": 0.5,
    },
    # narrower "highlight" categories (sub-sets of sights / nature that can be searched on their own)
    "castles": {
        "label": "Castles & fortresses",
        "geoapify": "tourism.sights.castle,tourism.sights.fort,tourism.sights.city_gate,tourism.sights.tower,tourism.sights.manor",
        "otm": "castles,fortifications", "otm_fallback": "fortifications",
        "base": 2.5,
    },
    "archaeology": {
        "label": "Ruins & archaeology",
        "geoapify": "tourism.sights.archaeological_site,tourism.sights.ruines",
        "otm": "archaeology", "otm_fallback": "historic",
        "base": 2.0,
    },
    "religious": {
        "label": "Monasteries & churches",
        "geoapify": "tourism.sights.monastery,tourism.sights.place_of_worship",
        "otm": "religion",
        "base": 1.2,
    },
    "wonders": {
        "label": "Caves, springs & peaks",
        "geoapify": "natural.mountain.cave_entrance,natural.mountain.peak,natural.mountain.volcano,natural.water.hot_spring,natural.water.geyser,natural.water.spring",
        "otm": "waterfalls,caves,natural_springs,mountain_peaks", "otm_fallback": "natural",
        "base": 1.5,
    },
    "spa": {
        "label": "Thermal baths",
        "geoapify": "leisure.spa.public_bath,natural.water.hot_spring",
        "otm": "",
        "base": 1.5,
    },
    "wine": {
        "label": "Wineries",
        "geoapify": "production.winery",
        "otm": "",
        "base": 1.2,
    },
}

# a narrower category also counts as its broad one (asking for "sights" also gives castles)
PARENT = {"castles": "sights", "archaeology": "sights", "religious": "sights", "wonders": "nature", "spa": "nature"}


def _wanted(category: str, cats: List[str]) -> bool:
    return category in cats or PARENT.get(category) in cats

# Geoapify category prefix -> our key (first match wins, most specific first)
_GEO_TO_KEY = [
    ("tourism.sights.castle", "castles"), ("tourism.sights.fort", "castles"), ("tourism.sights.city_gate", "castles"),
    ("tourism.sights.tower", "castles"), ("tourism.sights.manor", "castles"),
    ("tourism.sights.archaeological_site", "archaeology"), ("tourism.sights.ruines", "archaeology"),
    ("tourism.sights.monastery", "religious"), ("tourism.sights.place_of_worship", "religious"),
    ("leisure.spa", "spa"), ("natural.water.hot_spring", "spa"), ("production.winery", "wine"),
    ("natural.mountain.cave_entrance", "wonders"), ("natural.mountain.peak", "wonders"), ("natural.mountain.volcano", "wonders"),
    ("natural.water.geyser", "wonders"), ("natural.water.spring", "wonders"),
    ("tourism.attraction.viewpoint", "viewpoints"),
    ("entertainment.museum", "museums"), ("entertainment.culture", "museums"),
    ("entertainment.zoo", "family"), ("entertainment.aquarium", "family"),
    ("entertainment.theme_park", "family"), ("entertainment.water_park", "family"),
    ("beach", "beaches"),
    ("national_park", "nature"), ("natural", "nature"), ("leisure.park", "nature"),
    ("catering", "food"),
    ("heritage", "sights"), ("building.historic", "sights"), ("tourism", "sights"),
]

_OTM_TO_KEY = [
    ("castles", "castles"), ("fortifications", "castles"), ("archaeology", "archaeology"),
    ("monasteries", "religious"), ("churches", "religious"), ("cathedrals", "religious"),
    ("waterfalls", "wonders"), ("caves", "wonders"), ("natural_springs", "wonders"), ("mountain_peaks", "wonders"),
    ("view_points", "viewpoints"), ("museums", "museums"), ("theatres", "museums"),
    ("beaches", "beaches"), ("amusements", "family"), ("natural", "nature"),
    ("foods", "food"), ("historic", "sights"), ("architecture", "sights"),
    ("fortifications", "sights"), ("religion", "sights"), ("cultural", "museums"),
]

SCORING = {
    # popularity = in how many language editions of Wikipedia the place has an article
    # (Wikidata sitelinks). +log2(n+1), capped: 1 lang -> +1, 3 -> +2, 7 -> +3, 31 -> +5, 63+ -> +6
    "popularity_weight": 1.5,     # x log2(n+1): 1 lang -> +1.5, 7 -> +4.5, 31 -> +7.5
    "popularity_cap": 8.0,
    "wikidata_only": 0.5,         # Wikidata entry but no Wikipedia article at all
    "common_type_base": 0.8,      # memorials, churches, cemeteries: very many of them, base lowered
    "otm_rate_per_point": 0.7,    # OpenTripMap rate 1..3 (in Serbia many listed monuments get 3)

    "unesco": 3.0,
    "heritage": 1.0,              # protected monument (Geoapify heritage or OTM "h"), counted once
    "per_extra_source": 1.0,
    "detour_penalty_per_10min": 1.0,
    "top_threshold": 5.0,         # mode "top": minimum score to show
    "top_per_50km": 5,            # mode "top": max places per 50 km of route
    "top_max": 40,
    "all_max": 300,
}

# raw categories that exist in huge numbers; they must earn their place by popularity
COMMON_TYPES = ("memorial", "place_of_worship", "cemetery", "grave_yard", "burial", "churches",
                "monuments_and_memorials", "wayside", "religion")

PROFILE_SPEED_KMH = {"driving": 50, "cycling": 15, "walking": 4.5}  # for off-route legs
VISIT_MINUTES = 0  # detour = travel there and back only; visit time is up to you


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def haversine_km(a_lat, a_lon, b_lat, b_lon) -> float:
    r = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def norm_name(s) -> str:
    # sources sometimes return numeric names (e.g. a monument called "1848")
    s = unicodedata.normalize("NFKD", str(s) if s is not None else "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def names_match(a: str, b: str) -> bool:
    na, nb = norm_name(a), norm_name(b)
    if not na or not nb:
        return False
    if na == nb or na in nb or nb in na:
        return True
    ta, tb = set(na.split()), set(nb.split())
    return len(ta & tb) / max(1, min(len(ta), len(tb))) >= 0.6


def densify(coords: List[Tuple[float, float]], step_km: float) -> List[Tuple[float, float, float]]:
    """Points every ~step_km along the polyline: (lat, lon, km_from_start)."""
    out = []
    if not coords:
        return out
    acc = 0.0
    last = coords[0]
    out.append((last[0], last[1], 0.0))
    since = 0.0
    for p in coords[1:]:
        d = haversine_km(last[0], last[1], p[0], p[1])
        acc += d
        since += d
        if since >= step_km:
            out.append((p[0], p[1], acc))
            since = 0.0
        last = p
    if out[-1][2] != acc:
        out.append((last[0], last[1], acc))
    return out


class _Cache:
    def __init__(self, ttl=24 * 3600):
        self.ttl, self.data = ttl, {}

    def get(self, k):
        v = self.data.get(k)
        if v and time.time() - v[0] < self.ttl:
            return v[1]
        return None

    def set(self, k, val):
        self.data[k] = (time.time(), val)


_cache = _Cache()


@dataclass
class Candidate:
    name: str
    lat: float
    lon: float
    category: str
    source: str
    raw_categories: List[str] = field(default_factory=list)
    wikidata: Optional[str] = None
    wikipedia: Optional[str] = None
    website: Optional[str] = None
    otm_rate: Optional[str] = None
    heritage: bool = False
    unesco: bool = False


# --------------------------------------------------------------------------
# sources
# --------------------------------------------------------------------------

async def _geoapify(client, lat, lon, radius_m, cats: List[str], limit: int) -> List[Candidate]:
    key = settings.GEOAPIFY_API_KEY
    geo_cats = ",".join(CATEGORIES[c]["geoapify"] for c in cats)
    ck = ("geo", round(lat, 3), round(lon, 3), radius_m, geo_cats, limit)
    if (hit := _cache.get(ck)) is not None:
        return hit
    r = await client.get(
        "https://api.geoapify.com/v2/places",
        params={"categories": geo_cats, "filter": f"circle:{lon},{lat},{radius_m}",
                "bias": f"proximity:{lon},{lat}", "limit": limit, "lang": "en", "apiKey": key},
    )
    r.raise_for_status()
    out = []
    for f in r.json().get("features", []):
        p = f.get("properties", {})
        name = p.get("name")
        if name is None or str(name).strip() == "":
            continue
        name = str(name)
        raw_cats = p.get("categories", []) or []
        category = next((k for pref, k in _GEO_TO_KEY if any(c.startswith(pref) for c in raw_cats)), cats[0])
        raw = (p.get("datasource") or {}).get("raw") or {}
        wm = p.get("wiki_and_media") or {}
        out.append(Candidate(
            name=name, lat=p.get("lat"), lon=p.get("lon"), category=category, source="geoapify",
            raw_categories=raw_cats,
            wikidata=wm.get("wikidata") or raw.get("wikidata"),
            wikipedia=wm.get("wikipedia") or raw.get("wikipedia"),
            website=p.get("website") or raw.get("website"),
            heritage=any(c.startswith("heritage") for c in raw_cats) or bool(raw.get("heritage")),
            unesco="heritage.unesco" in raw_cats,
        ))
    _cache.set(ck, out)
    return out


async def _opentripmap(client, lat, lon, radius_m, cats: List[str], limit: int, min_rate: str) -> List[Candidate]:
    key = settings.OPENTRIPMAP_API_KEY
    kinds = ",".join(CATEGORIES[c]["otm"] for c in cats if CATEGORIES[c]["otm"])
    if not kinds:
        return []
    ck = ("otm", round(lat, 3), round(lon, 3), radius_m, kinds, limit, min_rate)
    if (hit := _cache.get(ck)) is not None:
        return hit
    params = {"lat": lat, "lon": lon, "radius": radius_m, "kinds": kinds, "rate": min_rate,
              "limit": limit, "format": "json", "apikey": key}
    r = await client.get("https://api.opentripmap.com/0.1/en/places/radius", params=params)
    if r.status_code == 400:  # a kind name OTM does not know: fall back to the broad kinds
        params["kinds"] = ",".join(dict.fromkeys(CATEGORIES[c].get("otm_fallback", CATEGORIES[c]["otm"])
                                                 for c in cats if CATEGORIES[c]["otm"]))
        r = await client.get("https://api.opentripmap.com/0.1/en/places/radius", params=params)
    r.raise_for_status()
    out = []
    data = r.json()
    for p in data if isinstance(data, list) else []:
        name = p.get("name") if isinstance(p, dict) else None
        if name is None or str(name).strip() == "":
            continue
        name = str(name)
        kinds_list = (p.get("kinds") or "").split(",")
        category = next((k for pref, k in _OTM_TO_KEY if any(x.startswith(pref) for x in kinds_list)), cats[0])
        pt = p.get("point") or {}
        out.append(Candidate(
            name=name, lat=pt.get("lat"), lon=pt.get("lon"), category=category, source="opentripmap",
            raw_categories=kinds_list, wikidata=p.get("wikidata"), otm_rate=str(p.get("rate") or ""),
        ))
    _cache.set(ck, out)
    return out


async def _wikipedia(client, lat, lon, radius_m) -> List[dict]:
    """Wikipedia articles around a point, with their Wikidata id."""
    radius_m = min(radius_m, 10000)  # API maximum
    ck = ("wiki2", round(lat, 3), round(lon, 3), radius_m)
    if (hit := _cache.get(ck)) is not None:
        return hit
    r = await client.get(
        "https://en.wikipedia.org/w/api.php",
        params={"action": "query", "generator": "geosearch", "ggscoord": f"{lat}|{lon}",
                "ggsradius": radius_m, "ggslimit": 200, "prop": "coordinates|pageprops",
                "ppprop": "wikibase_item", "format": "json"},
    )
    r.raise_for_status()
    out = []
    for pg in (r.json().get("query", {}).get("pages") or {}).values():
        co = (pg.get("coordinates") or [{}])[0]
        if "lat" not in co:
            continue
        out.append({"pageid": pg.get("pageid"), "title": str(pg.get("title", "")), "lat": co["lat"], "lon": co["lon"],
                    "qid": (pg.get("pageprops") or {}).get("wikibase_item")})
    _cache.set(ck, out)
    return out


_SITE_RE = re.compile(r"^[a-z_]+wiki$")
_NOT_WIKIPEDIA = {"commonswiki", "specieswiki", "wikidatawiki", "metawiki", "mediawikiwiki", "sourceswiki", "outreachwiki"}


# preferred languages for the article we link to / summarise (first available wins)
WIKI_LANGS = ["ru", "en", "sr", "hu", "hr", "bg", "el", "it", "de", "ro", "sl", "sh", "bs", "mk"]


async def _wikidata_info(client, qids: List[str]) -> Dict[str, dict]:
    """qid -> {"n": Wikipedia languages count (popularity), "lang": .., "title": ..} (preferred article)."""
    out, todo = {}, []
    for q in qids:
        v = _cache.get(("wd", q))
        if v is None:
            todo.append(q)
        else:
            out[q] = v
    for i in range(0, len(todo), 50):
        batch = todo[i:i + 50]
        r = await client.get("https://www.wikidata.org/w/api.php",
                             params={"action": "wbgetentities", "ids": "|".join(batch), "props": "sitelinks", "format": "json"})
        r.raise_for_status()
        for q, ent in (r.json().get("entities") or {}).items():
            links = ent.get("sitelinks") or {}
            wp = {k[:-4]: v.get("title") for k, v in links.items() if _SITE_RE.match(k) and k not in _NOT_WIKIPEDIA}
            lang = next((l for l in WIKI_LANGS if l in wp), next(iter(wp), None))
            info = {"n": len(wp), "lang": lang, "title": wp.get(lang) if lang else None}
            out[q] = info
            _cache.set(("wd", q), info)
    return out


async def wiki_summary(lang: str, title: str) -> Optional[dict]:
    """Short description + thumbnail of a Wikipedia article (REST summary endpoint), cached."""
    if not re.fullmatch(r"[a-z_-]{2,12}", lang or ""):
        return None
    ck = ("sum", lang, title)
    if (hit := _cache.get(ck)) is not None:
        return hit
    url = f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{quote(title.replace(' ', '_'), safe='')}"
    async with httpx.AsyncClient(timeout=10.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True) as client:
        r = await client.get(url)
    if r.status_code != 200:
        return None
    d = r.json()
    out = {
        "title": d.get("title"),
        "description": d.get("description"),
        "extract": d.get("extract"),
        "thumbnail": (d.get("thumbnail") or {}).get("source"),
        "url": ((d.get("content_urls") or {}).get("desktop") or {}).get("page"),
    }
    _cache.set(ck, out)
    return out


# Wikidata types -> (our category, tag used for COMMON_TYPES); unknown types count as "sights"
WD_TYPES = {
    "Q23413": ("castles", "castle"), "Q57821": ("castles", "fortress"), "Q1785071": ("castles", "fort"),
    "Q16560": ("sights", "palace"), "Q839954": ("archaeology", "archaeological_site"), "Q174782": ("sights", "square"),
    "Q12280": ("sights", "bridge"), "Q12518": ("castles", "tower"), "Q2977": ("religious", "cathedral"),
    "Q44613": ("religious", "monastery"),
    "Q16970": ("religious", "place_of_worship"), "Q32815": ("religious", "place_of_worship.mosque"),
    "Q34627": ("religious", "place_of_worship.synagogue"), "Q39614": ("sights", "cemetery"),
    "Q109607": ("archaeology", "ruins"), "Q8502": ("wonders", "mountain"),
    "Q5003624": ("sights", "memorial"), "Q4989906": ("sights", "memorial.monument"), "Q179700": ("sights", "memorial.statue"),
    "Q33506": ("museums", "museum"), "Q207694": ("museums", "museum.art"), "Q24354": ("museums", "theatre"),
    "Q22698": ("nature", "park"), "Q46169": ("nature", "national_park"), "Q179049": ("nature", "nature_reserve"),
    "Q23397": ("nature", "lake"), "Q34038": ("wonders", "waterfall"), "Q35509": ("wonders", "cave"),
    "Q6017969": ("viewpoints", "viewpoint"), "Q40080": ("beaches", "beach"), "Q43501": ("family", "zoo"),
}
# things that have coordinates and many Wikipedia articles but are not places to visit
WD_EXCLUDE = {
    "Q5",                                            # human
    "Q4022", "Q34442", "Q79007",                     # river, road, street
    "Q55488", "Q1248784",                            # railway station, airport
    "Q3918", "Q3914", "Q16917",                      # university, school, hospital
    "Q43229", "Q4830453",                            # organization, business
    "Q486972", "Q515", "Q532", "Q3957", "Q5119", "Q1549591", "Q1637706",  # settlements
    "Q123705", "Q2983893", "Q15284",                 # neighbourhood, quarter, municipality
    "Q1093829", "Q747074", "Q484170", "Q262166",     # country-specific municipality types
    "Q4167410", "Q13406463",                         # disambiguation, list
}


async def _wikidata_around(client, lat, lon, radius_km, min_sitelinks: int, cats: List[str]) -> List[Candidate]:
    """Notable places (many Wikipedia articles) around a point, straight from Wikidata.
    Catches big objects like fortresses that other sources list only by their parts."""
    radius_km = min(radius_km, 20.0)
    ck = ("wdq", round(lat, 3), round(lon, 3), radius_km, min_sitelinks)
    rows = _cache.get(ck)
    if rows is None:
        q = f"""
SELECT ?item ?label ?lat ?lon ?sl (GROUP_CONCAT(DISTINCT STRAFTER(STR(?type), "entity/"); separator=",") AS ?types) WHERE {{
  SERVICE wikibase:around {{ ?item wdt:P625 ?loc .
    bd:serviceParam wikibase:center "Point({lon} {lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "{radius_km}" . }}
  ?item wikibase:sitelinks ?sl . FILTER(?sl >= {min_sitelinks})
  FILTER NOT EXISTS {{ ?item wdt:P1082 [] }}
  OPTIONAL {{ ?item wdt:P31 ?type }}
  BIND(geof:latitude(?loc) AS ?lat) BIND(geof:longitude(?loc) AS ?lon)
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "{','.join(WIKI_LANGS)}". ?item rdfs:label ?label . }}
}} GROUP BY ?item ?label ?lat ?lon ?sl ORDER BY DESC(?sl) LIMIT 80"""
        r = await client.get("https://query.wikidata.org/sparql", params={"query": q, "format": "json"},
                             headers={"Accept": "application/sparql-results+json"})
        r.raise_for_status()
        rows = []
        for b in r.json().get("results", {}).get("bindings", []):
            rows.append({
                "qid": b["item"]["value"].rsplit("/", 1)[-1],
                "label": b.get("label", {}).get("value", ""),
                "lat": float(b["lat"]["value"]), "lon": float(b["lon"]["value"]),
                "types": [t for t in b.get("types", {}).get("value", "").split(",") if t],
            })
        _cache.set(ck, rows)
    out = []
    for row in rows:
        if not row["label"] or re.fullmatch(r"Q\d+", row["label"]) or WD_EXCLUDE.intersection(row["types"]):
            continue
        known = [WD_TYPES[t] for t in row["types"] if t in WD_TYPES]
        category, tag = known[0] if known else ("sights", "notable")
        if not _wanted(category, cats):
            continue
        out.append(Candidate(name=row["label"], lat=row["lat"], lon=row["lon"], category=category, source="wikidata",
                             raw_categories=[f"wikidata.{tag}"], wikidata=row["qid"]))
    return out


# --------------------------------------------------------------------------
# main entry
# --------------------------------------------------------------------------

def _merge_candidates(candidates: List[Candidate]) -> List[dict]:
    """Merge the same place found by several sources (grid of ~1 km cells keeps this fast)."""
    merged: List[dict] = []
    grid: Dict[Tuple[int, int], List[dict]] = {}
    by_wikidata: Dict[str, dict] = {}
    for c in candidates:
        if c.lat is None or c.lon is None:
            continue
        cell = (int(c.lat * 100), int(c.lon * 100))
        hit = by_wikidata.get(c.wikidata) if c.wikidata else None
        if not hit:
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    for m in grid.get((cell[0] + dy, cell[1] + dx), []):
                        if haversine_km(c.lat, c.lon, m["lat"], m["lon"]) < 0.25 and names_match(c.name, m["name"]):
                            hit = m
                            break
                    if hit:
                        break
                if hit:
                    break
        if hit:
            hit["sources"].add(c.source)
            hit["wikidata"] = hit["wikidata"] or c.wikidata
            hit["wikipedia"] = hit["wikipedia"] or c.wikipedia
            hit["website"] = hit["website"] or c.website
            hit["otm_rate"] = hit["otm_rate"] or c.otm_rate
            hit["heritage"] |= c.heritage
            hit["unesco"] |= c.unesco
            hit["raw_categories"] = list(dict.fromkeys(hit["raw_categories"] + c.raw_categories))
            if c.wikidata:
                by_wikidata.setdefault(c.wikidata, hit)
        else:
            m = dict(name=c.name, lat=c.lat, lon=c.lon, category=c.category, sources={c.source},
                     raw_categories=list(c.raw_categories), wikidata=c.wikidata, wikipedia=c.wikipedia,
                     website=c.website, otm_rate=c.otm_rate, heritage=c.heritage, unesco=c.unesco)
            merged.append(m)
            grid.setdefault(cell, []).append(m)
            if c.wikidata:
                by_wikidata[c.wikidata] = m
    return merged


def _score_place(m: dict, langs: Dict[str, dict]) -> None:
    """Popularity score without detour: category + Wikipedia languages + heritage/UNESCO + sources."""
    common = any(t in c for c in m["raw_categories"] for t in COMMON_TYPES)
    base = min(CATEGORIES[m["category"]]["base"], SCORING["common_type_base"]) if common else CATEGORIES[m["category"]]["base"]
    reasons, score = [], base
    reasons.append(f"{CATEGORIES[m['category']]['label']}{' (common type)' if common else ''} +{base:g}")
    info = langs.get(m["wikidata"]) if m["wikidata"] else None
    n = info["n"] if info else None
    if info and info.get("title"):
        m["wikipedia"] = f'{info["lang"]}:{info["title"]}'  # preferred-language article
    m["wiki_languages"] = n
    if n:
        pts = round(min(SCORING["popularity_cap"], SCORING["popularity_weight"] * math.log2(n + 1)), 1)
        score += pts
        reasons.append(f"Wikipedia in {n} language{'s' if n > 1 else ''} +{pts:g}")
    elif m["wikidata"] or m["wikipedia"]:
        score += SCORING["wikidata_only"]
        reasons.append(f"Wikidata entry, no Wikipedia article +{SCORING['wikidata_only']:g}")
    rate = (m["otm_rate"] or "").lower()
    if rate[:1].isdigit() and not n:  # OTM rate is itself derived from Wikipedia; use it only as a fallback
        pts = int(rate[0]) * SCORING["otm_rate_per_point"]
        score += pts
        reasons.append(f"OpenTripMap rate {rate[0]} +{pts:g}")
    if "h" in rate:
        m["heritage"] = True
    if m["unesco"]:
        score += SCORING["unesco"]
        reasons.append(f"UNESCO +{SCORING['unesco']:g}")
    elif m["heritage"]:
        score += SCORING["heritage"]
        reasons.append(f"heritage +{SCORING['heritage']:g}")
    if len(m["sources"]) > 1:
        pts = (len(m["sources"]) - 1) * SCORING["per_extra_source"]
        score += pts
        reasons.append(f"found in {len(m['sources'])} sources +{pts:g}")
    m["score"] = round(score, 1)
    m["reasons"] = reasons


async def find_pois_along_route(
    waypoints: List[dict],
    profile: str,
    categories: List[str],
    max_detour_minutes: int,
    mode: str,
) -> dict:
    """waypoints: [{"lat", "lon", "name", "leg_mode", "leg_hours"}] - ferry legs are not searched."""
    from app.services.route_builder import build_route

    t0 = time.time()
    stats = {"sources": {}, "errors": []}
    cats = [c for c in categories if c in CATEGORIES] or ["sights", "museums", "viewpoints", "nature"]

    # 1. real route (road parts via OSRM, ferry legs as straight lines)
    built = await build_route(waypoints, profile)
    if not built:
        raise RuntimeError("Routing service returned no route")
    route_km = built["distance_km"]

    # leg boundaries in km (to know between which stops a place lies)
    leg_ends, acc = [], 0.0
    for leg in built["legs"]:
        acc += leg["distance_km"]
        leg_ends.append(acc)
    leg_start_km = [0.0] + leg_ends[:-1]

    # 2. search circles - along road segments only
    speed = PROFILE_SPEED_KMH.get(profile, 50)
    one_way_km = speed * (max_detour_minutes / 2) / 60
    radius_km = max(1.0, min(10.0, one_way_km))
    road_km = sum(l["distance_km"] for l in built["legs"] if l["mode"] == "road")
    spacing_km = radius_km * 1.6
    if road_km / spacing_km > 120:  # keep request count sane on long routes ...
        spacing_km = road_km / 120
        # ... but keep the circles touching, otherwise whole cities fall between them (Bari on a 3600 km trip)
        radius_km = min(20.0, max(radius_km, spacing_km * 0.55))
    centers, fine = [], []
    for seg in built["segments"]:
        if seg["mode"] != "road":
            continue
        offset = leg_start_km[seg["from_index"]]
        centers += [(la, lo, km + offset) for la, lo, km in densify(seg["coords"], spacing_km)]
        fine += [(la, lo, km + offset) for la, lo, km in densify(seg["coords"], 1.0)]
    if not fine:
        raise RuntimeError("Route has no road parts to search along")
    radius_m = int(radius_km * 1000)
    stats.update(route_km=round(route_km, 1), search_radius_km=round(radius_km, 1), search_points=len(centers))
    # detour estimate keeps the user's limit even if circles became bigger


    # 3. query sources
    use_geo = bool(settings.GEOAPIFY_API_KEY)
    use_otm = bool(settings.OPENTRIPMAP_API_KEY)
    if not use_geo:
        stats["sources"]["geoapify"] = {"skipped": "no GEOAPIFY_API_KEY in backend/.env"}
    if not use_otm:
        stats["sources"]["opentripmap"] = {"skipped": "no OPENTRIPMAP_API_KEY in backend/.env"}

    # per-source limits: free tiers answer 429 when hit in parallel (Wikidata SPARQL is the strictest)
    sems = {"geoapify": asyncio.Semaphore(3), "opentripmap": asyncio.Semaphore(3),
            "wikipedia": asyncio.Semaphore(3), "wikidata": asyncio.Semaphore(1)}
    candidates: List[Candidate] = []
    wiki_articles: Dict[int, dict] = {}
    counts = {"geoapify": 0, "opentripmap": 0, "wikipedia": 0, "wikidata": 0}
    # dense cities have hundreds of places per circle; a small limit cuts off famous ones
    # that are not nearest to the circle centre (Geoapify: 1 credit per 20 places)
    per_circle = 100

    async def run(name, make):
        async with sems[name]:
            for attempt in (1, 2, 3):
                try:
                    return name, await make()
                except httpx.HTTPStatusError as e:  # rate limit / temporary error: wait and retry
                    if attempt < 3 and e.response.status_code in (429, 500, 502, 503, 504):
                        await asyncio.sleep(2.0 * attempt)
                        continue
                    stats["errors"].append(f"{name}: HTTP {e.response.status_code} {str(e.request.url)[:90]}")
                except Exception as e:  # one failed circle must not kill the search
                    stats["errors"].append(f"{name}: {type(e).__name__} {str(e)[:120]}")
                return name, []

    async with httpx.AsyncClient(timeout=15.0, headers={"User-Agent": USER_AGENT}) as client:
        tasks = []
        for ci, (lat, lon, _) in enumerate(centers):
            la, lo = lat, lon
            if use_geo:
                tasks.append(run("geoapify", lambda la=la, lo=lo: _geoapify(client, la, lo, radius_m, cats, per_circle)))
            if use_otm:
                tasks.append(run("opentripmap", lambda la=la, lo=lo: _opentripmap(
                    client, la, lo, radius_m, cats, per_circle, "2" if mode == "top" else "1")))
            tasks.append(run("wikipedia", lambda la=la, lo=lo: _wikipedia(client, la, lo, radius_m)))
            # Wikidata SPARQL is slow and strict about load: it lists only notable places, so every
            # second circle with a doubled radius covers the same road with half the queries
            if ci % 2 == 0 or ci == len(centers) - 1:
                tasks.append(run("wikidata", lambda la=la, lo=lo: _wikidata_around(
                    client, la, lo, min(20.0, radius_km * 2), 5 if mode == "top" else 3, cats)))
        for name, res in await asyncio.gather(*tasks):
            if name == "wikipedia":
                for a in res:
                    wiki_articles[a["pageid"]] = a
            else:
                candidates.extend(res)
            counts[name] += len(res)

    if use_geo:
        stats["sources"]["geoapify"] = {"results": counts["geoapify"]}
    if use_otm:
        stats["sources"]["opentripmap"] = {"results": counts["opentripmap"]}
    stats["sources"]["wikipedia"] = {"articles_nearby": len(wiki_articles), "role": "popularity signal only"}
    stats["sources"]["wikidata_places"] = {"results": counts["wikidata"], "role": "notable places (5+ Wikipedia languages)"}
    stats["candidates_raw"] = len(candidates)

    # 4. merge duplicates
    merged = _merge_candidates(candidates)
    stats["after_merge"] = len(merged)

    # 5. score
    wiki_grid: Dict[Tuple[int, int], List[dict]] = {}
    for a in wiki_articles.values():
        wiki_grid.setdefault((int(a["lat"] * 100), int(a["lon"] * 100)), []).append(a)
    for m in merged:
        # position relative to route
        coslat = math.cos(math.radians(m["lat"]))
        best_d2, best_km, best_pt = 1e18, 0.0, None
        for lat, lon, km in fine:
            dy, dx = lat - m["lat"], (lon - m["lon"]) * coslat
            d2 = dx * dx + dy * dy
            if d2 < best_d2:
                best_d2, best_km, best_pt = d2, km, (lat, lon)
        best_d = haversine_km(m["lat"], m["lon"], best_pt[0], best_pt[1])
        m["off_route_km"] = round(best_d, 2)
        m["route_km"] = round(best_km, 1)
        m["_route_pt"] = best_pt
        m["leg_index"] = next((i for i, end in enumerate(leg_ends) if best_km <= end + 0.01), max(0, len(leg_ends) - 1))
        # estimate: there and back, road ~1.3x straight line
        m["detour_minutes"] = round(2 * best_d * 1.3 / speed * 60 + VISIT_MINUTES)
        m["detour_source"] = "estimate"

        if not m["wikidata"]:
            cell = (int(m["lat"] * 100), int(m["lon"] * 100))
            nearby = [a for dy in (-1, 0, 1) for dx in (-1, 0, 1) for a in wiki_grid.get((cell[0] + dy, cell[1] + dx), [])]
            near = next((a for a in nearby
                         if haversine_km(m["lat"], m["lon"], a["lat"], a["lon"]) < 0.4 and names_match(m["name"], a["title"])), None)
            if near:
                m["wikipedia"] = m["wikipedia"] or f"en:{near['title']}"
                m["wikidata"] = near.get("qid")

    # popularity: number of Wikipedia languages per Wikidata id (batched, cached)
    qids = sorted({m["wikidata"] for m in merged if m["wikidata"] and str(m["wikidata"]).startswith("Q")})
    langs: Dict[str, dict] = {}
    if qids:
        try:
            async with httpx.AsyncClient(timeout=20.0, headers={"User-Agent": USER_AGENT}) as client:
                langs = await _wikidata_info(client, qids)
        except Exception as e:
            stats["errors"].append(f"wikidata: {type(e).__name__} {str(e)[:120]}")
    stats["sources"]["wikidata"] = {"entities": len(langs), "role": "popularity (Wikipedia languages)"}

    for m in merged:
        _score_place(m, langs)
        score, reasons = m["score"], m["reasons"]
        pen = m["detour_minutes"] / 10 * SCORING["detour_penalty_per_10min"]
        if pen >= 0.1:
            score -= pen
            reasons.append(f"detour ~{m['detour_minutes']} min (straight-line est.) −{pen:.1f}")
        m["score"] = round(score, 1)
        m["reasons"] = reasons

    in_range = [m for m in merged if m["detour_minutes"] <= max_detour_minutes]
    stats["within_detour"] = len(in_range)

    # 6. select
    in_range.sort(key=lambda m: -m["score"])
    if mode == "top":
        chosen, per_bucket = [], {}
        for m in in_range:
            if m["score"] < SCORING["top_threshold"]:
                continue
            b = int(m["route_km"] // 50)
            if per_bucket.get(b, 0) >= SCORING["top_per_50km"]:
                continue
            per_bucket[b] = per_bucket.get(b, 0) + 1
            chosen.append(m)
            if len(chosen) >= SCORING["top_max"]:
                break
    else:
        chosen = in_range[: SCORING["all_max"]]

    # 7. refine detour for the shown places with real road times (one OSRM table call)
    if chosen and len(chosen) <= 50:
        try:
            src_pts = list(dict.fromkeys(m["_route_pt"] for m in chosen))
            table = await osrm_service.get_table_durations(src_pts, [(m["lat"], m["lon"]) for m in chosen], profile)
            if table:
                for j, m in enumerate(chosen):
                    sec = table[src_pts.index(m["_route_pt"])][j]
                    if sec is not None:
                        m["detour_minutes"] = round(2 * sec / 60 + VISIT_MINUTES)
                        m["detour_source"] = "road"
        except Exception as e:
            stats["errors"].append(f"osrm table: {type(e).__name__}")

    pois = []
    for m in sorted(chosen, key=lambda m: m["route_km"]):
        m.pop("_route_pt", None)
        m["sources"] = sorted(m["sources"])
        if m["wikipedia"] and ":" in m["wikipedia"]:
            lang, title = m["wikipedia"].split(":", 1)
            m["wikipedia_url"] = f"https://{lang}.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}"
            m["wiki_lang"], m["wiki_title"] = lang, title
            _readable_name(m)
        pois.append(m)
    try:  # thumbnails + one-line descriptions (batched, 1 request per 50 places)
        async with httpx.AsyncClient(timeout=15.0, headers={"User-Agent": USER_AGENT}) as client:
            await _wiki_cards(client, pois)
    except Exception as e:
        stats["errors"].append(f"wiki cards: {type(e).__name__}")

    stats["shown"] = len(chosen)
    stats["seconds"] = round(time.time() - t0, 1)

    return {"mode": mode, "categories": cats, "max_detour_minutes": max_detour_minutes,
            "pois": pois, "stats": stats}


def _readable_name(m: dict) -> None:
    """OSM objects often carry the Wikidata id of what they belong to (stairs/gate -> fortress) and local
    scripts (Greek, Cyrillic, Albanian): show the ru/en article title - it is what the popularity is about."""
    if (m.get("wiki_languages") or 0) >= 3 and m.get("wiki_lang") in ("ru", "en") and m.get("wiki_title"):
        nice = re.sub(r"\s*\([^)]*\)\s*$", "", m["wiki_title"]).strip()
        if nice and not names_match(nice, m["name"]):
            m["local_name"], m["name"] = m["name"], nice


async def _wiki_cards(client, items: List[dict]) -> None:
    """Add a thumbnail and a one-line description to places that have a Wikipedia article (batched per language)."""
    by_lang: Dict[str, List[dict]] = {}
    for m in items:
        if m.get("wiki_lang") and m.get("wiki_title"):
            by_lang.setdefault(m["wiki_lang"], []).append(m)
    for lang, group in by_lang.items():
        if not re.fullmatch(r"[a-z_-]{2,12}", lang):
            continue
        for i in range(0, len(group), 50):
            batch = group[i:i + 50]
            ck = ("cards", lang, tuple(sorted(m["wiki_title"] for m in batch)))
            pages = _cache.get(ck)
            if pages is None:
                r = await client.get(f"https://{lang}.wikipedia.org/w/api.php", params={
                    "action": "query", "prop": "pageimages|description", "piprop": "thumbnail",
                    "pithumbsize": 320, "redirects": 1, "format": "json",
                    "titles": "|".join(m["wiki_title"] for m in batch)})
                r.raise_for_status()
                q = r.json().get("query", {})
                redirect = {x["from"]: x["to"] for x in (q.get("normalized") or []) + (q.get("redirects") or [])}
                pages = {}
                for pg in (q.get("pages") or {}).values():
                    pages[pg.get("title")] = {"thumb": (pg.get("thumbnail") or {}).get("source"),
                                              "description": pg.get("description")}
                for a, b in redirect.items():
                    if b in pages:
                        pages[a] = pages[b]
                _cache.set(ck, pages)
            for m in batch:
                info = pages.get(m["wiki_title"]) or {}
                m["thumb"] = info.get("thumb")
                m["description"] = info.get("description")


async def find_popular_near(lat: float, lon: float, radius_km: float, categories: List[str], limit: int = 30) -> dict:
    """Most notable places around one stop (a city, a village): same sources and score as along the route,
    but ranked by popularity only (no detour)."""
    t0 = time.time()
    stats = {"sources": {}, "errors": []}
    cats = [c for c in categories if c in CATEGORIES] or ["sights", "museums", "viewpoints", "nature"]
    radius_km = max(1.0, min(10.0, radius_km))
    radius_m = int(radius_km * 1000)

    async def run(name, make):
        for attempt in (1, 2):
            try:
                return name, await make()
            except httpx.HTTPStatusError as e:  # Wikidata often answers 429 - wait and retry once
                if attempt == 1 and e.response.status_code in (429, 500, 502, 503, 504):
                    await asyncio.sleep(2.0)
                    continue
                stats["errors"].append(f"{name}: HTTP {e.response.status_code}")
            except Exception as e:
                stats["errors"].append(f"{name}: {type(e).__name__} {str(e)[:120]}")
            return name, []

    candidates: List[Candidate] = []
    async with httpx.AsyncClient(timeout=15.0, headers={"User-Agent": USER_AGENT}) as client:
        tasks = [run("wikidata", lambda: _wikidata_around(client, lat, lon, radius_km, 2, cats))]
        if settings.GEOAPIFY_API_KEY:
            tasks.append(run("geoapify", lambda: _geoapify(client, lat, lon, radius_m, cats, 200)))
        if settings.OPENTRIPMAP_API_KEY:
            tasks.append(run("opentripmap", lambda: _opentripmap(client, lat, lon, radius_m, cats, 200, "1")))
        for name, res in await asyncio.gather(*tasks):
            candidates.extend(res)
            stats["sources"][name] = {"results": len(res)}

        merged = _merge_candidates(candidates)
        qids = sorted({m["wikidata"] for m in merged if m["wikidata"] and str(m["wikidata"]).startswith("Q")})
        langs: Dict[str, dict] = {}
        if qids:
            try:
                langs = await _wikidata_info(client, qids)
            except Exception as e:
                stats["errors"].append(f"wikidata: {type(e).__name__}")
        for m in merged:
            _score_place(m, langs)
            m["distance_km"] = round(haversine_km(lat, lon, m["lat"], m["lon"]), 2)
            m["sources"] = sorted(m["sources"])
            if m["wikipedia"] and ":" in m["wikipedia"]:
                lg, title = m["wikipedia"].split(":", 1)
                m["wikipedia_url"] = f"https://{lg}.wikipedia.org/wiki/{quote(title.replace(' ', '_'))}"
                m["wiki_lang"], m["wiki_title"] = lg, title
                _readable_name(m)

        merged.sort(key=lambda m: (-m["score"], m["distance_km"]))
        chosen = merged[:limit]
        try:
            await _wiki_cards(client, chosen)
        except Exception as e:
            stats["errors"].append(f"wiki cards: {type(e).__name__}")

    stats.update(candidates=len(candidates), after_merge=len(merged), shown=len(chosen),
                 seconds=round(time.time() - t0, 1))
    return {"radius_km": radius_km, "categories": cats, "places": chosen, "stats": stats}


async def wiki_near(name: str, lat: float, lon: float, max_km: float = 30.0) -> Optional[dict]:
    """Wikipedia article of a named place at given coordinates (a town of the route, a picked sight):
    full-text search by name in ru, then en; the hit with coordinates closest to the point wins."""
    name = (name or "").split(",")[0].strip()
    if not name or re.fullmatch(r"[-\d.\s]+", name):
        return None
    ck = ("wnear", name.lower(), round(lat, 2), round(lon, 2))
    if (hit := _cache.get(ck)) is not None:
        return hit or None
    found = None
    async with httpx.AsyncClient(timeout=10.0, headers={"User-Agent": USER_AGENT}) as client:
        for lang in ("ru", "en"):
            r = await client.get(f"https://{lang}.wikipedia.org/w/api.php", params={
                "action": "query", "generator": "search", "gsrsearch": name, "gsrlimit": 10,
                "prop": "coordinates", "format": "json"})
            if r.status_code != 200:
                continue
            best = None
            for pg in (r.json().get("query", {}).get("pages") or {}).values():
                co = (pg.get("coordinates") or [{}])[0]
                if "lat" not in co:
                    continue
                d = haversine_km(lat, lon, co["lat"], co["lon"])
                if d <= max_km and (best is None or d < best[0]):
                    best = (d, pg.get("title"))
            if best:
                found = (lang, best[1])
                break
    if not found:
        _cache.set(ck, {})
        return None
    summary = await wiki_summary(*found)
    out = {"lang": found[0], **summary} if summary else None
    _cache.set(ck, out or {})
    return out
