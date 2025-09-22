/**
 * Map Places Integration
 * Handles adding places from map interaction
 */

class MapPlacesManager {
    constructor(app) {
        this.app = app;
        this.addPlaceMode = false;
        this.contextMenuPosition = null;
        this.clickedCoordinates = null;

        this.init();
    }

    init() {
        this.setupMapEvents();
        this.setupEventListeners();
    }

    setupMapEvents() {
        // Add right-click context menu
        this.app.map.on('contextmenu', (e) => {
            this.showContextMenu(e);
        });

        // Hide context menu on map click
        this.app.map.on('click', () => {
            this.hideContextMenu();
        });

        // Hide context menu on outside click
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.map-context-menu')) {
                this.hideContextMenu();
            }
        });
    }

    setupEventListeners() {
        // Quick add place form
        const quickAddForm = document.getElementById('quickAddPlaceForm');
        if (quickAddForm) {
            quickAddForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.submitQuickPlace();
            });
        }
    }

    showContextMenu(e) {
        const menu = document.getElementById('mapContextMenu');
        const addPlaceItem = document.getElementById('addPlaceContextItem');

        if (!menu) return;

        // Store coordinates
        this.clickedCoordinates = {
            lat: e.latlng.lat,
            lng: e.latlng.lng
        };

        // Show/hide add place option based on auth status
        if (addPlaceItem) {
            addPlaceItem.style.display = this.app.currentUser ? 'flex' : 'none';
        }

        // Position and show menu
        const containerRect = e.containerPoint;
        menu.style.left = `${containerRect.x}px`;
        menu.style.top = `${containerRect.y}px`;
        menu.style.display = 'block';

        // Prevent map event
        L.DomEvent.stopPropagation(e);
    }

    hideContextMenu() {
        const menu = document.getElementById('mapContextMenu');
        if (menu) {
            menu.style.display = 'none';
        }
    }

    toggleAddPlaceMode() {
        if (!this.app.currentUser) {
            showNotification('Please sign in to add places', 'warning');
            return;
        }

        this.addPlaceMode = !this.addPlaceMode;
        const btn = document.getElementById('addPlaceModeBtn');

        if (this.addPlaceMode) {
            btn.classList.add('active');
            btn.title = 'Exit add place mode';
            showStatusMessage('Click on the map to add a place');

            // Change cursor
            this.app.map.getContainer().style.cursor = 'crosshair';

            // Add click handler
            this.app.map.on('click', this.handleAddPlaceClick.bind(this));
        } else {
            btn.classList.remove('active');
            btn.title = 'Add place mode';
            this.hideStatusMessage();

            // Reset cursor
            this.app.map.getContainer().style.cursor = '';

            // Remove click handler
            this.app.map.off('click', this.handleAddPlaceClick.bind(this));
        }
    }

    handleAddPlaceClick(e) {
        if (!this.addPlaceMode) return;

        this.clickedCoordinates = {
            lat: e.latlng.lat,
            lng: e.latlng.lng
        };

        this.showQuickAddPlaceModal();
    }

    showQuickAddPlaceModal() {
        if (!this.clickedCoordinates) return;

        const modal = document.getElementById('quickAddPlaceModal');
        const coordsSpan = document.getElementById('quickPlaceCoords');
        const form = document.getElementById('quickAddPlaceForm');

        if (modal && coordsSpan && form) {
            // Reset form
            form.reset();

            // Show coordinates
            coordsSpan.textContent = `${this.clickedCoordinates.lat.toFixed(6)}, ${this.clickedCoordinates.lng.toFixed(6)}`;

            // Show modal
            modal.style.display = 'flex';
        }
    }

    closeQuickAddPlaceModal() {
        const modal = document.getElementById('quickAddPlaceModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    async submitQuickPlace() {
        if (!this.clickedCoordinates || !this.app.currentUser) return;

        const form = document.getElementById('quickAddPlaceForm');
        const formData = new FormData(form);

        const placeData = {
            name: formData.get('name') || document.getElementById('quickPlaceName').value,
            description: formData.get('description') || document.getElementById('quickPlaceDescription').value,
            category: formData.get('category') || document.getElementById('quickPlaceCategory').value,
            latitude: this.clickedCoordinates.lat,
            longitude: this.clickedCoordinates.lng
        };

        try {
            const token = localStorage.getItem('token');
            const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/places`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(placeData)
            });

            if (!response.ok) {
                throw new Error('Failed to add place');
            }

            const newPlace = await response.json();

            // Show success message
            showNotification(`"${placeData.name}" added successfully!`, 'success');

            // Close modal
            this.closeQuickAddPlaceModal();

            // Add marker to map
            this.addPlaceMarker(newPlace);

            // Exit add place mode
            if (this.addPlaceMode) {
                this.toggleAddPlaceMode();
            }

        } catch (error) {
            console.error('Failed to add place:', error);
            showNotification('Failed to add place. Please try again.', 'error');
        }
    }

    addPlaceMarker(place) {
        // Create custom icon based on category
        const iconHtml = this.getCategoryIcon(place.category);
        const customIcon = L.divIcon({
            html: `<div class="place-marker">${iconHtml}</div>`,
            className: 'custom-place-marker',
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        });

        // Create marker
        const marker = L.marker([place.latitude, place.longitude], {
            icon: customIcon
        }).addTo(this.app.map);

        // Add popup
        const popupContent = `
            <div class="place-popup">
                <h4>${place.name}</h4>
                <p class="place-category">${this.getCategoryName(place.category)}</p>
                ${place.description ? `<p class="place-description">${place.description}</p>` : ''}
                <div class="place-actions">
                    <button class="btn btn-sm btn-outline" onclick="openProfile()">
                        <i class="fas fa-user"></i> View in Profile
                    </button>
                </div>
            </div>
        `;

        marker.bindPopup(popupContent);

        // Store reference
        marker.placeData = place;

        return marker;
    }

    getCategoryIcon(category) {
        const icons = {
            attraction: '🏛️',
            restaurant: '🍽️',
            hotel: '🏨',
            nature: '🌲',
            beach: '🏖️',
            museum: '🏛️',
            other: '📍'
        };
        return icons[category] || '📍';
    }

    getCategoryName(category) {
        const names = {
            attraction: 'Attraction',
            restaurant: 'Restaurant',
            hotel: 'Hotel',
            nature: 'Nature',
            beach: 'Beach',
            museum: 'Museum',
            other: 'Other'
        };
        return names[category] || 'Place';
    }

    async loadUserPlaces() {
        if (!this.app.currentUser) return;

        try {
            const token = localStorage.getItem('token');
            const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/places`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error('Failed to load places');
            }

            const places = await response.json();

            // Clear existing place markers
            this.clearPlaceMarkers();

            // Add markers for each place
            places.forEach(place => {
                this.addPlaceMarker(place);
            });

        } catch (error) {
            console.error('Failed to load user places:', error);
        }
    }

    clearPlaceMarkers() {
        this.app.map.eachLayer(layer => {
            if (layer instanceof L.Marker && layer.placeData) {
                this.app.map.removeLayer(layer);
            }
        });
    }

    enableControls() {
        if (this.app.currentUser) {
            const addPlaceBtn = document.getElementById('addPlaceModeBtn');
            if (addPlaceBtn) {
                addPlaceBtn.disabled = false;
            }
        }
    }

    disableControls() {
        const addPlaceBtn = document.getElementById('addPlaceModeBtn');
        if (addPlaceBtn) {
            addPlaceBtn.disabled = true;
            addPlaceBtn.classList.remove('active');
        }

        // Exit add place mode
        if (this.addPlaceMode) {
            this.addPlaceMode = false;
            this.app.map.getContainer().style.cursor = '';
            this.app.map.off('click', this.handleAddPlaceClick.bind(this));
            this.hideStatusMessage();
        }
    }
}

// Global functions for HTML onclick handlers
function toggleAddPlaceMode() {
    if (window.app && window.app.placesManager) {
        window.app.placesManager.toggleAddPlaceMode();
    }
}

function setAsStartPoint() {
    if (window.app && window.app.placesManager && window.app.placesManager.clickedCoordinates) {
        const coords = window.app.placesManager.clickedCoordinates;
        window.app.setStartPoint(coords.lat, coords.lng);
        window.app.placesManager.hideContextMenu();
    }
}

function setAsEndPoint() {
    if (window.app && window.app.placesManager && window.app.placesManager.clickedCoordinates) {
        const coords = window.app.placesManager.clickedCoordinates;
        window.app.setEndPoint(coords.lat, coords.lng);
        window.app.placesManager.hideContextMenu();
    }
}

function addPlaceHere() {
    if (window.app && window.app.placesManager) {
        window.app.placesManager.showQuickAddPlaceModal();
        window.app.placesManager.hideContextMenu();
    }
}

function closeQuickAddPlaceModal() {
    if (window.app && window.app.placesManager) {
        window.app.placesManager.closeQuickAddPlaceModal();
    }
}

function openProfile() {
    window.open('/profile', '_blank');
}