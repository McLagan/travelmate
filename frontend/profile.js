/**
 * Profile Page JavaScript
 * Handles profile management, places, and countries
 */

// Simple notification function for profile page
function showNotification(message, type = 'info') {
    console.log(`${type.toUpperCase()}: ${message}`);

    // Create notification element
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${type === 'error' ? '#dc3545' : type === 'success' ? '#28a745' : '#007bff'};
        color: white;
        padding: 12px 20px;
        border-radius: 5px;
        z-index: 10000;
        font-size: 14px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    `;
    notification.textContent = message;

    document.body.appendChild(notification);

    // Remove after 3 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 3000);
}

class ProfileManager {
    constructor() {
        console.log('🏗️ ProfileManager constructor started');
        try {
            this.user = null;
            this.places = [];
            this.countries = [];
            this.visitedCountries = [];
            this.miniMap = null;
            this.isInitialized = false;
            this.editingPlaceId = null; // Track which place is being edited

            console.log('🏗️ ProfileManager properties initialized');
        } catch (error) {
            console.error('❌ Error in ProfileManager constructor:', error);
            throw error;
        }
    }

    async init() {
        console.log('🔄 ProfileManager init started');
        try {
            await this.checkAuth();
            console.log('✅ checkAuth completed');

            await this.loadProfile();
            console.log('✅ loadProfile completed');

            await this.loadCountriesList();
            console.log('✅ loadCountriesList completed');

            this.initMiniMap();
            console.log('✅ initMiniMap completed');

            this.setupEventListeners();
            console.log('✅ setupEventListeners completed');

            console.log('🎉 ProfileManager fully initialized');
            this.isInitialized = true;
        } catch (error) {
            console.error('❌ Error in ProfileManager init:', error);
            this.isInitialized = false;
            throw error;
        }
    }

    async checkAuth() {
        const token = localStorage.getItem('token');
        console.log('🔐 Profile checkAuth: token =', token ? 'EXISTS' : 'NOT_FOUND');

        if (!token) {
            console.log('❌ Profile: No token, redirecting to map');
            window.location.href = '/map';
            return;
        }

        try {
            console.log('📡 Profile: Making auth request to /auth/me');
            const response = await fetch(`${window.CONFIG.API_BASE_URL}/auth/me`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            console.log('📊 Profile: Auth response status:', response.status);

            if (!response.ok) {
                throw new Error(`Authentication failed: ${response.status}`);
            }

            this.user = await response.json();
            console.log('✅ Profile: User authenticated:', this.user.name);
        } catch (error) {
            console.error('❌ Profile: Auth check failed:', error);
            localStorage.removeItem('token');
            window.location.href = '/map';
        }
    }

    async loadProfile() {
        try {
            const token = localStorage.getItem('token');
            const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/dashboard`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error('Failed to load profile');
            }

            const data = await response.json();
            this.updateProfileUI(data);
        } catch (error) {
            console.error('Failed to load profile:', error);
            console.error('Failed to load profile data');
        }
    }

    updateProfileUI(data) {
        // Update user info
        document.getElementById('userName').textContent = data.user.name;
        document.getElementById('profileName').textContent = data.user.name;
        document.getElementById('profileEmail').textContent = data.user.email;

        // Update bio
        const bioElement = document.getElementById('profileBio');
        bioElement.textContent = data.user.bio || 'Add your bio...';

        // Update avatar
        if (data.user.avatar_url) {
            document.getElementById('userAvatar').src = data.user.avatar_url;
            document.getElementById('userAvatar').style.display = 'block';
            document.getElementById('avatarPlaceholder').style.display = 'none';
        }

        // Update stats
        document.getElementById('totalRoutes').textContent = data.total_routes;
        document.getElementById('totalPlaces').textContent = data.total_places;
        document.getElementById('totalCountries').textContent = data.total_countries;

        // Store data
        this.places = data.user_places;
        this.visitedCountries = data.visited_countries;

        // Update places and countries
        this.updatePlacesList();
        this.updateCountriesGrid();
        this.updateMiniMap();
    }

    updatePlacesList() {
        const container = document.getElementById('placesList');

        if (this.places.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-map-marker-alt"></i>
                    <p>No places added yet</p>
                    <button class="btn btn-outline" onclick="profileManager.showAddPlaceModal()">Add your first place</button>
                </div>
            `;
            return;
        }

        container.innerHTML = this.places.map(place => `
            <div class="place-item-enhanced" onclick="profileManager.showPlaceOnMap(${place.latitude}, ${place.longitude})">
                ${this.renderPlaceImage(place)}

                <div class="place-content">
                    <div class="place-header">
                        <div class="place-icon">
                            ${this.getCategoryIcon(place.category)}
                        </div>
                        <div class="place-title">
                            <h4 class="place-name">${place.name}</h4>
                            <span class="place-category">${this.getCategoryName(place.category)}</span>
                        </div>
                        <div class="place-actions">
                            ${place.images && place.images.length > 0 ? `
                                <button class="action-btn" onclick="event.stopPropagation(); profileManager.showPlacePhotos(${place.id})" title="Photos">
                                    <i class="fas fa-images"></i>
                                    <span class="photo-count">${place.images.length}</span>
                                </button>
                            ` : ''}
                            <button class="action-btn" onclick="event.stopPropagation(); profileManager.editPlace(${place.id})" title="Edit">
                                <i class="fas fa-edit"></i>
                            </button>
                            <button class="action-btn" onclick="event.stopPropagation(); profileManager.deletePlace(${place.id})" title="Delete">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>

                    ${place.description ? `
                        <div class="place-description-wrapper">
                            <p class="place-description collapsed" id="desc-${place.id}">${place.description}</p>
                            <button class="description-toggle" onclick="event.stopPropagation(); profileManager.toggleDescription(${place.id})">
                                <span class="toggle-text">Show more</span>
                                <i class="fas fa-chevron-down"></i>
                            </button>
                        </div>
                    ` : ''}

                    ${this.renderPlaceDetails(place)}

                    <div class="place-meta">
                        <div class="place-coordinates">
                            <i class="fas fa-map-marker-alt"></i>
                            <span>${place.latitude.toFixed(4)}, ${place.longitude.toFixed(4)}</span>
                        </div>
                        ${place.is_public ? '<span class="place-public-badge"><i class="fas fa-globe"></i> Public</span>' : '<span class="place-private-badge"><i class="fas fa-lock"></i> Private</span>'}
                    </div>
                </div>
            </div>
        `).join('');
    }

    updateCountriesGrid() {
        const container = document.getElementById('countriesGrid');

        if (this.visitedCountries.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-globe"></i>
                    <p>No countries marked yet</p>
                    <button class="btn btn-outline" onclick="profileManager.showCountriesModal()">Mark your first country</button>
                </div>
            `;
            return;
        }

        container.innerHTML = this.visitedCountries.map(country => `
            <div class="country-item visited" onclick="profileManager.removeVisitedCountry('${country.country_code}', ${country.id})">
                <img class="country-flag" src="assets/flags/${country.country_code.toLowerCase()}.png" alt="${country.country_name} flag" loading="lazy">
                <p class="country-name">${country.country_name}</p>
                <span class="remove-indicator">×</span>
            </div>
        `).join('');
    }

    initMiniMap() {
        this.miniMap = L.map('miniMap').setView([0, 0], 2);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors'
        }).addTo(this.miniMap);

        // Add click handler for adding places
        this.miniMap.on('click', (e) => this.handleMapClick(e));

        this.updateMiniMap();
    }

    updateMiniMap() {
        if (!this.miniMap) return;

        // Clear existing markers
        this.miniMap.eachLayer(layer => {
            if (layer instanceof L.Marker) {
                this.miniMap.removeLayer(layer);
            }
        });

        // Add place markers
        if (this.places.length > 0) {
            const group = new L.FeatureGroup();

            this.places.forEach(place => {
                const marker = L.marker([place.latitude, place.longitude])
                    .bindPopup(`<strong>${place.name}</strong><br>${place.description || ''}`);

                marker.addTo(this.miniMap);
                group.addLayer(marker);
            });

            // Fit map to show all places
            this.miniMap.fitBounds(group.getBounds(), { padding: [20, 20] });
        } else {
            this.miniMap.setView([0, 0], 2);
        }
    }

    async loadCountriesList() {
        try {
            const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/countries`);
            if (!response.ok) {
                throw new Error('Failed to load countries');
            }
            this.countries = await response.json();
        } catch (error) {
            console.error('Failed to load countries:', error);
        }
    }



    async deletePlace(placeId) {
        if (!confirm('Are you sure you want to delete this place?')) {
            return;
        }

        try {
            const token = localStorage.getItem('token');
            const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/places/${placeId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error('Failed to delete place');
            }

            showNotification('Place deleted successfully!', 'success');
            await this.loadProfile();
        } catch (error) {
            console.error('Failed to delete place:', error);
            showNotification('Failed to delete place', 'error');
        }
    }


    renderCountriesSelection() {
        const container = document.getElementById('countriesSelection');
        const visitedCodes = this.visitedCountries.map(c => c.country_code);

        container.innerHTML = this.countries.map((country, index) => `
            <div class="country-option ${visitedCodes.includes(country.code) ? 'selected' : ''}"
                 data-country-code="${country.code}"
                 data-country-name="${country.name.replace(/"/g, '&quot;')}"
                 onclick="profileManager.toggleCountryByElement(this)">
                <img class="country-flag"
                     data-src="${country.flag}"
                     alt="${country.name} flag"
                     loading="lazy"
                     onerror="this.style.display='none'; this.nextElementSibling.style.marginLeft='0'">
                <span class="country-name">${country.name}</span>
            </div>
        `).join('');

        // Implement intersection observer for lazy loading
        this.initLazyLoading();
    }

    initLazyLoading() {
        // Lazy loading for flag images
        const images = document.querySelectorAll('img[data-src]');

        if ('IntersectionObserver' in window) {
            const imageObserver = new IntersectionObserver((entries, observer) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        img.src = img.dataset.src;
                        img.removeAttribute('data-src');
                        observer.unobserve(img);
                    }
                });
            }, {
                rootMargin: '50px 0px',
                threshold: 0.01
            });

            images.forEach(img => imageObserver.observe(img));
        } else {
            // Fallback for older browsers
            images.forEach(img => {
                img.src = img.dataset.src;
                img.removeAttribute('data-src');
            });
        }
    }

    async toggleCountryByElement(element) {
        console.log('🔍 toggleCountryByElement called', element);
        const countryCode = element.dataset.countryCode;
        const countryName = element.dataset.countryName;
        console.log('🔍 Country data:', countryCode, countryName);
        return this.toggleCountry(countryCode, countryName, element);
    }

    async toggleCountry(countryCode, countryName, element) {
        console.log('🔍 toggleCountry called', countryCode, countryName, element);
        const isSelected = element.classList.contains('selected');
        console.log('🔍 isSelected:', isSelected);

        try {
            const token = localStorage.getItem('token');
            console.log('🔍 token:', token ? 'EXISTS' : 'NOT_FOUND');

            if (isSelected) {
                // Remove country
                const country = this.visitedCountries.find(c => c.country_code === countryCode);
                if (country) {
                    const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/visited-countries/${country.id}`, {
                        method: 'DELETE',
                        headers: {
                            'Authorization': `Bearer ${token}`
                        }
                    });

                    if (!response.ok) {
                        throw new Error('Failed to remove country');
                    }

                    element.classList.remove('selected');
                    showNotification('Country removed!', 'success');
                }
            } else {
                // Add country
                console.log('🔍 Adding country via POST request');
                console.log('🔍 window.CONFIG:', window.CONFIG);

                if (!window.CONFIG || !window.CONFIG.API_BASE_URL) {
                    console.error('❌ CONFIG not available!');
                    throw new Error('Configuration not loaded');
                }

                const requestBody = {
                    country_code: countryCode,
                    country_name: countryName
                };
                console.log('🔍 Request body:', requestBody);
                console.log('🔍 API URL:', `${window.CONFIG.API_BASE_URL}/profile/visited-countries`);

                try {
                    const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/visited-countries`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${token}`
                        },
                        body: JSON.stringify(requestBody)
                    });

                    console.log('🔍 Response status:', response.status);
                    console.log('🔍 Response ok:', response.ok);

                    if (!response.ok) {
                        const errorText = await response.text();
                        console.log('🔍 Error response:', errorText);
                        throw new Error(`Failed to add country: ${response.status} - ${errorText}`);
                    }

                    element.classList.add('selected');
                    showNotification('Country added!', 'success');
                } catch (fetchError) {
                    console.error('🔍 Fetch error:', fetchError);
                    throw fetchError;
                }
            }

            await this.loadProfile();
            this.renderCountriesSelection();
        } catch (error) {
            console.error('Failed to toggle country:', error);
            showNotification('Failed to update country', 'error');
        }
    }

    async removeVisitedCountry(countryCode, countryId) {
        if (!confirm('Remove this country from your visited list?')) {
            return;
        }

        try {
            const token = localStorage.getItem('token');
            const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/visited-countries/${countryId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error('Failed to remove country');
            }

            showNotification('Country removed successfully!', 'success');
            await this.loadProfile();
        } catch (error) {
            console.error('Failed to remove country:', error);
            showNotification('Failed to remove country', 'error');
        }
    }



    async updateProfile(formData) {
        console.log('🔄 updateProfile called');
        console.log('📝 FormData entries:', Array.from(formData.entries()));

        try {
            // Upload avatar first if selected
            if (this.selectedAvatarFile) {
                console.log('📤 Uploading avatar first...');
                await this.uploadAvatar();
            }

            const token = localStorage.getItem('token');
            const profileData = {
                name: formData.get('name'),
                bio: formData.get('bio')
            };

            console.log('📊 Profile data to send:', profileData);

            const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/me`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(profileData)
            });

            if (!response.ok) {
                const errorData = await response.json();
                console.error('❌ Server error:', errorData);
                throw new Error(errorData.detail || 'Failed to update profile');
            }

            showNotification('Profile updated successfully!', 'success');
            this.closeEditProfileModal();
            await this.loadProfile();
        } catch (error) {
            console.error('❌ Failed to update profile:', error);
            showNotification(error.message || 'Failed to update profile', 'error');
        }
    }

    showPlaceOnMap(lat, lng) {
        this.miniMap.setView([lat, lng], 15);
    }

    openFullMap() {
        window.open('/map', '_blank');
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

    getCategoryName(category) {
        const names = {
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
        return names[category] || 'Other';
    }

    renderPlaceImage(place) {
        if (place.images && place.images.length > 0) {
            const primaryImage = place.images.find(img => img.is_primary) || place.images[0];
            return `
                <div class="place-image">
                    <img src="${primaryImage.image_url}" alt="${place.name}" loading="lazy">
                    ${place.images.length > 1 ? `<div class="image-count">+${place.images.length - 1}</div>` : ''}
                </div>
            `;
        }
        return '';
    }

    renderPlaceDetails(place) {
        let detailsHtml = '';

        // Website
        if (place.website) {
            detailsHtml += `
                <div class="place-website">
                    <a href="${place.website}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();">
                        <i class="fas fa-external-link-alt"></i>
                        Visit Website
                    </a>
                </div>
            `;
        }

        // Custom fields
        if (place.custom_fields && place.custom_fields.length > 0) {
            detailsHtml += `
                <div class="place-custom-fields">
                    ${place.custom_fields.map(field => `
                        <div class="custom-field">
                            <strong>${field.name}:</strong> ${field.value}
                        </div>
                    `).join('')}
                </div>
            `;
        }

        return detailsHtml;
    }


    setupEventListeners() {
        // Add Place Form
        document.getElementById('addPlaceForm').addEventListener('submit', (e) => {
            e.preventDefault();
            if (!this.isInitialized) {
                console.error('❌ ProfileManager not initialized, cannot add place');
                showNotification('System not ready. Please wait and try again.', 'error');
                return;
            }
            const formData = new FormData(e.target);
            this.addPlace(formData);
        });

        // Edit Profile Form
        document.getElementById('editProfileForm').addEventListener('submit', (e) => {
            e.preventDefault();
            if (!this.isInitialized) {
                console.error('❌ ProfileManager not initialized, cannot update profile');
                showNotification('System not ready. Please wait and try again.', 'error');
                return;
            }
            const formData = new FormData(e.target);
            this.updateProfile(formData);
        });

        // Country Search
        document.getElementById('countrySearch').addEventListener('input', (e) => {
            this.filterCountries(e.target.value);
        });

        // Profile place photo upload handler
        const profilePhotoInput = document.getElementById('profilePlacePhoto');
        if (profilePhotoInput) {
            profilePhotoInput.addEventListener('change', (e) => {
                this.handleProfilePhotoUpload(e);
            });
        }

        // Close modals on outside click
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal-overlay')) {
                e.target.classList.remove('active');
                setTimeout(() => {
                    e.target.style.display = 'none';
                }, 200);
            }
        });
    }

    filterCountries(searchTerm) {
        const options = document.querySelectorAll('.country-option');
        options.forEach(option => {
            const countryName = option.querySelector('.country-name').textContent.toLowerCase();
            if (countryName.includes(searchTerm.toLowerCase())) {
                option.style.display = 'flex';
            } else {
                option.style.display = 'none';
            }
        });
    }

    showEditProfileModal() {
        console.log('🔧 showEditProfileModal called');
        const modal = document.getElementById('editProfileModal');
        console.log('🔧 Modal element:', modal);
        if (modal && this.user) {
            // Pre-fill form with current user data
            document.getElementById('editName').value = this.user.name || '';
            document.getElementById('editBio').value = this.user.bio || '';

            // Setup avatar preview
            this.setupAvatarPreview();

            modal.style.display = 'flex';
            modal.classList.add('active');
            console.log('✅ Modal opened');
        } else {
            console.error('❌ Modal not found or user not loaded');
        }
    }

    closeEditProfileModal() {
        const modal = document.getElementById('editProfileModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 200); // Wait for transition
        }
    }

    showAddPlaceModal() {
        const modal = document.getElementById('addPlaceModal');
        if (modal) {
            this.editingPlaceId = null; // Reset editing mode
            modal.style.display = 'flex';
            modal.classList.add('active');
            document.getElementById('addPlaceForm').reset();

            // Update modal title
            const modalTitle = modal.querySelector('.modal-title');
            if (modalTitle) modalTitle.textContent = 'Add New Place';

            // Update submit button
            const submitBtn = modal.querySelector('button[type="submit"]');
            if (submitBtn) submitBtn.textContent = 'Add Place';
        }
    }

    closeAddPlaceModal() {
        const modal = document.getElementById('addPlaceModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
                this.editingPlaceId = null;
            }, 200);
        }
    }

    async editPlace(placeId) {
        try {
            // Find place in current places array
            const place = this.places.find(p => p.id === placeId);
            if (!place) {
                showNotification('Place not found', 'error');
                return;
            }

            // Set editing mode
            this.editingPlaceId = placeId;

            // Open modal
            const modal = document.getElementById('addPlaceModal');
            if (!modal) return;

            modal.style.display = 'flex';
            modal.classList.add('active');

            // Update modal title
            const modalTitle = modal.querySelector('.modal-title');
            if (modalTitle) modalTitle.textContent = 'Edit Place';

            // Update submit button
            const submitBtn = modal.querySelector('button[type="submit"]');
            if (submitBtn) submitBtn.textContent = 'Update Place';

            // Fill form with place data
            document.getElementById('placeName').value = place.name || '';
            document.getElementById('placeDescription').value = place.description || '';
            document.getElementById('placeLatitude').value = place.latitude || '';
            document.getElementById('placeLongitude').value = place.longitude || '';
            document.getElementById('placeCategory').value = place.category || 'other';
            document.getElementById('placeIsPublic').checked = place.is_public || false;

            // Optional fields
            if (document.getElementById('placeWebsite')) {
                document.getElementById('placeWebsite').value = place.website || '';
            }
            if (document.getElementById('placeRating')) {
                document.getElementById('placeRating').value = place.rating || '';
            }

            // Update map marker if map is available
            if (window.app?.map) {
                window.app.map.setView([place.latitude, place.longitude], 14);
            }

        } catch (error) {
            console.error('Error loading place for edit:', error);
            showNotification('Failed to load place data', 'error');
        }
    }

    showPlacePhotos(placeId) {
        const place = this.places.find(p => p.id === placeId);
        if (!place || !place.images || place.images.length === 0) {
            showNotification('No photos available', 'info');
            return;
        }

        // Create modal HTML
        const modalHTML = `
            <div class="modal-overlay active" id="photoGalleryModal" onclick="if(event.target === this) profileManager.closePhotoGallery()">
                <div class="modal photo-gallery-modal">
                    <div class="modal-header">
                        <h3 class="modal-title">${place.name} - Photos</h3>
                        <button class="modal-close" onclick="profileManager.closePhotoGallery()">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div class="photo-gallery">
                            ${place.images.map((img, index) => `
                                <div class="gallery-item">
                                    <img src="${img.image_url}" alt="${place.name} photo ${index + 1}">
                                    ${img.is_primary ? '<span class="primary-badge">Primary</span>' : ''}
                                </div>
                            `).join('')}
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Remove existing modal if any
        const existingModal = document.getElementById('photoGalleryModal');
        if (existingModal) {
            existingModal.remove();
        }

        // Add modal to body
        document.body.insertAdjacentHTML('beforeend', modalHTML);
    }

    closePhotoGallery() {
        const modal = document.getElementById('photoGalleryModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => modal.remove(), 200);
        }
    }

    toggleDescription(placeId) {
        const descElement = document.getElementById(`desc-${placeId}`);
        const button = event.currentTarget;
        const toggleText = button.querySelector('.toggle-text');
        const icon = button.querySelector('i');

        if (descElement.classList.contains('collapsed')) {
            descElement.classList.remove('collapsed');
            descElement.classList.add('expanded');
            toggleText.textContent = 'Show less';
            icon.classList.remove('fa-chevron-down');
            icon.classList.add('fa-chevron-up');
        } else {
            descElement.classList.add('collapsed');
            descElement.classList.remove('expanded');
            toggleText.textContent = 'Show more';
            icon.classList.remove('fa-chevron-up');
            icon.classList.add('fa-chevron-down');
        }
    }

    showCountriesModal() {
        const modal = document.getElementById('countriesModal');
        if (modal) {
            modal.style.display = 'flex';
            modal.classList.add('active');
            this.renderCountriesSelection();
        }
    }

    closeCountriesModal() {
        const modal = document.getElementById('countriesModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 200);
        }
    }


    setupAvatarPreview() {
        const avatarImg = document.getElementById('currentAvatarImg');
        const avatarPlaceholder = document.getElementById('currentAvatarPlaceholder');
        const removeBtn = document.getElementById('removeAvatarBtn');
        const fileInput = document.getElementById('avatarFileInput');

        // Show current avatar or placeholder
        if (this.user.avatar_url) {
            avatarImg.src = this.user.avatar_url;
            avatarImg.style.display = 'block';
            avatarPlaceholder.style.display = 'none';
            removeBtn.style.display = 'inline-block';
        } else {
            avatarImg.style.display = 'none';
            avatarPlaceholder.style.display = 'flex';
            removeBtn.style.display = 'none';
        }

        // Setup file input change handler
        fileInput.onchange = (e) => this.handleAvatarFileSelect(e);
    }

    handleAvatarFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        // Validate file type
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (!allowedTypes.includes(file.type)) {
            showNotification('Please select a valid image file (JPG, PNG, WebP)', 'error');
            return;
        }

        // Validate file size (5MB)
        if (file.size > 5 * 1024 * 1024) {
            showNotification('File size must be less than 5MB', 'error');
            return;
        }

        // Show preview
        const reader = new FileReader();
        reader.onload = (e) => {
            const avatarImg = document.getElementById('currentAvatarImg');
            const avatarPlaceholder = document.getElementById('currentAvatarPlaceholder');
            const removeBtn = document.getElementById('removeAvatarBtn');

            avatarImg.src = e.target.result;
            avatarImg.style.display = 'block';
            avatarPlaceholder.style.display = 'none';
            removeBtn.style.display = 'inline-block';
        };
        reader.readAsDataURL(file);

        // Store selected file for upload
        this.selectedAvatarFile = file;
    }

    async uploadAvatar() {
        if (!this.selectedAvatarFile) return null;

        console.log('📤 Starting avatar upload...', this.selectedAvatarFile.name);

        const formData = new FormData();
        formData.append('file', this.selectedAvatarFile);

        // Show loading state
        const container = document.querySelector('.avatar-upload-container');
        if (container) container.classList.add('uploading');

        try {
            const token = localStorage.getItem('token');
            const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/avatar`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                body: formData
            });

            if (!response.ok) {
                const error = await response.json();
                console.error('❌ Upload error:', error);
                throw new Error(error.detail || 'Failed to upload avatar');
            }

            const result = await response.json();
            console.log('✅ Avatar uploaded:', result);

            // Update user object
            this.user.avatar_url = result.avatar_url;

            // Clear selected file
            this.selectedAvatarFile = null;

            return result.avatar_url;

        } catch (error) {
            console.error('❌ Failed to upload avatar:', error);
            showNotification(error.message || 'Failed to upload avatar', 'error');
            throw error;
        } finally {
            // Remove loading state
            const container = document.querySelector('.avatar-upload-container');
            if (container) container.classList.remove('uploading');
        }
    }

    async deleteAvatar() {
        try {
            const token = localStorage.getItem('token');
            const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/avatar`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!response.ok) {
                throw new Error('Failed to delete avatar');
            }

            showNotification('Avatar removed successfully!', 'success');

            // Update user object
            this.user.avatar_url = null;

            // Update UI
            this.updateProfileUI({ user: this.user, ...this.getProfileSummaryData() });
            this.setupAvatarPreview();

        } catch (error) {
            console.error('Failed to delete avatar:', error);
            showNotification('Failed to remove avatar', 'error');
        }
    }

    getProfileSummaryData() {
        // Helper to get current profile data for UI update
        return {
            total_routes: this.places.length,
            total_places: this.places.length,
            total_countries: this.visitedCountries.length,
            user_places: this.places,
            visited_countries: this.visitedCountries
        };
    }

    // Map click handler for adding places
    handleMapClick(e) {
        if (!this.isInitialized) {
            console.error('❌ ProfileManager not initialized, cannot handle map click');
            showNotification('System not ready. Please wait and try again.', 'error');
            return;
        }

        const lat = parseFloat(e.latlng.lat.toFixed(6));
        const lng = parseFloat(e.latlng.lng.toFixed(6));

        // Set coordinates in hidden form fields
        document.getElementById('placeLatitude').value = lat;
        document.getElementById('placeLongitude').value = lng;

        // Update location display
        const locationDisplay = document.getElementById('selectedLocation');
        if (locationDisplay) {
            locationDisplay.textContent = `${lat}, ${lng}`;
        }

        // Show the add place modal
        this.showAddPlaceModal();

        showNotification(`📍 Location selected`, 'success');
    }

    // Photo handling for profile
    handleProfilePhotoUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        // Validate file size (5MB max)
        if (file.size > 5 * 1024 * 1024) {
            showNotification('File size must be less than 5MB', 'error');
            return;
        }

        // Validate file type
        if (!file.type.startsWith('image/')) {
            showNotification('Please select an image file', 'error');
            return;
        }

        // Show preview
        const reader = new FileReader();
        reader.onload = (e) => {
            this.showProfilePhotoPreview(e.target.result);
        };
        reader.readAsDataURL(file);
    }

    showProfilePhotoPreview(imageSrc) {
        const preview = document.getElementById('profilePhotoPreview');
        const placeholder = document.getElementById('profileUploadPlaceholder');
        const previewImage = document.getElementById('profilePreviewImage');

        if (preview && placeholder && previewImage) {
            previewImage.src = imageSrc;
            placeholder.style.display = 'none';
            preview.style.display = 'block';
        }
    }

    removeProfilePhoto() {
        const photoInput = document.getElementById('profilePlacePhoto');
        const preview = document.getElementById('profilePhotoPreview');
        const placeholder = document.getElementById('profileUploadPlaceholder');

        if (photoInput) photoInput.value = '';
        if (preview) preview.style.display = 'none';
        if (placeholder) placeholder.style.display = 'block';
    }

    // Custom fields handling for profile
    toggleProfileCustomFields() {
        const container = document.getElementById('profileCustomFieldsContainer');
        const toggle = document.getElementById('profileCustomFieldsToggle');

        if (!container || !toggle) return;

        const isHidden = container.style.display === 'none';

        if (isHidden) {
            container.style.display = 'block';
            toggle.classList.add('active');
            toggle.innerHTML = '<i class="fas fa-minus"></i> Hide Custom Fields';

            // Add first field if container is empty
            if (!container.querySelector('.custom-field-item')) {
                this.addProfileCustomField();
            }
        } else {
            container.style.display = 'none';
            toggle.classList.remove('active');
            toggle.innerHTML = '<i class="fas fa-plus"></i> Add Custom Field';
        }
    }

    addProfileCustomField() {
        const container = document.getElementById('profileCustomFieldsList');
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
                <button type="button" class="btn-remove" onclick="removeProfileCustomField(${fieldId})" title="Remove field">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;

        container.insertAdjacentHTML('beforeend', fieldHtml);

        // Add animation
        const newField = container.lastElementChild;
        newField.classList.add('slide-down');
    }

    removeProfileCustomField(fieldId) {
        const field = document.querySelector(`[data-field-id="${fieldId}"]`);
        if (field) {
            field.remove();
        }
    }

    // Enhanced addPlace method
    async addPlace(formData) {
        try {
            console.log('🏗️ Adding place...', formData);
            console.log('🔍 FormData entries:', Array.from(formData.entries()));

            // Debug: Check form fields directly
            const nameField = document.getElementById('placeName');
            const descField = document.getElementById('placeDescription');
            const latField = document.getElementById('placeLatitude');
            const lngField = document.getElementById('placeLongitude');

            console.log('🔍 Direct field values:');
            console.log('  placeName value:', nameField?.value);
            console.log('  placeDescription value:', descField?.value);
            console.log('  placeLatitude value:', latField?.value);
            console.log('  placeLongitude value:', lngField?.value);
            console.log('  Form valid:', document.getElementById('addPlaceForm').checkValidity());

            const token = localStorage.getItem('token');

            // Collect all form data including new fields
            const placeData = this.collectPlaceFormData(formData);
            console.log('📊 Collected place data:', placeData);

            // Validate required fields
            if (!placeData.name || placeData.name.trim() === '') {
                console.error('❌ Place name validation failed:', placeData.name);
                throw new Error('Place name is required');
            }
            if (!placeData.latitude || !placeData.longitude) {
                console.error('❌ Coordinates validation failed:', placeData.latitude, placeData.longitude);
                throw new Error('Location coordinates are required. Please click on the map to select a location.');
            }

            // Always use FormData for consistency with backend endpoint
            const photoInput = document.getElementById('profilePlacePhoto');
            const requestData = new FormData();
            const headers = {
                'Authorization': `Bearer ${token}`
            };

            // Add all form data
            Object.keys(placeData).forEach(key => {
                if (key === 'customFields') {
                    requestData.append(key, JSON.stringify(placeData[key]));
                } else {
                    requestData.append(key, placeData[key]);
                }
            });

            // Add photo if selected
            if (photoInput.files[0]) {
                requestData.append('photo', photoInput.files[0]);
                console.log('📷 Photo attached:', photoInput.files[0].name);
            }

            // Determine if editing or adding
            const isEditing = this.editingPlaceId !== null;
            const endpoint = isEditing
                ? `${window.CONFIG.API_BASE_URL}/profile/places/${this.editingPlaceId}`
                : `${window.CONFIG.API_BASE_URL}/profile/places`;
            const method = isEditing ? 'PUT' : 'POST';

            console.log(`📡 Sending ${method} request to:`, endpoint);
            console.log('📋 FormData contents:', Array.from(requestData.entries()));

            // Debug each FormData entry explicitly
            for (let [key, value] of requestData.entries()) {
                console.log(`  ${key}: "${value}" (type: ${typeof value})`);
            }

            const response = await fetch(endpoint, {
                method: method,
                headers: headers,
                body: requestData
            });

            if (!response.ok) {
                const errorData = await response.text();
                console.error('❌ Server response:', response.status, errorData);
                throw new Error(`Failed to ${isEditing ? 'update' : 'add'} place: ${response.status} - ${errorData}`);
            }

            console.log(`✅ Place ${isEditing ? 'updated' : 'added'} successfully!`);
            showNotification(`Place ${isEditing ? 'updated' : 'added'} successfully!`, 'success');
            this.closeAddPlaceModal();
            this.resetPlaceForm();
            await this.loadProfile();
        } catch (error) {
            console.error('❌ Failed to add place:', error);
            showNotification(`Failed to add place: ${error.message}`, 'error');
        }
    }

    collectPlaceFormData(formData) {
        const customFields = this.getProfileCustomFieldsData();

        // Get values directly from form inputs as fallback
        const nameFromForm = formData.get('name');
        const nameFromInput = document.getElementById('placeName')?.value;
        const descriptionFromForm = formData.get('description');
        const descriptionFromInput = document.getElementById('placeDescription')?.value;
        const latFromHidden = document.getElementById('placeLatitude')?.value;
        const lngFromHidden = document.getElementById('placeLongitude')?.value;
        const categoryFromForm = formData.get('category');
        const categoryFromSelect = document.getElementById('placeCategory')?.value;

        console.log('🔍 Form data debug:');
        console.log('  name from FormData:', nameFromForm);
        console.log('  name from input:', nameFromInput);
        console.log('  description from FormData:', descriptionFromForm);
        console.log('  description from input:', descriptionFromInput);
        console.log('  lat from hidden:', latFromHidden);
        console.log('  lng from hidden:', lngFromHidden);
        console.log('  category from FormData:', categoryFromForm);
        console.log('  category from select:', categoryFromSelect);

        return {
            name: nameFromForm || nameFromInput,
            description: descriptionFromForm || descriptionFromInput,
            latitude: parseFloat(formData.get('latitude') || latFromHidden),
            longitude: parseFloat(formData.get('longitude') || lngFromHidden),
            category: categoryFromForm || categoryFromSelect,
            website: formData.get('website') || document.getElementById('placeWebsite')?.value || null,
            is_public: formData.get('is_public') === 'on' || document.getElementById('placeIsPublic')?.checked || false,
            customFields: customFields
        };
    }

    getProfileCustomFieldsData() {
        const customFields = [];
        const fieldItems = document.querySelectorAll('#profileCustomFieldsList .custom-field-item');

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

    resetPlaceForm() {
        const form = document.getElementById('addPlaceForm');
        if (form) {
            form.reset();
        }

        // Reset location display
        const locationDisplay = document.getElementById('selectedLocation');
        if (locationDisplay) {
            locationDisplay.textContent = '-';
        }

        // Reset photo preview
        this.removeProfilePhoto();

        // Reset custom fields
        const customFieldsList = document.getElementById('profileCustomFieldsList');
        if (customFieldsList) {
            customFieldsList.innerHTML = '';
        }

        const customFieldsContainer = document.getElementById('profileCustomFieldsContainer');
        const customFieldsToggle = document.getElementById('profileCustomFieldsToggle');
        if (customFieldsContainer && customFieldsToggle) {
            customFieldsContainer.style.display = 'none';
            customFieldsToggle.classList.remove('active');
            customFieldsToggle.innerHTML = '<i class="fas fa-plus"></i> Add Custom Field';
        }
    }

}

