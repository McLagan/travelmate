""""
TravelMate FastAPI Application
Main entry point with enhanced security
"""

import os
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from app.config import settings
from app.database import engine
from app.models import User, Route, RouteWaypoint, VisitedCountry, UserPlace, PlaceImage  # Импортируем модели
from app.routers import auth, locations, routes, profile, ferries, flights, cars
from app.middleware.security import (
    RateLimitMiddleware,
    SecurityHeadersMiddleware,
    RequestValidationMiddleware,
    LoggingMiddleware
)

# Create database tables
from app.database import Base
Base.metadata.create_all(bind=engine)

# create_all() does not add columns to existing tables; add the ferry-leg columns once.
# (Alembic chain in this repo is not usable yet - see README/status.)
def _ensure_columns():
    from sqlalchemy import inspect, text
    wanted = {
        "route_waypoints": {"leg_mode": "VARCHAR DEFAULT 'road'", "leg_hours": "FLOAT", "leg_date": "VARCHAR",
                            "stop_type": "VARCHAR DEFAULT 'pass'", "nights": "INTEGER", "lodging_name": "VARCHAR",
                            "lodging_url": "VARCHAR", "lodging_price": "FLOAT", "lodging_currency": "VARCHAR",
                            "lodging_booked": "BOOLEAN", "leg_cost": "FLOAT", "leg_currency": "VARCHAR",
                            "leg_booked": "BOOLEAN", "leg_ref": "VARCHAR", "spots": "TEXT",
                            "leg_spots": "TEXT", "lodging_paid": "BOOLEAN", "leg_paid": "BOOLEAN"},
        "routes": {"start_date": "VARCHAR", "fuel_l_per_100km": "FLOAT", "fuel_price": "FLOAT",
                   "fuel_currency": "VARCHAR", "budget_currency": "VARCHAR", "extras": "TEXT",
                   "car_id": "INTEGER", "fuel_settings": "TEXT"},
    }
    insp = inspect(engine)
    with engine.begin() as conn:
        for table, add in wanted.items():
            cols = {c["name"] for c in insp.get_columns(table)}
            for name, ddl in add.items():
                if name not in cols:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                    print(f"✓ added column {table}.{name}")

_ensure_columns()

# Ensure upload directories exist
def ensure_upload_directories():
    """Create upload directories if they don't exist"""
    upload_dirs = [
        "uploads",
        "uploads/avatars",
        "uploads/places"
    ]

    for directory in upload_dirs:
        os.makedirs(directory, exist_ok=True)
        print(f"✓ Upload directory ensured: {directory}")

# Initialize upload directories on startup
ensure_upload_directories()

# Create FastAPI app
app = FastAPI(
    title=settings.APP_NAME,
    version=settings.VERSION,
    docs_url="/docs" if settings.DEBUG else None,
)

# Frontend files change often during development: make the browser revalidate them
# every time, otherwise it keeps old JS/CSS/HTML and new features "don't show up".
@app.middleware("http")
async def no_cache_frontend(request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path in ("/", "/map", "/profile", "/trips", "/trip") or path.endswith((".js", ".css", ".html")):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response

# Add security middleware (order matters!)
app.add_middleware(LoggingMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
# Temporarily disabled for debugging
# app.add_middleware(RequestValidationMiddleware)

# Rate limiting (only in production or when explicitly enabled)
# Temporarily disabled for development
# if settings.is_production or settings.DEBUG:
#     app.add_middleware(RateLimitMiddleware)

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

# Mount assets directory for images and static assets
app.mount("/assets", StaticFiles(directory="frontend/assets"), name="assets")

# Mount uploads directory for user files
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")

# Include API routes
app.include_router(auth.router, prefix="/auth", tags=["Authentication"])
app.include_router(locations.router, prefix="/locations", tags=["Locations"])
app.include_router(routes.router, prefix="/routes", tags=["Routes"])
app.include_router(profile.router, prefix="/profile", tags=["Profile"])
app.include_router(ferries.router, prefix="/ferries", tags=["Ferries"])
app.include_router(flights.router, prefix="/flights", tags=["Flights"])
app.include_router(cars.router, tags=["Cars & fuel"])

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

@app.get("/route-planner.js")
async def serve_route_planner_js():
    return FileResponse("frontend/route-planner.js", media_type="application/javascript")

@app.get("/profile-routes.js")
async def serve_profile_routes_js():
    return FileResponse("frontend/profile-routes.js", media_type="application/javascript")

@app.get("/poi-explorer.js")
async def serve_poi_explorer_js():
    return FileResponse("frontend/poi-explorer.js", media_type="application/javascript")

@app.get("/stop-places.js")
async def serve_stop_places_js():
    return FileResponse("frontend/stop-places.js", media_type="application/javascript")

@app.get("/trip-budget.js")
async def serve_trip_budget_js():
    return FileResponse("frontend/trip-budget.js", media_type="application/javascript")

@app.get("/cars-ui.js")
async def serve_cars_ui_js():
    return FileResponse("frontend/cars-ui.js", media_type="application/javascript")

@app.get("/trip-common.js")
async def serve_trip_common_js():
    return FileResponse("frontend/trip-common.js", media_type="application/javascript")

@app.get("/trip-page.js")
async def serve_trip_page_js():
    return FileResponse("frontend/trip-page.js", media_type="application/javascript")

@app.get("/trip")
async def serve_trip_page():
    return FileResponse("frontend/trip.html")

@app.get("/ai-review.js")
async def serve_ai_review_js():
    return FileResponse("frontend/ai-review.js", media_type="application/javascript")

@app.get("/extension-blocker.js")
async def serve_extension_blocker():
    return FileResponse("frontend/extension-blocker.js", media_type="application/javascript")

# Serve the map page
@app.get("/map")
async def serve_map():
    return FileResponse("frontend/index.html")

# Serve the profile page
@app.get("/trips")
async def serve_trips():
    return FileResponse("frontend/trips.html")

@app.get("/trips.js")
async def serve_trips_js():
    return FileResponse("frontend/trips.js", media_type="application/javascript")

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