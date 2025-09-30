/**
 * TravelMate - Utility Classes
 * Error handling, API client, and other utilities
 */

/**
 * Enhanced Error Handler
 */
class ErrorHandler {
    constructor() {
        this.errorLog = [];
        this.maxLogSize = 100;
    }

    handle(error, context = 'Unknown', showToUser = true) {
        const errorInfo = {
            timestamp: new Date().toISOString(),
            context,
            message: error.message || 'Unknown error',
            stack: error.stack,
            type: error.constructor.name,
            userAgent: navigator.userAgent,
            url: window.location.href
        };

        // Log error
        this.log(errorInfo);

        // Show to user if requested
        if (showToUser) {
            this.showUserFriendlyError(error, context);
        }

        // Send to backend in production
        if (CONFIG.environment === 'production') {
            this.reportError(errorInfo);
        }

        CONFIG.error('Error handled:', errorInfo);
    }

    log(errorInfo) {
        this.errorLog.unshift(errorInfo);
        if (this.errorLog.length > this.maxLogSize) {
            this.errorLog.pop();
        }

        // Store in localStorage for debugging
        try {
            localStorage.setItem(
                CONFIG.getStorageKey('error_log'),
                JSON.stringify(this.errorLog.slice(0, 10))
            );
        } catch (e) {
            console.warn('Failed to store error log:', e);
        }
    }

    showUserFriendlyError(error, context) {
        let message = 'An unexpected error occurred';

        // Network errors
        if (error.name === 'TypeError' && error.message.includes('fetch')) {
            message = 'Network connection failed. Please check your internet connection.';
        } else if (error.message.includes('timeout')) {
            message = 'Request timed out. Please try again.';
        } else if (error.message.includes('401')) {
            message = 'Your session has expired. Please sign in again.';
        } else if (error.message.includes('403')) {
            message = 'You don\'t have permission to perform this action.';
        } else if (error.message.includes('404')) {
            message = 'The requested resource was not found.';
        } else if (error.message.includes('500')) {
            message = 'Server error. Please try again later.';
        } else if (context === 'Login failed') {
            message = 'Invalid email or password. Please try again.';
        } else if (context === 'Registration failed') {
            message = 'Registration failed. Please check your information and try again.';
        } else if (context.includes('Route')) {
            message = 'Route operation failed. Please try again.';
        } else if (context.includes('Search')) {
            message = 'Search failed. Please try again.';
        }

        // Show status message
        if (window.app) {
            window.app.showStatus(message, 'error');
        } else {
            alert(message);
        }
    }

    async reportError(errorInfo) {
        try {
            await fetch(CONFIG.getEndpoint('/error-report'), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(errorInfo)
            });
        } catch (e) {
            console.warn('Failed to report error:', e);
        }
    }

    getErrorLog() {
        return [...this.errorLog];
    }

    clearErrorLog() {
        this.errorLog = [];
        localStorage.removeItem(CONFIG.getStorageKey('error_log'));
    }
}

/**
 * Enhanced API Client with retry, caching, and rate limiting
 */
class APIClient {
    constructor() {
        this.cache = new Map();
        this.requestQueue = [];
        this.isProcessingQueue = false;
    }

    async request(method, endpoint, data = null, headers = {}) {
        // Check rate limiting
        const operationType = this.getOperationType(endpoint);
        if (!CONFIG.checkRateLimit(operationType)) {
            throw new Error(`Rate limit exceeded for ${operationType}. Please wait a moment.`);
        }

        // Build request configuration
        const config = {
            method: method.toUpperCase(),
            headers: {
                'Content-Type': 'application/json',
                ...headers
            }
        };

        // Add auth token if available
        if (window.app?.authToken) {
            config.headers['Authorization'] = `Bearer ${window.app.authToken}`;
        }

        // Add data for non-GET requests
        if (data && method !== 'GET') {
            if (data instanceof FormData) {
                delete config.headers['Content-Type']; // Let browser set it
                config.body = data;
            } else if (data instanceof URLSearchParams) {
                config.body = data;
            } else {
                config.body = JSON.stringify(data);
            }
        }

        const url = CONFIG.getEndpoint(endpoint);
        const cacheKey = `${method}:${url}:${JSON.stringify(data)}`;

        // Check cache for GET requests
        if (method === 'GET' && this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            if (Date.now() - cached.timestamp < CONFIG.CACHE_DURATION) {
                CONFIG.debug('Cache hit:', endpoint);
                return cached.data;
            }
        }

        try {
            CONFIG.debug('API Request:', method, endpoint, data);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);

            const response = await fetch(url, {
                ...config,
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();

            // Cache successful GET requests
            if (method === 'GET') {
                this.cache.set(cacheKey, {
                    data: result,
                    timestamp: Date.now()
                });
            }

            CONFIG.debug('API Response:', result);
            return result;

        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Request timeout');
            }
            throw error;
        }
    }