// Global state
let profileManager = null;
let retryCount = 0;
const MAX_RETRIES = 10;

// Global functions for HTML onclick handlers - defined immediately
window.editProfile = function() {
    console.log('🔧 editProfile called');
    if (profileManager && profileManager.isInitialized && profileManager.showEditProfileModal) {
        profileManager.showEditProfileModal();
    } else if (profileManager && profileManager.initializationFailed) {
        showNotification('Profile system failed to initialize. Please refresh the page.', 'error');
    } else {
        console.log('⏳ ProfileManager not ready, queuing action...');
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            setTimeout(() => {
                retryCount--;
                window.editProfile();
            }, 500);
        } else {
            showNotification('Profile system not ready. Please refresh the page.', 'error');
            retryCount = 0;
        }
    }
};

window.showAddPlaceModal = function() {
    console.log('🔧 showAddPlaceModal called');
    if (profileManager && profileManager.isInitialized && profileManager.showAddPlaceModal) {
        profileManager.showAddPlaceModal();
    } else if (profileManager && profileManager.initializationFailed) {
        showNotification('Profile system failed to initialize. Please refresh the page.', 'error');
    } else {
        console.log('⏳ ProfileManager not ready, queuing action...');
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            setTimeout(() => {
                retryCount--;
                window.showAddPlaceModal();
            }, 500);
        } else {
            showNotification('Profile system not ready. Please refresh the page.', 'error');
            retryCount = 0;
        }
    }
};

