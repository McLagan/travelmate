"""
Configuration settings for TravelMate
"""

class Settings:
    # App info
    APP_NAME: str = "TravelMate API"
    VERSION: str = "0.1.0"
    DEBUG: bool = True

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000

# Global settings instance
settings = Settings()