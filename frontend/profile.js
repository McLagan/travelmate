/**
 * Profile Page JavaScript
 * Handles profile management, places, and countries
 */

class ProfileManager {
    constructor() {
        console.log('🏗️ ProfileManager constructor started');
        try {
            this.user = null;
            this.places = [];
            this.countries = [];
            this.visitedCountries = [];
            this.miniMap = null;

            console.log('🏗️ ProfileManager properties initialized');
            this.init();
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

            this.setupButtonEventListeners();
            console.log('✅ setupButtonEventListeners completed');

            console.log('🎉 ProfileManager fully initialized');
        } catch (error) {
            console.error('❌ Error in ProfileManager init:', error);
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
            <div class="country-item visited" onclick="profileManager.removeCountry(${country.id})">
                <span class="country-flag">${this.getCountryFlag(country.country_code)}</span>
                <p class="country-name">${country.country_name}</p>
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

    showAddPlaceModal() {
        document.getElementById('addPlaceModal').style.display = 'flex';
        document.getElementById('addPlaceForm').reset();
    }

    closeAddPlaceModal() {
        document.getElementById('addPlaceModal').style.display = 'none';
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

    showCountriesModal() {
        document.getElementById('countriesModal').style.display = 'flex';
        this.renderCountriesSelection();
    }

    closeCountriesModal() {
        document.getElementById('countriesModal').style.display = 'none';
    }

    renderCountriesSelection() {
        const container = document.getElementById('countriesSelection');
        const visitedCodes = this.visitedCountries.map(c => c.country_code);

        container.innerHTML = this.countries.map(country => `
            <div class="country-option ${visitedCodes.includes(country.code) ? 'selected' : ''}"
                 onclick="profileManager.toggleCountry('${country.code}', '${country.name}', this)">
                <span class="country-flag">${country.flag}</span>
                <span class="country-name">${country.name}</span>
            </div>
        `).join('');
    }

    async toggleCountry(countryCode, countryName, element) {
        const isSelected = element.classList.contains('selected');

        try {
            const token = localStorage.getItem('token');

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
                const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/visited-countries`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({
                        country_code: countryCode,
                        country_name: countryName
                    })
                });

                if (!response.ok) {
                    throw new Error('Failed to add country');
                }

                element.classList.add('selected');
                showNotification('Country added!', 'success');
            }

            await this.loadProfile();
        } catch (error) {
            console.error('Failed to toggle country:', error);
            showNotification('Failed to update country', 'error');
        }
    }

    showEditProfileModal() {
        document.getElementById('editName').value = this.user.name;
        document.getElementById('editBio').value = this.user.bio || '';
        document.getElementById('editAvatarUrl').value = this.user.avatar_url || '';
        document.getElementById('editProfileModal').style.display = 'flex';
    }

    closeEditProfileModal() {
        document.getElementById('editProfileModal').style.display = 'none';
    }

    async updateProfile(formData) {
        try {
            const token = localStorage.getItem('token');
            const profileData = {
                name: formData.get('name'),
                bio: formData.get('bio'),
                avatar_url: formData.get('avatarUrl')
            };

            const response = await fetch(`${window.CONFIG.API_BASE_URL}/profile/me`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(profileData)
            });

            if (!response.ok) {
                throw new Error('Failed to update profile');
            }

            showNotification('Profile updated successfully!', 'success');
            this.closeEditProfileModal();
            await this.loadProfile();
        } catch (error) {
            console.error('Failed to update profile:', error);
            showNotification('Failed to update profile', 'error');
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

    getCountryFlag(countryCode) {
        // This is a basic implementation. In a real app, you'd have a comprehensive mapping
        const flags = {
            'RU': '🇷🇺', 'US': '🇺🇸', 'CN': '🇨🇳', 'JP': '🇯🇵', 'DE': '🇩🇪',
            'FR': '🇫🇷', 'IT': '🇮🇹', 'ES': '🇪🇸', 'GB': '🇬🇧', 'CA': '🇨🇦',
            'AU': '🇦🇺', 'BR': '🇧🇷', 'IN': '🇮🇳', 'KR': '🇰🇷', 'MX': '🇲🇽',
            'TH': '🇹🇭', 'TR': '🇹🇷', 'EG': '🇪🇬', 'ZA': '🇿🇦', 'AR': '🇦🇷'
        };
        return flags[countryCode] || '🏴';
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
                e.target.style.display = 'none';
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

    // Modal management methods
    showEditProfileModal() {
        console.log('🔧 showEditProfileModal called');
        const modal = document.getElementById('editProfileModal');
        console.log('🔧 Modal element:', modal);
        if (modal && this.user) {
            // Pre-fill form with current user data
            document.getElementById('editName').value = this.user.name || '';
            document.getElementById('editBio').value = this.user.bio || '';
            document.getElementById('editAvatarUrl').value = this.user.avatar_url || '';
            modal.style.display = 'flex';
            console.log('✅ Modal opened');
        } else {
            console.error('❌ Modal not found or user not loaded');
        }
    }

    closeEditProfileModal() {
        const modal = document.getElementById('editProfileModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    showAddPlaceModal() {
        const modal = document.getElementById('addPlaceModal');
        if (modal) {
            modal.style.display = 'flex';
        }
    }

    closeAddPlaceModal() {
        const modal = document.getElementById('addPlaceModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    showCountriesModal() {
        const modal = document.getElementById('countriesModal');
        if (modal) {
            modal.style.display = 'flex';
        }
    }

    closeCountriesModal() {
        const modal = document.getElementById('countriesModal');
        if (modal) {
            modal.style.display = 'none';
        }
    }

    openFullMap() {
        window.location.href = '/map';
    }

    setupButtonEventListeners() {
        console.log('🔧 Setting up button event listeners...');

        // Edit Profile button
        const editProfileBtn = document.querySelector('button[onclick="editProfile()"]');
        if (editProfileBtn) {
            editProfileBtn.removeAttribute('onclick');
            editProfileBtn.addEventListener('click', () => {
                console.log('🔧 Edit Profile button clicked');
                this.showEditProfileModal();
            });
            console.log('✅ Edit Profile button listener added');
        }

        // Add Place buttons
        document.querySelectorAll('button[onclick="showAddPlaceModal()"]').forEach(btn => {
            btn.removeAttribute('onclick');
            btn.addEventListener('click', () => {
                console.log('🔧 Add Place button clicked');
                this.showAddPlaceModal();
            });
        });

        // Add Country button
        const addCountryBtn = document.querySelector('button[onclick="showCountriesModal()"]');
        if (addCountryBtn) {
            addCountryBtn.removeAttribute('onclick');
            addCountryBtn.addEventListener('click', () => {
                console.log('🔧 Add Country button clicked');
                this.showCountriesModal();
            });
        }

        // View Full Map button
        const fullMapBtn = document.querySelector('button[onclick="openFullMap()"]');
        if (fullMapBtn) {
            fullMapBtn.removeAttribute('onclick');
            fullMapBtn.addEventListener('click', () => {
                console.log('🔧 Full Map button clicked');
                this.openFullMap();
            });
        }

        console.log('✅ All button listeners set up');
    }
}

// Global functions for HTML onclick handlers
function editProfile() {
    console.log('🔧 editProfile called, profileManager:', profileManager);
    if (profileManager && profileManager.showEditProfileModal) {
        profileManager.showEditProfileModal();
    } else {
        console.error('❌ profileManager not initialized or method not available');
        console.log('🔧 Trying to initialize manually...');
        if (!profileManager) {
            // Try to wait a bit and retry
            setTimeout(() => {
                if (profileManager) {
                    profileManager.showEditProfileModal();
                } else {
                    alert('Profile system not ready. Please refresh the page.');
                }
            }, 1000);
        }
    }
}

function editAvatar() {
    profileManager.showEditProfileModal();
}

function showAddPlaceModal() {
    profileManager.showAddPlaceModal();
}

function closeAddPlaceModal() {
    profileManager.closeAddPlaceModal();
}

function showCountriesModal() {
    profileManager.showCountriesModal();
}

function closeCountriesModal() {
    profileManager.closeCountriesModal();
}

function closeEditProfileModal() {
    profileManager.closeEditProfileModal();
}

function openFullMap() {
    profileManager.openFullMap();
}

function logout() {
    localStorage.removeItem('token');
    window.location.href = '/map';
}

// Initialize immediately - not waiting for DOMContentLoaded
let profileManager = null;

// Define global functions immediately
window.editProfile = function() {
    console.log('🔧 editProfile called');
    if (profileManager && profileManager.showEditProfileModal) {
        profileManager.showEditProfileModal();
    } else {
        console.log('⏳ ProfileManager not ready, queuing action...');
        setTimeout(() => window.editProfile(), 500);
    }
};

window.showAddPlaceModal = function() {
    console.log('🔧 showAddPlaceModal called');
    if (profileManager && profileManager.showAddPlaceModal) {
        profileManager.showAddPlaceModal();
    } else {
        setTimeout(() => window.showAddPlaceModal(), 500);
    }
};

window.showCountriesModal = function() {
    console.log('🔧 showCountriesModal called');
    if (profileManager && profileManager.showCountriesModal) {
        profileManager.showCountriesModal();
    } else {
        setTimeout(() => window.showCountriesModal(), 500);
    }
};

window.closeEditProfileModal = function() {
    if (profileManager) profileManager.closeEditProfileModal();
};

window.closeAddPlaceModal = function() {
    if (profileManager) profileManager.closeAddPlaceModal();
};

window.closeCountriesModal = function() {
    if (profileManager) profileManager.closeCountriesModal();
};

window.openFullMap = function() {
    window.location.href = '/map';
};

window.logout = function() {
    localStorage.removeItem('token');
    window.location.href = '/map';
};

// Initialize ProfileManager when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
    console.log('📋 Initializing ProfileManager...');
    try {
        profileManager = new ProfileManager();
        window.profileManager = profileManager;
        console.log('✅ ProfileManager ready');
    } catch (error) {
        console.error('❌ ProfileManager failed:', error);
    }
});