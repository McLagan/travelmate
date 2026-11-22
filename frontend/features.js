/**
 * TravelMate - Feature Functions
 * Route planning, search, and map features
 */

/**
 * Route Management Functions
 */

// Real route calculation
async function calculateRealRoute() {
    if (!window.app?.currentUser) {
        window.app?.showAuthModal('login');
        return;
    }

    const { startPoint, endPoint } = window.app;

    if (!startPoint || !endPoint) {
        window.app?.showStatus('Please set both start and end points first', 'error');
        return;
    }

    // Support both formats: {lat, lng} and {latitude, longitude}
    const startLat = startPoint.lat || startPoint.latitude;
    const startLng = startPoint.lng || startPoint.longitude;
    const endLat = endPoint.lat || endPoint.latitude;
    const endLng = endPoint.lng || endPoint.longitude;

    if (!startLat || !startLng || !endLat || !endLng) {
        window.app?.showStatus('Invalid start or end point coordinates', 'error');
        return;
    }

    const transportMode = document.getElementById('transportMode')?.value || 'driving';
    window.app?.showStatus(`Calculating ${transportMode} route...`, 'info');

    try {
        PerformanceMonitor.start('calculate-route');

        const routeData = await window.app.api.get('/routes/real-route', {
            start_lat: startLat,
            start_lon: startLng,
            end_lat: endLat,
            end_lon: endLng,
            profile: transportMode
        });

        PerformanceMonitor.end('calculate-route');

        if (!routeData || typeof routeData.distance_km === 'undefined') {
            throw new Error('Invalid route data received');
        }

        // Clear existing route line
        if (window.app.routeLine) {
            window.app.map.removeLayer(window.app.routeLine);
            window.app.routeLine = null;
        }

        // Draw real route
        if (routeData.geometry && routeData.geometry.coordinates && routeData.geometry.coordinates.length > 0) {
            const coordinates = routeData.geometry.coordinates.map(coord => [coord[1], coord[0]]);

            const routeColor = getTransportColor(transportMode);

            window.app.routeLine = L.polyline(coordinates, {
                color: routeColor,
                weight: 4,
                opacity: 0.8,
                className: 'route-animation'
            }).addTo(window.app.map);

            const group = new L.featureGroup([window.app.routeStartMarker, window.app.routeEndMarker, window.app.routeLine]);
            window.app.map.fitBounds(group.getBounds().pad(0.05));

            const modeEmoji = getTransportEmoji(transportMode);
            const formattedDistance = Formatter.distance(routeData.distance_km);
            const formattedDuration = Formatter.duration(routeData.duration_minutes);

            window.app?.showStatus(`${modeEmoji} Route: ${formattedDistance}, ${formattedDuration}`, 'success');

            // Enable POI exploration button
            document.getElementById('explorePOIsBtn').disabled = false;
        } else {
            window.app?.showStatus('No route found - try different points or transport mode', 'error');
        }

    } catch (error) {
        window.app?.errorHandler.handle(error, 'Route calculation failed');

        if (window.app.routeLine) {
            window.app.map.removeLayer(window.app.routeLine);
            window.app.routeLine = null;
        }
    }
}

