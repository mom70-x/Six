#!/usr/bin/env node
/**
 * Feed Server - Только чтение ленты
 * ==================================
 * 
 * Отдельный сервер для чтения истории группы
 * БЕЗ webhook - использует getUpdates
 */

const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const cors = require('cors')

class FeedServer {
  constructor() {
    // Используем ДРУГОЙ бот-токен!
    this.BOT_TOKEN = process.env.FEED_BOT_TOKEN || "НОВЫЙ_ТОКЕН_ВТОРОГО_БОТА"
    this.PUBLICATION_GROUP = process.env.PUBLICATION_GROUP || "-1002361596586"
    this.PORT = process.env.PORT || 3001 // Другой порт

    this.app = express()
    this.bot = new TelegramBot(this.BOT_TOKEN, { polling: false }) // БЕЗ webhook и polling

    this.initialize()
  }

  async initialize() {
    console.log('🍽️ Initializing Feed Server...')
    console.log(`📱 Feed Bot Token: ${this.BOT_TOKEN.substring(0, 10)}...`)
    console.log(`📢 Publication Group: ${this.PUBLICATION_GROUP}`)

    this.setupMiddleware()
    this.setupRoutes()
    this.startServer()
  }

  setupMiddleware() {
    this.app.use(cors({ origin: true }))
    this.app.use(express.json())

    this.app.use((req, res, next) => {
      console.log(`🍽️ ${req.method} ${req.path}`)
      next()
    })

    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        server: 'feed-server',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      })
    })
  }

  setupRoutes() {
    // ГЛАВНЫЙ ENDPOINT - чтение ленты
    this.app.get('/api/feed', async (req, res) => {
      try {
        console.log('📖 Reading Telegram group history...')

        // Читаем через getUpdates (работает без webhook)
        const messages = await this.getGroupMessages()
        const events = []

        for (const message of messages) {
          const event = this.parsePublicationMessage(message)
          if (event) events.push(event)
        }

        // Фильтрация
        const { search, city, category, page = 1, limit = 20 } = req.query
        let filteredEvents = events

        if (search) {
          const searchLower = search.toLowerCase()
          filteredEvents = filteredEvents.filter(event =>
            event.title.toLowerCase().includes(searchLower) ||
            event.description.toLowerCase().includes(searchLower)
          )
        }

        if (city) filteredEvents = filteredEvents.filter(e => e.city === city)
        if (category) filteredEvents = filteredEvents.filter(e => e.category === category)

        // Сортировка по дате
        filteredEvents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

        // Пагинация
        const offset = (parseInt(page) - 1) * parseInt(limit)
        const paginatedEvents = filteredEvents.slice(offset, offset + parseInt(limit))

        res.json({
          posts: paginatedEvents,
          hasMore: paginatedEvents.length === parseInt(limit),
          total: filteredEvents.length,
          server: 'feed-server'
        })

        console.log(`📋 Sent ${paginatedEvents.length} events from ${events.length} total`)
      } catch (error) {
        console.error('❌ Feed error:', error)
        res.status(500).json({ error: 'Failed to fetch events' })
      }
    })
  }

  async getGroupMessages() {
    try {
      // Читаем через getUpdates (работает БЕЗ webhook)
      const updates = await this.bot.getUpdates({ 
        limit: 100,
        timeout: 5 // Короткий timeout
      })

      const messages = updates
        .filter(update =>
          (update.message && update.message.chat.id.toString() === this.PUBLICATION_GROUP) ||
          (update.channel_post && update.channel_post.chat.id.toString() === this.PUBLICATION_GROUP)
        )
        .map(update => update.message || update.channel_post)
        .filter(msg => msg.text && msg.text.includes('#event'))

      console.log(`📨 Found ${messages.length} relevant messages`)
      
      // Очищаем updates чтобы не накапливались
      if (updates.length > 0) {
        const lastUpdateId = Math.max(...updates.map(u => u.update_id))
        await this.bot.getUpdates({ offset: lastUpdateId + 1, limit: 1 })
      }
      
      return messages

    } catch (error) {
      console.error('❌ Failed to get group messages:', error)
      return []
    }
  }

  parsePublicationMessage(message) {
    try {
      const text = message.text

      if (!text || !text.includes('#event')) {
        return null
      }

      const lines = text.split('\n').filter(line => line.trim())

      // Извлекаем данные
      const title = lines[0]?.replace(/^🎯\s*/, '').trim()
      const description = lines[1]?.trim()

      // ID события
      const lastLine = lines[lines.length - 1]
      const idMatch = lastLine?.match(/#([a-z0-9_]+)$/)
      const id = idMatch ? idMatch[1] : `auto_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

      // Метаданные
      const authorLine = lines.find(line => line.startsWith('👤'))
      const cityLine = lines.find(line => line.startsWith('📍'))
      const categoryLine = lines.find(line => line.startsWith('📂'))

      const event = {
        id,
        title: title || 'Событие',
        description: description || 'Описание',
        author: {
          fullName: authorLine?.replace('👤 ', '').trim() || 'Unknown',
          avatar: undefined,
          username: undefined,
          telegramId: undefined
        },
        authorId: `telegram_user_${message.from?.id || 'unknown'}`,
        city: cityLine?.replace('📍 ', '').trim() || '',
        category: categoryLine?.replace('📂 ', '').trim() || '',
        gender: '',
        ageGroup: '',
        eventDate: '',
        likes: 0,
        isLiked: false,
        createdAt: new Date(message.date * 1000).toISOString(),
        updatedAt: new Date(message.date * 1000).toISOString(),
        status: 'active'
      }

      return event
    } catch (error) {
      console.error('❌ Parse error:', error)
      return null
    }
  }

  startServer() {
    this.app.listen(this.PORT, () => {
      console.log(`🍽️ Feed Server running on port ${this.PORT}`)
      console.log(`📖 Only reads group history - NO webhook conflicts`)
    })
  }
}

// Запуск
const feedServer = new FeedServer()

process.on('SIGTERM', () => {
  console.log('🛑 Feed server shutting down')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('🛑 Feed server shutting down')  
  process.exit(0)
})
