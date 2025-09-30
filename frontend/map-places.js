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
        this.loadPublicPlaces();
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

        // Photo upload handler
        const photoInput = document.getElementById('quickPlacePhoto');
        if (photoInput) {
            photoInput.addEventListener('change', (e) => {
                this.handlePhotoUpload(e);
            });
        }
    }

    showContextMenu(e) {
        const menu = document.getElementById('mapContextMenu');
        const addPlaceItem = document.getElementById('addPlaceContextItem');

        if (!menu) return;

        // Check if click was on a marker (if so, don't show context menu)
        if (e.originalEvent && e.originalEvent.target &&
            (e.originalEvent.target.closest('.leaflet-marker-icon') ||
             e.originalEvent.target.closest('.leaflet-popup'))) {
            return; // Don't show context menu on markers or popups
        }

        // Store coordinates
        this.clickedCoordinates = {
            lat: e.latlng.lat,
            lng: e.latlng.lng
        };

        // Hide add place option completely in public map - only available in profile
        if (addPlaceItem) {
            addPlaceItem.style.display = 'none';
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
        const hasImage = place.images && place.images.length > 0 && place.images[0].image_url;
        const popupContent = `
            <div class="place-popup">
                ${hasImage ? `<img src="${place.images[0].image_url}" class="place-popup-image" alt="${place.name}">` : ''}
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

    // Photo handling methods
    handlePhotoUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        // Validate file size (5MB max)
        if (file.size > 5 * 1024 * 1024) {
            alert('File size must be less than 5MB');
            return;
        }

        // Validate file type
        if (!file.type.startsWith('image/')) {
            alert('Please select an image file');
            return;
        }

        // Show preview
        const reader = new FileReader();
        reader.onload = (e) => {
            this.showPhotoPreview(e.target.result);
        };
        reader.readAsDataURL(file);
    }

    showPhotoPreview(imageSrc) {
        const preview = document.getElementById('photoPreview');
        const placeholder = document.getElementById('uploadPlaceholder');
        const previewImage = document.getElementById('previewImage');

        if (preview && placeholder && previewImage) {
            previewImage.src = imageSrc;
            placeholder.style.display = 'none';
            preview.style.display = 'block';
        }
    }

    removePhoto() {
        const photoInput = document.getElementById('quickPlacePhoto');
        const preview = document.getElementById('photoPreview');
        const placeholder = document.getElementById('uploadPlaceholder');

        if (photoInput) photoInput.value = '';
        if (preview) preview.style.display = 'none';
        if (placeholder) placeholder.style.display = 'block';
    }

    // Custom fields handling
    toggleCustomFields() {
        const container = document.getElementById('customFieldsContainer');
        const toggle = document.getElementById('customFieldsToggle');

        if (!container || !toggle) return;

        const isHidden = container.style.display === 'none';

        if (isHidden) {
            container.style.display = 'block';
            toggle.classList.add('active');
            toggle.innerHTML = '<i class="fas fa-minus"></i> Hide Custom Fields';

            // Add first field if container is empty
            if (!container.querySelector('.custom-field-item')) {
                this.addCustomField();
            }
        } else {
            container.style.display = 'none';
            toggle.classList.remove('active');
            toggle.innerHTML = '<i class="fas fa-plus"></i> Add Custom Field';
        }
    }

    addCustomField() {
        const container = document.getElementById('customFieldsList');
        if (!container) return;

        const fieldId = Date.now();
        const fieldHtml = `
            <div class="custom-field-item" data-field-id="${fieldId}">
                <div class="form-group">
                    <label class="form-label">Field Name</label>
                    <input type="text" class="form-input" placeholder="e.g. Opening Hours" name="customFieldName_${fieldId}">
                </div>
                <div class="form-group">
                    <label class="form-label">Value</label>
                    <input type="text" class="form-input" placeholder="e.g. 9:00 - 18:00" name="customFieldValue_${fieldId}">
                </div>
                <button type="button" class="btn-remove" onclick="removeCustomField(${fieldId})" title="Remove field">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;

        container.insertAdjacentHTML('beforeend', fieldHtml);

        // Add animation
        const newField = container.lastElementChild;
        newField.classList.add('slide-down');
    }

    removeCustomField(fieldId) {
        const field = document.querySelector(`[data-field-id="${fieldId}"]`);
        if (field) {
            field.remove();
        }
    }

    // Enhanced form submission
    async submitQuickPlace() {
        if (!this.clickedCoordinates || !this.app.currentUser) return;

        const formData = this.collectFormData();

        try {
            // Show loading state
            const submitBtn = document.querySelector('#quickAddPlaceForm button[type="submit"]');
            const originalText = submitBtn.innerHTML;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';
            submitBtn.disabled = true;

            const response = await this.sendPlaceData(formData);

            if (!response.ok) {
                throw new Error('Failed to add place');
            }

            const newPlace = await response.json();

            // Show success message
            this.app.showStatus(`"${formData.name}" added successfully!`, 'success');

            // Close modal and reset
            this.closeQuickAddPlaceModal();
            this.resetForm();

            // Add marker to map
            this.addPlaceMarker(newPlace);

            // Exit add place mode
            if (this.addPlaceMode) {
                this.toggleAddPlaceMode();
            }

        } catch (error) {
            console.error('Failed to add place:', error);
            this.app.showStatus('Failed to add place. Please try again.', 'error');
        } finally {
            // Reset button state
            const submitBtn = document.querySelector('#quickAddPlaceForm button[type="submit"]');
            if (submitBtn) {
                submitBtn.innerHTML = '<i class="fas fa-plus"></i> Add Place';
                submitBtn.disabled = false;
            }
        }
    }

    collectFormData() {
        const form = document.getElementById('quickAddPlaceForm');
        const photoInput = document.getElementById('quickPlacePhoto');

        // Basic data
        const data = {
            name: document.getElementById('quickPlaceName').value.trim(),
            description: document.getElementById('quickPlaceDescription').value.trim(),
            category: document.getElementById('quickPlaceCategory').value,
            website: document.getElementById('quickPlaceWebsite').value.trim(),
            latitude: this.clickedCoordinates.lat,
            longitude: this.clickedCoordinates.lng,
            customFields: this.getCustomFieldsData()
        };

        // Add photo if selected
        if (photoInput.files[0]) {
            data.photo = photoInput.files[0];
        }

        return data;
    }

    getCustomFieldsData() {
        const customFields = [];
        const fieldItems = document.querySelectorAll('.custom-field-item');

        fieldItems.forEach(item => {
            const nameInput = item.querySelector('input[name^="customFieldName_"]');
            const valueInput = item.querySelector('input[name^="customFieldValue_"]');

            if (nameInput && valueInput && nameInput.value.trim() && valueInput.value.trim()) {
                customFields.push({
                    name: nameInput.value.trim(),
                    value: valueInput.value.trim()
                });
            }
        });

        return customFields;
    }

    async sendPlaceData(data) {
        const token = localStorage.getItem('token');

        // If there's a photo, use FormData
        if (data.photo) {
            const formData = new FormData();
            Object.keys(data).forEach(key => {
                if (key === 'customFields') {
                    formData.append(key, JSON.stringify(data[key]));
                } else {
                    formData.append(key, data[key]);
                }
            });

            return fetch(`${window.CONFIG.API_BASE_URL}/profile/places`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                body: formData
            });
        } else {
            // JSON request without photo
            return fetch(`${window.CONFIG.API_BASE_URL}/profile/places`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(data)
            });
        }
    }

    resetForm() {
        const form = document.getElementById('quickAddPlaceForm');
        if (form) {
            form.reset();
        }

        // Reset photo preview
        this.removePhoto();

        // Reset custom fields
        const customFieldsList = document.getElementById('customFieldsList');
        if (customFieldsList) {
            customFieldsList.innerHTML = '';
        }

        const customFieldsContainer = document.getElementById('customFieldsContainer');
        const customFieldsToggle = document.getElementById('customFieldsToggle');
        if (customFieldsContainer && customFieldsToggle) {
            customFieldsContainer.style.display = 'none';
            customFieldsToggle.classList.remove('active');
            customFieldsToggle.innerHTML = '<i class="fas fa-plus"></i> Add Custom Field';
        }
    }

    // Load and display public places on the map
    async loadPublicPlaces() {
        try {
            console.log('🌍 Loading public places...');
            const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/places/public`);

            if (!response.ok) {
                throw new Error('Failed to load public places');
            }

            const publicPlaces = await response.json();
            console.log(`📍 Loaded ${publicPlaces.length} public places`);

            // Add markers for each public place
            publicPlaces.forEach(place => {
                this.addPublicPlaceMarker(place);
            });

        } catch (error) {
            console.error('Failed to load public places:', error);
        }
    }

    addPublicPlaceMarker(place) {
        const categoryIcon = this.getCategoryIcon(place.category);

        // Create a custom marker for public places
        const markerHtml = `
            <div class="public-place-marker" data-category="${place.category}">
                <div class="marker-icon">${categoryIcon}</div>
                <div class="marker-ring"></div>
            </div>
        `;

        const icon = L.divIcon({
            html: markerHtml,
            className: 'custom-public-marker',
            iconSize: [32, 32],
            iconAnchor: [16, 32],
            popupAnchor: [0, -32]
        });

        const marker = L.marker([place.latitude, place.longitude], { icon })
            .addTo(this.app.map);

        // Create popup content
        const popupContent = this.createPublicPlacePopup(place);
        marker.bindPopup(popupContent, {
            maxWidth: 300,
            className: 'public-place-popup'
        });

        return marker;
    }

    createPublicPlacePopup(place) {
        const categoryIcon = this.getCategoryIcon(place.category);

        // Build custom fields HTML
        let customFieldsHtml = '';
        if (place.customFields && place.customFields.length > 0) {
            customFieldsHtml = `
                <div class="custom-fields">
                    <h5>Details</h5>
                    ${place.customFields.map(field => `
                        <div class="custom-field">
                            <strong>${field.name}:</strong> ${field.value}
                        </div>
                    `).join('')}
                </div>
            `;
        }

        // Build images HTML
        let imagesHtml = '';
        if (place.images && place.images.length > 0) {
            const primaryImage = place.images.find(img => img.is_primary) || place.images[0];
            imagesHtml = `
                <div class="place-image">
                    <img src="${primaryImage.image_url}" alt="${place.name}" loading="lazy">
                </div>
            `;
        }

        // Build website link
        let websiteHtml = '';
        if (place.website) {
            websiteHtml = `
                <div class="place-website">
                    <a href="${place.website}" target="_blank" rel="noopener noreferrer">
                        <i class="fas fa-external-link-alt"></i>
                        Official Website
                    </a>
                </div>
            `;
        }

        return `
            <div class="public-place-content">
                <div class="place-header">
                    <h4>
                        <span class="category-icon">${categoryIcon}</span>
                        ${place.name}
                    </h4>
                    <span class="place-category">${this.formatCategory(place.category)}</span>
                </div>

                ${imagesHtml}

                ${place.description ? `<p class="place-description">${place.description}</p>` : ''}

                ${customFieldsHtml}

                ${websiteHtml}

                <div class="place-actions">
                    <button class="btn btn-primary btn-sm" onclick="routeToPlace(${place.latitude}, ${place.longitude})" title="Get directions">
                        <i class="fas fa-route"></i>
                        Get Directions
                    </button>
                    <button class="btn btn-outline btn-sm" onclick="openProfile()" title="View in profile">
                        <i class="fas fa-user"></i>
                        Profile
                    </button>
                </div>

                <div class="place-meta">
                    <small>
                        <i class="fas fa-map-marker-alt"></i>
                        ${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}
                    </small>
                </div>
            </div>
        `;
    }

    getCategoryIcon(category) {
        const icons = {
            attraction: '🏛️',
            restaurant: '🍽️',
            hotel: '🏨',
            nature: '🌲',
            beach: '🏖️',
            museum: '🏛️',
            shopping: '🛍️',
            entertainment: '🎭',
            transport: '🚌',
            other: '📍'
        };
        return icons[category] || '📍';
    }

    formatCategory(category) {
        const labels = {
            attraction: 'Attraction',
            restaurant: 'Restaurant',
            hotel: 'Hotel',
            nature: 'Nature',
            beach: 'Beach',
            museum: 'Museum',
            shopping: 'Shopping',
            entertainment: 'Entertainment',
            transport: 'Transport',
            other: 'Other'
        };
        return labels[category] || 'Other';
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

// Photo handling global functions
function removePhoto() {
    if (window.app && window.app.placesManager) {
        window.app.placesManager.removePhoto();
    }
}

// Custom fields global functions
function toggleCustomFields() {
    if (window.app && window.app.placesManager) {
        window.app.placesManager.toggleCustomFields();
    }
}

function addCustomField() {
    if (window.app && window.app.placesManager) {
        window.app.placesManager.addCustomField();
    }
}

function removeCustomField(fieldId) {
    if (window.app && window.app.placesManager) {
        window.app.placesManager.removeCustomField(fieldId);
    }
}

function routeToPlace(lat, lng) {
    if (window.app) {
        // Set the place as destination
        window.app.setEndPoint(lat, lng);

        // Try to get user's current location as start point
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const userLat = position.coords.latitude;
                    const userLng = position.coords.longitude;
                    window.app.setStartPoint(userLat, userLng);
                    window.app.calculateRoute();
                    showNotification('Route calculated from your location!', 'success');
                },
                (error) => {
                    console.log('Geolocation error:', error);
                    showNotification('Please set a start point on the map to calculate route', 'info');
                },
                { timeout: 5000, enableHighAccuracy: false }
            );
        } else {
            showNotification('Please set a start point on the map to calculate route', 'info');
        }
    }
}