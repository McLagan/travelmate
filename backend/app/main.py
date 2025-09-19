""""
TravelMate FastAPI Application
Main entry point
"""

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from app.config import settings
from app.database import engine
from app.models import User, Route  # Импортируем модели
from app.routers import auth, locations

# Create database tables
from app.database import Base
Base.metadata.create_all(bind=engine)

# Create FastAPI app
app = FastAPI(
    title=settings.APP_NAME,
    version=settings.VERSION,
    docs_url="/docs" if settings.DEBUG else None,
)

# Mount static files (for frontend)
app.mount("/static", StaticFiles(directory="frontend"), name="static")

# Include authentication routes
app.include_router(auth.router, prefix="/auth", tags=["Authentication"])
app.include_router(locations.router, prefix="/locations", tags=["Locations"])

# Serve the map page
@app.get("/map")
async def serve_map():
    return FileResponse("frontend/index.html")

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
        "version": settings.VERSION,
        "map_demo": "/map"
    }