/**
 * TravelMate - Main Application
 * Modern travel planning application with improved error handling and validation
 */

class TravelMateApp {
    constructor() {
        // Global state
        this.currentUser = null;
        this.authToken = null;
        this.isAuthMode = 'login';
        this.isModalOperationInProgress = false;

        // Map state
        this.map = null;
        this.markers = [];
        this.startPoint = null;
        this.endPoint = null;
        this.routeStartMarker = null;
        this.routeEndMarker = null;
        this.routeLine = null;
        this.currentRoutes = [];

        // Error handler
        this.errorHandler = new ErrorHandler();

        // API client
        this.api = new APIClient();

        // Initialize
        this.init();
    }

    async init() {
        try {
            CONFIG.info('Initializing TravelMate application...');

            await this.initializeMap();
            this.initializePlacesManager();
            this.checkAuthStatus();
            this.setupEventListeners();

            CONFIG.info('Application initialized successfully');
        } catch (error) {
            this.errorHandler.handle(error, 'Failed to initialize application');
        }
    }

    initializePlacesManager() {
        // Initialize places manager if available
        if (typeof MapPlacesManager !== 'undefined') {
            this.placesManager = new MapPlacesManager(this);
        }
    }

    // Map initialization
    initializeMap() {
        try {
            this.map = L.map('map').setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors'
            }).addTo(this.map);

            // Add welcome marker
            const [lat, lng] = CONFIG.MAP_CENTER;
            const welcomeMarker = L.marker([lat, lng])
                .addTo(this.map)
                .bindPopup('<b>Belgrade, Serbia</b><br>Welcome to TravelMate!')
                .openPopup();

            // Map click handler
            this.map.on('click', (e) => this.handleMapClick(e));

