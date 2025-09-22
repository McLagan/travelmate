""""
TravelMate FastAPI Application
Main entry point with enhanced security
"""

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.database import engine
from app.models import User, Route, VisitedCountry, UserPlace, PlaceImage  # Импортируем модели
from app.routers import auth, locations, routes, profile
from app.middleware.security import (
    RateLimitMiddleware,
    SecurityHeadersMiddleware,
    RequestValidationMiddleware,
    LoggingMiddleware
)

# Create database tables
from app.database import Base
Base.metadata.create_all(bind=engine)

# Create FastAPI app
app = FastAPI(
    title=settings.APP_NAME,
    version=settings.VERSION,
    docs_url="/docs" if settings.DEBUG else None,
)

# Add security middleware (order matters!)
app.add_middleware(LoggingMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RequestValidationMiddleware)

# Rate limiting (only in production or when explicitly enabled)
if settings.is_production or settings.DEBUG:
    app.add_middleware(RateLimitMiddleware)

# Add CORS middleware with secure configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=settings.ALLOWED_CREDENTIALS,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=[
        "Accept",
        "Accept-Language",
        "Content-Language",
        "Content-Type",
        "Authorization",
        "Cache-Control",
        "X-Requested-With"
    ],
    expose_headers=["X-Total-Count", "X-Process-Time"],
    max_age=600,  # Cache preflight requests for 10 minutes
)

# Mount static files (for frontend)
app.mount("/static", StaticFiles(directory="frontend"), name="static")

# Mount uploads directory for user files
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")

# Include API routes
app.include_router(auth.router, prefix="/auth", tags=["Authentication"])
app.include_router(locations.router, prefix="/locations", tags=["Locations"])
app.include_router(routes.router, prefix="/routes", tags=["Routes"])
app.include_router(profile.router, prefix="/profile", tags=["Profile"])

# Serve static files directly
@app.get("/styles.css")
async def serve_styles():
    return FileResponse("frontend/styles.css", media_type="text/css")

@app.get("/config.js")
async def serve_config():
    return FileResponse("frontend/config.js", media_type="application/javascript")

@app.get("/utils.js")
async def serve_utils():
    return FileResponse("frontend/utils.js", media_type="application/javascript")

@app.get("/app.js")
async def serve_app():
    return FileResponse("frontend/app.js", media_type="application/javascript")

@app.get("/features.js")
async def serve_features():
    return FileResponse("frontend/features.js", media_type="application/javascript")

@app.get("/profile.css")
async def serve_profile_css():
    return FileResponse("frontend/profile.css", media_type="text/css")

@app.get("/profile.js")
async def serve_profile_js():
    return FileResponse("frontend/profile.js", media_type="application/javascript")

@app.get("/map-places.js")
async def serve_map_places_js():
    return FileResponse("frontend/map-places.js", media_type="application/javascript")

@app.get("/navigation.js")
async def serve_navigation_js():
    return FileResponse("frontend/navigation.js", media_type="application/javascript")

@app.get("/extension-blocker.js")
async def serve_extension_blocker():
    return FileResponse("frontend/extension-blocker.js", media_type="application/javascript")

# Serve the map page
@app.get("/map")
async def serve_map():
    return FileResponse("frontend/index.html")

# Serve the profile page
@app.get("/profile")
async def serve_profile():
    return FileResponse("frontend/profile.html")

# Health check endpoint
@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "version": settings.VERSION
    }

# Root endpoint - redirect to map
@app.get("/")
async def root():
    return FileResponse("frontend/index.html")