// Create and save route
async function createRoute() {
    console.log('createRoute called');

    if (!window.app?.currentUser) {
        window.app?.showAuthModal('login');
        return;
    }

    const { startPoint, endPoint } = window.app;

    if (!startPoint || !endPoint) {
        window.app?.showStatus('Please set both start and end points first', 'error');
        return;
    }

    // Support both formats: {lat, lng} and {latitude, longitude}
    const startLat = startPoint.lat || startPoint.latitude;
    const startLng = startPoint.lng || startPoint.longitude;
    const endLat = endPoint.lat || endPoint.latitude;
    const endLng = endPoint.lng || endPoint.longitude;

    if (!startLat || !startLng || !endLat || !endLng) {
        window.app?.showStatus('Invalid start or end point coordinates', 'error');
        return;
    }

    const routeName = document.getElementById('routeName')?.value?.trim();
    const routeDescription = document.getElementById('routeDescription')?.value?.trim();

    if (!routeName) {
        window.app?.showStatus('Please enter a route name', 'error');
        return;
    }

    if (routeName.length < 2) {
        window.app?.showStatus('Route name must be at least 2 characters long', 'error');
        return;
    }

    try {
        window.app?.showStatus('Saving route...', 'info');

        const routeData = {
            name: routeName,
            description: routeDescription || "",
            start_point: {
                latitude: startLat,
                longitude: startLng,
                name: startPoint.name || 'Start Point'
            },
            end_point: {
                latitude: endLat,
                longitude: endLng,
                name: endPoint.name || 'End Point'
            }
        };

        const savedRoute = await window.app.api.post('/routes/', routeData);
        window.app?.showStatus(`Route "${savedRoute.name}" saved successfully!`, 'success');

        // Clear form
        document.getElementById('routeName').value = '';
        document.getElementById('routeDescription').value = '';

        CONFIG.info('Route saved:', savedRoute);

    } catch (error) {
        window.app?.errorHandler.handle(error, 'Failed to save route');
    }
}

// Load user routes
async function loadRoutes() {
    if (!window.app?.currentUser) {
        window.app?.showAuthModal('login');
        return;
    }

    try {
        window.app?.showStatus('Loading routes...', 'info');

        const routesList = await window.app.api.get('/routes/');
        displayRoutes(routesList.routes);
        window.app?.showStatus(`Loaded ${routesList.routes.length} routes`, 'success');

    } catch (error) {
        window.app?.errorHandler.handle(error, 'Failed to load routes');
    }
}

