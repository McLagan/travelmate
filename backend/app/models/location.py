"""
Location model for places and points of interest
"""

from sqlalchemy import Column, Integer, String, Float
from app.database import Base


class Location(Base):
    __tablename__ = "locations"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    display_name = Column(String)  # Full address from OpenStreetMap
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    place_type = Column(String)  # city, restaurant, attraction, etc.
    osm_id = Column(String)  # OpenStreetMap ID for reference