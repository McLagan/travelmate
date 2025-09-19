"""
TravelMate FastAPI Application
Main entry point
"""

from fastapi import FastAPI
from app.config import settings

# Create FastAPI app
app = FastAPI(
    title=settings.APP_NAME,
    version=settings.VERSION,
    docs_url="/docs" if settings.DEBUG else None,
)

# Health check endpoint
@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "version": settings.VERSION
    }

# Root endpoint
@app.get("/")
async def root():
    return {
        "message": "Welcome to TravelMate API",
        "version": settings.VERSION
    }