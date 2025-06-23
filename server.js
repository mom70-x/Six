const express = require('express')
const http = require('http')
const WebSocket = require('ws')
const TelegramBot = require('node-telegram-bot-api')
const cors = require('cors')

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

// Environment variables
const BOT2_TOKEN = '7948285859:AAGPM2BYYE2US3AIbP7P4yEBV4C5oWt3FSw'
const GROUP_ID = '-1002268255207'
const BOT1_URL = 'https://sub-muey.onrender.com'
const PORT = process.env.PORT || 3002

// Initialize Telegram bot
const bot = new TelegramBot(BOT2_TOKEN, { polling: true })

// Middleware
app.use(cors())
app.use(express.json())

// WebSocket clients
const clients = new Set()

// ===== IN-MEMORY EVENT CACHE =====
let eventsCache = []
let lastSyncTime = 0
const CACHE_DURATION = 5 * 60 * 1000 // 5 минут

// ===== TELEGRAM MESSAGE PARSING =====
function parseEventFromMessage(msg) {
  try {
    if (!msg.text || !msg.text.includes('🎯')) return null
    
    const text = msg.text
    
    // Парсим основные данные
    const titleMatch = text.match(/🎯 <b>(.*?)<\/b>/)
    const descMatch = text.match(/<\/b>\n\n(.*?)\n\n/)
    
    // Парсим метаданные
    const cityMatch = text.match(/📍 ([^|]+)/)
    const categoryMatch = text.match(/🏷️ ([^|]+)/)
    const genderMatch = text.match(/👤 ([^|]+)/)
    const ageMatch = text.match(/🎂 ([^|]+)/)
    
    // Парсим автора
    const authorMatch = text.match(/👤 ([^(@\n]+)/)
    const usernameMatch = text.match(/@([^\s\n]+)/)
    
    // Парсим ID и лайки
    const idMatch = text.match(/#([a-zA-Z0-9-]+)/)
    const likesMatch = text.match(/⚡ (\d+)/)
    
    // Парсим контакты
    const contactsSection = text.match(/📞 Контакты:\n(.*?)(?=\n\n|$)/s)
    let contacts = []
    if (contactsSection) {
      contacts = contactsSection[1]
        .split('\n')
        .map(line => line.replace('• ', '').trim())
        .filter(Boolean)
    }
    
    if (!titleMatch || !descMatch || !idMatch) return null
    
    return {
      id: idMatch[1],
      title: titleMatch[1],
      description: descMatch[1],
      authorId: `tg_${msg.from?.id || 'unknown'}`,
      author: {
        fullName: authorMatch ? authorMatch[1].trim() : 'Unknown',
        username: usernameMatch ? usernameMatch[1] : null,
        telegramId: msg.from?.id?.toString(),
        avatar: null
      },
      city: cityMatch ? cityMatch[1].trim() : '',
      category: categoryMatch ? categoryMatch[1].trim() : '',
      gender: genderMatch ? genderMatch[1].trim() : '',
      ageGroup: ageMatch ? ageMatch[1].trim() : '',
      likes: likesMatch ? parseInt(likesMatch[1]) : 0,
      isLiked: false,
      contacts: contacts,
      status: 'active',
      createdAt: new Date(msg.date * 1000).toISOString(),
      updatedAt: new Date(msg.date * 1000).toISOString(),
      date: new Date(msg.date * 1000).toISOString(),
      telegramMessageId: msg.message_id
    }
  } catch (error) {
    console.error('Parse error:', error)
    return null
  }
}

// ===== TELEGRAM GROUP READER =====
async function syncEventsFromTelegram() {
  try {
    console.log('📖 Syncing events from Telegram group...')
    
    const updates = await bot.getUpdates({ 
      limit: 100,
      allowed_updates: ['message'] 
    })
    
    const events = []
    
    for (const update of updates) {
      if (update.message && 
          update.message.chat.id.toString() === GROUP_ID &&
          update.message.text?.includes('🎯')) {
        
        const event = parseEventFromMessage(update.message)
        if (event) {
          events.push(event)
        }
      }
    }
    
    // Удаляем дубликаты по ID
    const uniqueEvents = []
    const seenIds = new Set()
    
    for (const event of events.reverse()) { // Новые сначала
      if (!seenIds.has(event.id)) {
        seenIds.add(event.id)
        uniqueEvents.push(event)
      }
    }
    
    eventsCache = uniqueEvents
    lastSyncTime = Date.now()
    
    console.log(`✅ Synced ${eventsCache.length} events from Telegram`)
    return eventsCache
    
  } catch (error) {
    console.error('❌ Sync error:', error)
    return eventsCache
  }
}

// ===== EVENT FILTERING & SEARCHING =====
function filterEvents(events, filters = {}) {
  let filtered = [...events]
  
  // Search
  if (filters.search) {
    const search = filters.search.toLowerCase()
    filtered = filtered.filter(event => 
      event.title.toLowerCase().includes(search) ||
      event.description.toLowerCase().includes(search)
    )
  }
  
  // City filter
  if (filters.city) {
    filtered = filtered.filter(event => event.city === filters.city)
  }
  
  // Category filter
  if (filters.category) {
    filtered = filtered.filter(event => event.category === filters.category)
  }
  
  // Gender filter
  if (filters.gender) {
    filtered = filtered.filter(event => event.gender === filters.gender)
  }
  
  // Age group filter
  if (filters.ageGroup) {
    filtered = filtered.filter(event => event.ageGroup === filters.ageGroup)
  }
  
  // Author filter
  if (filters.authorId) {
    filtered = filtered.filter(event => event.authorId === filters.authorId)
  }
  
  // Date filters
  if (filters.dateFrom) {
    const fromDate = new Date(filters.dateFrom)
    filtered = filtered.filter(event => new Date(event.createdAt) >= fromDate)
  }
  
  if (filters.dateTo) {
    const toDate = new Date(filters.dateTo)
    filtered = filtered.filter(event => new Date(event.createdAt) <= toDate)
  }
  
  // Sorting
  if (filters.sort === 'popularity') {
    filtered.sort((a, b) => b.likes - a.likes)
  } else if (filters.sort === 'old') {
    filtered.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
  } else {
    // Default: newest first
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }
  
  return filtered
}

// ===== PAGINATION =====
function paginateEvents(events, page = 1, limit = 20) {
  const offset = (page - 1) * limit
  const paginated = events.slice(offset, offset + limit)
  const hasMore = offset + limit < events.length
  
  return {
    events: paginated,
    hasMore,
    total: events.length,
    page: parseInt(page),
    limit: parseInt(limit)
  }
}

// ===== HTTP API ENDPOINTS =====

// Feed endpoint with search, filters, and pagination
app.get('/api/feed', async (req, res) => {
  try {
    // Check if cache needs refresh
    if (Date.now() - lastSyncTime > CACHE_DURATION) {
      await syncEventsFromTelegram()
    }
    
    const {
      search, city, category, gender, ageGroup, authorId,
      dateFrom, dateTo, sort = 'new', page = 1, limit = 20
    } = req.query

    const filters = {
      search, city, category, gender, 
      ageGroup, authorId, dateFrom, dateTo, sort
    }

    const filteredEvents = filterEvents(eventsCache, filters)
    const result = paginateEvents(filteredEvents, page, limit)

    res.json({
      posts: result.events,
      hasMore: result.hasMore,
      total: result.total,
      page: result.page,
      limit: result.limit,
      cacheTime: lastSyncTime
    })

    console.log(`📋 Feed: ${result.events.length}/${result.total} events (page ${page})`)

  } catch (error) {
    console.error('Feed error:', error)
    res.status(500).json({ error: 'Failed to fetch feed' })
  }
})

// Force sync endpoint
app.post('/api/sync', async (req, res) => {
  try {
    const events = await syncEventsFromTelegram()
    
    // Broadcast to all connected clients
    broadcast('EVENTS_SYNCED', { 
      count: events.length,
      timestamp: Date.now() 
    })
    
    res.json({
      success: true,
      eventsCount: events.length,
      timestamp: lastSyncTime
    })
  } catch (error) {
    res.status(500).json({ error: 'Sync failed' })
  }
})

// Search endpoint (для команд из Telegram)
app.get('/api/search', async (req, res) => {
  try {
    const { q, limit = 5 } = req.query
    
    if (!q) {
      return res.json({ events: [] })
    }
    
    const filtered = filterEvents(eventsCache, { search: q })
    const result = paginateEvents(filtered, 1, limit)
    
    res.json({
      events: result.events,
      total: result.total
    })
  } catch (error) {
    res.status(500).json({ error: 'Search failed' })
  }
})

// Stats endpoint
app.get('/api/stats', (req, res) => {
  const stats = {
    totalEvents: eventsCache.length,
    lastSync: lastSyncTime,
    cacheAge: Date.now() - lastSyncTime,
    connectedClients: clients.size,
    
    // Group by categories
    byCategory: {},
    byCities: {},
    byGender: {},
    totalLikes: 0
  }
  
  eventsCache.forEach(event => {
    // Categories
    if (event.category) {
      stats.byCategory[event.category] = (stats.byCategory[event.category] || 0) + 1
    }
    
    // Cities
    if (event.city) {
      stats.byCities[event.city] = (stats.byCities[event.city] || 0) + 1
    }
    
    // Gender
    if (event.gender) {
      stats.byGender[event.gender] = (stats.byGender[event.gender] || 0) + 1
    }
    
    stats.totalLikes += event.likes
  })
  
  res.json(stats)
})

// ===== WEBSOCKET MANAGEMENT =====
wss.on('connection', (ws, req) => {
  const clientId = Date.now().toString()
  ws.clientId = clientId
  clients.add(ws)
  
  console.log(`🔗 Client connected: ${clientId} (${clients.size} total)`)
  
  ws.send(JSON.stringify({
    type: 'CONNECTED',
    data: { 
      clientId, 
      timestamp: Date.now(),
      eventsCount: eventsCache.length 
    }
  }))

  // Send initial data if cache is available
  if (eventsCache.length > 0) {
    ws.send(JSON.stringify({
      type: 'INITIAL_EVENTS',
      data: {
        events: eventsCache.slice(0, 20), // First 20 events
        total: eventsCache.length,
        cacheTime: lastSyncTime
      }
    }))
  }

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString())
      await handleWebSocketMessage(message, ws)
    } catch (error) {
      console.error(`💥 WS Error from ${clientId}:`, error)
      ws.send(JSON.stringify({
        type: 'ERROR',
        data: { message: 'Failed to process message' }
      }))
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    console.log(`🔌 Client disconnected: ${clientId} (${clients.size} remaining)`)
  })

  ws.on('error', (error) => {
    console.error(`💥 WS Error ${clientId}:`, error)
    clients.delete(ws)
  })
})

