"""
Admin area API (/admin/api/...). Every endpoint requires users.is_admin; every change is written to admin_log.
"""

import json
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.toll import TollItem, DataImport, AdminLog
from app.models.user import User
from app.services import tolls as toll_svc
from app.services.fuel import country_names
from app.utils.auth import require_admin

router = APIRouter()


def _log(db: Session, user: User, action: str, details: dict):
    db.add(AdminLog(user_id=user.id, user_name=user.name, action=action, details=json.dumps(details, ensure_ascii=False, default=str)))
    db.commit()


def _toll_out(t: TollItem) -> dict:
    return {"id": t.id, "source": t.source, "country": t.country, "type": t.type, "name": t.name,
            "price_eur": t.price_eur, "override_price_eur": t.override_price_eur, "prev_price_eur": t.prev_price_eur,
            "price_local": t.price_local, "currency": t.currency, "info": t.info, "lat": t.lat, "lng": t.lng,
            "hidden": t.hidden, "reviewed": t.reviewed, "gone": t.gone, "changed_at": t.changed_at,
            "fetched_at": t.fetched_at, "url": toll_svc.official_url(t.info), "verified": toll_svc.verified_on(t.info),
            "days": toll_svc.vignette_days(t.name) if t.type == "vignette" else None}


@router.get("/me")
def me(user: User = Depends(require_admin)):
    return {"id": user.id, "name": user.name}


@router.get("/tolls/status")
def tolls_status(db: Session = Depends(get_db), user: User = Depends(require_admin)):
    st = db.get(DataImport, toll_svc.IMPORT_NAME)
    q = db.query(TollItem)
    return {"source": toll_svc.SOURCE_URL, "attribution": toll_svc.ATTRIBUTION,
            "last_ok_at": st.last_ok_at if st else None, "last_attempt_at": st.last_attempt_at if st else None,
            "last_error": st.last_error if st else None, "last_count": st.last_count if st else None,
            "total": q.count(), "to_review": q.filter(TollItem.reviewed.is_(False)).count(),
            "countries": country_names()}


@router.post("/tolls/import")
async def tolls_import(db: Session = Depends(get_db), user: User = Depends(require_admin)):
    res = await toll_svc.run_import(db)
    _log(db, user, "tolls.import", res)
    return res


def _filtered(db: Session, country, type, only, q):
    query = db.query(TollItem)
    if country:
        query = query.filter(TollItem.country == country.upper())
    if type:
        query = query.filter(TollItem.type == type)
    if only == "review":
        query = query.filter(TollItem.reviewed.is_(False))
    elif only == "hidden":
        query = query.filter(TollItem.hidden.is_(True))
    elif only == "overridden":
        query = query.filter(TollItem.override_price_eur.isnot(None))
    if q:
        query = query.filter(or_(TollItem.name.ilike(f"%{q}%"), TollItem.info.ilike(f"%{q}%")))
    return query


@router.get("/tolls")
def tolls_list(country: Optional[str] = Query(None, max_length=2), type: Optional[str] = Query(None, max_length=20),
               only: Optional[Literal["review", "hidden", "overridden"]] = None, q: Optional[str] = Query(None, max_length=60),
               db: Session = Depends(get_db), user: User = Depends(require_admin)):
    rows = _filtered(db, country, type, only, q).order_by(TollItem.country, TollItem.type, TollItem.name).limit(1000).all()
    return [_toll_out(t) for t in rows]


@router.post("/tolls/review-shown")
def tolls_review_shown(country: Optional[str] = Query(None, max_length=2), type: Optional[str] = Query(None, max_length=20),
                       only: Optional[Literal["review", "hidden", "overridden"]] = None, q: Optional[str] = Query(None, max_length=60),
                       db: Session = Depends(get_db), user: User = Depends(require_admin)):
    """Mark every record matching the current filter as reviewed."""
    ids = [t.id for t in _filtered(db, country, type, only, q).filter(TollItem.reviewed.is_(False))]
    if ids:
        db.query(TollItem).filter(TollItem.id.in_(ids)).update({"reviewed": True}, synchronize_session=False)
        db.commit()
    _log(db, user, "tolls.review_shown", {"count": len(ids), "country": country, "type": type, "only": only, "q": q})
    return {"reviewed": len(ids)}


class TollPatch(BaseModel):
    override_price_eur: Optional[float] = Field(None, ge=0, le=10000)
    clear_override: bool = False
    hidden: Optional[bool] = None
    reviewed: Optional[bool] = None


@router.patch("/tolls/{toll_id}")
def tolls_patch(toll_id: int, body: TollPatch, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    t = db.get(TollItem, toll_id)
    if not t:
        raise HTTPException(status_code=404, detail="Not found")
    before = _toll_out(t)
    if body.clear_override:
        t.override_price_eur = None
    elif body.override_price_eur is not None:
        t.override_price_eur = body.override_price_eur
    if body.hidden is not None:
        t.hidden = body.hidden
    if body.reviewed is not None:
        t.reviewed = body.reviewed
    db.commit()
    _log(db, user, "tolls.update", {"id": t.id, "name": t.name, "country": t.country,
                                     "before": {k: before[k] for k in ("override_price_eur", "hidden", "reviewed")},
                                     "after": body.model_dump(exclude_none=True)})
    return _toll_out(t)


class TollIn(BaseModel):
    country: str = Field(..., min_length=2, max_length=2)
    type: Literal["vignette", "tunnel", "bridge"]
    name: str = Field(..., min_length=2, max_length=200)
    price_eur: float = Field(..., ge=0, le=10000)
    info: Optional[str] = Field(None, max_length=1000)
    lat: Optional[float] = Field(None, ge=-90, le=90)
    lng: Optional[float] = Field(None, ge=-180, le=180)


@router.post("/tolls", status_code=201)
def tolls_add(body: TollIn, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    if body.type != "vignette" and (body.lat is None or body.lng is None):
        raise HTTPException(status_code=400, detail="Tunnels and bridges need coordinates")
    t = TollItem(source="admin", country=body.country.upper(), type=body.type, name=body.name,
                 price_eur=body.price_eur, currency="EUR", info=body.info, lat=body.lat, lng=body.lng, reviewed=True)
    db.add(t)
    db.commit()
    db.refresh(t)
    _log(db, user, "tolls.add", _toll_out(t))
    return _toll_out(t)


@router.delete("/tolls/{toll_id}", status_code=204)
def tolls_delete(toll_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)):
    """Only records added by hand can be deleted (imported ones are hidden instead)."""
    t = db.get(TollItem, toll_id)
    if not t:
        raise HTTPException(status_code=404, detail="Not found")
    if t.source != "admin":
        raise HTTPException(status_code=400, detail="Imported records cannot be deleted - hide them instead")
    _log(db, user, "tolls.delete", _toll_out(t))
    db.delete(t)
    db.commit()


@router.get("/log")
def admin_log(db: Session = Depends(get_db), user: User = Depends(require_admin)):
    rows = db.query(AdminLog).order_by(AdminLog.id.desc()).limit(100).all()
    return [{"at": r.created_at, "user": r.user_name, "action": r.action, "details": r.details} for r in rows]
