"""
Configuration settings for TravelMate
Enhanced with security, validation, and environment handling
"""

import os
import secrets
from pydantic_settings import BaseSettings
from pydantic import validator, Field
from typing import List, Optional


class Settings(BaseSettings):
    # App info
    APP_NAME: str = "TravelMate API"
    VERSION: str = "0.1.0"
    DEBUG: bool = True
    ENVIRONMENT: str = Field(default="development", pattern="^(development|staging|production)$")

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = Field(default=8088, ge=1, le=65535)

    # Database
    DATABASE_URL: str = "postgresql://postgres:postgres123@localhost:5432/travelmate_dev"

    # Security
    SECRET_KEY: str = Field(min_length=32)
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_HOURS: int = Field(default=24, ge=1, le=168)  # Max 1 week

    # CORS
    ALLOWED_ORIGINS: List[str] = Field(default_factory=lambda: ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:8088", "http://127.0.0.1:8088"])
    ALLOWED_CREDENTIALS: bool = True

    # External APIs
    OPENSTREETMAP_URL: str = "https://nominatim.openstreetmap.org"
    OSRM_URL: str = "https://router.project-osrm.org"

    # Rate Limiting (requests per minute)
    RATE_LIMIT_SEARCH: int = Field(default=20, ge=1, le=1000)
    RATE_LIMIT_ROUTES: int = Field(default=30, ge=1, le=1000)
    RATE_LIMIT_AUTH: int = Field(default=5, ge=1, le=100)

    # Logging
    LOG_LEVEL: str = Field(default="INFO", pattern="^(DEBUG|INFO|WARNING|ERROR|CRITICAL)$")
    LOG_FORMAT: str = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

    @validator("SECRET_KEY")
    def validate_secret_key(cls, v):
        if v == "your-super-secret-key-change-in-production":
            if os.getenv("ENVIRONMENT", "development") == "production":
                raise ValueError("Default SECRET_KEY cannot be used in production!")
            # Generate a secure key for development
            return secrets.token_urlsafe(32)

        if len(v) < 32:
            raise ValueError("SECRET_KEY must be at least 32 characters long")

        return v

    @validator("ALLOWED_ORIGINS", pre=True)
    def parse_allowed_origins(cls, v):
        if isinstance(v, str):
            # Handle comma-separated string from .env
            return [origin.strip() for origin in v.split(",") if origin.strip()]
        elif isinstance(v, list):
            # Already a list, return as-is
            return v
        else:
            # Use default
            return ["http://localhost:3000", "http://127.0.0.1:3000"]

    @validator("DATABASE_URL")
    def validate_database_url(cls, v):
        if not v.startswith(("postgresql://", "sqlite:///")):
            raise ValueError("DATABASE_URL must be a valid PostgreSQL or SQLite URL")
        return v

    @property
    def is_development(self) -> bool:
        return self.ENVIRONMENT == "development"

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == "production"

    @property
    def cors_origins(self) -> List[str]:
        """Get CORS origins based on environment"""
        if self.is_production:
            # In production, only allow specific domains
            return [origin for origin in self.ALLOWED_ORIGINS if not origin.startswith("http://localhost")]
        return self.ALLOWED_ORIGINS

    class Config:
        env_file = ".env"
        case_sensitive = True


# Initialize settings with validation
try:
    settings = Settings()
except Exception as e:
    print(f"❌ Configuration error: {e}")
    print("💡 Please check your .env file or environment variables")
    raise

# Log configuration status
if settings.DEBUG:
    print(f"🚀 TravelMate API starting...")
    print(f"   Environment: {settings.ENVIRONMENT}")
    print(f"   Debug mode: {settings.DEBUG}")
    print(f"   Port: {settings.PORT}")
    print(f"   Database: {settings.DATABASE_URL.split('@')[-1] if '@' in settings.DATABASE_URL else 'SQLite'}")
    print(f"   CORS origins: {len(settings.cors_origins)} configured")

    if settings.ENVIRONMENT == "development" and "your-super-secret-key" in str(settings.SECRET_KEY):
        print("⚠️  Using default SECRET_KEY in development mode")

    if settings.ENVIRONMENT == "production":
        print("🔒 Production mode: Enhanced security enabled")