function broadcast(type, data, excludeClient = null) {
  const message = JSON.stringify({ type, data })
  let sent = 0
  
  clients.forEach((client) => {
    if (client !== excludeClient && client.readyState === WebSocket.OPEN) {
      try {
        client.send(message)
        sent++
      } catch (error) {
        console.error(`Failed to send to client ${client.clientId}:`, error)
        clients.delete(client)
      }
    }
  })
  
  console.log(`📢 Broadcast ${type}: ${sent} clients`)
}

// ===== WEBSOCKET MESSAGE HANDLERS =====
async function handleWebSocketMessage(message, senderWs) {
  const { type, data } = message

  try {
    switch (type) {
      case 'GET_FEED':
        await handleGetFeed(data, senderWs)
        break
      case 'SEARCH_EVENTS':
        await handleSearchEvents(data, senderWs)
        break
      case 'SYNC_REQUEST':
        await handleSyncRequest(senderWs)
        break
      case 'PING':
        senderWs.send(JSON.stringify({ type: 'PONG', data: { timestamp: Date.now() } }))
        break
      default:
        senderWs.send(JSON.stringify({
          type: 'ERROR',
          data: { message: `Unknown message type: ${type}` }
        }))
    }
  } catch (error) {
    console.error('WebSocket handler error:', error)
    senderWs.send(JSON.stringify({
      type: `${type}_ERROR`,
      data: { message: error.message }
    }))
  }
}

