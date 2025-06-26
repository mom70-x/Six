#!/usr/bin/env node
/**
 * Accounts Server - User Management & Metadata
 * ============================================
 * 
 * Управляет:
 * - Пользователями Telegram
 * - Лайками пользователей 
 * - Избранными событиями
 * - Скрытыми событиями
 * - Подписками и настройками
 */

const express = require('express')
const cors = require('cors')
const { Pool } = require('pg')
const crypto = require('crypto')

class AccountsServer {
  constructor() {
    this.serverId = process.env.SERVER_ID || `accounts_${Date.now()}`
    this.port = process.env.PORT || 3001

    // Минимальный in-memory кеш (только для текущих запросов)
    this.activeUsers = new Map() // userId -> user data (TTL 5 минут)
    this.cacheTTL = 5 * 60 * 1000 // 5 минут

    this.initializeServices()
  }

  async initializeServices() {
    // Express
    this.app = express()
    this.setupMiddleware()

    // База данных
    if (process.env.DATABASE_URL && process.env.DATABASE_URL !== 'disabled') {
      this.db = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production',
        max: 3 // Минимум коннекций для экономии
      })
      await this.initializeDatabase()
    } else {
      console.log('📝 Database disabled - running in memory-only mode')
      this.db = null
      this.memoryUsers = new Map()
    }

    this.setupRoutes()
    this.startCleanupTasks()

    this.app.listen(this.port, () => {
      console.log(`👤 Accounts Server [${this.serverId}] running on port ${this.port}`)
      console.log(`💾 Database: ${this.db ? 'PostgreSQL' : 'Memory'}`)
      console.log(`🧠 Cache: Minimal (5min TTL)`)
    })
  }

  setupMiddleware() {
    this.app.use(cors())
    this.app.use(express.json({ limit: '1mb' }))

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        serverId: this.serverId,
        service: 'accounts',
        activeUsers: this.activeUsers.size,
        memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
        uptime: process.uptime(),
        status: 'healthy'
      })
    })

    // Request logging
    this.app.use((req, res, next) => {
      console.log(`📝 ${req.method} ${req.path} - ${req.ip}`)
      next()
    })
  }

  setupRoutes() {
    // === ПОЛЬЗОВАТЕЛИ ===

    // Получить/создать пользователя из Telegram
    this.app.post('/api/users/auth', async (req, res) => {
      try {
        const { telegramUser } = req.body
        
        if (!telegramUser || !telegramUser.id) {
          return res.status(400).json({ error: 'Invalid Telegram user data' })
        }

        const user = await this.createOrUpdateUser(telegramUser)
        res.json(user)
      } catch (error) {
        console.error('Auth error:', error)
        res.status(500).json({ error: 'Authentication failed' })
      }
    })

    // Получить профиль пользователя
    this.app.get('/api/users/:userId', async (req, res) => {
      try {
        const { userId } = req.params
        const user = await this.getUser(userId)
        
        if (!user) {
          return res.status(404).json({ error: 'User not found' })
        }

        res.json(user)
      } catch (error) {
        console.error('Get user error:', error)
        res.status(500).json({ error: 'Failed to get user' })
      }
    })

    // === МЕТАДАННЫЕ ПОЛЬЗОВАТЕЛЯ ===

    // Получить полные метаданные пользователя
    this.app.get('/api/users/:userId/meta', async (req, res) => {
      try {
        const { userId } = req.params
        const { lastSync } = req.query

        const meta = await this.getUserMeta(userId, lastSync)
        res.json(meta)
      } catch (error) {
        console.error('Get meta error:', error)
        res.status(500).json({ error: 'Failed to get user meta' })
      }
    })

    // Обновить метаданные пользователя (батч)
    this.app.post('/api/users/:userId/meta/batch', async (req, res) => {
      try {
        const { userId } = req.params
        const { updates } = req.body

        const result = await this.batchUpdateUserMeta(userId, updates)
        res.json(result)
      } catch (error) {
        console.error('Batch update error:', error)
        res.status(500).json({ error: 'Failed to update user meta' })
      }
    })

    // === ЛАЙКИ ===

    // Добавить лайк
    this.app.post('/api/users/:userId/likes/:postId', async (req, res) => {
      try {
        const { userId, postId } = req.params
        await this.addLike(userId, postId)
        res.json({ success: true })
      } catch (error) {
        console.error('Add like error:', error)
        res.status(500).json({ error: 'Failed to add like' })
      }
    })

    // Убрать лайк
    this.app.delete('/api/users/:userId/likes/:postId', async (req, res) => {
      try {
        const { userId, postId } = req.params
        await this.removeLike(userId, postId)
        res.json({ success: true })
      } catch (error) {
        console.error('Remove like error:', error)
        res.status(500).json({ error: 'Failed to remove like' })
      }
    })

    // Получить лайки пользователя
    this.app.get('/api/users/:userId/likes', async (req, res) => {
      try {
        const { userId } = req.params
        const { limit = 100, offset = 0 } = req.query

        const likes = await this.getUserLikes(userId, parseInt(limit), parseInt(offset))
        res.json(likes)
      } catch (error) {
        console.error('Get likes error:', error)
        res.status(500).json({ error: 'Failed to get likes' })
      }
    })

    // === ИЗБРАННОЕ ===

    // Добавить в избранное
    this.app.post('/api/users/:userId/favorites/:postId', async (req, res) => {
      try {
        const { userId, postId } = req.params
        await this.addFavorite(userId, postId)
        res.json({ success: true })
      } catch (error) {
        console.error('Add favorite error:', error)
        res.status(500).json({ error: 'Failed to add favorite' })
      }
    })

    // Убрать из избранного
    this.app.delete('/api/users/:userId/favorites/:postId', async (req, res) => {
      try {
        const { userId, postId } = req.params
        await this.removeFavorite(userId, postId)
        res.json({ success: true })
      } catch (error) {
        console.error('Remove favorite error:', error)
        res.status(500).json({ error: 'Failed to remove favorite' })
      }
    })

    // === СКРЫТЫЕ СОБЫТИЯ ===

    // Скрыть событие
    this.app.post('/api/users/:userId/hidden/:postId', async (req, res) => {
      try {
        const { userId, postId } = req.params
        await this.hidePost(userId, postId)
        res.json({ success: true })
      } catch (error) {
        console.error('Hide post error:', error)
        res.status(500).json({ error: 'Failed to hide post' })
      }
    })

    // Показать событие
    this.app.delete('/api/users/:userId/hidden/:postId', async (req, res) => {
      try {
        const { userId, postId } = req.params
        await this.unhidePost(userId, postId)
        res.json({ success: true })
      } catch (error) {
        console.error('Unhide post error:', error)
        res.status(500).json({ error: 'Failed to unhide post' })
      }
    })

    // === СТАТИСТИКА ===

    // Статистика сервера
    this.app.get('/api/stats', async (req, res) => {
      try {
        const stats = await this.getServerStats()
        res.json(stats)
      } catch (error) {
        console.error('Stats error:', error)
        res.status(500).json({ error: 'Failed to get stats' })
      }
    })
  }

  // === БАЗА ДАННЫХ ===

  async initializeDatabase() {
    try {
      // Пользователи
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          telegram_id BIGINT UNIQUE NOT NULL,
          username TEXT,
          first_name TEXT,
          last_name TEXT,
          language_code TEXT DEFAULT 'en',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          last_seen TIMESTAMP DEFAULT NOW()
        )
      `)

      // Лайки
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS user_likes (
          user_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (user_id, post_id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `)

      // Избранное
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS user_favorites (
          user_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (user_id, post_id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `)

      // Скрытые посты
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS user_hidden (
          user_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (user_id, post_id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `)

      // Индексы для производительности
      await this.db.query(`
        CREATE INDEX IF NOT EXISTS idx_user_likes_user ON user_likes(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_likes_post ON user_likes(post_id);
        CREATE INDEX IF NOT EXISTS idx_user_favorites_user ON user_favorites(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_hidden_user ON user_hidden(user_id);
      `)

      console.log('✅ Accounts database initialized')
    } catch (error) {
      console.error('❌ Database initialization failed:', error)
    }
  }

  // === ОПЕРАЦИИ С ПОЛЬЗОВАТЕЛЯМИ ===

  async createOrUpdateUser(telegramUser) {
    const userId = `tg_${telegramUser.id}`
    
    // Проверяем кеш
    const cached = this.activeUsers.get(userId)
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data
    }

    const user = {
      id: userId,
      telegramId: telegramUser.id,
      username: telegramUser.username || '',
      firstName: telegramUser.first_name || '',
      lastName: telegramUser.last_name || '',
      languageCode: telegramUser.language_code || 'en',
      updatedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    }

    if (this.db) {
      await this.db.query(`
        INSERT INTO users (id, telegram_id, username, first_name, last_name, language_code, updated_at, last_seen)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (telegram_id) DO UPDATE SET
          username = $3, first_name = $4, last_name = $5, 
          language_code = $6, updated_at = $7, last_seen = $8
        RETURNING *
      `, [user.id, user.telegramId, user.username, user.firstName, 
          user.lastName, user.languageCode, user.updatedAt, user.lastSeen])
    } else {
      this.memoryUsers.set(userId, user)
    }

    // Кешируем на 5 минут
    this.activeUsers.set(userId, {
      data: user,
      timestamp: Date.now()
    })

    console.log(`👤 User created/updated: ${user.firstName} ${user.lastName} (${userId})`)
    return user
  }

  async getUser(userId) {
    // Проверяем кеш
    const cached = this.activeUsers.get(userId)
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data
    }

    let user
    if (this.db) {
      const result = await this.db.query('SELECT * FROM users WHERE id = $1', [userId])
      user = result.rows[0] ? this.formatUserFromDB(result.rows[0]) : null
    } else {
      user = this.memoryUsers.get(userId) || null
    }

    if (user) {
      // Кешируем
      this.activeUsers.set(userId, {
        data: user,
        timestamp: Date.now()
      })
    }

    return user
  }

  formatUserFromDB(row) {
    return {
      id: row.id,
      telegramId: row.telegram_id,
      username: row.username || '',
      firstName: row.first_name || '',
      lastName: row.last_name || '',
      languageCode: row.language_code || 'en',
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      lastSeen: row.last_seen.toISOString()
    }
  }

  // === МЕТАДАННЫЕ ===

  async getUserMeta(userId, lastSync = null) {
    const since = lastSync ? new Date(parseInt(lastSync)) : new Date(0)
    
    console.log(`📊 Getting meta for ${userId}, since: ${since.toISOString()}`)

    if (this.db) {
      const [likes, favorites, hidden] = await Promise.all([
        this.db.query('SELECT post_id, created_at FROM user_likes WHERE user_id = $1 AND created_at > $2', [userId, since]),
        this.db.query('SELECT post_id, created_at FROM user_favorites WHERE user_id = $1 AND created_at > $2', [userId, since]),
        this.db.query('SELECT post_id, created_at FROM user_hidden WHERE user_id = $1 AND created_at > $2', [userId, since])
      ])

      return {
        userId,
        likes: likes.rows.map(row => row.post_id),
        favorites: favorites.rows.map(row => row.post_id),
        hidden: hidden.rows.map(row => row.post_id),
        timestamp: Date.now(),
        isDelta: !!lastSync
      }
    } else {
      // Memory fallback - возвращаем пустые массивы
      return {
        userId,
        likes: [],
        favorites: [],
        hidden: [],
        timestamp: Date.now(),
        isDelta: !!lastSync
      }
    }
  }

  async batchUpdateUserMeta(userId, updates) {
    console.log(`📦 Batch update for ${userId}:`, updates)

    if (!this.db) {
      console.log('💾 Database disabled - skipping batch update')
      return { success: true }
    }

    const client = await this.db.connect()
    
    try {
      await client.query('BEGIN')

      // Добавляем лайки
      if (updates.addLikes && updates.addLikes.length > 0) {
        for (const postId of updates.addLikes) {
          await client.query(`
            INSERT INTO user_likes (user_id, post_id) 
            VALUES ($1, $2) 
            ON CONFLICT (user_id, post_id) DO NOTHING
          `, [userId, postId])
        }
        console.log(`➕ Added ${updates.addLikes.length} likes`)
      }

      // Убираем лайки
      if (updates.removeLikes && updates.removeLikes.length > 0) {
        for (const postId of updates.removeLikes) {
          await client.query('DELETE FROM user_likes WHERE user_id = $1 AND post_id = $2', [userId, postId])
        }
        console.log(`➖ Removed ${updates.removeLikes.length} likes`)
      }

      // Добавляем избранное
      if (updates.addFavorites && updates.addFavorites.length > 0) {
        for (const postId of updates.addFavorites) {
          await client.query(`
            INSERT INTO user_favorites (user_id, post_id) 
            VALUES ($1, $2) 
            ON CONFLICT (user_id, post_id) DO NOTHING
          `, [userId, postId])
        }
        console.log(`⭐ Added ${updates.addFavorites.length} favorites`)
      }

      // Убираем избранное
      if (updates.removeFavorites && updates.removeFavorites.length > 0) {
        for (const postId of updates.removeFavorites) {
          await client.query('DELETE FROM user_favorites WHERE user_id = $1 AND post_id = $2', [userId, postId])
        }
        console.log(`🗑️ Removed ${updates.removeFavorites.length} favorites`)
      }

      // Скрываем посты
      if (updates.hideEvents && updates.hideEvents.length > 0) {
        for (const postId of updates.hideEvents) {
          await client.query(`
            INSERT INTO user_hidden (user_id, post_id) 
            VALUES ($1, $2) 
            ON CONFLICT (user_id, post_id) DO NOTHING
          `, [userId, postId])
        }
        console.log(`👁️ Hidden ${updates.hideEvents.length} events`)
      }

      await client.query('COMMIT')
      
      // Очищаем кеш пользователя
      this.activeUsers.delete(userId)

      return { 
        success: true, 
        processed: Object.keys(updates).length,
        timestamp: Date.now() 
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  // === ИНДИВИДУАЛЬНЫЕ ОПЕРАЦИИ ===

  async addLike(userId, postId) {
    if (this.db) {
      await this.db.query(`
        INSERT INTO user_likes (user_id, post_id) 
        VALUES ($1, $2) 
        ON CONFLICT (user_id, post_id) DO NOTHING
      `, [userId, postId])
    }
    console.log(`👍 Like added: ${userId} -> ${postId}`)
  }

  async removeLike(userId, postId) {
    if (this.db) {
      await this.db.query('DELETE FROM user_likes WHERE user_id = $1 AND post_id = $2', [userId, postId])
    }
    console.log(`👎 Like removed: ${userId} -> ${postId}`)
  }

  async addFavorite(userId, postId) {
    if (this.db) {
      await this.db.query(`
        INSERT INTO user_favorites (user_id, post_id) 
        VALUES ($1, $2) 
        ON CONFLICT (user_id, post_id) DO NOTHING
      `, [userId, postId])
    }
    console.log(`⭐ Favorite added: ${userId} -> ${postId}`)
  }

  async removeFavorite(userId, postId) {
    if (this.db) {
      await this.db.query('DELETE FROM user_favorites WHERE user_id = $1 AND post_id = $2', [userId, postId])
    }
    console.log(`🗑️ Favorite removed: ${userId} -> ${postId}`)
  }

  async hidePost(userId, postId) {
    if (this.db) {
      await this.db.query(`
        INSERT INTO user_hidden (user_id, post_id) 
        VALUES ($1, $2) 
        ON CONFLICT (user_id, post_id) DO NOTHING
      `, [userId, postId])
    }
    console.log(`👁️ Post hidden: ${userId} -> ${postId}`)
  }

  async unhidePost(userId, postId) {
    if (this.db) {
      await this.db.query('DELETE FROM user_hidden WHERE user_id = $1 AND post_id = $2', [userId, postId])
    }
    console.log(`👀 Post unhidden: ${userId} -> ${postId}`)
  }

  async getUserLikes(userId, limit, offset) {
    if (this.db) {
      const result = await this.db.query(`
        SELECT post_id, created_at 
        FROM user_likes 
        WHERE user_id = $1 
        ORDER BY created_at DESC 
        LIMIT $2 OFFSET $3
      `, [userId, limit, offset])
      
      return result.rows.map(row => ({
        postId: row.post_id,
        createdAt: row.created_at.toISOString()
      }))
    }
    return []
  }

  // === СТАТИСТИКА ===

  async getServerStats() {
    if (!this.db) {
      return {
        totalUsers: this.memoryUsers?.size || 0,
        totalLikes: 0,
        totalFavorites: 0,
        totalHidden: 0,
        activeUsers: this.activeUsers.size,
        memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        uptime: Math.round(process.uptime())
      }
    }

    const [users, likes, favorites, hidden] = await Promise.all([
      this.db.query('SELECT COUNT(*) FROM users'),
      this.db.query('SELECT COUNT(*) FROM user_likes'),
      this.db.query('SELECT COUNT(*) FROM user_favorites'),
      this.db.query('SELECT COUNT(*) FROM user_hidden')
    ])

    return {
      totalUsers: parseInt(users.rows[0].count),
      totalLikes: parseInt(likes.rows[0].count),
      totalFavorites: parseInt(favorites.rows[0].count),
      totalHidden: parseInt(hidden.rows[0].count),
      activeUsers: this.activeUsers.size,
      memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      uptime: Math.round(process.uptime())
    }
  }

  // === ОЧИСТКА ===

  startCleanupTasks() {
    // Очистка кеша каждые 5 минут
    setInterval(() => {
      const now = Date.now()
      for (const [userId, cached] of this.activeUsers.entries()) {
        if (now - cached.timestamp > this.cacheTTL) {
          this.activeUsers.delete(userId)
        }
      }
      
      const memUsage = process.memoryUsage().heapUsed / 1024 / 1024
      console.log(`🧹 Cache cleanup: ${this.activeUsers.size} active users, ${memUsage.toFixed(1)}MB RAM`)
    }, 5 * 60 * 1000)

    // Принудительная сборка мусора при высоком потреблении памяти
    setInterval(() => {
      const memUsage = process.memoryUsage().heapUsed
      if (memUsage > 400 * 1024 * 1024) { // 400MB
        console.log('🚨 High memory usage, forcing garbage collection')
        this.activeUsers.clear()
        global.gc && global.gc()
      }
    }, 2 * 60 * 1000) // Каждые 2 минуты
  }
}

// === ЗАПУСК СЕРВЕРА ===

const server = new AccountsServer()

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Accounts server graceful shutdown...')
  if (server.db) await server.db.end()
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.log('🛑 Accounts server interrupted, shutting down...')
  if (server.db) await server.db.end()
  process.exit(0)
})
