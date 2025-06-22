const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');

// ========================= КОНФИГУРАЦИЯ =========================

const BOT_TOKEN = '7229365201:AAHVSXlcoU06UVsTn3Vwp9deRndatnlJLVA';
const GROUP_ID = '-1002268255207'; // Группа БД
const PORT = process.env.PORT || 8080;

// ========================= ИНИЦИАЛИЗАЦИЯ =========================

const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const app = express();

app.use(cors());
app.use(express.json());

// ========================= УТИЛИТЫ =========================

// Парсинг поста из сообщения группы
const parsePost = (message) => {
  try {
    const text = message.text;
    
    // Проверяем формат POST::
    if (!text || !text.startsWith('POST::')) {
      return null;
    }
    
    // Извлекаем JSON часть после первой строки
    const lines = text.split('\n');
    if (lines.length < 2) return null;
    
    const jsonData = lines.slice(1).join('\n');
    const post = JSON.parse(jsonData);
    
    // Проверяем что это пост
    if (post.t !== 'post') return null;
    
    return post;
  } catch (error) {
    console.error('❌ Error parsing post:', error);
    return null;
  }
};

// Генерация ID для нового поста
const generateId = () => {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
};

// ========================= API ENDPOINTS =========================

// Главная страница - информация о боте
app.get('/', (req, res) => {
  res.json({
    service: 'Bot #4 - Feed Server',
    role: 'Пагинация для новых пользователей',
    group: GROUP_ID,
    status: 'active',
    version: '1.0.0',
    endpoints: {
      '/api/feed': 'Получение ленты постов',
      '/api/feed/latest': 'Последние посты', 
      '/api/posts/:id': 'Получение конкретного поста',
      '/api/test-post': 'Создание тестового поста'
    },
    timestamp: new Date().toISOString()
  });
});

// Health check
app.get('/heartbeat', (req, res) => {
  res.json({
    status: 'alive',
    bot: 'feed-server',
    timestamp: Date.now(),
    group: GROUP_ID
  });
});

// Получение ленты постов с пагинацией
app.get('/api/feed', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20,
      city,
      tag,
      gender,
      search 
    } = req.query;

    console.log(`📋 Feed request: page=${page}, limit=${limit}, filters:`, { city, tag, gender, search });

    // Получаем сообщения из группы
    const messages = await bot.getChatHistory(GROUP_ID, {
      limit: parseInt(limit) * 5, // Берем больше для фильтрации
      offset: (parseInt(page) - 1) * parseInt(limit) * 5
    });

    console.log(`📥 Retrieved ${messages.length} messages from group`);

    // Парсим и фильтруем посты
    let posts = [];
    for (const message of messages) {
      const post = parsePost(message);
      if (post) {
        posts.push(post);
      }
    }

    console.log(`✅ Parsed ${posts.length} valid posts`);

    // Применяем фильтры
    if (city && city !== 'all') {
      posts = posts.filter(post => post.meta?.city === city);
    }
    
    if (tag && tag !== 'all') {
      posts = posts.filter(post => post.meta?.tag === tag);
    }
    
    if (gender && gender !== 'all') {
      posts = posts.filter(post => post.meta?.gender === gender);
    }
    
    if (search) {
      const searchLower = search.toLowerCase();
      posts = posts.filter(post => 
        post.title?.toLowerCase().includes(searchLower) ||
        post.content?.toLowerCase().includes(searchLower)
      );
    }

    // Сортируем по времени (новые первые)
    posts.sort((a, b) => b.ts - a.ts);

    // Пагинация
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const endIndex = startIndex + parseInt(limit);
    const paginatedPosts = posts.slice(startIndex, endIndex);
    
    const hasMore = posts.length > endIndex;

    console.log(`📤 Returning ${paginatedPosts.length} posts (hasMore: ${hasMore})`);

    res.json({
      posts: paginatedPosts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: posts.length,
        hasMore
      },
      filters: { city, tag, gender, search },
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('❌ Error fetching feed:', error);
    res.status(500).json({
      error: 'Failed to fetch feed',
      message: error.message,
      timestamp: Date.now()
    });
  }
});