window.showCountriesModal = function() {
    console.log('🔧 showCountriesModal called');
    if (profileManager && profileManager.isInitialized && profileManager.showCountriesModal) {
        profileManager.showCountriesModal();
    } else if (profileManager && profileManager.initializationFailed) {
        showNotification('Profile system failed to initialize. Please refresh the page.', 'error');
    } else {
        console.log('⏳ ProfileManager not ready, queuing action...');
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            setTimeout(() => {
                retryCount--;
                window.showCountriesModal();
            }, 500);
        } else {
            showNotification('Profile system not ready. Please refresh the page.', 'error');
            retryCount = 0;
        }
    }
};

window.closeEditProfileModal = function() {
    if (profileManager && profileManager.closeEditProfileModal) {
        profileManager.closeEditProfileModal();
    }
};

window.closeAddPlaceModal = function() {
    if (profileManager && profileManager.closeAddPlaceModal) {
        profileManager.closeAddPlaceModal();
    }
};

window.closeCountriesModal = function() {
    if (profileManager && profileManager.closeCountriesModal) {
        profileManager.closeCountriesModal();
    }
};

window.openFullMap = function() {
    window.location.href = '/map';
};

window.logout = function() {
    localStorage.removeItem('token');
    window.location.href = '/map';
};

// Legacy function aliases for backward compatibility
window.editAvatar = window.editProfile;

