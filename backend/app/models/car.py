"""
Cars of a user (consumption for the trip budget) and fuel prices the user entered by hand
for countries without an automatic source.
"""
from sqlalchemy import Column, Integer, String, Float, ForeignKey, DateTime, Text, UniqueConstraint
from sqlalchemy.sql import func

from app.database import Base


class Car(Base):
    __tablename__ = "cars"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String, nullable=False)          # "Наша Škoda"
    make = Column(String)
    model = Column(String)
    year = Column(Integer)
    fuel_type = Column(String, default="petrol")   # petrol | diesel | lpg | hybrid | electric
    consumption = Column(Float)                    # L/100 km (kWh/100 km for electric), real-life value
    tank_l = Column(Float)
    notes = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ManualFuelPrice(Base):
    __tablename__ = "fuel_prices_manual"
    __table_args__ = (UniqueConstraint("user_id", "country", "fuel", name="uq_fuel_manual"),)

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    country = Column(String(2), nullable=False)    # ISO 3166-1 alpha-2
    fuel = Column(String, nullable=False)          # petrol | diesel | lpg
    price = Column(Float, nullable=False)          # per litre
    currency = Column(String, default="EUR")
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
