"""
Read a booking confirmation (pasted text, screenshot or PDF) with the Claude API and return structured fields:
what was booked, dates, total price and currency, whether it is already paid, confirmation number, link.
Nothing is stored here: the file goes to the Claude API once and the answer goes back to the browser,
where the traveller checks it before it is written into the trip.
"""
from __future__ import annotations

import base64
from typing import Optional

import httpx

from app.config import settings
from app.services.ai_review import API_URL, AIReviewError

MEDIA = {"image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"}
MAX_FILE = 5 * 1024 * 1024
MAX_TEXT = 30_000

TOOL = {
    "name": "save_booking",
    "description": "Save what the booking confirmation says. Leave a field out when the confirmation does not say it.",
    "input_schema": {
        "type": "object",
        "properties": {
            "is_booking": {"type": "boolean", "description": "false if this is not a booking confirmation at all"},
            "kind": {"type": "string", "enum": ["lodging", "ferry", "flight", "other"]},
            "name": {"type": "string", "description": "hotel / apartment name, or ferry/airline company with route"},
            "address": {"type": "string"},
            "city": {"type": "string", "description": "city or place of the lodging; for ferry/flight: departure port/airport city"},
            "to_city": {"type": "string", "description": "ferry/flight: arrival port/airport city"},
            "check_in": {"type": "string", "description": "YYYY-MM-DD; ferry/flight: departure date"},
            "check_out": {"type": "string", "description": "YYYY-MM-DD"},
            "total_price": {"type": "number", "description": "the total the traveller pays for the whole booking, taxes and fees included"},
            "currency": {"type": "string", "description": "ISO 4217 code, e.g. EUR, RSD"},
            "payment": {"type": "string", "enum": ["paid", "partly_paid", "pay_later", "unknown"],
                        "description": "paid = the full amount was already charged; partly_paid = deposit/prepayment only; "
                                       "pay_later = pay at the property / charged later; unknown = not stated"},
            "amount_paid": {"type": "number", "description": "amount already charged, if stated"},
            "pay_due": {"type": "string", "description": "when the rest is charged/paid, if stated (YYYY-MM-DD or text)"},
            "free_cancellation_until": {"type": "string", "description": "YYYY-MM-DD if stated"},
            "confirmation_number": {"type": "string"},
            "booking_site": {"type": "string", "description": "Booking.com, Airbnb, hotel website, Ferryhopper..."},
            "url": {"type": "string", "description": "link to manage the booking, only if it is in the confirmation"},
            "guests": {"type": "string"},
            "notes": {"type": "string", "description": "one short line worth remembering (breakfast, parking, check-in time), traveller's language"},
        },
        "required": ["is_booking"],
    },
}

SYSTEM = """You read booking confirmations (e-mails, screenshots, PDFs) for a trip planner and call save_booking exactly once.
Copy facts only from the confirmation; never guess prices, dates or payment status. The total price is the full amount for
the stay or ticket (all nights, taxes and fees that the confirmation includes). Payment: "paid" only if the confirmation
clearly says the full amount was charged/paid (e.g. "You paid", "Paid online", "Prepaid", "Payment received");
"pay at the property", "you'll pay", "will be charged on" mean pay_later. Dates as YYYY-MM-DD."""


async def extract(text: Optional[str], file_b64: Optional[str], media_type: Optional[str]) -> dict:
    if not settings.ANTHROPIC_API_KEY:
        raise AIReviewError("no ANTHROPIC_API_KEY in backend/.env")
    content = []
    if file_b64:
        if media_type not in MEDIA:
            raise ValueError("Use a screenshot (JPG, PNG, WebP) or a PDF")
        try:
            raw = base64.b64decode(file_b64, validate=True)
        except Exception:
            raise ValueError("File could not be read")
        if len(raw) > MAX_FILE:
            raise ValueError("File is larger than 5 MB")
        kind = "document" if media_type == "application/pdf" else "image"
        content.append({"type": kind, "source": {"type": "base64", "media_type": media_type, "data": file_b64}})
    if text and text.strip():
        content.append({"type": "text", "text": "Confirmation text:\n" + text.strip()[:MAX_TEXT]})
    if not content:
        raise ValueError("Paste the confirmation or attach a screenshot / PDF")
    content.append({"type": "text", "text": "Extract the booking."})
    body = {"model": settings.ANTHROPIC_MODEL, "max_tokens": 1000, "system": SYSTEM,
            "tools": [TOOL], "tool_choice": {"type": "tool", "name": "save_booking"},
            "messages": [{"role": "user", "content": content}]}
    headers = {"x-api-key": settings.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            r = await client.post(API_URL, json=body, headers=headers)
    except httpx.HTTPError as e:
        raise AIReviewError(f"Claude API unreachable: {type(e).__name__}")
    if r.status_code != 200:
        try:
            err = r.json().get("error", {})
            msg = f'{err.get("type", "error")}: {err.get("message", "")[:200]}'
        except ValueError:
            msg = r.text[:200]
        raise AIReviewError(f"Claude API HTTP {r.status_code} — {msg}")
    j = r.json()
    out = next((b.get("input") for b in j.get("content", []) if b.get("type") == "tool_use"), None)
    if not isinstance(out, dict):
        raise AIReviewError("Claude did not return the booking")
    if isinstance(out.get("currency"), str):
        out["currency"] = out["currency"].strip().upper()[:3]
    return out
