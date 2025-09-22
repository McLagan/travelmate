/**
 * Navigation utilities with browser extension protection
 * Handles safe navigation and prevents conflicts with browser extensions
 */

// Защищенная навигация
class SafeNavigation {
    constructor() {
        this.isNavigating = false;
        this.init();
    }

    init() {
        // Защита от расширений браузера
        this.setupExtensionProtection();

        // Переопределяем console.error для подавления ошибок расширений
        this.setupConsoleProtection();
    }

    setupExtensionProtection() {
        // Перехватываем и игнорируем ошибки расширений
        window.addEventListener('error', (event) => {
            if (event.message && (
                event.message.includes('Extension context invalidated') ||
                event.message.includes('message channel closed') ||
                event.message.includes('listener indicated an asynchronous response')
            )) {
                event.preventDefault();
                event.stopPropagation();
                return false;
            }
        });

        // Перехватываем unhandled promise rejections
        window.addEventListener('unhandledrejection', (event) => {
            if (event.reason && event.reason.message && (
                event.reason.message.includes('Extension context invalidated') ||
                event.reason.message.includes('message channel closed') ||
                event.reason.message.includes('listener indicated an asynchronous response')
            )) {
                event.preventDefault();
                return false;
            }
        });
    }

    setupConsoleProtection() {
        // Сохраняем оригинальный console.error
        const originalError = console.error;

        console.error = function(...args) {
            // Фильтруем ошибки расширений
            const message = args.join(' ');
            if (message.includes('Extension context invalidated') ||
                message.includes('message channel closed') ||
                message.includes('listener indicated an asynchronous response')) {
                return; // Игнорируем эти ошибки
            }

            // Показываем остальные ошибки
            originalError.apply(console, args);
        };
    }

    // Безопасная навигация на страницу профиля
    async goToProfile() {
        if (this.isNavigating) {
            return; // Предотвращаем множественные клики
        }

        try {
            this.isNavigating = true;

            // Небольшая задержка для предотвращения конфликтов
            await this.delay(100);

            // Используем location.href вместо прямых ссылок
            window.location.href = '/profile';

        } catch (error) {
            console.warn('Navigation error (safe to ignore if from browser extension):', error);
            // Fallback навигация
            try {
                window.location.assign('/profile');
            } catch (fallbackError) {
                // Последний fallback
                window.open('/profile', '_self');
            }
        } finally {
            // Сбрасываем флаг через небольшую задержку
            setTimeout(() => {
                this.isNavigating = false;
            }, 1000);
        }
    }

    // Безопасный logout
    async safeLogout() {
        try {
            if (window.app && typeof window.app.logout === 'function') {
                await this.delay(50);
                window.app.logout();
            } else {
                // Fallback logout
                localStorage.removeItem('token');
                window.location.href = '/map';
            }
        } catch (error) {
            console.warn('Logout error (safe to ignore if from browser extension):', error);
            // Принудительный logout
            localStorage.removeItem('token');
            window.location.reload();
        }
    }

    // Безопасное отображение модала аутентификации
    async safeShowAuthModal(mode = 'login') {
        try {
            await this.delay(50);

            if (window.app && typeof window.app.showAuthModal === 'function') {
                window.app.showAuthModal(mode);
            } else if (window.showAuthModal && typeof window.showAuthModal === 'function') {
                window.showAuthModal(mode);
            } else {
                console.warn('Auth modal function not available');
            }
        } catch (error) {
            console.warn('Auth modal error (safe to ignore if from browser extension):', error);
        }
    }

    // Утилита для задержки
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Защищенная проверка токена
    hasValidToken() {
        try {
            const token = localStorage.getItem('token');
            return token && token.length > 0;
        } catch (error) {
            return false;
        }
    }

    // Безопасная проверка аутентификации
    checkAuthAndRedirect(requiredAuth = true) {
        try {
            const hasToken = this.hasValidToken();

            if (requiredAuth && !hasToken) {
                this.safeShowAuthModal('login');
                return false;
            }

            return true;
        } catch (error) {
            console.warn('Auth check error:', error);
            return !requiredAuth;
        }
    }
}

// Создаем глобальный экземпляр
const safeNav = new SafeNavigation();

// Глобальные функции для использования в HTML
window.goToProfile = function() {
    safeNav.goToProfile();
};

window.logout = function() {
    safeNav.safeLogout();
};

window.showAuthModal = function(mode = 'login') {
    safeNav.safeShowAuthModal(mode);
};

// Переопределяем стандартные обработчики событий для защиты
window.safeAddEventListener = function(element, event, handler, options = {}) {
    if (!element || typeof element.addEventListener !== 'function') {
        return;
    }

    const safeHandler = function(e) {
        try {
            return handler.call(this, e);
        } catch (error) {
            if (error.message && (
                error.message.includes('Extension context invalidated') ||
                error.message.includes('message channel closed')
            )) {
                // Игнорируем ошибки расширений
                return;
            }
            console.error('Event handler error:', error);
        }
    };

    try {
        element.addEventListener(event, safeHandler, options);
    } catch (error) {
        console.warn('Failed to add event listener:', error);
    }
};

// Экспортируем для использования в других модулях
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { SafeNavigation, safeNav };
}