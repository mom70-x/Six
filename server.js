#!/usr/bin/env node
/**
 * Stateless Feed Server - Telegram Group as Database
 * =================================================
 * 
 * Каждый запрос:
 * 1. Читает ВСЮ группу
 * 2. Парсит в события  
 * 3. Отдает пользователю
 * 4. Забывает все
 */

const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const cors = require('cors')

class StatelessFeedServer {
  constructor() {
    // Другой бот без webhook
    this.BOT_TOKEN = process.env.FEED_BOT_TOKEN || "7948285859:AAEEQMIUqgiFaWKYpm5CPMHg1zJvL3q4mKM"
    this.PUBLICATION_GROUP = process.env.PUBLICATION_GROUP || "-1002361596586"
    this.PORT = process.env.PORT || 3001

    this.app = express()
    this.bot = new TelegramBot(this.BOT_TOKEN, { polling: false })

    this.initialize()
  }

  async initialize() {
    console.log('🗄️ Initializing Stateless Feed Server...')
    console.log(`📱 Feed Bot Token: ${this.BOT_TOKEN.substring(0, 10)}...`)
    console.log(`📢 Publication Group: ${this.PUBLICATION_GROUP}`)
    console.log(`💾 Mode: Telegram Group as Database (no cache)`)

    this.setupMiddleware()
    this.setupRoutes()
    this.startServer()
  }

  setupMiddleware() {
    this.app.use(cors({ origin: true }))
    this.app.use(express.json())

    this.app.use((req, res, next) => {
      console.log(`🗄️ ${req.method} ${req.path}`)
      next()
    })

    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        server: 'stateless-feed-server',
        mode: 'telegram-group-as-database',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      })
    })
  }

  setupRoutes() {
    // ЕДИНСТВЕННЫЙ ENDPOINT
    this.app.get('/api/feed', async (req, res) => {
      try {
        console.log('🗄️ Reading ENTIRE Telegram group as database...')

        // Читаем ВСЮ группу заново каждый раз
        const allMessages = await this.readEntireGroupAsDatabase()
        
        // Парсим в события
        const events = []
        for (const message of allMessages) {
          const event = this.parsePublicationMessage(message)
          if (event) events.push(event)
        }

        console.log(`📊 Parsed ${events.length} events from ${allMessages.length} messages`)

        // Фильтрация и пагинация
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

        // Сортировка по дате (новые первые)
        filteredEvents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))

        // Пагинация
        const offset = (parseInt(page) - 1) * parseInt(limit)
        const paginatedEvents = filteredEvents.slice(offset, offset + parseInt(limit))

        res.json({
          posts: paginatedEvents,
          hasMore: paginatedEvents.length === parseInt(limit),
          total: filteredEvents.length,
          server: 'stateless-database-mode'
        })

        console.log(`📋 Sent ${paginatedEvents.length} events. Server forgot everything.`)
        
        // Сервер забывает все - никакого кеша!

      } catch (error) {
        console.error('❌ Database read error:', error)
        res.status(500).json({ error: 'Failed to read database' })
      }
    })
  }

  async readEntireGroupAsDatabase() {
    try {
      // Читаем БЕЗ offset - получаем все доступные updates
      // Telegram хранит updates ~24 часа
      console.log('📖 Reading all available updates from Telegram...')
      
      const updates = await this.bot.getUpdates({ 
        limit: 100,    // Максимум за раз
        timeout: 10,   // Подождать новых
        // НЕТ offset - читаем все доступные
      })

      console.log(`📨 Received ${updates.length} total updates`)

      // Фильтруем сообщения из нужной группы с #event
      const relevantMessages = updates
        .filter(update =>
          (update.message && update.message.chat.id.toString() === this.PUBLICATION_GROUP) ||
          (update.channel_post && update.channel_post.chat.id.toString() === this.PUBLICATION_GROUP)
        )
        .map(update => update.message || update.channel_post)
        .filter(msg => msg && msg.text && msg.text.includes('#event'))

      console.log(`🎯 Found ${relevantMessages.length} relevant event messages`)

      return relevantMessages

    } catch (error) {
      console.error('❌ Failed to read group database:', error)
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

      // Парсим как раньше
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
        authorId: `telegram_user_${message.from?.id || message.sender_chat?.id || 'unknown'}`,
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
      console.log(`🗄️ Stateless Feed Server running on port ${this.PORT}`)
      console.log(`📊 Each request reads entire Telegram group as database`)
      console.log(`🧹 Zero persistence - server forgets everything after each request`)
    })
  }
}

// Запуск
const server = new StatelessFeedServer()

process.on('SIGTERM', () => {
  console.log('🛑 Stateless server shutting down (nothing to save)')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('🛑 Stateless server shutting down (nothing to save)')  
  process.exit(0)
})