async function handleGetFeed(data, senderWs) {
  const { filters = {}, page = 1, limit = 20 } = data
  
  // Refresh cache if needed
  if (Date.now() - lastSyncTime > CACHE_DURATION) {
    await syncEventsFromTelegram()
  }
  
  const filteredEvents = filterEvents(eventsCache, filters)
  const result = paginateEvents(filteredEvents, page, limit)
  
  senderWs.send(JSON.stringify({
    type: 'FEED_RESPONSE',
    data: result
  }))
}

async function handleSearchEvents(data, senderWs) {
  const { query, limit = 20 } = data
  
  const filtered = filterEvents(eventsCache, { search: query })
  const result = paginateEvents(filtered, 1, limit)
  
  senderWs.send(JSON.stringify({
    type: 'SEARCH_RESPONSE',
    data: result
  }))
}

async function handleSyncRequest(senderWs) {
  const events = await syncEventsFromTelegram()
  
  senderWs.send(JSON.stringify({
    type: 'SYNC_RESPONSE',
    data: {
      eventsCount: events.length,
      timestamp: lastSyncTime
    }
  }))
}

// ===== TELEGRAM BOT COMMANDS =====
bot.on('message', async (msg) => {
  try {
    // Only process messages from our group
    if (msg.chat.id.toString() !== GROUP_ID) return
    
    const text = msg.text
    if (!text) return
    
    // Handle search commands
    if (text.startsWith('/search ')) {
      const query = text.replace('/search ', '').trim()
      await handleTelegramSearch(msg, query)
    }
    
    // Handle stats command
    if (text === '/stats') {
      await handleTelegramStats(msg)
    }
    
    // Handle sync command
    if (text === '/sync') {
      await handleTelegramSync(msg)
    }
    
    // Auto-sync when new events are posted
    if (text.includes('🎯') && msg.from.id !== parseInt(BOT2_TOKEN.split(':')[0])) {
      setTimeout(() => {
        syncEventsFromTelegram()
      }, 2000) // Delay to ensure message is processed
    }
    
  } catch (error) {
    console.error('Telegram message error:', error)
  }
})

