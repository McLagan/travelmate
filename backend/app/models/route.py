"""
Route model for travel planning
"""

from sqlalchemy import Column, Integer, String, Float, ForeignKey, DateTime, Text, Boolean
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship

from app.database import Base


class Route(Base):
    __tablename__ = "routes"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    description = Column(String)
    start_date = Column(String)        # trip start, YYYY-MM-DD (days are counted from it)
    # budget
    fuel_l_per_100km = Column(Float)
    fuel_price = Column(Float)         # per litre
    fuel_currency = Column(String)
    budget_currency = Column(String)
    extras = Column(Text)              # JSON list [{label, amount, currency, booked}]
    car_id = Column(Integer)           # cars.id of the user (fuel type, consumption)
    fuel_settings = Column(Text)       # JSON {start_pct, reserve_pct, end} of the refuel plan

    # Start and end points
    start_name = Column(String, nullable=False)
    start_latitude = Column(Float, nullable=False)
    start_longitude = Column(Float, nullable=False)

    end_name = Column(String, nullable=False)
    end_latitude = Column(Float, nullable=False)
    end_longitude = Column(Float, nullable=False)

    # Metadata
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationship with User
    user = relationship("User", back_populates="routes")

    # Ordered stops (start, intermediate points, finish).
    # start_*/end_* columns are kept in sync with the first/last waypoint
    # for backward compatibility with routes created before waypoints existed.
    waypoints = relationship(
        "RouteWaypoint",
        back_populates="route",
        order_by="RouteWaypoint.position",
        cascade="all, delete-orphan",
    )


class RouteWaypoint(Base):
    __tablename__ = "route_waypoints"

    id = Column(Integer, primary_key=True, index=True)
    route_id = Column(Integer, ForeignKey("routes.id", ondelete="CASCADE"), nullable=False, index=True)
    position = Column(Integer, nullable=False)  # 0-based order within the route
    name = Column(String, nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    note = Column(Text)
    # how to travel from this stop to the next one
    leg_mode = Column(String, default="road")   # "road" | "ferry"
    leg_hours = Column(Float)                    # ferry crossing time (hours)
    leg_date = Column(String)                    # planned ferry date, YYYY-MM-DD
    # what happens at this stop
    stop_type = Column(String, default="pass")   # "pass" | "visit" | "overnight"
    nights = Column(Integer)                     # overnight: number of nights
    lodging_name = Column(String)
    lodging_url = Column(String)
    lodging_price = Column(Float)                # total for the stay
    lodging_currency = Column(String)
    lodging_booked = Column(Boolean)
    lodging_paid = Column(Boolean)
    # budget & booking of the leg to the next stop
    leg_cost = Column(Float)
    leg_currency = Column(String)
    leg_booked = Column(Boolean)
    leg_paid = Column(Boolean)
    leg_ref = Column(String)
    # places chosen at this stop, JSON list (see schemas.route.StopSpot)
    spots = Column(Text)
    # places on the way to the next stop (not stops themselves), JSON list
    leg_spots = Column(Text)

    route = relationship("Route", back_populates="waypoints")