// Display routes in sidebar
function displayRoutes(routes) {
    const routesListElement = document.getElementById('routesList');

    if (!routesListElement) return;

    if (routes.length === 0) {
        routesListElement.innerHTML = '<p style="text-align: center; color: var(--text-muted);">No saved routes yet</p>';
        routesListElement.style.display = 'block';
        return;
    }

    let routesHtml = '<h3 class="section-title"><i class="fas fa-list"></i> My Routes</h3>';

    routes.forEach(route => {
        const createdDate = Formatter.date(route.created_at);

        routesHtml += `
            <div style="border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 1rem; margin-bottom: 1rem;">
                <h4 style="margin-bottom: 0.5rem;">${escapeHtml(route.name)}</h4>
                ${route.description ? `<p style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 0.5rem;">${escapeHtml(route.description)}</p>` : ''}
                ${route.waypoints && route.waypoints.length ? `<p style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.25rem;">${route.waypoints.length} stops: ${route.waypoints.map(w => escapeHtml(w.name.split(',')[0])).join(' → ')}</p>` : ''}
                <p style="font-size: 0.75rem; color: var(--text-muted);">Created: ${createdDate}</p>
                <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
                    <button class="btn btn-sm btn-primary" onclick="loadRouteOnMap(${route.id})">
                        <i class="fas fa-map"></i> Show
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deleteRoute(${route.id})">
                        <i class="fas fa-trash"></i> Delete
                    </button>
                </div>
            </div>
        `;
    });

    routesListElement.innerHTML = routesHtml;
    routesListElement.style.display = 'block';
}

// Load specific route on map
async function loadRouteOnMap(routeId) {
    try {
        const route = await window.app.api.get(`/routes/${routeId}`);

        // Clear current route
        window.app?.clearRouteDisplay();

        // Set points
        window.app.startPoint = route.start_point;
        window.app.endPoint = route.end_point;

        // Add markers
        window.app.routeStartMarker = L.marker([route.start_point.latitude, route.start_point.longitude], {
            icon: createMarkerIcon('green')
        }).addTo(window.app.map).bindPopup(`<strong>🟢 ${escapeHtml(route.name)}</strong><br>${escapeHtml(route.start_point.name)}`);

        window.app.routeEndMarker = L.marker([route.end_point.latitude, route.end_point.longitude], {
            icon: createMarkerIcon('red')
        }).addTo(window.app.map).bindPopup(`<strong>🔴 ${escapeHtml(route.name)}</strong><br>${escapeHtml(route.end_point.name)}`);

        // Fit view to show both markers
        const group = new L.featureGroup([window.app.routeStartMarker, window.app.routeEndMarker]);
        window.app.map.fitBounds(group.getBounds().pad(0.1));

        window.app?.checkRouteReady();
        window.app?.showStatus(`Loaded route: ${route.name}`, 'success');

    } catch (error) {
        window.app?.errorHandler.handle(error, 'Failed to load route');
    }
}

// Delete route
async function deleteRoute(routeId) {
    console.log('deleteRoute called with routeId:', routeId);

    if (!confirm('Are you sure you want to delete this route?')) {
        return;
    }

    try {
        console.log('Sending DELETE request to:', `/routes/${routeId}`);
        const response = await window.app.api.delete(`/routes/${routeId}`);
        console.log('Delete response:', response);
        window.app?.showStatus('Route deleted successfully', 'success');
        loadRoutes(); // Refresh routes list

    } catch (error) {
        console.error('Delete route error:', error);
        window.app?.errorHandler.handle(error, 'Failed to delete route');
    }
}

/**
 * Search Functions
 */

// Search for places
async function searchPlace() {
    if (!window.app?.currentUser) {
        window.app?.showAuthModal('login');
        return;
    }

    const query = document.getElementById('searchInput')?.value?.trim();
    if (!query) {
        window.app?.showStatus('Please enter a search query', 'error');
        return;
    }

    if (query.length < 2) {
        window.app?.showStatus('Search query must be at least 2 characters long', 'error');
        return;
    }

    try {
        window.app?.showStatus('Searching...', 'info');

        const results = await window.app.api.get('/locations/search', {
            query: encodeURIComponent(query),
            limit: 5
        });

        if (results.results && results.results.length > 0) {
            const firstResult = results.results[0];

            // Add marker for found location
            const marker = L.marker([firstResult.latitude, firstResult.longitude])
                .addTo(window.app.map)
                .bindPopup(`<strong>🔍 ${escapeHtml(firstResult.display_name)}</strong><br><small>Search result</small>`)
                .openPopup();

            window.app.map.setView([firstResult.latitude, firstResult.longitude], 15);
            window.app.markers.push(marker);

            window.app?.showStatus(`Found: ${firstResult.display_name}`, 'success');
        } else {
            window.app?.showStatus('No places found', 'error');
        }

    } catch (error) {
        window.app?.errorHandler.handle(error, 'Search failed');
    }
}

// Debounced search input
const debouncedSearch = debounce(async function(query) {
    if (query.length >= 2 && window.app?.currentUser) {
        try {
            const results = await window.app.api.get('/locations/search', {
                query: encodeURIComponent(query),
                limit: 3
            });
            showSearchSuggestions(results.results);
        } catch (error) {
            CONFIG.debug('Search suggestion failed:', error);
        }
    }
}, 300);

// Show search suggestions (future enhancement)
function showSearchSuggestions(results) {
    // Implementation for dropdown suggestions
    CONFIG.debug('Search suggestions:', results);
}

/**
 * Helper Functions
 */

function getTransportColor(mode) {
    const colors = {
        driving: '#6366f1',
        cycling: '#22c55e',
        walking: '#f59e0b'
    };
    return colors[mode] || colors.driving;
}

function getTransportEmoji(mode) {
    const emojis = {
        driving: '🚗',
        cycling: '🚴',
        walking: '🚶'
    };
    return emojis[mode] || emojis.driving;
}

function createMarkerIcon(color) {
    const iconUrls = {
        green: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png',
        red: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
        blue: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-blue.png'
    };

    return L.icon({
        iconUrl: iconUrls[color] || iconUrls.blue,
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41]
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Enhanced Features
 */

// Export route data
function exportRoute(routeId, format = 'gpx') {
    // Future implementation for GPX/KML export
    CONFIG.info('Export route requested:', routeId, format);
    window.app?.showStatus('Export feature coming soon!', 'info');
}

// Share route
function shareRoute(routeId) {
    if (navigator.share) {
        navigator.share({
            title: 'TravelMate Route',
            text: 'Check out this route I created!',
            url: `${window.location.origin}/route/${routeId}`
        }).catch(err => CONFIG.debug('Share failed:', err));
    } else {
        // Fallback to clipboard
        navigator.clipboard.writeText(`${window.location.origin}/route/${routeId}`)
            .then(() => window.app?.showStatus('Route link copied to clipboard!', 'success'))
            .catch(() => window.app?.showStatus('Failed to copy link', 'error'));
    }
}

// Get user location
function getCurrentLocation() {
    if (!navigator.geolocation) {
        window.app?.showStatus('Geolocation is not supported by this browser', 'error');
        return;
    }

    window.app?.showStatus('Getting your location...', 'info');

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const { latitude, longitude } = position.coords;
            window.app.map.setView([latitude, longitude], 15);

            const marker = L.marker([latitude, longitude])
                .addTo(window.app.map)
                .bindPopup('📍 Your location')
                .openPopup();

            window.app.markers.push(marker);
            window.app?.showStatus('Location found!', 'success');
        },
        (error) => {
            let message = 'Failed to get your location';
            switch (error.code) {
                case error.PERMISSION_DENIED:
                    message = 'Location access denied by user';
                    break;
                case error.POSITION_UNAVAILABLE:
                    message = 'Location information unavailable';
                    break;
                case error.TIMEOUT:
                    message = 'Location request timed out';
                    break;
            }
            window.app?.showStatus(message, 'error');
        },
        {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 60000
        }
    );
}

// Setup search input enhancement
document.addEventListener('DOMContentLoaded', function() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            debouncedSearch(this.value.trim());
        });

        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchPlace();
            }
        });
    }
});

// POI Explorer functions
function showPOIExplorer() {
    document.getElementById('poiExplorerModal').style.display = 'flex';
}

function closePOIExplorer() {
    document.getElementById('poiExplorerModal').style.display = 'none';
}

function closePOIResults() {
    document.getElementById('poiResultsPanel').style.display = 'none';
}

// Global POI storage
window.currentPOIs = [];

async function searchPOIs() {
    if (!window.app?.startPoint || !window.app?.endPoint) {
        window.app?.showStatus('Please calculate a route first', 'error');
        return;
    }

    try {
        // Get settings
        const transport = document.getElementById('poiTransport').value;
        const timeLimit = parseInt(document.getElementById('poiTimeLimit').value);

        // Get selected categories
        const categoryBoxes = document.querySelectorAll('#poiExplorerModal input[type="checkbox"]:checked');
        const categories = Array.from(categoryBoxes).map(cb => cb.value);

        window.app?.showStatus('Searching for attractions...', 'info');
        closePOIExplorer();

        // Call backend API
        const params = {
            start_lat: window.app.startPoint.lat || window.app.startPoint.latitude,
            start_lon: window.app.startPoint.lng || window.app.startPoint.longitude,
            end_lat: window.app.endPoint.lat || window.app.endPoint.latitude,
            end_lon: window.app.endPoint.lng || window.app.endPoint.longitude,
            transport: transport,
            time_limit: timeLimit
        };

        const pois = await window.app.api.get('/routes/explore-pois', params);

        // Store POIs globally
        window.currentPOIs = pois;

        displayPOIResults(pois);
        displayPOIsOnMap(pois);

        window.app?.showStatus(`Found ${pois.length} attractions!`, 'success');

    } catch (error) {
        window.app?.errorHandler.handle(error, 'Failed to search POIs');
    }
}

function displayPOIResults(pois) {
    const panel = document.getElementById('poiResultsPanel');
    const list = document.getElementById('poiList');
    const count = document.getElementById('poiCount');

    if (pois.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: #9ca3af;">No attractions found. Try adjusting filters.</p>';
        panel.style.display = 'block';
        count.textContent = '0';
        return;
    }

    let html = '';
    pois.forEach(poi => {
        const stars = '⭐'.repeat(poi.rate || 0);
        html += `
            <div style="border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin-bottom: 12px;">
                <h4 style="margin: 0 0 8px 0; font-size: 16px;">${escapeHtml(poi.name)}</h4>
                <p style="margin: 4px 0; font-size: 13px; color: #6b7280;">${poi.kinds || 'Attraction'}</p>
                <p style="margin: 4px 0; font-size: 13px;">${stars}</p>
                <p style="margin: 4px 0; font-size: 13px; color: #10b981;">
                    ⏱️ +${poi.detour_time} min detour
                </p>
                <div style="display: flex; gap: 8px; margin-top: 8px;">
                    <button onclick="viewPOIOnMap('${poi.xid}', ${poi.lat}, ${poi.lon})"
                            class="btn btn-sm" style="flex: 1; padding: 6px; font-size: 12px;">
                        👁️ View
                    </button>
                    <button onclick="addPOIToRoute('${poi.xid}', ${poi.lat}, ${poi.lon}, '${escapeHtml(poi.name)}')"
                            class="btn btn-sm btn-primary" style="flex: 1; padding: 6px; font-size: 12px;">
                        ➕ Add
                    </button>
                </div>
            </div>
        `;
    });

    list.innerHTML = html;
    count.textContent = pois.length;
    panel.style.display = 'block';
}

function displayPOIsOnMap(pois) {
    // Clear existing POI markers if any
    if (window.app.poiMarkers) {
        window.app.poiMarkers.forEach(marker => window.app.map.removeLayer(marker));
    }
    window.app.poiMarkers = [];

    // Add POI markers to map
    pois.forEach(poi => {
        const marker = L.marker([poi.lat, poi.lon], {
            icon: L.divIcon({
                className: 'poi-marker',
                html: '<div style="background: #10b981; color: white; border-radius: 50%; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border: 2px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.3); font-size: 16px;">📍</div>',
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            })
        }).addTo(window.app.map);

        marker.bindPopup(`
            <div style="min-width: 200px;">
                <h4 style="margin: 0 0 8px 0;">${escapeHtml(poi.name)}</h4>
                <p style="margin: 4px 0; font-size: 13px; color: #6b7280;">${poi.kinds || 'Attraction'}</p>
                <p style="margin: 4px 0; font-size: 13px;">${'⭐'.repeat(poi.rate || 0)}</p>
                <p style="margin: 4px 0; font-size: 13px; color: #10b981;">
                    ⏱️ +${poi.detour_time} min detour
                </p>
                <button onclick="addPOIToRoute('${poi.xid}', ${poi.lat}, ${poi.lon}, '${escapeHtml(poi.name)}')"
                        class="btn btn-sm btn-primary" style="width: 100%; margin-top: 8px;">
                    ➕ Add to Route
                </button>
            </div>
        `);

        window.app.poiMarkers.push(marker);
    });
}

function viewPOIOnMap(xid, lat, lon) {
    window.app.map.setView([lat, lon], 15);

    // Find and open the marker popup
    const marker = window.app.poiMarkers?.find(m => {
        const pos = m.getLatLng();
        return pos.lat === lat && pos.lng === lon;
    });

    if (marker) {
        marker.openPopup();
    }
}

function addPOIToRoute(xid, lat, lon, name) {
    window.app?.showStatus(`Added ${name} to route`, 'success');
    // TODO: Implement waypoint addition to route
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Export functions to global scope
window.calculateRealRoute = calculateRealRoute;
window.createRoute = createRoute;
window.loadRoutes = loadRoutes;
window.loadRouteOnMap = loadRouteOnMap;
window.deleteRoute = deleteRoute;
window.searchPlace = searchPlace;
window.exportRoute = exportRoute;
window.shareRoute = shareRoute;
window.getCurrentLocation = getCurrentLocation;
window.showPOIExplorer = showPOIExplorer;
window.closePOIExplorer = closePOIExplorer;
window.closePOIResults = closePOIResults;