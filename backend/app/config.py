"""
Configuration settings for TravelMate
"""

from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    # App info
    APP_NAME: str = "TravelMate API"
    VERSION: str = "0.1.0"
    DEBUG: bool = True

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # Database
    DATABASE_URL: str = "postgresql://postgres:postgres123@localhost:5432/travelmate_dev"

    # Security
    SECRET_KEY: str = "your-super-secret-key-change-in-production"

    # External APIs
    OPENSTREETMAP_URL: str = "https://nominatim.openstreetmap.org"

    class Config:
        env_file = ".env"


# Global settings instance
settings = Settings()