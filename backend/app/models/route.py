"""
Route model for travel planning
"""

from sqlalchemy import Column, Integer, String, Float, ForeignKey, DateTime, Text
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship

from app.database import Base


class Route(Base):
    __tablename__ = "routes"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    description = Column(String)

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

    route = relationship("Route", back_populates="waypoints")