    async get(endpoint, params = {}) {
        const query = new URLSearchParams(params).toString();
        const url = query ? `${endpoint}?${query}` : endpoint;
        return this.request('GET', url);
    }

    async post(endpoint, data, headers = {}) {
        return this.request('POST', endpoint, data, headers);
    }

    async put(endpoint, data) {
        return this.request('PUT', endpoint, data);
    }

    async delete(endpoint) {
        return this.request('DELETE', endpoint);
    }

    getOperationType(endpoint) {
        if (endpoint.includes('/locations/search')) return 'search';
        if (endpoint.includes('/routes')) return 'routes';
        return 'general';
    }

    clearCache() {
        this.cache.clear();
        CONFIG.debug('API cache cleared');
    }

    getCacheStats() {
        return {
            size: this.cache.size,
            keys: Array.from(this.cache.keys())
        };
    }
}

/**
 * Local Storage Manager
 */
class StorageManager {
    static set(key, value, ttl = null) {
        try {
            const item = {
                value,
                timestamp: Date.now(),
                ttl
            };
            localStorage.setItem(CONFIG.getStorageKey(key), JSON.stringify(item));
            return true;
        } catch (error) {
            CONFIG.warn('Failed to save to localStorage:', error);
            return false;
        }
    }

    static get(key) {
        try {
            const stored = localStorage.getItem(CONFIG.getStorageKey(key));
            if (!stored) return null;

            const item = JSON.parse(stored);

            // Check TTL
            if (item.ttl && Date.now() - item.timestamp > item.ttl) {
                StorageManager.remove(key);
                return null;
            }

            return item.value;
        } catch (error) {
            CONFIG.warn('Failed to read from localStorage:', error);
            return null;
        }
    }

    static remove(key) {
        try {
            localStorage.removeItem(CONFIG.getStorageKey(key));
            return true;
        } catch (error) {
            CONFIG.warn('Failed to remove from localStorage:', error);
            return false;
        }
    }

    static clear() {
        try {
            const keys = Object.keys(localStorage);
            const prefix = CONFIG.getStorageKey('');

            keys.forEach(key => {
                if (key.startsWith(prefix)) {
                    localStorage.removeItem(key);
                }
            });

            return true;
        } catch (error) {
            CONFIG.warn('Failed to clear localStorage:', error);
            return false;
        }
    }

    static getUsage() {
        let total = 0;
        const keys = Object.keys(localStorage);
        const prefix = CONFIG.getStorageKey('');

        keys.forEach(key => {
            if (key.startsWith(prefix)) {
                total += localStorage.getItem(key).length;
            }
        });

        return {
            used: total,
            keys: keys.filter(k => k.startsWith(prefix)).length
        };
    }
}

/**
 * Debounce utility
 */
function debounce(func, wait, immediate = false) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            timeout = null;
            if (!immediate) func.apply(this, args);
        };
        const callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) func.apply(this, args);
    };
}

/**
 * Throttle utility
 */
function throttle(func, limit) {
    let inThrottle;
    return function() {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

/**
 * Format utilities
 */
class Formatter {
    static distance(km) {
        if (km < 1) {
            return `${Math.round(km * 1000)} m`;
        } else if (km < 100) {
            return `${km.toFixed(1)} km`;
        } else {
            return `${Math.round(km)} km`;
        }
    }

    static duration(minutes) {
        if (minutes < 60) {
            return `${Math.round(minutes)} min`;
        } else {
            const hours = Math.floor(minutes / 60);
            const mins = Math.round(minutes % 60);
            return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
        }
    }

    static date(dateString) {
        const date = new Date(dateString);
        return date.toLocaleDateString(CONFIG.DEFAULT_LOCALE, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    static coordinates(lat, lng, precision = 6) {
        return `${lat.toFixed(precision)}, ${lng.toFixed(precision)}`;
    }
}

/**
 * Performance Monitor
 */
class PerformanceMonitor {
    static marks = new Map();

    static start(name) {
        PerformanceMonitor.marks.set(name, performance.now());
    }

    static end(name) {
        const startTime = PerformanceMonitor.marks.get(name);
        if (startTime) {
            const duration = performance.now() - startTime;
            CONFIG.debug(`Performance [${name}]:`, `${duration.toFixed(2)}ms`);
            PerformanceMonitor.marks.delete(name);
            return duration;
        }
        return null;
    }

    static measure(name, fn) {
        PerformanceMonitor.start(name);
        const result = fn();
        PerformanceMonitor.end(name);
        return result;
    }

    static async measureAsync(name, asyncFn) {
        PerformanceMonitor.start(name);
        const result = await asyncFn();
        PerformanceMonitor.end(name);
        return result;
    }
}

// Export utilities to global scope
window.ErrorHandler = ErrorHandler;
window.APIClient = APIClient;
window.StorageManager = StorageManager;
window.debounce = debounce;
window.throttle = throttle;
window.Formatter = Formatter;
window.PerformanceMonitor = PerformanceMonitor;