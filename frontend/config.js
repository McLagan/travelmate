/**
 * TravelMate - Frontend Configuration
 * Environment-based configuration management
 */

class Config {
    constructor() {
        // Detect environment
        this.environment = this.detectEnvironment();

        // Load configuration based on environment
        this.loadConfig();
    }

    detectEnvironment() {
        const hostname = window.location.hostname;
        const port = window.location.port;

        if (hostname === 'localhost' || hostname === '127.0.0.1') {
            return 'development';
        } else if (hostname.includes('staging') || hostname.includes('dev')) {
            return 'staging';
        } else {
            return 'production';
        }
    }

    loadConfig() {
        const configs = {
            development: {
                API_BASE_URL: 'http://localhost:8088',
                APP_NAME: 'TravelMate (Dev)',
                DEBUG: true,
                LOG_LEVEL: 'debug',
                MAP_CENTER: [44.8176, 20.4633], // Belgrade, Serbia
                MAP_ZOOM: 10,
                DEFAULT_LOCALE: 'en',
                CACHE_DURATION: 5 * 60 * 1000, // 5 minutes
                REQUEST_TIMEOUT: 10000, // 10 seconds
                RATE_LIMIT: {
                    search: 10, // requests per minute
                    routes: 20
                },
                FEATURES: {
                    offline: false,
                    analytics: false,
                    push_notifications: false
                }
            },
            staging: {
                API_BASE_URL: 'https://api-staging.travelmate.app',
                APP_NAME: 'TravelMate (Staging)',
                DEBUG: true,
                LOG_LEVEL: 'info',
                MAP_CENTER: [44.8176, 20.4633],
                MAP_ZOOM: 10,
                DEFAULT_LOCALE: 'en',
                CACHE_DURATION: 15 * 60 * 1000, // 15 minutes
                REQUEST_TIMEOUT: 8000,
                RATE_LIMIT: {
                    search: 15,
                    routes: 30
                },
                FEATURES: {
                    offline: true,
                    analytics: false,
                    push_notifications: true
                }
            },
            production: {
                API_BASE_URL: 'https://api.travelmate.app',
                APP_NAME: 'TravelMate',
                DEBUG: false,
                LOG_LEVEL: 'error',
                MAP_CENTER: [44.8176, 20.4633],
                MAP_ZOOM: 10,
                DEFAULT_LOCALE: 'en',
                CACHE_DURATION: 30 * 60 * 1000, // 30 minutes
                REQUEST_TIMEOUT: 5000,
                RATE_LIMIT: {
                    search: 20,
                    routes: 50
                },
                FEATURES: {
                    offline: true,
                    analytics: true,
                    push_notifications: true
                }
            }
        };

        // Merge configuration
        Object.assign(this, configs[this.environment]);

        // Override with URL parameters if in development
        if (this.DEBUG) {
            this.overrideFromURL();
        }
    }

    overrideFromURL() {
        const urlParams = new URLSearchParams(window.location.search);

        // Allow API URL override via ?api=http://localhost:8080
        if (urlParams.has('api')) {
            this.API_BASE_URL = urlParams.get('api');
            console.log(`🔧 API URL overridden to: ${this.API_BASE_URL}`);
        }

        // Allow debug override via ?debug=true
        if (urlParams.has('debug')) {
            this.DEBUG = urlParams.get('debug') === 'true';
            console.log(`🔧 Debug mode: ${this.DEBUG}`);
        }
    }

    // Logging methods
    log(level, message, ...args) {
        if (!this.DEBUG && level === 'debug') return;

        const levels = { debug: 0, info: 1, warn: 2, error: 3 };
        const currentLevel = levels[this.LOG_LEVEL] || 1;

        if (levels[level] >= currentLevel) {
            console[level](`[TravelMate] ${message}`, ...args);
        }
    }

    debug(message, ...args) {
        this.log('debug', message, ...args);
    }

    info(message, ...args) {
        this.log('info', message, ...args);
    }

    warn(message, ...args) {
        this.log('warn', message, ...args);
    }

    error(message, ...args) {
        this.log('error', message, ...args);
    }

    // Feature flags
    isFeatureEnabled(feature) {
        return this.FEATURES[feature] || false;
    }

    // API endpoints
    getEndpoint(path) {
        return `${this.API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
    }

    // Storage helpers
    getStorageKey(key) {
        return `travelmate_${this.environment}_${key}`;
    }

    // Rate limiting
    checkRateLimit(type) {
        const key = this.getStorageKey(`rate_limit_${type}`);
        const now = Date.now();
        const data = JSON.parse(localStorage.getItem(key) || '{"count": 0, "timestamp": 0}');

        // Reset if minute passed
        if (now - data.timestamp > 60000) {
            data.count = 0;
            data.timestamp = now;
        }

        // Check limit
        if (data.count >= this.RATE_LIMIT[type]) {
            return false;
        }

        // Increment
        data.count++;
        localStorage.setItem(key, JSON.stringify(data));
        return true;
    }
}

// Global configuration instance
window.CONFIG = new Config();

// Log configuration on load
if (window.CONFIG.DEBUG) {
    console.log('🚀 TravelMate Configuration:', {
        environment: window.CONFIG.environment,
        apiUrl: window.CONFIG.API_BASE_URL,
        debug: window.CONFIG.DEBUG,
        features: window.CONFIG.FEATURES
    });
}