async function handleTelegramSearch(msg, query) {
  try {
    const filtered = filterEvents(eventsCache, { search: query })
    const result = paginateEvents(filtered, 1, 5)
    
    if (result.events.length === 0) {
      await bot.sendMessage(GROUP_ID, `🔍 По запросу "${query}" ничего не найдено`)
      return
    }
    
    let response = `🔍 Найдено ${result.total} событий по запросу "${query}":\n\n`
    
    result.events.forEach((event, index) => {
      response += `${index + 1}. 🎯 <b>${event.title}</b>\n`
      response += `${event.description.substring(0, 100)}${event.description.length > 100 ? '...' : ''}\n`
      response += `⚡ ${event.likes} | 👤 ${event.author.fullName}\n\n`
    })
    
    if (result.hasMore) {
      response += `... и еще ${result.total - result.events.length} событий`
    }
    
    await bot.sendMessage(GROUP_ID, response, { parse_mode: 'HTML' })
    
  } catch (error) {
    console.error('Search error:', error)
    await bot.sendMessage(GROUP_ID, '❌ Ошибка поиска')
  }
}

async function handleTelegramStats(msg) {
  try {
    const stats = {
      total: eventsCache.length,
      totalLikes: eventsCache.reduce((sum, event) => sum + event.likes, 0),
      byCategory: {},
      byCities: {},
      topLiked: eventsCache
        .sort((a, b) => b.likes - a.likes)
        .slice(0, 3)
    }
    
    eventsCache.forEach(event => {
      if (event.category) {
        stats.byCategory[event.category] = (stats.byCategory[event.category] || 0) + 1
      }
      if (event.city) {
        stats.byCities[event.city] = (stats.byCities[event.city] || 0) + 1
      }
    })
    
    let response = `📊 <b>Статистика группы:</b>\n\n`
    response += `📝 Всего событий: ${stats.total}\n`
    response += `⚡ Всего лайков: ${stats.totalLikes}\n`
    response += `🔗 Подключено клиентов: ${clients.size}\n\n`
    
    if (Object.keys(stats.byCategory).length > 0) {
      response += `🏷️ <b>По категориям:</b>\n`
      Object.entries(stats.byCategory).forEach(([cat, count]) => {
        response += `• ${cat}: ${count}\n`
      })
      response += '\n'
    }
    
    if (Object.keys(stats.byCities).length > 0) {
      response += `📍 <b>По городам:</b>\n`
      Object.entries(stats.byCities).forEach(([city, count]) => {
        response += `• ${city}: ${count}\n`
      })
      response += '\n'
    }
    
    if (stats.topLiked.length > 0) {
      response += `🔥 <b>Топ по лайкам:</b>\n`
      stats.topLiked.forEach((event, index) => {
        response += `${index + 1}. ${event.title} (⚡ ${event.likes})\n`
      })
    }
    
    await bot.sendMessage(GROUP_ID, response, { parse_mode: 'HTML' })
    
  } catch (error) {
    console.error('Stats error:', error)
    await bot.sendMessage(GROUP_ID, '❌ Ошибка получения статистики')
  }
}

