const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const cors = require('cors')
const fs = require('fs').promises
const path = require('path')

const app = express()

// Environment variables
const BOT_TOKEN = '7948285859:AAGPM2BYYE2US3AIbP7P4yEBV4C5oWt3FSw'
const GROUP_ID = '-1002268255207'
const PORT = process.env.PORT || 3002
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://six-z05l.onrender.com'

// Initialize Telegram bot
const bot = new TelegramBot(BOT_TOKEN)

// Middleware
app.use(cors())
app.use('/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())

// In-memory storage (простое накопление)
let events = []
let lastProcessedMessageId = 0

// Persistent storage file path
const EVENTS_FILE = path.join(__dirname, 'events.json')

// Load events from file on startup
async function loadEventsFromFile() {
  try {
    const data = await fs.readFile(EVENTS_FILE, 'utf8')
    const savedData = JSON.parse(data)
    events = savedData.events || []
    lastProcessedMessageId = savedData.lastProcessedMessageId || 0
    console.log(`📁 Loaded ${events.length} events from file`)
  } catch (error) {
    console.log('📁 No existing events file, starting fresh')
    events = []
    lastProcessedMessageId = 0
  }
}

// Save events to file
async function saveEventsToFile() {
  try {
    const data = {
      events,
      lastProcessedMessageId,
      updatedAt: new Date().toISOString()
    }
    await fs.writeFile(EVENTS_FILE, JSON.stringify(data, null, 2))
    console.log(`💾 Saved ${events.length} events to file`)
  } catch (error) {
    console.error('💾 Error saving events to file:', error)
  }
}

// Message parsers
function parseEventFromMessage(text, messageId, date, from) {
  try {
    console.log(`🔍 Parsing message ${messageId}:`, text.substring(0, 100) + '...')
    
    // Parse create/update message: "🎯 Title\n\nDescription\n\n📍 city..."
    if (text.includes('🎯')) {
      const isUpdate = text.startsWith('✏️ Updated:')
      const content = isUpdate ? text.replace('✏️ Updated:\n\n', '') : text
      
      const lines = content.split('\n').filter(line => line.trim())
      
      // Extract title (after 🎯)
      const titleLine = lines.find(line => line.includes('🎯'))
      if (!titleLine) return null
      
      const title = titleLine.replace('🎯', '').replace(/<\/?b>/g, '').trim()
      
      // Extract description (lines between title and metadata)
      const titleIndex = lines.findIndex(line => line.includes('🎯'))
      let description = ''
      let metadataStartIndex = lines.length
      
      for (let i = titleIndex + 1; i < lines.length; i++) {
        if (lines[i].match(/^[📍🏷️👤🎂]/)) {
          metadataStartIndex = i
          break
        }
        if (lines[i].trim()) {
          description += (description ? ' ' : '') + lines[i].trim()
        }
      }
      
      // Extract metadata
      const metadata = lines.slice(metadataStartIndex)
      let city = '', category = '', gender = '', ageGroup = '', authorName = '', username = ''
      
      metadata.forEach(line => {
        if (line.startsWith('📍')) city = line.replace('📍', '').trim()
        else if (line.startsWith('🏷️')) category = line.replace('🏷️', '').trim()
        else if (line.startsWith('👤') && !line.includes('@')) gender = line.replace('👤', '').trim()
        else if (line.startsWith('🎂')) ageGroup = line.replace('🎂', '').trim()
        else if (line.startsWith('👤') && line.includes('@')) {
          const authorLine = line.replace('👤', '').trim()
          const match = authorLine.match(/^(.+?)\s*\(@(.+?)\)$/)
          if (match) {
            authorName = match[1].trim()
            username = match[2].trim()
          } else {
            authorName = authorLine
          }
        }
      })
      
      const event = {
        id: messageId.toString(),
        title,
        description,
        authorId: from?.id?.toString() || 'unknown',
        author: {
          fullName: authorName,
          username: username || undefined,
          telegramId: from?.id?.toString()
        },
        city,
        category,
        gender,
        ageGroup,
        createdAt: new Date(date * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        likes: 0,
        isLiked: false,
        status: 'active',
        telegramMessageId: messageId
      }
      
      console.log(`✅ Parsed event: ${title}`)
      return { type: isUpdate ? 'update' : 'create', event }
    }
    
    // Parse delete message: "🗑️ Event deleted\n\nEvent ID: {id}"
    if (text.includes('🗑️') && text.includes('Event deleted')) {
      const match = text.match(/Event ID:\s*(\w+)/)
      if (match) {
        console.log(`✅ Parsed delete: ${match[1]}`)
        return { type: 'delete', eventId: match[1] }
      }
    }
    
    // Parse like message: "⚡ Event liked/unliked\n\nEvent ID: {id}"
    if (text.includes('⚡') && text.includes('Event ID:')) {
      const match = text.match(/Event ID:\s*(\w+)/)
      const isLiked = text.includes('liked') && !text.includes('unliked')
      if (match) {
        console.log(`✅ Parsed like: ${match[1]} - ${isLiked}`)
        return { type: 'like', eventId: match[1], isLiked }
      }
    }
    
    return null
  } catch (error) {
    console.error('💥 Error parsing message:', error)
    return null
  }
}

// Process parsed message
function processMessage(parsed) {
  if (!parsed) return
  
  switch (parsed.type) {
    case 'create':
      // Check if event already exists
      const existingIndex = events.findIndex(e => e.id === parsed.event.id)
      if (existingIndex === -1) {
        events.unshift(parsed.event) // Add to beginning for newest first
        console.log(`📝 Event created: ${parsed.event.title}`)
      } else {
        console.log(`⚠️ Event already exists: ${parsed.event.title}`)
      }
      break
      
    case 'update':
      const updateIndex = events.findIndex(e => e.id === parsed.event.id)
      if (updateIndex !== -1) {
        events[updateIndex] = { ...events[updateIndex], ...parsed.event }
        console.log(`📝 Event updated: ${parsed.event.title}`)
      } else {
        // If event not found, create it
        events.unshift(parsed.event)
        console.log(`📝 Event created from update: ${parsed.event.title}`)
      }
      break
      
    case 'delete':
      const deleteIndex = events.findIndex(e => e.id === parsed.eventId)
      if (deleteIndex !== -1) {
        const deletedEvent = events[deleteIndex]
        events.splice(deleteIndex, 1)
        console.log(`🗑️ Event deleted: ${parsed.eventId}`)
      }
      break
      
    case 'like':
      const likeIndex = events.findIndex(e => e.id === parsed.eventId)
      if (likeIndex !== -1) {
        const event = events[likeIndex]
        event.likes = parsed.isLiked ? event.likes + 1 : Math.max(0, event.likes - 1)
        event.isLiked = parsed.isLiked
        console.log(`⚡ Event liked: ${parsed.eventId} - ${parsed.isLiked}`)
      }
      break
  }
  
  // Save to file after each change
  saveEventsToFile().catch(console.error)
}

// Webhook endpoint
app.post('/webhook', (req, res) => {
  try {
    const update = JSON.parse(req.body.toString())
    
    // Process only messages from the specific group
    if (update.message && 
        update.message.chat.id.toString() === GROUP_ID &&
        update.message.text &&
        update.message.message_id > lastProcessedMessageId) {
      
      const { message_id, text, date, from } = update.message
      console.log(`📨 New message ${message_id}: ${text.substring(0, 50)}...`)
      
      const parsed = parseEventFromMessage(text, message_id, date, from)
      processMessage(parsed)
      
      // Update last processed message ID
      lastProcessedMessageId = message_id
    }
    
    res.status(200).send('OK')
  } catch (error) {
    console.error('💥 Webhook error:', error)
    res.status(500).send('Error')
  }
})

// Helper functions for filtering and sorting
function fullTextSearch(events, query) {
  const searchTerms = query.toLowerCase().split(' ')
  return events.filter(event => {
    const searchText = `${event.title} ${event.description}`.toLowerCase()
    return searchTerms.every(term => searchText.includes(term))
  })
}

function applyFilters(events, filters) {
  let filtered = events
  
  if (filters.city) {
    filtered = filtered.filter(e => e.city === filters.city)
  }
  
  if (filters.category) {
    filtered = filtered.filter(e => e.category === filters.category)
  }
  
  if (filters.gender) {
    filtered = filtered.filter(e => e.gender === filters.gender)
  }
  
  if (filters.ageGroup) {
    filtered = filtered.filter(e => e.ageGroup === filters.ageGroup)
  }
  
  if (filters.dateFrom) {
    filtered = filtered.filter(e => new Date(e.createdAt) >= new Date(filters.dateFrom))
  }
  
  if (filters.dateTo) {
    filtered = filtered.filter(e => new Date(e.createdAt) <= new Date(filters.dateTo))
  }
  
  if (filters.authorId) {
    filtered = filtered.filter(e => e.authorId === filters.authorId)
  }
  
  return filtered
}

function sortEvents(events, sortType) {
  switch (sortType) {
    case 'popularity':
      return [...events].sort((a, b) => (b.likes || 0) - (a.likes || 0))
    case 'old':
      return [...events].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    case 'new':
    default:
      return [...events].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }
}

// API Routes
app.get('/api/feed', async (req, res) => {
  try {
    const { 
      city, 
      category, 
      gender, 
      ageGroup, 
      search, 
      sort = 'new',
      page = 1, 
      limit = 20,
      authorId,
      dateFrom,
      dateTo
    } = req.query

    console.log(`📋 Feed request: ${events.length} total events, page ${page}`)

    let filteredEvents = [...events] // Copy array

    // Apply search
    if (search) {
      filteredEvents = fullTextSearch(filteredEvents, search)
      console.log(`🔍 After search: ${filteredEvents.length} events`)
    }

    // Apply filters
    const filters = { city, category, gender, ageGroup, authorId, dateFrom, dateTo }
    filteredEvents = applyFilters(filteredEvents, filters)
    console.log(`🔧 After filters: ${filteredEvents.length} events`)

    // Apply sorting
    filteredEvents = sortEvents(filteredEvents, sort)

    // Pagination
    const startIndex = (page - 1) * limit
    const endIndex = startIndex + parseInt(limit)
    const paginatedEvents = filteredEvents.slice(startIndex, endIndex)

    console.log(`📄 Returning ${paginatedEvents.length} events (${startIndex}-${endIndex})`)

    res.json({
      posts: paginatedEvents,
      hasMore: filteredEvents.length > endIndex,
      total: filteredEvents.length,
      page: parseInt(page),
      limit: parseInt(limit)
    })
  } catch (error) {
    console.error('💥 Error fetching feed:', error)
    res.status(500).json({ error: 'Failed to fetch feed' })
  }
})

// Get single event
app.get('/api/events/:id', (req, res) => {
  const event = events.find(e => e.id === req.params.id)
  if (!event) {
    return res.status(404).json({ error: 'Event not found' })
  }
  res.json(event)
})

// Stats endpoint
app.get('/api/stats', (req, res) => {
  const stats = {
    totalEvents: events.length,
    lastProcessedMessageId,
    byCity: {},
    byCategory: {},
    byStatus: {}
  }
  
  events.forEach(event => {
    // City stats
    stats.byCity[event.city] = (stats.byCity[event.city] || 0) + 1
    
    // Category stats
    stats.byCategory[event.category] = (stats.byCategory[event.category] || 0) + 1
    
    // Status stats
    stats.byStatus[event.status] = (stats.byStatus[event.status] || 0) + 1
  })
  
  res.json(stats)
})

// Debug endpoint to see all events
app.get('/api/debug/events', (req, res) => {
  res.json({
    events: events.slice(0, 10), // Only first 10 for debugging
    totalCount: events.length,
    lastProcessedMessageId
  })
})

// Manual trigger to process existing messages (for testing)
app.post('/api/debug/process-message', (req, res) => {
  const { text, messageId = Date.now(), date = Date.now() / 1000 } = req.body
  
  const parsed = parseEventFromMessage(text, messageId, date, null)
  processMessage(parsed)
  
  res.json({
    success: true,
    parsed,
    totalEvents: events.length
  })
})

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    eventsCount: events.length,
    lastProcessedMessageId,
    webhookUrl: `${WEBHOOK_URL}/webhook`
  })
})

// Error handler
app.use((error, req, res, next) => {
  console.error('💥 Server error:', error)
  res.status(500).json({ error: 'Internal server error' })
})

// Setup webhook and start server
async function setupWebhook() {
  try {
    const webhookUrl = `${WEBHOOK_URL}/webhook`
    await bot.setWebHook(webhookUrl)
    console.log(`🔗 Webhook set to: ${webhookUrl}`)
  } catch (error) {
    console.error('💥 Error setting webhook:', error)
  }
}

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Bot 2 server running on port ${PORT}`)
  
  // Load existing events from file
  await loadEventsFromFile()
  
  // Setup webhook
  await setupWebhook()
  
  console.log(`📡 Bot 2 ready - will accumulate messages from webhook`)
  console.log(`📊 Current state: ${events.length} events, last message ID: ${lastProcessedMessageId}`)
  
  // Save events every 5 minutes
  setInterval(() => {
    saveEventsToFile().catch(console.error)
  }, 5 * 60 * 1000)
})