window.removeAvatar = function() {
    if (profileManager) {
        // If we're in edit modal and have selected file, clear the preview
        const avatarImg = document.getElementById('currentAvatarImg');
        const avatarPlaceholder = document.getElementById('currentAvatarPlaceholder');
        const removeBtn = document.getElementById('removeAvatarBtn');
        const fileInput = document.getElementById('avatarFileInput');

        if (avatarImg && avatarPlaceholder && removeBtn) {
            // Clear selected file
            profileManager.selectedAvatarFile = null;
            if (fileInput) fileInput.value = '';

            // Reset to original avatar or placeholder
            if (profileManager.user && profileManager.user.avatar_url) {
                avatarImg.src = profileManager.user.avatar_url;
                avatarImg.style.display = 'block';
                avatarPlaceholder.style.display = 'none';
                removeBtn.style.display = 'inline-block';
            } else {
                avatarImg.style.display = 'none';
                avatarPlaceholder.style.display = 'flex';
                removeBtn.style.display = 'none';
            }
        } else if (profileManager.deleteAvatar) {
            // Delete saved avatar
            profileManager.deleteAvatar();
        }
    }
};

// Profile place photo functions
window.removeProfilePhoto = function() {
    if (profileManager && profileManager.removeProfilePhoto) {
        profileManager.removeProfilePhoto();
    }
};