async function handleTelegramSync(msg) {
  try {
    const events = await syncEventsFromTelegram()
    
    broadcast('EVENTS_SYNCED', { 
      count: events.length,
      timestamp: Date.now() 
    })
    
    await bot.sendMessage(GROUP_ID, 
      `🔄 Синхронизация завершена\n📝 Загружено событий: ${events.length}\n🔗 Подключено клиентов: ${clients.size}`,
      { parse_mode: 'HTML' }
    )
    
  } catch (error) {
    console.error('Sync error:', error)
    await bot.sendMessage(GROUP_ID, '❌ Ошибка синхронизации')
  }
}

// ===== WEBHOOK ENDPOINTS FOR BOT1 =====

// Receive commands from BOT1
app.post('/api/webhook/command', async (req, res) => {
  try {
    const { type, eventId, data, timestamp, source } = req.body
    
    console.log(`📨 Webhook from ${source}: ${type} for event ${eventId}`)
    
    switch (type) {
      case 'NEW_EVENT':
        await handleNewEvent(eventId, data.event)
        break
      case 'UPDATE_LIKES':
        await handleLikeUpdate(eventId, data.likes, data.isLiked)
        break
      case 'DELETE_EVENT':
        await handleEventDelete(eventId)
        break
      case 'UPDATE_EVENT':
        await handleEventUpdate(eventId, data.updates || data)
        break
      default:
        console.log(`❓ Unknown webhook command: ${type}`)
    }
    
    res.json({ 
      success: true, 
      processed: type,
      eventId,
      timestamp: Date.now()
    })
    
  } catch (error) {
    console.error('❌ Webhook error:', error)
    res.status(500).json({ error: 'Webhook failed: ' + error.message })
  }
})

async function handleNewEvent(eventId, eventData) {
  try {
    console.log(`➕ Adding new event to cache: ${eventData.title}`)
    
    // Add to cache (at the beginning for newest first)
    eventsCache.unshift(eventData)
    
    // Remove duplicates if any
    const uniqueEvents = []
    const seenIds = new Set()
    
    for (const event of eventsCache) {
      if (!seenIds.has(event.id)) {
        seenIds.add(event.id)
        uniqueEvents.push(event)
      }
    }
    
    eventsCache = uniqueEvents
    
    // Broadcast to all connected clients
    broadcast('EVENT_CREATED', eventData)
    
    console.log(`✅ New event added to cache: ${eventData.title}`)
    
  } catch (error) {
    console.error('❌ Error handling new event:', error)
  }
}

async function handleLikeUpdate(eventId, newLikes, isLiked) {
  try {
    // Find event in cache and update likes
    const eventIndex = eventsCache.findIndex(e => e.id === eventId)
    if (eventIndex !== -1) {
      const oldLikes = eventsCache[eventIndex].likes
      eventsCache[eventIndex].likes = newLikes
      eventsCache[eventIndex].updatedAt = new Date().toISOString()
      
      console.log(`⚡ Updated likes for ${eventId}: ${oldLikes} → ${newLikes}`)
      
      // Broadcast update to all clients
      broadcast('EVENT_LIKED', {
        id: eventId,
        likes: newLikes,
        isLiked: isLiked,
        type: 'likes'
      })
    } else {
      console.log(`⚠️ Event ${eventId} not found in cache for like update`)
    }
  } catch (error) {
    console.error('❌ Error updating likes:', error)
  }
}