// Получение последних постов (без пагинации)
app.get('/api/feed/latest', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const messages = await bot.getChatHistory(GROUP_ID, {
      limit: parseInt(limit) * 3 // Берем больше для парсинга
    });

    const posts = [];
    for (const message of messages) {
      const post = parsePost(message);
      if (post && posts.length < parseInt(limit)) {
        posts.push(post);
      }
    }

    // Сортируем по времени
    posts.sort((a, b) => b.ts - a.ts);

    res.json({
      posts: posts.slice(0, parseInt(limit)),
      count: posts.length,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('❌ Error fetching latest posts:', error);
    res.status(500).json({
      error: 'Failed to fetch latest posts',
      message: error.message
    });
  }
});

// Получение конкретного поста по ID
app.get('/api/posts/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Ищем пост по ID в истории группы
    const messages = await bot.getChatHistory(GROUP_ID, {
      limit: 1000 // Берем больше сообщений для поиска
    });

    for (const message of messages) {
      const post = parsePost(message);
      if (post && post.id === id) {
        return res.json({
          post,
          found: true,
          timestamp: Date.now()
        });
      }
    }

    res.status(404).json({
      error: 'Post not found',
      id,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('❌ Error fetching post:', error);
    res.status(500).json({
      error: 'Failed to fetch post',
      message: error.message
    });
  }
});

// Создание тестового поста
app.post('/api/test-post', async (req, res) => {
  try {
    const {
      title = 'Тестовый пост от Bot #4',
      content = 'Это тестовый пост для проверки работы системы',
      city = 'moscow',
      tag = 'general',
      gender = 'male'
    } = req.body;

    const testPost = {
      t: 'post',
      id: generateId(),
      title,
      content,
      author: {
        id: 'bot_4_test',
        name: 'Bot #4 Test',
        photo: '',
        username: 'bot4_test'
      },
      meta: {
        city,
        tag,
        gender,
        age: '25-35'
      },
      ts: Date.now(),
      likes: 0,
      views: 0
    };

    // Формируем сообщение для группы
    const messageText = `POST::${testPost.id}::${testPost.ts}\n${JSON.stringify(testPost, null, 2)}`;

    // Отправляем в группу
    await bot.sendMessage(GROUP_ID, messageText);

    console.log('✅ Test post created:', testPost.id);

    res.json({
      success: true,
      post: testPost,
      message: 'Test post created successfully',
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('❌ Error creating test post:', error);
    res.status(500).json({
      error: 'Failed to create test post',
      message: error.message
    });
  }
});

// ========================= СТАТИСТИКА =========================

app.get('/api/stats', async (req, res) => {
  try {
    // Получаем последние сообщения для анализа
    const messages = await bot.getChatHistory(GROUP_ID, {
      limit: 1000
    });

    let postsCount = 0;
    let likesCount = 0;
    let usersCount = new Set();

    for (const message of messages) {
      const text = message.text;
      if (!text) continue;

      if (text.startsWith('POST::')) {
        postsCount++;
        const post = parsePost(message);
        if (post?.author?.id) {
          usersCount.add(post.author.id);
        }
      } else if (text.startsWith('LIKE::')) {
        likesCount++;
      }
    }

    res.json({
      posts: postsCount,
      likes: likesCount,
      users: usersCount.size,
      messagesAnalyzed: messages.length,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error('❌ Error fetching stats:', error);
    res.status(500).json({
      error: 'Failed to fetch stats',
      message: error.message
    });
  }
});

// ========================= ЗАПУСК СЕРВЕРА =========================

app.listen(PORT, '0.0.0.0', () => {
  console.log('🤖 Bot #4 - Feed Server started');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`📱 Group ID: ${GROUP_ID}`);
  console.log(`🔗 API URL: https://six-z05l.onrender.com`);
  console.log('');
  console.log('📋 Available endpoints:');
  console.log('  GET  /api/feed - Feed with pagination');
  console.log('  GET  /api/feed/latest - Latest posts');
  console.log('  GET  /api/posts/:id - Get specific post');
  console.log('  POST /api/test-post - Create test post');
  console.log('  GET  /api/stats - Statistics');
  console.log('');
});

// Обработка ошибок
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error);
});

module.exports = app;
