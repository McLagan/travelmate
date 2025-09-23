/**
 * Extension Blocker
 * Блокирует ошибки от расширений браузера согласно рекомендациям Chrome
 * https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/
 */

(function() {
    'use strict';

    // Более точная блокировка только специфичных ошибок расширений
    const isExtensionError = (msg) => {
        const str = String(msg || '').toLowerCase();
        return str.includes('chrome-extension://') ||
               str.includes('moz-extension://') ||
               str.includes('chrome-untrusted://') ||
               str.includes('the message port closed before a response was received') ||
               str.includes('extension context invalidated') ||
               str.includes('unchecked runtime.lasterror') ||
               str.includes('listener indicated an asynchronous response by returning true') ||
               str.includes('zmstat.com') ||
               str.includes('gtmpx.com') ||
               (str.includes('runtime.lasterror') && str.includes('chrome'));
    };

    // Блокируем на уровне window.onerror (самый низкий уровень)
    window.onerror = function(message, source, lineno, colno, error) {
        if (isExtensionError(message) || isExtensionError(source)) {
            return true; // Полностью блокируем
        }
        return false;
    };

    // Блокируем unhandled promise rejections
    window.addEventListener('unhandledrejection', function(e) {
        if (isExtensionError(e.reason?.message) || isExtensionError(e.reason)) {
            e.preventDefault();
            e.stopPropagation();
            return true;
        }
    }, true);

    // Блокируем error события
    window.addEventListener('error', function(e) {
        if (isExtensionError(e.message) || isExtensionError(e.filename) || isExtensionError(e.error?.message)) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            return true;
        }
    }, true);

    // Более точный список ошибок расширений для блокировки
    const EXTENSION_ERROR_PATTERNS = [
        'The message port closed before a response was received',
        'Extension context invalidated',
        'Unchecked runtime.lastError',
        'A listener indicated an asynchronous response by returning true',
        'chrome-extension://',
        'moz-extension://',
        'chrome-untrusted://',
        'zmstat.com',
        'gtmpx.com',
        'google-analytics.com/ga',
        'googletagmanager.com/gtm',
        'gtag/js',
        'ga?u=',
        'extId=',
        'Content Security Policy directive: "script-src',
        'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT'
    ];

    // Блокируем ошибки в консоли с более точной фильтрацией
    const originalError = console.error;
    console.error = function(...args) {
        const message = args.join(' ');

        // Проверяем только если ошибка точно от расширения
        for (const pattern of EXTENSION_ERROR_PATTERNS) {
            if (message.toLowerCase().includes(pattern.toLowerCase())) {
                // Дополнительная проверка - не блокируем ошибки нашего приложения
                if (!message.includes('travelmate') && !message.includes('localhost') && !message.includes('8088')) {
                    return; // Тихо игнорируем ошибки расширений
                }
            }
        }

        originalError.apply(console, args);
    };

    // Дополнительная блокировка для console.warn с точной фильтрацией
    const originalWarn = console.warn;
    console.warn = function(...args) {
        const message = args.join(' ');

        for (const pattern of EXTENSION_ERROR_PATTERNS) {
            if (message.toLowerCase().includes(pattern.toLowerCase())) {
                // Не блокируем предупреждения нашего приложения
                if (!message.includes('travelmate') && !message.includes('localhost') && !message.includes('8088')) {
                    return; // Тихо игнорируем предупреждения расширений
                }
            }
        }

        originalWarn.apply(console, args);
    };

    // Блокируем window.onerror
    const originalWindowError = window.onerror;
    window.onerror = function(message, source, lineno, colno, error) {
        const msgStr = String(message || '');
        const srcStr = String(source || '');

        if (EXTENSION_ERROR_PATTERNS.some(pattern =>
            msgStr.includes(pattern) || srcStr.includes(pattern)
        )) {
            return true; // Предотвращаем дальнейшую обработку
        }

        if (originalWindowError) {
            return originalWindowError.apply(this, arguments);
        }

        return false;
    };

    // Блокируем unhandled promise rejections от расширений
    window.addEventListener('unhandledrejection', function(event) {
        const message = String(event.reason?.message || event.reason || '');

        if (EXTENSION_ERROR_PATTERNS.some(pattern => message.includes(pattern))) {
            event.preventDefault();
            event.stopPropagation();
            return false;
        }
    }, true);

    // Блокируем error события от расширений
    window.addEventListener('error', function(event) {
        const message = String(event.message || '');
        const filename = String(event.filename || '');

        if (EXTENSION_ERROR_PATTERNS.some(pattern =>
            message.includes(pattern) || filename.includes(pattern)
        )) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return false;
        }
    }, true);

    // Защита от chrome.runtime вызовов (по рекомендации Chrome)
    if (typeof chrome !== 'undefined' && chrome.runtime) {
        const originalSendMessage = chrome.runtime.sendMessage;
        if (originalSendMessage) {
            chrome.runtime.sendMessage = function(...args) {
                try {
                    return originalSendMessage.apply(this, args);
                } catch (error) {
                    // Тихо игнорируем ошибки chrome.runtime
                    return Promise.resolve(undefined);
                }
            };
        }

        // Защита от onMessage.addListener
        if (chrome.runtime.onMessage) {
            const originalAddListener = chrome.runtime.onMessage.addListener;
            if (originalAddListener) {
                chrome.runtime.onMessage.addListener = function(callback) {
                    const safeCallback = function(...args) {
                        try {
                            return callback.apply(this, args);
                        } catch (error) {
                            // Тихо игнорируем ошибки от listeners
                            return undefined;
                        }
                    };

                    try {
                        return originalAddListener.call(this, safeCallback);
                    } catch (error) {
                        // Тихо игнорируем ошибки addListener
                        return undefined;
                    }
                };
            }
        }
    }

    // Защита от browser API (Firefox)
    if (typeof browser !== 'undefined' && browser.runtime) {
        const originalSendMessage = browser.runtime.sendMessage;
        if (originalSendMessage) {
            browser.runtime.sendMessage = function(...args) {
                try {
                    return originalSendMessage.apply(this, args);
                } catch (error) {
                    return Promise.resolve(undefined);
                }
            };
        }
    }

    // Дополнительная защита: перехватываем postMessage от расширений
    const originalPostMessage = window.postMessage;
    window.postMessage = function(message, targetOrigin, transfer) {
        try {
            // Проверяем, не от расширения ли это сообщение
            if (typeof message === 'object' && message !== null) {
                const msgStr = JSON.stringify(message);
                if (EXTENSION_ERROR_PATTERNS.some(pattern => msgStr.includes(pattern))) {
                    return; // Игнорируем сообщения от расширений
                }
            }

            return originalPostMessage.call(this, message, targetOrigin, transfer);
        } catch (error) {
            // Тихо игнорируем ошибки postMessage
            return;
        }
    };

    console.log('🛡️ Extension blocker initialized - browser extension errors will be suppressed');
})();