// Profile custom fields functions
window.toggleProfileCustomFields = function() {
    if (profileManager && profileManager.toggleProfileCustomFields) {
        profileManager.toggleProfileCustomFields();
    }
};

window.addProfileCustomField = function() {
    if (profileManager && profileManager.addProfileCustomField) {
        profileManager.addProfileCustomField();
    }
};

window.removeProfileCustomField = function(fieldId) {
    if (profileManager && profileManager.removeProfileCustomField) {
        profileManager.removeProfileCustomField(fieldId);
    }
};

// Initialize ProfileManager when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    console.log('📋 Initializing ProfileManager...');
    try {
        profileManager = new ProfileManager();
        window.profileManager = profileManager;

        // Initialize asynchronously
        await profileManager.init();
        profileManager.isInitialized = true;

        console.log('✅ ProfileManager fully ready');

        // Show success notification
        showNotification('Profile system ready!', 'success');
    } catch (error) {
        console.error('❌ ProfileManager failed:', error);

        // Mark as failed initialization
        if (profileManager) {
            profileManager.isInitialized = false;
            profileManager.initializationFailed = true;
        }

        // Show user-friendly error
        showNotification('Profile system failed to load. Please refresh the page.', 'error');

        // Add retry button
        const retryButton = document.createElement('button');
        retryButton.textContent = 'Retry Initialization';
        retryButton.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#007bff;color:white;border:none;padding:10px 15px;border-radius:5px;cursor:pointer;z-index:1001;';
        retryButton.onclick = () => {
            retryButton.remove();
            window.location.reload();
        };
        document.body.appendChild(retryButton);
    }
});