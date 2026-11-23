"""
Cars of the user and fuel: /cars (CRUD), /fuel/prices (manual prices), /fuel/estimate (cost per country).
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.car import Car, ManualFuelPrice
from app.models.user import User
from app.services import fuel as fuel_service
from app.utils.auth import get_current_user

router = APIRouter()
FUELS = "^(petrol|diesel|lpg|hybrid|electric)$"


class CarIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    make: Optional[str] = Field(None, max_length=60)
    model: Optional[str] = Field(None, max_length=60)
    year: Optional[int] = Field(None, ge=1950, le=2100)
    fuel_type: str = Field("petrol", pattern=FUELS)
    consumption: Optional[float] = Field(None, gt=0, le=100)
    tank_l: Optional[float] = Field(None, gt=0, le=500)
    notes: Optional[str] = Field(None, max_length=1000)


class CarOut(CarIn):
    id: int

    class Config:
        from_attributes = True


def _car(db, user, car_id) -> Car:
    car = db.query(Car).filter(Car.id == car_id, Car.user_id == user.id).first()
    if not car:
        raise HTTPException(status_code=404, detail="Car not found")
    return car


@router.get("/cars", response_model=List[CarOut])
def list_cars(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.query(Car).filter(Car.user_id == user.id).order_by(Car.id).all()


@router.post("/cars", response_model=CarOut, status_code=201)
def create_car(data: CarIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    car = Car(user_id=user.id, **data.model_dump())
    db.add(car)
    db.commit()
    db.refresh(car)
    return car


@router.put("/cars/{car_id}", response_model=CarOut)
def update_car(car_id: int, data: CarIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    car = _car(db, user, car_id)
    for k, v in data.model_dump().items():
        setattr(car, k, v)
    db.commit()
    db.refresh(car)
    return car


@router.delete("/cars/{car_id}", status_code=204)
def delete_car(car_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.delete(_car(db, user, car_id))
    db.commit()


# ---------------- fuel prices ----------------

class ManualPriceIn(BaseModel):
    country: str = Field(..., pattern="^[A-Z]{2}$")
    fuel: str = Field(..., pattern="^(petrol|diesel|lpg|electric)$")
    price: float = Field(..., gt=0, le=100_000)
    currency: str = Field("EUR", pattern="^[A-Z]{3}$")


@router.put("/fuel/prices")
def set_manual_price(data: ManualPriceIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.query(ManualFuelPrice).filter_by(user_id=user.id, country=data.country, fuel=data.fuel).first()
    if row:
        row.price, row.currency = data.price, data.currency
    else:
        db.add(ManualFuelPrice(user_id=user.id, **data.model_dump()))
    db.commit()
    return {"ok": True}


@router.delete("/fuel/prices/{country}/{fuel}", status_code=204)
def delete_manual_price(country: str, fuel: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(ManualFuelPrice).filter_by(user_id=user.id, country=country.upper(), fuel=fuel).delete()
    db.commit()


class EstimateIn(BaseModel):
    lines: List[List[List[float]]] = Field(..., max_length=50)    # road parts, [[lon, lat], ...]
    fuel_type: str = Field("petrol", pattern=FUELS)
    consumption: float = Field(..., gt=0, le=100)


@router.post("/fuel/estimate")
async def estimate(data: EstimateIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Road km per country x consumption x price of that country. EU prices are automatic (weekly bulletin),
    other countries use the price the user entered; without a price the country is listed with price null."""
    if sum(len(l) for l in data.lines) > 60_000:
        raise HTTPException(status_code=413, detail="Route geometry too large")
    fuel = {"hybrid": "petrol"}.get(data.fuel_type, data.fuel_type)
    km = fuel_service.km_by_country(data.lines)
    names = fuel_service.country_names()
    manual = {(r.country, r.fuel): r for r in db.query(ManualFuelPrice).filter_by(user_id=user.id).all()}
    rows = []
    for cc, k in km.items():
        amount = k * data.consumption / 100
        row = {"country": cc, "name": names.get(cc, "unknown / at sea"), "km": k, "amount": round(amount, 1),
               "unit": "kWh" if fuel == "electric" else "L", "price": None, "currency": None, "source": None, "date": None}
        eu = await fuel_service.eu_price(cc) if fuel in ("petrol", "diesel") and cc != "??" else None
        if eu and eu.get(fuel):
            row.update(price=eu[fuel], currency="EUR", source="eu_bulletin", date=eu["date"])
        elif (cc, fuel) in manual:
            m = manual[(cc, fuel)]
            row.update(price=m.price, currency=m.currency, source="manual",
                       date=m.updated_at.date().isoformat() if m.updated_at else None)
        if row["price"] is not None:
            row["cost"] = round(amount * row["price"], 2)
        rows.append(row)
    return {"fuel": fuel, "consumption": data.consumption, "countries": rows,
            "total_km": round(sum(km.values()), 1), "attribution": fuel_service.ATTRIBUTION}


