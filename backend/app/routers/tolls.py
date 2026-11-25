"""
Vignettes and toll tunnels/bridges for a trip (data: fuel-prices.eu, CC BY 4.0).
"""

from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services import tolls as svc
from app.utils.auth import get_current_user

router = APIRouter()


class LegIn(BaseModel):
    day: int = Field(..., ge=1, le=400)
    coords: List[List[float]] = Field(..., min_length=2, max_length=5000)


class EstimateIn(BaseModel):
    legs: List[LegIn] = Field(..., max_length=60)


@router.post("/estimate")
def estimate(body: EstimateIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    if sum(len(l.coords) for l in body.legs) > 30000:
        raise HTTPException(status_code=413, detail="Route too long")
    return svc.estimate(db, [l.model_dump() for l in body.legs])