            CONFIG.debug('Map initialized successfully');
        } catch (error) {
            throw new Error(`Map initialization failed: ${error.message}`);
        }
    }

    // Authentication status check
    async checkAuthStatus() {
        try {
            this.authToken = localStorage.getItem('token');

            if (this.authToken) {
                await this.validateToken();
            } else {
                this.showGuestMode();
            }
        } catch (error) {
            CONFIG.error('Auth status check failed:', error);
            this.showGuestMode();
        }
    }

    // Token validation
    async validateToken() {
        try {
            const response = await this.api.get('/auth/me');
            this.setAuthenticatedUser(response);
        } catch (error) {
            CONFIG.warn('Token validation failed, clearing auth');
            localStorage.removeItem('token');
            this.showGuestMode();
        }
    }

    // Event listeners setup
    setupEventListeners() {
        // Auth forms
        document.getElementById('loginForm').addEventListener('submit', (e) => this.handleLogin(e));
        document.getElementById('registerForm').addEventListener('submit', (e) => this.handleRegister(e));

        // Modal handlers - only close if clicking on overlay background
        document.getElementById('authModal').addEventListener('click', (e) => {
            // Only close if clicking directly on the overlay background (not on modal content)
            if (e.target.classList.contains('modal-overlay') && !e.target.closest('.auth-modal')) {
                this.closeAuthModal();
            }
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.closeAuthModal();
        });

        // Mobile overlay handler
        document.addEventListener('click', (e) => this.handleMobileOverlayClick(e));

        CONFIG.debug('Event listeners set up');
    }

    // Authentication handlers
    async handleLogin(e) {
        e.preventDefault();

        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value;

        // Validation
        if (!this.validateEmail(email)) {
            this.showStatus('Please enter a valid email address', 'error');
            return;
        }

        if (!password) {
            this.showStatus('Password is required', 'error');
            return;
        }

        try {
            this.showStatus('Signing in...', 'info');

            const params = new URLSearchParams();
            params.append('username', email);
            params.append('password', password);

            console.log('🔍 Login attempt:', { email, password: '***' });

            const response = await this.api.post('/auth/login', params, {
                'Content-Type': 'application/x-www-form-urlencoded'
            });

            console.log('🔐 Login response:', response);
            this.authToken = response.access_token;
            console.log('🔑 Token to save:', this.authToken);
            localStorage.setItem('token', this.authToken);
            console.log('✅ Token saved to localStorage:', localStorage.getItem('token'));

            // Get user info
            const userResponse = await this.api.get('/auth/me');
            this.setAuthenticatedUser(userResponse);
            this.closeAuthModal();
            this.showStatus('Welcome back!', 'success');

        } catch (error) {
            this.errorHandler.handle(error, 'Login failed');
        }
    }

    async handleRegister(e) {
        e.preventDefault();

        const name = document.getElementById('registerName').value.trim();
        const email = document.getElementById('registerEmail').value.trim();
        const password = document.getElementById('registerPassword').value;

        // Validation
        if (!name || name.length < 2) {
            this.showStatus('Name must be at least 2 characters long', 'error');
            return;
        }

        if (!this.validateEmail(email)) {
            this.showStatus('Please enter a valid email address', 'error');
            return;
        }

        if (!this.validatePassword(password)) {
            this.showStatus('Password must be at least 6 characters long', 'error');
            return;
        }

        try {
            this.showStatus('Creating account...', 'info');

            await this.api.post('/auth/register', {
                name,
                email,
                password
            });

            this.showStatus('Account created successfully! Please sign in.', 'success');
            this.toggleAuthMode();
        } catch (error) {
            this.errorHandler.handle(error, 'Registration failed');
        }
    }

    // User state management
    setAuthenticatedUser(user) {
        this.currentUser = user;

        // Update UI
        document.getElementById('loginBtn').style.display = 'none';
        document.getElementById('registerBtn').style.display = 'none';
        document.getElementById('userMenu').style.display = 'flex';
        document.getElementById('userName').textContent = user.name;

        // Hide guest banner
        document.getElementById('guestBanner').style.display = 'none';

        // Enable controls
        this.enableControls();

        // Load user places
        if (this.placesManager) {
            this.placesManager.loadUserPlaces();
        }

        // Auto-open sidebar
        this.toggleSidebar(true);

        CONFIG.info('User authenticated:', user.name);
    }

    showGuestMode() {
        this.currentUser = null;
        this.authToken = null;

        // Update UI
        document.getElementById('loginBtn').style.display = 'inline-flex';
        document.getElementById('registerBtn').style.display = 'inline-flex';
        document.getElementById('userMenu').style.display = 'none';

        // Show guest banner
        document.getElementById('guestBanner').style.display = 'block';

        // Disable controls
        this.disableControls();

        CONFIG.debug('Guest mode activated');
    }

    logout() {
        try {
            localStorage.removeItem('token');
            this.showGuestMode();
            this.clearRouteDisplay();
            this.clearMap();
            this.showStatus('You have been signed out', 'info');
        } catch (error) {
            console.warn('Logout error (safe to ignore if from browser extension):', error);
            // Принудительный logout
            localStorage.removeItem('token');
            window.location.reload();
        }
    }

    // Control state management
    enableControls() {
        const controls = ['searchInput', 'transportMode', 'routeName', 'routeDescription', 'realRouteBtn', 'createRouteBtn'];
        controls.forEach(id => {
            const element = document.getElementById(id);
            if (element) element.disabled = false;
        });

        const buttons = document.querySelectorAll('[onclick*="searchPlace"], [onclick*="loadRoutes"]');
        buttons.forEach(btn => btn.disabled = false);

        // Enable places manager controls
        if (this.placesManager) {
            this.placesManager.enableControls();
        }
    }

    disableControls() {
        const controls = ['searchInput', 'transportMode', 'routeName', 'routeDescription', 'realRouteBtn', 'createRouteBtn'];
        controls.forEach(id => {
            const element = document.getElementById(id);
            if (element) element.disabled = true;
        });

        const buttons = document.querySelectorAll('[onclick*="searchPlace"], [onclick*="loadRoutes"]');
        buttons.forEach(btn => btn.disabled = true);

        // Disable places manager controls
        if (this.placesManager) {
            this.placesManager.disableControls();
        }
    }

    // UI helpers
    toggleSidebar(forceOpen = false) {
        const sidebar = document.getElementById('sidebar');
        const toggle = document.getElementById('sidebarToggle');

        if (forceOpen || !sidebar.classList.contains('open')) {
            sidebar.classList.add('open');
            toggle.innerHTML = '<i class="fas fa-times"></i>';
        } else {
            sidebar.classList.remove('open');
            toggle.innerHTML = '<i class="fas fa-bars"></i>';

            // Trigger map resize after sidebar closes
            setTimeout(() => {
                if (this.map) {
                    this.map.invalidateSize();
                }
            }, 300);
        }
    }

    showAuthModal(mode = 'login') {
        try {
            console.log('showAuthModal method called with mode:', mode);

            // Check if toggleBtn exists before we start
            const preCheckToggleBtn = document.getElementById('authToggleBtn');
            console.log('Pre-check toggleBtn exists:', !!preCheckToggleBtn);

        this.isAuthMode = mode;

        const modal = document.getElementById('authModal');
        const title = document.getElementById('authTitle');
        const subtitle = document.getElementById('authSubtitle');
        const loginForm = document.getElementById('loginForm');
        const registerForm = document.getElementById('registerForm');
        const toggleText = document.getElementById('authToggleText');
        const toggleBtn = document.getElementById('authToggleBtn');

        // Check if all required elements exist
        console.log('Checking modal elements...');
        console.log('modal:', modal);
        console.log('title:', title);
        console.log('subtitle:', subtitle);
        console.log('loginForm:', loginForm);
        console.log('registerForm:', registerForm);
        console.log('toggleText:', toggleText);
        console.log('toggleBtn:', toggleBtn);

        const elements = { modal, title, subtitle, loginForm, registerForm, toggleText, toggleBtn };
        for (const [name, element] of Object.entries(elements)) {
            if (!element) {
                console.error(`Element ${name} not found`);
                return;
            }
        }

        console.log('All modal elements found successfully');

        if (mode === 'login') {
            if (title) title.textContent = 'Welcome Back';
            if (subtitle) subtitle.textContent = 'Sign in to your account';
            if (loginForm) loginForm.style.display = 'flex';
            if (registerForm) registerForm.style.display = 'none';
            if (toggleText) {
                // Preserve the button by only changing text content, not innerHTML
                const textNode = toggleText.firstChild;
                if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                    textNode.textContent = 'Don\'t have an account? ';
                }
            }
            if (toggleBtn) toggleBtn.textContent = 'Sign up';
        } else {
            if (title) title.textContent = 'Create Account';
            if (subtitle) subtitle.textContent = 'Join TravelMate today';
            if (loginForm) loginForm.style.display = 'none';
            if (registerForm) registerForm.style.display = 'flex';
            if (toggleText) {
                // Preserve the button by only changing text content, not innerHTML
                const textNode = toggleText.firstChild;
                if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                    textNode.textContent = 'Already have an account? ';
                }
            }
            if (toggleBtn) toggleBtn.textContent = 'Sign in';
        }

        modal.classList.add('active');
        console.log('Modal opened successfully in mode:', mode);

        // Temporarily disabled
        // setTimeout(() => {
        //     this.isModalOperationInProgress = false;
        // }, 500);
        } catch (error) {
            console.warn('Auth modal error (safe to ignore if from browser extension):', error);
            // Fallback: просто показываем модал без сложной логики
            try {
                const modal = document.getElementById('authModal');
                if (modal) {
                    modal.style.display = 'flex';
                }
            } catch (fallbackError) {
                console.error('Critical modal error:', fallbackError);
            }
        }
    }

    closeAuthModal() {
        console.log('closeAuthModal called');

        const modal = document.getElementById('authModal');

        if (!modal) {
            console.error('Auth modal not found');
            return;
        }

        // Check if modal is actually open
        if (!modal.classList.contains('active')) {
            console.log('Modal is already closed, skipping');
            return;
        }

        console.log('Closing modal...');

        // Check toggleBtn before any operations
        const toggleBtnBefore = document.getElementById('authToggleBtn');
        console.log('toggleBtn before operations:', toggleBtnBefore);

        modal.classList.remove('active');

        // Clear all input fields in the modal
        const modalInputs = modal.querySelectorAll('input');
        console.log('Found input fields:', modalInputs.length);
        modalInputs.forEach(input => {
            console.log('Clearing input:', input.id, input.type);
            input.value = '';
        });

        // Check toggleBtn after clearing inputs
        const toggleBtnAfter = document.getElementById('authToggleBtn');
        console.log('toggleBtn after clearing inputs:', toggleBtnAfter);

        // Reset mode to default
        this.isAuthMode = 'login';

        // Reset any operation flags
        this.isModalOperationInProgress = false;

        console.log('Auth modal closed successfully');
    }

    toggleAuthMode() {
        this.isAuthMode = this.isAuthMode === 'login' ? 'register' : 'login';
        this.showAuthModal(this.isAuthMode);
    }

    showStatus(message, type = 'info') {
        const statusElement = document.getElementById('statusMessage');
        statusElement.textContent = message;
        statusElement.className = `status-message ${type} show`;

        setTimeout(() => {
            statusElement.classList.remove('show');
        }, 4000);

        CONFIG.debug('Status message:', message, type);
    }

    // Mobile overlay handler
    handleMobileOverlayClick(e) {
        const mapContainer = document.querySelector('.map-container');
        const sidebar = document.getElementById('sidebar');

        if (window.innerWidth <= 768 && sidebar.classList.contains('open')) {
            const rect = mapContainer.getBoundingClientRect();
            const isClickOnOverlay = e.clientX >= rect.left && e.clientX <= rect.right &&
                                   e.clientY >= rect.top && e.clientY <= rect.bottom;

            if (isClickOnOverlay && !sidebar.contains(e.target)) {
                this.toggleSidebar();
            }
        }
    }

    // Validation helpers
    validateEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    validatePassword(password) {
        return password && password.length >= 6;
    }

    // Map interaction methods
    handleMapClick(e) {
        if (!this.currentUser) {
            this.showAuthModal('login');
            this.showStatus('Please sign in to add places', 'error');
            return;
        }

        // Check if places manager is in add place mode
        if (this.placesManager && this.placesManager.addPlaceMode) {
            // Let places manager handle the click
            return;
        }

        const lat = parseFloat(e.latlng.lat.toFixed(6));
        const lng = parseFloat(e.latlng.lng.toFixed(6));

        // Directly open add place modal with coordinates
        if (this.placesManager) {
            this.placesManager.clickedCoordinates = { lat, lng };
            this.placesManager.showQuickAddPlaceModal();
        }
    }

    // Route point setters
    setAsStartPoint(lat, lng, markerId) {
        if (this.routeStartMarker) {
            this.map.removeLayer(this.routeStartMarker);
        }

        this.startPoint = {
            latitude: parseFloat(lat),
            longitude: parseFloat(lng),
            name: `Start (${lat}, ${lng})`
        };

        this.routeStartMarker = L.marker([lat, lng], {
            icon: L.icon({
                iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-green.png',
                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowSize: [41, 41]
            })
        }).addTo(this.map).bindPopup(`
            <div style="text-align: center;">
                <strong>🟢 Start Point</strong><br>
                <button onclick="app.clearStartPoint()" style="background: #ef4444; color: white; border: none; padding: 6px 10px; border-radius: 4px; cursor: pointer; margin-top: 5px;">
                    ❌ Remove
                </button>
            </div>
        `);

        this.deleteClickedMarker(markerId);
        this.showStatus('Start point set!', 'success');
        this.checkRouteReady();
    }

    setAsEndPoint(lat, lng, markerId) {
        if (this.routeEndMarker) {
            this.map.removeLayer(this.routeEndMarker);
        }

        this.endPoint = {
            latitude: parseFloat(lat),
            longitude: parseFloat(lng),
            name: `End (${lat}, ${lng})`
        };

        this.routeEndMarker = L.marker([lat, lng], {
            icon: L.icon({
                iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowSize: [41, 41]
            })
        }).addTo(this.map).bindPopup(`
            <div style="text-align: center;">
                <strong>🔴 End Point</strong><br>
                <button onclick="app.clearEndPoint()" style="background: #ef4444; color: white; border: none; padding: 6px 10px; border-radius: 4px; cursor: pointer; margin-top: 5px;">
                    ❌ Remove
                </button>
            </div>
        `);

        this.deleteClickedMarker(markerId);
        this.showStatus('End point set!', 'success');
        this.checkRouteReady();
    }

    // Cleanup methods
    deleteClickedMarker(markerId) {
        const markerIndex = this.markers.findIndex(marker => marker._markerId === markerId);
        if (markerIndex !== -1) {
            const marker = this.markers[markerIndex];
            this.map.removeLayer(marker);
            this.markers.splice(markerIndex, 1);
        }
    }

    clearStartPoint() {
        if (this.routeStartMarker) {
            this.map.removeLayer(this.routeStartMarker);
            this.routeStartMarker = null;
        }
        if (this.routeLine) {
            this.map.removeLayer(this.routeLine);
            this.routeLine = null;
        }
        this.startPoint = null;
        this.showStatus('Start point removed', 'info');
        this.checkRouteReady();
    }

    clearEndPoint() {
        if (this.routeEndMarker) {
            this.map.removeLayer(this.routeEndMarker);
            this.routeEndMarker = null;
        }
        if (this.routeLine) {
            this.map.removeLayer(this.routeLine);
            this.routeLine = null;
        }
        this.endPoint = null;
        this.showStatus('End point removed', 'info');
        this.checkRouteReady();
    }

    clearRouteDisplay() {
        if (this.routeStartMarker) {
            this.map.removeLayer(this.routeStartMarker);
            this.routeStartMarker = null;
        }
        if (this.routeEndMarker) {
            this.map.removeLayer(this.routeEndMarker);
            this.routeEndMarker = null;
        }
        if (this.routeLine) {
            this.map.removeLayer(this.routeLine);
            this.routeLine = null;
        }
        this.startPoint = null;
        this.endPoint = null;
        this.checkRouteReady();
    }

    clearMap() {
        this.markers.forEach(marker => this.map.removeLayer(marker));
        this.markers = [];
        this.clearRouteDisplay();
        this.showStatus('Map cleared', 'info');
    }

    centerMap() {
        this.map.setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);
    }

    checkRouteReady() {
        const createBtn = document.getElementById('createRouteBtn');
        const realRouteBtn = document.getElementById('realRouteBtn');

        if (this.startPoint && this.endPoint) {
            createBtn.disabled = false;
            realRouteBtn.disabled = false;
        } else {
            createBtn.disabled = true;
            realRouteBtn.disabled = true;
        }
    }

    // Map point setters (used by context menu)
    setStartPoint(lat, lng) {
        this.startPoint = { lat, lng };
        console.log('Start point set:', this.startPoint);

        // Remove existing start marker
        if (this.routeStartMarker) {
            this.map.removeLayer(this.routeStartMarker);
        }

        // Add new start marker
        this.routeStartMarker = L.marker([lat, lng], {
            icon: L.icon({
                iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowSize: [41, 41]
            })
        }).addTo(this.map);

        this.routeStartMarker.bindPopup('Start Point').openPopup();
        this.updateCreateRouteButton();
        this.checkRouteReady();
        this.showStatus('Start point set', 'success');
    }

    setEndPoint(lat, lng) {
        this.endPoint = { lat, lng };
        console.log('End point set:', this.endPoint);

        // Remove existing end marker
        if (this.routeEndMarker) {
            this.map.removeLayer(this.routeEndMarker);
        }

        // Add new end marker
        this.routeEndMarker = L.marker([lat, lng], {
            icon: L.icon({
                iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowSize: [41, 41]
            })
        }).addTo(this.map);

        this.routeEndMarker.bindPopup('End Point').openPopup();
        this.updateCreateRouteButton();
        this.checkRouteReady();
        this.showStatus('End point set', 'success');
    }

    // Calculate route between start and end points
    async calculateRoute() {
        console.log('calculateRoute called', { startPoint: this.startPoint, endPoint: this.endPoint });

        if (!this.startPoint || !this.endPoint) {
            this.showStatus('Please set both start and end points', 'error');
            return;
        }

        try {
            // Remove existing route line
            if (this.routeLine) {
                this.map.removeLayer(this.routeLine);
            }

            // Show loading
            showNotification('Calculating route...', 'info');

            // Use OpenRouteService or GraphHopper for routing
            const transportMode = document.getElementById('transportMode')?.value || 'driving-car';

            // Convert transport mode for routing service
            const profile = this.getRoutingProfile(transportMode);

            // Calculate route using OSRM (free routing service)
            const response = await fetch(
                `https://router.project-osrm.org/route/v1/${profile}/${this.startPoint.lng},${this.startPoint.lat};${this.endPoint.lng},${this.endPoint.lat}?overview=full&geometries=geojson`
            );

            if (!response.ok) {
                throw new Error('Failed to calculate route');
            }

            const data = await response.json();

            if (data.routes && data.routes.length > 0) {
                const route = data.routes[0];
                const coordinates = route.geometry.coordinates.map(coord => [coord[1], coord[0]]);

                // Draw route on map
                this.routeLine = L.polyline(coordinates, {
                    color: '#2196F3',
                    weight: 5,
                    opacity: 0.8,
                    lineJoin: 'round'
                }).addTo(this.map);

                // Fit map to show the entire route
                const group = new L.featureGroup([this.routeStartMarker, this.routeEndMarker, this.routeLine]);
                this.map.fitBounds(group.getBounds(), { padding: [20, 20] });

                // Show route info
                const distance = (route.distance / 1000).toFixed(1); // km
                const duration = Math.round(route.duration / 60); // minutes

                this.showStatus(`Route calculated: ${distance} km, ~${duration} min`, 'success');
            } else {
                throw new Error('No route found');
            }

        } catch (error) {
            console.error('Route calculation failed:', error);
            this.showStatus('Failed to calculate route. Please try again.', 'error');
        }
    }

    // Update the create route button state
    updateCreateRouteButton() {
        const createRouteBtn = document.getElementById('createRouteBtn');
        if (!createRouteBtn) return;

        if (this.startPoint && this.endPoint) {
            createRouteBtn.disabled = false;
            createRouteBtn.textContent = 'Calculate Route';
            createRouteBtn.classList.remove('disabled');
        } else {
            createRouteBtn.disabled = true;
            createRouteBtn.textContent = this.startPoint ? 'Set End Point' : 'Set Start Point';
            createRouteBtn.classList.add('disabled');
        }
    }

    // Convert transport mode to routing profile
    getRoutingProfile(mode) {
        const profiles = {
            'driving-car': 'driving',
            'cycling-regular': 'cycling',
            'foot-walking': 'walking'
        };
        return profiles[mode] || 'driving';
    }
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    window.app = new TravelMateApp();

    // Expose global functions for onclick handlers after app is initialized
    window.toggleSidebar = (forceOpen) => {
        window.app.toggleSidebar(forceOpen);
    };

    window.showAuthModal = (mode) => {
        console.log('=== GLOBAL showAuthModal called ===');
        console.log('Mode:', mode);
        console.log('window.app exists:', !!window.app);
        console.log('DOM state:', document.readyState);
        console.log('Function still exists:', typeof window.showAuthModal);

        if (!window.app) {
            console.error('window.app is not available!');
            console.error('Attempting to initialize app...');

            // Try to re-initialize if needed
            if (typeof TravelMateApp !== 'undefined') {
                window.app = new TravelMateApp();
                console.log('App re-initialized');
            } else {
                console.error('TravelMateApp class not available');
                return false;
            }
        }

        try {
            console.log('Calling window.app.showAuthModal...');
            const result = window.app.showAuthModal(mode);
            console.log('showAuthModal result:', result);
            return result;
        } catch (error) {
            console.error('Error in showAuthModal:', error);
            return false;
        }
    };

    window.closeAuthModal = () => {
        console.log('=== GLOBAL closeAuthModal called ===');
        if (window.app) {
            window.app.closeAuthModal();
        } else {
            console.error('window.app not available for closeAuthModal');
        }
    };

    window.toggleAuthMode = () => {
        window.app.toggleAuthMode();
    };

    window.logout = () => {
        window.app.logout();
    };

    window.clearMap = () => {
        window.app.clearMap();
    };

    window.centerMap = () => {
        window.app.centerMap();
    };

    console.log('TravelMateApp initialized and global functions exposed');

    // Add alternative event listeners as backup
    const loginBtn = document.getElementById('loginBtn');
    const registerBtn = document.getElementById('registerBtn');

    if (loginBtn) {
        console.log('Setting up alternative click listener for loginBtn');

        // Remove any existing onclick to avoid conflicts
        loginBtn.removeAttribute('onclick');

        loginBtn.addEventListener('click', function(e) {
            console.log('=== loginBtn clicked via addEventListener ===');
            console.log('Event object:', e);
            console.log('Target:', e.target);
            console.log('CurrentTarget:', e.currentTarget);

            e.preventDefault();
            e.stopPropagation();

            try {
                window.showAuthModal('login');
            } catch (error) {
                console.error('Error calling showAuthModal from loginBtn:', error);
            }
        }, true); // Use capture phase
    }

    if (registerBtn) {
        console.log('Setting up alternative click listener for registerBtn');

        // Remove any existing onclick to avoid conflicts
        registerBtn.removeAttribute('onclick');

        registerBtn.addEventListener('click', function(e) {
            console.log('=== registerBtn clicked via addEventListener ===');
            console.log('Event object:', e);
            console.log('Target:', e.target);
            console.log('CurrentTarget:', e.currentTarget);

            e.preventDefault();
            e.stopPropagation();

            try {
                window.showAuthModal('register');
            } catch (error) {
                console.error('Error calling showAuthModal from registerBtn:', error);
            }
        }, true); // Use capture phase
    }

    // Add debugging function
    window.debugButtons = function() {
        const loginBtn = document.getElementById('loginBtn');
        const registerBtn = document.getElementById('registerBtn');

        console.log('=== Button Debug Info ===');
        console.log('loginBtn exists:', !!loginBtn);
        console.log('loginBtn onclick:', loginBtn?.onclick);
        console.log('loginBtn getAttribute onclick:', loginBtn?.getAttribute('onclick'));
        console.log('loginBtn disabled:', loginBtn?.disabled);
        console.log('loginBtn style.display:', loginBtn?.style.display);
        console.log('loginBtn computed display:', window.getComputedStyle(loginBtn)?.display);
        console.log('loginBtn parentElement:', loginBtn?.parentElement);

        console.log('registerBtn exists:', !!registerBtn);
        console.log('registerBtn onclick:', registerBtn?.onclick);
        console.log('registerBtn getAttribute onclick:', registerBtn?.getAttribute('onclick'));
        console.log('registerBtn disabled:', registerBtn?.disabled);
        console.log('registerBtn style.display:', registerBtn?.style.display);
        console.log('registerBtn computed display:', window.getComputedStyle(registerBtn)?.display);
        console.log('registerBtn parentElement:', registerBtn?.parentElement);

        console.log('window.showAuthModal exists:', typeof window.showAuthModal);
        console.log('window.app exists:', !!window.app);

        // Test manual click simulation
        console.log('Attempting manual click simulation...');
        if (loginBtn) {
            try {
                window.showAuthModal('login');
                console.log('Manual showAuthModal call succeeded');
            } catch (error) {
                console.error('Manual showAuthModal call failed:', error);
            }
        }

        return { loginBtn, registerBtn };
    };

    // Add function to manually trigger events
    window.testButton = function(buttonId) {
        const btn = document.getElementById(buttonId);
        if (btn) {
            console.log(`Testing button: ${buttonId}`);
            btn.click();
        } else {
            console.error(`Button ${buttonId} not found`);
        }
    };
});