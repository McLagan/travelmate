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
            <div class="place-item" onclick="profileManager.showPlaceOnMap(${place.latitude}, ${place.longitude})">
                <div class="place-icon">
                    ${this.getCategoryIcon(place.category)}
                </div>
                <div class="place-info">
                    <h4 class="place-name">${place.name}</h4>
                    <p class="place-description">${place.description || 'No description'}</p>
                </div>
                <div class="place-actions">
                    <button class="action-btn" onclick="event.stopPropagation(); profileManager.editPlace(${place.id})" title="Edit">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="action-btn" onclick="event.stopPropagation(); profileManager.deletePlace(${place.id})" title="Delete">
                        <i class="fas fa-trash"></i>
                    </button>
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


    async addPlace(formData) {
        try {
            const token = localStorage.getItem('token');
            const placeData = {
                name: formData.get('name'),
                description: formData.get('description'),
                latitude: parseFloat(formData.get('latitude')),
                longitude: parseFloat(formData.get('longitude')),
                category: formData.get('category'),
                images: formData.get('imageUrl') ? [{
                    image_url: formData.get('imageUrl'),
                    is_primary: true
                }] : []
            };

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

            showNotification('Place added successfully!', 'success');
            this.closeAddPlaceModal();
            await this.loadProfile();
        } catch (error) {
            console.error('Failed to add place:', error);
            showNotification('Failed to add place', 'error');
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

    showEditProfileModal() {
        document.getElementById('editName').value = this.user.name;
        document.getElementById('editBio').value = this.user.bio || '';
        document.getElementById('editAvatarUrl').value = this.user.avatar_url || '';
        document.getElementById('editProfileModal').style.display = 'flex';
    }

    closeEditProfileModal() {
        const modal = document.getElementById('editProfileModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 200);
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
            other: '📍'
        };
        return icons[category] || '📍';
    }


    setupEventListeners() {
        // Add Place Form
        document.getElementById('addPlaceForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            this.addPlace(formData);
        });

        // Edit Profile Form
        document.getElementById('editProfileForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const formData = new FormData(e.target);
            this.updateProfile(formData);
        });

        // Country Search
        document.getElementById('countrySearch').addEventListener('input', (e) => {
            this.filterCountries(e.target.value);
        });

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
            modal.style.display = 'flex';
            modal.classList.add('active');
            document.getElementById('addPlaceForm').reset();
        }
    }

    closeAddPlaceModal() {
        const modal = document.getElementById('addPlaceModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 200);
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

    openFullMap() {
        window.location.href = '/map';
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

}

// Global state
let profileManager = null;
let retryCount = 0;
const MAX_RETRIES = 10;

// Global functions for HTML onclick handlers - defined immediately
window.editProfile = function() {
    console.log('🔧 editProfile called');
    if (profileManager && profileManager.showEditProfileModal) {
        profileManager.showEditProfileModal();
    } else {
        console.log('⏳ ProfileManager not ready, queuing action...');
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            setTimeout(() => {
                retryCount--;
                window.editProfile();
            }, 500);
        } else {
            alert('Profile system not ready. Please refresh the page.');
            retryCount = 0;
        }
    }
};

window.showAddPlaceModal = function() {
    console.log('🔧 showAddPlaceModal called');
    if (profileManager && profileManager.showAddPlaceModal) {
        profileManager.showAddPlaceModal();
    } else {
        console.log('⏳ ProfileManager not ready, queuing action...');
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            setTimeout(() => {
                retryCount--;
                window.showAddPlaceModal();
            }, 500);
        } else {
            alert('Profile system not ready. Please refresh the page.');
            retryCount = 0;
        }
    }
};

window.showCountriesModal = function() {
    console.log('🔧 showCountriesModal called');
    if (profileManager && profileManager.showCountriesModal) {
        profileManager.showCountriesModal();
    } else {
        console.log('⏳ ProfileManager not ready, queuing action...');
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            setTimeout(() => {
                retryCount--;
                window.showCountriesModal();
            }, 500);
        } else {
            alert('Profile system not ready. Please refresh the page.');
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
    } catch (error) {
        console.error('❌ ProfileManager failed:', error);

        // Show user-friendly error
        const errorDiv = document.createElement('div');
        errorDiv.style.cssText = 'position:fixed;top:20px;right:20px;background:#ff6b6b;color:white;padding:10px;border-radius:5px;z-index:1000';
        errorDiv.textContent = 'Profile system failed to load. Please refresh the page.';
        document.body.appendChild(errorDiv);

        setTimeout(() => errorDiv.remove(), 5000);
    }
});