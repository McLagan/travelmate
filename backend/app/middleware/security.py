"""
Security middleware for TravelMate API
Rate limiting, request validation, and security headers
"""

import time
import json
from typing import Dict, Optional
from fastapi import Request, HTTPException, status
from fastapi.responses import Response
from starlette.middleware.base import BaseHTTPMiddleware
from collections import defaultdict, deque
from app.config import settings


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Rate limiting middleware with per-IP and per-endpoint limits"""

    def __init__(self, app):
        super().__init__(app)
        self.requests: Dict[str, deque] = defaultdict(deque)
        self.window_size = 60  # 1 minute window

    async def dispatch(self, request: Request, call_next):
        client_ip = self.get_client_ip(request)
        endpoint = self.get_endpoint_key(request.url.path)

        # Check rate limit
        if not self.is_allowed(client_ip, endpoint):
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Rate limit exceeded. Please try again later.",
                headers={"Retry-After": "60"}
            )

        # Record request
        self.record_request(client_ip, endpoint)

        response = await call_next(request)
        return response

    def get_client_ip(self, request: Request) -> str:
        """Get client IP with proxy support"""
        forwarded_for = request.headers.get("X-Forwarded-For")
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()

        real_ip = request.headers.get("X-Real-IP")
        if real_ip:
            return real_ip

        return request.client.host if request.client else "unknown"

    def get_endpoint_key(self, path: str) -> str:
        """Map path to rate limit category"""
        if "/auth/" in path:
            return "auth"
        elif "/locations/search" in path:
            return "search"
        elif "/routes/" in path:
            return "routes"
        else:
            return "general"

    def get_rate_limit(self, endpoint: str) -> int:
        """Get rate limit for endpoint"""
        limits = {
            "auth": settings.RATE_LIMIT_AUTH,
            "search": settings.RATE_LIMIT_SEARCH,
            "routes": settings.RATE_LIMIT_ROUTES,
            "general": 100  # Default limit
        }
        return limits.get(endpoint, 100)

    def is_allowed(self, client_ip: str, endpoint: str) -> bool:
        """Check if request is within rate limit"""
        key = f"{client_ip}:{endpoint}"
        now = time.time()
        window_start = now - self.window_size

        # Clean old requests
        while self.requests[key] and self.requests[key][0] < window_start:
            self.requests[key].popleft()

        # Check limit
        limit = self.get_rate_limit(endpoint)
        return len(self.requests[key]) < limit

    def record_request(self, client_ip: str, endpoint: str):
        """Record request timestamp"""
        key = f"{client_ip}:{endpoint}"
        self.requests[key].append(time.time())


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security headers to responses"""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)

        # Security headers
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"

        # HSTS for HTTPS in production
        if settings.is_production and request.url.scheme == "https":
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

        # CSP header
        csp_directives = [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com",
            "style-src 'self' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
            "img-src 'self' data: https: blob:",
            "connect-src 'self' https://nominatim.openstreetmap.org https://router.project-osrm.org",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'"
        ]

        if settings.is_development:
            # More permissive for development
            csp_directives.extend([
                "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
                "connect-src 'self' ws: wss: http: https:"
            ])

        response.headers["Content-Security-Policy"] = "; ".join(csp_directives)

        return response


class RequestValidationMiddleware(BaseHTTPMiddleware):
    """Validate request size and content"""

    MAX_REQUEST_SIZE = 10 * 1024 * 1024  # 10MB
    MAX_JSON_DEPTH = 10

    async def dispatch(self, request: Request, call_next):
        # Check request size
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > self.MAX_REQUEST_SIZE:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Request too large"
            )

        # Validate JSON depth for JSON requests
        if request.headers.get("content-type", "").startswith("application/json"):
            try:
                body = await request.body()
                if body:
                    data = json.loads(body)
                    if self._get_json_depth(data) > self.MAX_JSON_DEPTH:
                        raise HTTPException(
                            status_code=status.HTTP_400_BAD_REQUEST,
                            detail="JSON structure too deep"
                        )
            except json.JSONDecodeError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Invalid JSON format"
                )
            except Exception:
                # Let the framework handle other validation
                pass

        response = await call_next(request)
        return response

    def _get_json_depth(self, obj, depth=0):
        """Calculate JSON object depth"""
        if depth > self.MAX_JSON_DEPTH:
            return depth

        if isinstance(obj, dict):
            return max([self._get_json_depth(v, depth + 1) for v in obj.values()] + [depth])
        elif isinstance(obj, list):
            return max([self._get_json_depth(item, depth + 1) for item in obj] + [depth])
        else:
            return depth


class LoggingMiddleware(BaseHTTPMiddleware):
    """Enhanced request/response logging"""

    async def dispatch(self, request: Request, call_next):
        start_time = time.time()

        # Log request
        client_ip = self.get_client_ip(request)
        if settings.DEBUG:
            print(f"🌐 {request.method} {request.url.path} - IP: {client_ip}")

        try:
            response = await call_next(request)
            process_time = time.time() - start_time

            # Log response
            if settings.DEBUG:
                print(f"✅ {response.status_code} - {process_time:.3f}s")

            # Add timing header
            response.headers["X-Process-Time"] = str(process_time)

            return response

        except Exception as e:
            process_time = time.time() - start_time
            print(f"❌ Error: {str(e)} - {process_time:.3f}s")
            raise

    def get_client_ip(self, request: Request) -> str:
        """Get client IP with proxy support"""
        forwarded_for = request.headers.get("X-Forwarded-For")
        if forwarded_for:
            return forwarded_for.split(",")[0].strip()

        real_ip = request.headers.get("X-Real-IP")
        if real_ip:
            return real_ip

        return request.client.host if request.client else "unknown"