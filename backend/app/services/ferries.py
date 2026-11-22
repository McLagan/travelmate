"""
Ferry sailings via the public Ferryhopper MCP server (https://mcp.ferryhopper.com/mcp).

Ferryhopper documents the tools and inputs but not the exact output fields, so
the parsing below is deliberately defensive: it looks for the trip options list,
pulls out what it can recognise (times, operator, price, booking link) and also
returns each option's raw JSON so nothing is lost.
Docs: https://ferryhopper.github.io/fh-mcp/
"""

import json
import re
import time
import unicodedata
from datetime import date as _date, timedelta
from typing import Any, Dict, List, Optional
from urllib.parse import quote_plus

import httpx

MCP_URL = "https://mcp.ferryhopper.com/mcp"
USER_AGENT = "TravelMate/0.1 (personal project)"
_cache: Dict[tuple, tuple] = {}
CACHE_TTL = 30 * 60


class MCPError(Exception):
    pass


def _parse_rpc(resp: httpx.Response) -> dict:
    """Response is either plain JSON or an SSE stream with `data:` lines."""
    ctype = resp.headers.get("content-type", "")
    if "text/event-stream" in ctype:
        last = None
        for line in resp.text.splitlines():
            if line.startswith("data:"):
                payload = line[5:].strip()
                if payload:
                    try:
                        msg = json.loads(payload)
                    except ValueError:
                        continue
                    if "result" in msg or "error" in msg:
                        last = msg
        if last is None:
            raise MCPError("empty SSE response")
        return last
    return resp.json()