async function handleEventDelete(eventId) {
  try {
    // Remove from cache
    const initialLength = eventsCache.length
    eventsCache = eventsCache.filter(e => e.id !== eventId)
    
    if (eventsCache.length < initialLength) {
      console.log(`🗑️ Deleted event ${eventId} from cache`)
      
      // Broadcast deletion to all clients
      broadcast('EVENT_DELETED', { id: eventId })
    } else {
      console.log(`⚠️ Event ${eventId} not found in cache for deletion`)
    }
  } catch (error) {
    console.error('❌ Error deleting event:', error)
  }
}

async function handleEventUpdate(eventId, updates) {
  try {
    // Update in cache
    const eventIndex = eventsCache.findIndex(e => e.id === eventId)
    if (eventIndex !== -1) {
      const oldEvent = eventsCache[eventIndex]
      eventsCache[eventIndex] = { 
        ...oldEvent, 
        ...updates, 
        updatedAt: new Date().toISOString() 
      }
      
      console.log(`✏️ Updated event ${eventId}: ${oldEvent.title}`)
      
      // Broadcast update to all clients
      broadcast('EVENT_UPDATED', {
        id: eventId,
        ...updates,
        type: 'content'
      })
    } else {
      console.log(`⚠️ Event ${eventId} not found in cache for update`)
    }
  } catch (error) {
    console.error('❌ Error updating event:', error)
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Telegram Library Bot',
    eventsCount: eventsCache.length,
    clients: clients.size,
    lastSync: lastSyncTime,
    uptime: process.uptime(),
    bot1Url: BOT1_URL
  })
})

// Debug endpoint
app.get('/api/debug', (req, res) => {
  res.json({
    eventsCache: eventsCache.length,
    clients: clients.size,
    lastSync: new Date(lastSyncTime).toISOString(),
    cacheAge: Date.now() - lastSyncTime,
    sampleEvents: eventsCache.slice(0, 3),
    bot1Url: BOT1_URL
  })
})

// Sync with BOT1 SQLite database
app.post('/api/sync-with-bot1', async (req, res) => {
  try {
    console.log('🔄 Requesting sync with BOT1 SQLite...')
    
    const response = await fetch(`${BOT1_URL}/api/webhook/from-bot2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'SYNC_REQUEST',
        timestamp: Date.now()
      }),
      timeout: 10000
    })
    
    if (!response.ok) {
      throw new Error(`BOT1 responded with ${response.status}`)
    }
    
    const data = await response.json()
    
    if (data.events) {
      // Merge with current cache
      const existingIds = new Set(eventsCache.map(e => e.id))
      const newEvents = data.events.filter(e => !existingIds.has(e.id))
      
      eventsCache = [...eventsCache, ...newEvents]
      console.log(`✅ Merged ${newEvents.length} events from BOT1 SQLite`)
      
      // Sort by creation date (newest first)
      eventsCache.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      
      broadcast('EVENTS_SYNCED', { 
        count: eventsCache.length,
        newFromBot1: newEvents.length,
        timestamp: Date.now() 
      })
    }
    
    res.json({
      success: true,
      totalEvents: eventsCache.length,
      newFromBot1: data.events?.length || 0
    })
    
  } catch (error) {
    console.error('❌ BOT1 sync error:', error)
    res.status(500).json({ error: 'BOT1 sync failed: ' + error.message })
  }
})

// ===== STARTUP =====
server.listen(PORT, async () => {
  console.log(`🚀 Telegram Library Bot running on port ${PORT}`)
  console.log(`📖 Group ID: ${GROUP_ID}`)
  console.log(`🤖 Bot Token: ${BOT2_TOKEN.substring(0, 10)}...`)
  
  try {
    // Initial sync on startup
    await syncEventsFromTelegram()
    
    console.log(`✅ Ready: Library service with ${eventsCache.length} events`)
    
    // Set up periodic sync (every 5 minutes)
    setInterval(async () => {
      try {
        const oldCount = eventsCache.length
        await syncEventsFromTelegram()
        
        if (eventsCache.length !== oldCount) {
          console.log(`🔄 Auto-sync: ${oldCount} → ${eventsCache.length} events`)
          broadcast('EVENTS_SYNCED', { 
            count: eventsCache.length,
            timestamp: Date.now() 
          })
        }
      } catch (error) {
        console.error('Auto-sync error:', error)
      }
    }, 5 * 60 * 1000) // 5 minutes
    
  } catch (error) {
    console.error('❌ Startup error:', error)
  }
})