class PlanIn(BaseModel):
    lines: List[List[List[float]]] = Field(..., max_length=50)
    fuel_type: str = Field("petrol", pattern=FUELS)
    consumption: float = Field(..., gt=0, le=100)
    tank_l: float = Field(..., gt=5, le=500)
    # fuel already in the tank at departure (NOT counted in the budget); 0 = only the reserve, so the first
    # fill-up at home is planned and counted like every other one
    start_pct: float = Field(0, ge=0, le=100)
    reserve_pct: float = Field(15, ge=0, le=50)
    end: str = Field("empty", pattern="^(same|empty|full)$")   # tank at the end: like at start / don't care / full


@router.post("/fuel/plan")
async def refuel_plan(data: PlanIn, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Where and how much to refuel for the lowest fuel cost (prices compared in EUR)."""
    if sum(len(l) for l in data.lines) > 60_000:
        raise HTTPException(status_code=413, detail="Route geometry too large")
    fuel = {"hybrid": "petrol"}.get(data.fuel_type, data.fuel_type)
    runs = fuel_service.country_runs(data.lines)
    if not runs:
        raise HTTPException(status_code=400, detail="No road in the route")
    countries = list(dict.fromkeys(r["cc"] for r in runs if r["cc"] != "??"))
    manual = {(r.country, r.fuel): r for r in db.query(ManualFuelPrice).filter_by(user_id=user.id).all()}
    rates = await fuel_service.eur_rates()
    prices, info, missing = {}, {}, []
    for cc in countries:
        eu = await fuel_service.eu_price(cc) if fuel in ("petrol", "diesel") else None
        if eu and eu.get(fuel):
            prices[cc] = eu[fuel]
            info[cc] = {"price": eu[fuel], "currency": "EUR", "price_eur": eu[fuel], "source": "eu_bulletin", "date": eu["date"]}
        elif (cc, fuel) in manual:
            m = manual[(cc, fuel)]
            rate = 1.0 if m.currency == "EUR" else (rates or {}).get(m.currency)
            pe = round(m.price / rate, 4) if rate else None
            prices[cc] = pe
            info[cc] = {"price": m.price, "currency": m.currency, "price_eur": pe, "source": "manual",
                        "date": m.updated_at.date().isoformat() if m.updated_at else None}
            if pe is None:
                missing.append(cc)
        else:
            prices[cc] = None
            missing.append(cc)
    tank = data.tank_l
    start_l = max(tank * data.start_pct / 100, tank * data.reserve_pct / 100)
    reserve_l = tank * data.reserve_pct / 100
    end_l = {"same": start_l, "empty": reserve_l, "full": tank}[data.end]
    plan = fuel_service.plan_refuels(runs, prices, data.consumption, tank, start_l, reserve_l, end_l)
    names = fuel_service.country_names()
    for st in plan["stops"]:
        st["name"] = names.get(st["cc"], st["cc"])
        st.pop("end", None)
    return {**plan, "fuel": fuel, "prices": info, "missing": missing, "names": {cc: names.get(cc, cc) for cc in countries},
            "settings": {"tank_l": tank, "start_pct": data.start_pct, "reserve_pct": data.reserve_pct, "end": data.end},
            "attribution": fuel_service.ATTRIBUTION}