async def _mcp_call_tool(name: str, arguments: dict, url: str = MCP_URL) -> Any:
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
               "User-Agent": USER_AGENT}
    async with httpx.AsyncClient(timeout=40.0, headers=headers) as client:
        r = await client.post(url, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                       "clientInfo": {"name": "TravelMate", "version": "0.1"}}})
        r.raise_for_status()
        init = _parse_rpc(r)
        if "error" in init:
            raise MCPError(f"initialize: {init['error']}")
        sid = r.headers.get("mcp-session-id")
        h2 = {"Mcp-Session-Id": sid} if sid else {}
        proto = (init.get("result") or {}).get("protocolVersion")
        if proto:
            h2["MCP-Protocol-Version"] = proto
        await client.post(url, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=h2)
        r = await client.post(url, json={"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                             "params": {"name": name, "arguments": arguments}}, headers=h2)
        r.raise_for_status()
        msg = _parse_rpc(r)
    if "error" in msg:
        raise MCPError(str(msg["error"])[:300])
    result = msg.get("result") or {}
    if result.get("isError"):
        texts = " ".join(c.get("text", "") for c in result.get("content", []) if isinstance(c, dict))
        raise MCPError(texts[:300] or "tool error")
    if result.get("structuredContent") is not None:
        return result["structuredContent"]
    for c in result.get("content", []):
        if isinstance(c, dict) and c.get("type") == "text":
            try:
                return json.loads(c["text"])
            except ValueError:
                return {"text": c["text"]}
    return result


# ---- defensive extraction -------------------------------------------------

def _walk(obj, path=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield f"{path}.{k}" if path else k, k, v
            yield from _walk(v, f"{path}.{k}" if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from _walk(v, f"{path}[{i}]")


def _find_options(data) -> List[dict]:
    """legs[0].options[] per the docs; otherwise the first list of dicts that have an 'id'."""
    if isinstance(data, dict):
        legs = data.get("legs")
        if isinstance(legs, list) and legs and isinstance(legs[0], dict) and isinstance(legs[0].get("options"), list):
            return legs[0]["options"]
    for _, key, v in _walk(data):
        if isinstance(v, list) and v and all(isinstance(x, dict) for x in v) and any("id" in x for x in v):
            return v
    return []


_TIME_RE = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|^\d{1,2}:\d{2}")


def _pick_time(opt, words):
    for p, k, v in _walk(opt):
        kl = k.lower()
        if any(w in kl for w in words) and isinstance(v, str) and _TIME_RE.search(v):
            return v
    return None


def _pick_price(opt):
    for p, k, v in _walk(opt):
        kl = k.lower()
        if "price" in kl or kl in ("amount", "fare", "cost"):
            if isinstance(v, (int, float)):
                cur = None
                return {"amount": v, "currency": cur}
            if isinstance(v, dict):
                amt = next((v[x] for x in ("amount", "value", "total", "price", "min", "from") if isinstance(v.get(x), (int, float))), None)
                if amt is not None:
                    return {"amount": amt, "currency": v.get("currency") or v.get("currencyCode")}
            if isinstance(v, str) and re.search(r"\d", v):
                return {"amount": v, "currency": None}
    return None


def _pick_str(opt, words):
    for p, k, v in _walk(opt):
        kl = k.lower()
        if any(w in kl for w in words):
            if isinstance(v, str) and v.strip():
                return v
            if isinstance(v, dict):
                n = v.get("name") or v.get("title")
                if isinstance(n, str):
                    return n
    return None


_IMG_RE = re.compile(r"\.(png|jpe?g|gif|svg|webp|ico)(\?|$)", re.I)
_IMG_KEYS = ("image", "logo", "photo", "icon", "picture", "thumb", "img")
_BOOK_KEYS = ("book", "deeplink", "deep_link", "redirect", "checkout", "purchase", "buy")


def _pick_url(obj, domain: str = "ferryhopper"):
    """Booking link: never an image; keys like bookingUrl/deeplink win over any other link."""
    best, best_score = None, -1
    for p, k, v in _walk(obj):
        if not (isinstance(v, str) and v.startswith("http") and domain in v):
            continue
        kl, pl = k.lower(), p.lower()
        if _IMG_RE.search(v) or any(w in kl or w in pl for w in _IMG_KEYS) or "/images/" in v or "/media/" in v:
            continue
        score = 2 if any(w in kl for w in _BOOK_KEYS) else (1 if ("url" in kl or "link" in kl) else 0)
        if score > best_score:
            best, best_score = v, score
    return best


def fallback_links(from_name: str, to_name: str) -> List[dict]:
    q = quote_plus(f"ferry {from_name} {to_name}")
    return [
        {"label": "Ferryhopper", "url": "https://www.ferryhopper.com/"},
        {"label": "Direct Ferries", "url": "https://www.directferries.com/"},
        {"label": "Google", "url": f"https://www.google.com/search?q={q}"},
    ]


def _clean(name: str) -> str:
    return name.split(",")[0].strip()


def _ascii(name: str) -> str:
    """Vlorë -> Vlore, Igoumenítsa -> Igoumenitsa (ports are usually known by ASCII names)."""
    return unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().strip()


async def search_sailings(from_name: str, to_name: str, date: str) -> dict:
    a, b = _clean(from_name), _clean(to_name)
    ck = (a.lower(), b.lower(), date)
    hit = _cache.get(ck)
    if hit and time.time() - hit[0] < CACHE_TTL:
        return hit[1]

    out = {"from": a, "to": b, "date": date, "options": [], "links": fallback_links(_ascii(a) or a, _ascii(b) or b),
           "source": "Ferryhopper MCP", "error": None, "tried": []}
    try:
        if _date.fromisoformat(date) < _date.today():
            out["error"] = f"date {date} is in the past"
            return out
    except ValueError:
        pass

    # try the names as given, then ASCII-folded (Vlorë -> Vlore)
    variants = list(dict.fromkeys([(a, b), (_ascii(a) or a, _ascii(b) or b)]))
    data, last_err, used = None, None, None
    for va, vb in variants:
        out["tried"].append(f"{va} → {vb}")
        try:
            data = await _mcp_call_tool("search_ferry_trips", {
                "legs": [{"departureLocation": va, "arrivalLocation": vb, "departureDate": date}]})
            used = (va, vb)
        except Exception as e:
            last_err = f"{type(e).__name__}: {str(e)[:200]}"
            continue
        if _find_options(data):
            break
    if data is None:
        out["error"] = last_err
        return out

    # which ports Ferryhopper recognised (e.g. VLORA -> BRINDISI)
    try:
        leg0 = (data.get("legs") or [{}])[0]
        dp, ap = leg0.get("departurePort") or {}, leg0.get("arrivalPort") or {}
        if dp.get("name") and ap.get("name"):
            out["ports"] = f'{dp.get("name")} ({dp.get("code", "")}) → {ap.get("name")} ({ap.get("code", "")})'
    except Exception:
        pass

    found_date = date
    if not _find_options(data) and used:
        # nothing that day: look at the next 7 days (winter timetables are sparse)
        start = _date.fromisoformat(date)
        for k in range(1, 8):
            d2 = (start + timedelta(days=k)).isoformat()
            try:
                d2data = await _mcp_call_tool("search_ferry_trips", {
                    "legs": [{"departureLocation": used[0], "arrivalLocation": used[1], "departureDate": d2}]})
            except Exception:
                continue
            if _find_options(d2data):
                data, found_date = d2data, d2
                break
        out["searched_until"] = (start + timedelta(days=7)).isoformat()
    out["found_date"] = found_date if _find_options(data) else None

    general_url = _pick_url(data)
    for opt in _find_options(data)[:20]:
        out["options"].append({
            "id": opt.get("id"),
            "date": found_date,
            "departure": _pick_time(opt, ("depart",)),
            "arrival": _pick_time(opt, ("arriv",)),
            "operator": _pick_str(opt, ("operator", "company", "carrier")),
            "vessel": _pick_str(opt, ("vessel", "ship")),
            "duration": opt.get("duration") or opt.get("durationMinutes") or opt.get("tripDuration"),
            "price": _pick_price(opt),
            "url": _pick_url(opt) or general_url,
            "raw": opt,
        })
    if not out["options"]:
        # unknown shape or really nothing: show what came back so the parser can be adapted
        out["raw"] = json.dumps(data, ensure_ascii=False)[:4000]
    _cache[ck] = (time.time(), out)
    return out


async def booking_link(trip_id: str) -> Optional[str]:
    """Ask trip_details for a sailing's booking link (used when the search result had none)."""
    data = await _mcp_call_tool("trip_details", {"tripId": trip_id})
    return _pick_url(data)
