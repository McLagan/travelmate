# TravelMate - Development Guide

## 🚀 Быстрый запуск

### Предварительные требования
- Docker Desktop
- Git

### 1. Запуск проекта

```bash
# Перезапустить сервисы (если уже запущены)
docker-compose -f docker-compose.dev.yml restart

# Или полный перезапуск с логами
docker-compose -f docker-compose.dev.yml down
docker-compose -f docker-compose.dev.yml up -d
```

### 2. Проверка состояния

После запуска проверьте статус:

```bash
# Проверка логов
docker-compose -f docker-compose.dev.yml logs backend --tail=10

# Проверка здоровья API
curl http://localhost:8088/health
```

Ожидаемый ответ:
```json
{"status":"healthy","version":"0.1.0"}
```

### 3. Доступ к приложению

- **Frontend:** http://localhost:8088/map
- **API Docs:** http://localhost:8088/docs
- **Health Check:** http://localhost:8088/health

## 🔧 Что изменилось

### Frontend (Модульная структура)
- `frontend/styles.css` - Все стили
- `frontend/config.js` - Конфигурация и переменные окружения
- `frontend/utils.js` - Утилиты и обработка ошибок
- `frontend/app.js` - Основная логика
- `frontend/features.js` - Функции маршрутов и поиска
- `frontend/index.html` - Чистая разметка

### Backend (Безопасность)
- `.env` файл для конфигурации
- Security headers middleware
- Rate limiting
- Enhanced error handling
- Request validation

### Исправленные проблемы
- ✅ Исправлена белая полоса слева (sidebar positioning)
- ✅ Модульная архитектура вместо монолитного HTML
- ✅ Конфигурация через environment variables
- ✅ Безопасность (CORS, rate limiting, validation)
- ✅ Улучшенная обработка ошибок

### Новые функции
- ✅ Геолокация пользователя
- ✅ Debounced поиск
- ✅ Кэширование API
- ✅ Performance monitoring
- ✅ Enhanced UI

## 🧪 Проверка функций

### 1. Базовая функциональность
1. Откройте http://localhost:8088/map
2. Нажмите кнопку "Use Current Location" (должна работать без входа)
3. Попробуйте зарегистрироваться/войти
4. После входа попробуйте поиск места
5. Создайте маршрут кликами по карте

### 2. Новые улучшения
- **Геолокация:** Кнопка "📍 Use Current Location"
- **Валидация:** Попробуйте короткий пароль при регистрации
- **Rate limiting:** Делайте много запросов подряд
- **Responsive:** Протестируйте на мобильном размере

### 3. API тестирование
```bash
# Health check
curl http://localhost:8088/health

# Rate limiting test
curl -X POST http://localhost:8088/auth/login \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=test&password=test"
```

## 🐛 Возможные проблемы

### Ошибка при запуске конфигурации
```bash
# Если видите ошибки валидации, проверьте .env файл
cat backend/.env
```

### Если нужен rebuild Docker
```bash
# Только если изменились зависимости в requirements.txt
docker-compose -f docker-compose.dev.yml build --no-cache
docker-compose -f docker-compose.dev.yml up -d
```

### Проблемы с CORS
```bash
# Проверьте, что frontend открывается через правильный порт
# http://localhost:8088/map (НЕ file://)
```

## 📂 Структура проекта

```
travelmate/
├── backend/
│   ├── .env                    # 🆕 Конфигурация разработки
│   ├── app/
│   │   ├── config.py          # 🔧 Улучшенная конфигурация
│   │   ├── main.py            # 🔒 Security middleware
│   │   └── middleware/        # 🆕 Security middleware
│   └── requirements.txt       # 🔧 Новые зависимости
├── frontend/
│   ├── index.html            # 🔧 Чистая разметка
│   ├── styles.css            # 🆕 Все стили
│   ├── config.js             # 🆕 Конфигурация
│   ├── utils.js              # 🆕 Утилиты
│   ├── app.js                # 🆕 Основная логика
│   └── features.js           # 🆕 Функции
└── docker-compose.dev.yml    # 🔧 Обновленный
```

## 🎯 Текущий статус

### ✅ Готово
- ✅ Docker контейнеры запущены и работают
- ✅ API отвечает на http://localhost:8088/health
- ✅ Frontend доступен на http://localhost:8088/map
- ✅ Конфигурационные ошибки исправлены
- ✅ Архитектурные проблемы решены
- ✅ Исправлена проблема с загрузкой статических файлов (CSS, JS)
- ✅ Все стили и карта работают корректно

### 🔄 Для тестирования
1. **Тестирование:** Проверьте все функции через браузер
2. **UI:** Убедитесь, что белая полоса слева исправлена
3. **Функции:** Протестируйте авторизацию, поиск, создание маршрутов

---

**Готово к тестированию!** 🚀

Все архитектурные проблемы исправлены, Docker контейнеры запущены успешно.