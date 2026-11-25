"""
Sharing a trip with other people (e.g. family).

- the owner invites a person by the email of their TravelMate account, as "editor" or "viewer"
- the trip appears in that person's trips only after they accept (a wrong address does no harm:
  the stranger just sees an invitation they can decline; it expires after 14 days)
- editors change the trip, viewers only look; only the owner deletes the trip and manages people
- saves carry the trip version: a save based on an older version is refused (see RouteService.update_route)
"""

from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.route import Route, RouteMember
from app.models.user import User
from app.services import mailer
from app.services.route import RouteService
from app.utils import ratelimit as rl
from app.utils.auth import get_current_user, find_user_by_email

router = APIRouter()

INVITE_DAYS = 14
Role = Literal["editor", "viewer"]


class InviteIn(BaseModel):
    email: EmailStr
    role: Role = "editor"


class RoleIn(BaseModel):
    role: Role


def _now():
    return datetime.now(timezone.utc)


def _expired(m: RouteMember) -> bool:
    created = m.created_at
    if created is None:
        return False
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return m.status == "pending" and created < _now() - timedelta(days=INVITE_DAYS)


def _route_for(db: Session, route_id: int, user: User, owner_only: bool = False) -> tuple:
    route, role = RouteService(db).access(route_id, user.id)
    if not route:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trip not found")
    if owner_only and role != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the owner can manage who has access")
    return route, role


def _member_out(m: RouteMember, u: User, show_email: bool) -> dict:
    return {"id": m.id, "user_id": m.user_id, "name": u.name if u else "?", "role": m.role,
            "status": "expired" if _expired(m) else m.status,
            "email": u.email if (u and show_email) else None,
            "invited_at": m.created_at, "responded_at": m.responded_at}


def _invite_mail(to: str, inviter: str, trip: str, role: str):
    url = f"{settings.APP_BASE_URL.rstrip('/')}/trips"
    what = "view and edit" if role == "editor" else "view"
    text = (f"{inviter} invited you to the trip \"{trip}\" on TravelMate ({what}).\n\n"
            f"Open your trips to accept or decline: {url}\n\n"
            f"If you don't know {inviter}, just decline or ignore it - the trip will not appear in your account.\n")
    mailer.send_mail(to, f"{inviter} shared a trip with you: {trip}", text)


# ---------- the owner: people of a trip ----------

@router.get("/routes/{route_id}/members")
def list_members(route_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Owner and members of a trip. Emails are shown to the owner only."""
    route, role = _route_for(db, route_id, user)
    rows = db.query(RouteMember, User).join(User, User.id == RouteMember.user_id) \
        .filter(RouteMember.route_id == route_id).order_by(RouteMember.created_at).all()
    if role != "owner":
        rows = [(m, u) for m, u in rows if m.status == "accepted"]
    owner = route.user
    return {"my_role": role,
            "owner": {"user_id": route.user_id, "name": owner.name if owner else "?",
                      "email": owner.email if (owner and role == "owner") else None},
            "members": [_member_out(m, u, role == "owner") for m, u in rows if m.status != "declined" or role == "owner"]}


@router.post("/routes/{route_id}/members", status_code=status.HTTP_201_CREATED)
def invite(route_id: int, body: InviteIn, background: BackgroundTasks, db: Session = Depends(get_db),
           user: User = Depends(get_current_user)):
    route, _ = _route_for(db, route_id, user, owner_only=True)
    rl.check_and_record(f"invite:user:{user.id}", 20, 24 * 3600)
    target = find_user_by_email(db, str(body.email))
    if not target or not target.is_active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND,
                            detail="There is no account with this email yet. Ask them to sign up with this address, then invite again.")
    if target.id == user.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This is you - you already own the trip")
    m = db.query(RouteMember).filter(RouteMember.route_id == route_id, RouteMember.user_id == target.id).first()
    if m and m.status == "accepted":
        m.role = body.role                       # already in: just change the rights
        db.commit()
        return _member_out(m, target, True)
    if m:                                        # pending / declined / expired: invite again
        m.status, m.role, m.invited_by, m.created_at, m.responded_at = "pending", body.role, user.id, _now(), None
    else:
        m = RouteMember(route_id=route_id, user_id=target.id, role=body.role, status="pending", invited_by=user.id)
        db.add(m)
    db.commit()
    db.refresh(m)
    background.add_task(_invite_mail, target.email, user.name, route.name, body.role)
    return _member_out(m, target, True)


@router.patch("/routes/{route_id}/members/{member_id}")
def change_role(route_id: int, member_id: int, body: RoleIn, db: Session = Depends(get_db),
                user: User = Depends(get_current_user)):
    _route_for(db, route_id, user, owner_only=True)
    m = db.query(RouteMember).filter(RouteMember.id == member_id, RouteMember.route_id == route_id).first()
    if not m:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    m.role = body.role
    db.commit()
    return _member_out(m, db.get(User, m.user_id), True)


@router.delete("/routes/{route_id}/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_member(route_id: int, member_id: int, db: Session = Depends(get_db),
                  user: User = Depends(get_current_user)):
    """The owner removes someone (or withdraws an invitation); a member removes themselves (= leaves)."""
    m = db.query(RouteMember).filter(RouteMember.id == member_id, RouteMember.route_id == route_id).first()
    route = db.query(Route).filter(Route.id == route_id).first()
    if not m or not route or (route.user_id != user.id and m.user_id != user.id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    db.delete(m)
    db.commit()


@router.post("/routes/{route_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
def leave(route_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    m = db.query(RouteMember).filter(RouteMember.route_id == route_id, RouteMember.user_id == user.id).first()
    if not m:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    db.delete(m)
    db.commit()


@router.get("/routes/{route_id}/version")
def route_version(route_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Cheap check for the trip page: has someone saved the trip since I loaded it?"""
    route, _ = _route_for(db, route_id, user)
    who = db.query(User).filter(User.id == route.updated_by).first() if route.updated_by else None
    return {"version": route.version or 1, "updated_at": route.updated_at,
            "updated_by_name": who.name if who else None, "updated_by_me": route.updated_by == user.id}


# ---------- the invited person ----------

@router.get("/invitations")
def my_invitations(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    rows = db.query(RouteMember, Route, User).join(Route, Route.id == RouteMember.route_id) \
        .join(User, User.id == Route.user_id) \
        .filter(RouteMember.user_id == user.id, RouteMember.status == "pending").all()
    return [{"id": m.id, "route_id": r.id, "trip": r.name, "owner": owner.name, "role": m.role,
             "start_date": r.start_date, "stops": len(r.waypoints or []), "invited_at": m.created_at}
            for m, r, owner in rows if not _expired(m)]


def _my_invitation(db: Session, member_id: int, user: User) -> RouteMember:
    m = db.query(RouteMember).filter(RouteMember.id == member_id, RouteMember.user_id == user.id,
                                     RouteMember.status == "pending").first()
    if not m or _expired(m):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="This invitation is no longer valid")
    return m


@router.post("/invitations/{member_id}/accept")
def accept(member_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    m = _my_invitation(db, member_id, user)
    m.status, m.responded_at = "accepted", _now()
    db.commit()
    return {"route_id": m.route_id, "role": m.role}


@router.post("/invitations/{member_id}/decline", status_code=status.HTTP_204_NO_CONTENT)
def decline(member_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    m = _my_invitation(db, member_id, user)
    m.status, m.responded_at = "declined", _now()
    db.commit()
