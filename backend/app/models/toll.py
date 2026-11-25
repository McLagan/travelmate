"""
Toll reference data: vignettes, toll tunnels / bridges / passes (later: toll gates).
Imported daily from fuel-prices.eu (CC BY 4.0, attribution required); the admin can review changes,
override a price, hide a record or add one by hand.
"""

from sqlalchemy import Boolean, Column, DateTime, Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.sql import func

from app.database import Base


class TollItem(Base):
    __tablename__ = "toll_items"
    __table_args__ = (UniqueConstraint("source", "source_id", name="uq_toll_source"),)

    id = Column(Integer, primary_key=True, index=True)
    source = Column(String(16), nullable=False, default="fpeu")   # "fpeu" (fuel-prices.eu) | "admin"
    source_id = Column(Integer)                                    # id in the source
    country = Column(String(2), nullable=False, index=True)
    type = Column(String(20), nullable=False, index=True)          # vignette | tunnel | bridge | gate | ticket_barrier
    barrier_type = Column(String(16))
    name = Column(String, nullable=False)
    price_eur = Column(Float)                                      # as in the source
    price_local = Column(Float)
    currency = Column(String(3))
    info = Column(Text)
    lat = Column(Float)
    lng = Column(Float)
    # admin
    override_price_eur = Column(Float)                             # used instead of price_eur when set
    hidden = Column(Boolean, nullable=False, default=False, server_default="false")
    reviewed = Column(Boolean, nullable=False, default=False, server_default="false")
    prev_price_eur = Column(Float)                                 # before the last change in the source
    changed_at = Column(DateTime(timezone=True))                   # last price change seen in the source
    gone = Column(Boolean, nullable=False, default=False, server_default="false")  # no longer in the source
    fetched_at = Column(DateTime(timezone=True))
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class DataImport(Base):
    """State of a scheduled import (one row per importer)."""
    __tablename__ = "data_imports"

    name = Column(String(32), primary_key=True)
    last_attempt_at = Column(DateTime(timezone=True))
    last_ok_at = Column(DateTime(timezone=True))
    last_error = Column(Text)
    last_count = Column(Integer)
    last_changes = Column(Integer)


class AdminLog(Base):
    """Who changed what in the admin area."""
    __tablename__ = "admin_log"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True)
    user_name = Column(String)
    action = Column(String(64), nullable=False)
    details = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
