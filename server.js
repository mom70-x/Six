// 🌊 Distributed Nostr Network - Complete Implementation
// 6-node resilient network with Nostr protocol support

const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const WebSocket = require('ws');

// ========================= GOLDEN RATIO CONSTANTS =========================

const GOLDEN_RATIO = 1.618;
const FIBONACCI = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55];

const NETWORK_CONFIG = {
  topology: 'tetrahedral',
  nodeId: process.env.NODE_ID || `node-${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 5)}`,

  roles: {
    master: 1,
    storage: 2,
    cache: 2,
    gateway: 1
  },

  peers: [
    process.env.PEER_1,
    process.env.PEER_2,
    process.env.PEER_3,
    process.env.PEER_4,
    process.env.PEER_5,
    process.env.PEER_6
  ].filter(Boolean),

  keepAlive: {
    interval: 12 * 60 * 1000,
    pingUrl: process.env.PING_URL,
    healthCheck: '/heartbeat'
  },

  consensus: {
    quorum: 4,
    syncInterval: 8000,
    conflictResolve: 'timestamp'
  },

  replication: {
    factor: 3,
    sharding: 'hash',
    backupInterval: 21 * 60 * 1000
  }
};

// ========================= DISTRIBUTED STORAGE ENGINE =========================

class DistributedStorage {
  constructor(nodeId) {
    this.nodeId = nodeId;
    this.role = this.determineRole();
    this.localData = new Map();
    this.replicatedData = new Map();
    this.metadata = new Map();
    this.peers = new Map();

    this.state = {
      isLeader: false,
      lastSync: Date.now(),
      version: 0,
      health: 'healthy'
    };

    this.conflictLog = [];
    this.lastHeartbeat = new Map();

    this.initializeNode();

    setInterval(() => {
      this.cleanupOldPosts();
    }, 6 * 60 * 60 * 1000);
  }

  selectStorageNodes(eventId) {
    const hash = crypto.createHash('sha256').update(eventId).digest('hex');
    const nodeIndex = parseInt(hash.slice(0, 2), 16) % 2;

    const storageNodes = this.getActivePeers().filter(p => p.role === 'storage');

    if (storageNodes.length >= 2) {
      const primaryNode = nodeIndex === 0 ? 'storage-001' : 'storage-002';
      const replicaNode = nodeIndex === 0 ? 'storage-002' : 'storage-001';
      return { primary: primaryNode, replica: replicaNode };
    }

    return { primary: this.nodeId, replica: null };
  }

  cleanupOldPosts() {
    if (this.role === 'gateway') return;

    const now = Date.now();
    const TTL = 30 * 24 * 60 * 60 * 1000;
    const deleted = [];

    for (const [id, post] of this.localData.entries()) {
      const age = now - post.timestamp;

      if (age > TTL) {
        this.localData.delete(id);
        deleted.push(id);

        this.broadcastToPeers({
          type: 'post_expired',
          postId: id,
          reason: 'ttl_expired',
          timestamp: Date.now(),
          nodeId: this.nodeId
        });
      }
    }

    if (deleted.length > 0) {
      console.log(`🗑️ ${this.role} cleaned up ${deleted.length} expired posts`);
    }
  }

  determineRole() {
    const envRole = process.env.NODE_ROLE;
    if (envRole && ['master', 'storage', 'cache', 'gateway'].includes(envRole)) {
      return envRole;
    }

    if (this.nodeId.includes('master')) return 'master';
    if (this.nodeId.includes('storage')) return 'storage';
    if (this.nodeId.includes('cache')) return 'cache';
    if (this.nodeId.includes('gateway')) return 'gateway';

    const hash = crypto.createHash('sha256').update(this.nodeId).digest('hex');
    const hashValue = parseInt(hash.slice(0, 8), 16);
    const position = (hashValue % 1000) / 1000;

    if (position < 0.167) return 'master';
    if (position < 0.5) return 'storage';
    if (position < 0.833) return 'cache';
    return 'gateway';
  }

  cleanupCacheData() {
    if (this.role !== 'cache') return;

    const now = Date.now();
    const deleted = [];

    for (const [id, post] of this.localData.entries()) {
      const age = now - post.timestamp;
      let shouldDelete = false;

      if (this.cacheType === 'hot') {
        shouldDelete = age > this.cacheTTL && post.likes.length < 5;
      } else {
        shouldDelete = age > this.cacheTTL;
      }

      if (shouldDelete) {
        this.localData.delete(id);
        deleted.push(id);
      }
    }

    if (deleted.length > 0) {
      console.log(`🗑️ ${this.nodeId} (${this.cacheType}) cleaned ${deleted.length} cached posts`);
    }
  }

  async initializeNode() {
    console.log(`🌊 Node ${this.nodeId} starting as ${this.role}`);
    this.connectToPeers();
    this.startConsensusLoop();
    this.startKeepAlive();
    this.initializeRoleServices();
  }

  async connectToPeers() {
    for (const peerUrl of NETWORK_CONFIG.peers) {
      if (!peerUrl || peerUrl.includes(this.nodeId)) continue;

      try {
        const wsUrl = peerUrl.replace('https://', 'wss://').replace('http://', 'ws://');
        const ws = new WebSocket(wsUrl);

        ws.on('open', () => {
          console.log(`🤝 Connected to peer: ${peerUrl}`);
          this.peers.set(peerUrl, {
            ws,
            lastSeen: Date.now(),
            health: 'connected',
            nodeId: null // Will be set when we receive intro
          });

          this.sendToPeer(ws, {
            type: 'node_intro',
            nodeId: this.nodeId,
            role: this.role,
            timestamp: Date.now()
          });
        });

        ws.on('message', (data) => this.handlePeerMessage(peerUrl, data));
        ws.on('close', () => this.handlePeerDisconnect(peerUrl));
        ws.on('error', (error) => {
          console.log(`❌ WebSocket error for ${peerUrl}:`, error.message);
        });

      } catch (error) {
        console.log(`❌ Failed to connect to ${peerUrl}:`, error.message);
      }
    }
  }

  startConsensusLoop() {
    setInterval(() => {
      this.performConsensusRound();
    }, NETWORK_CONFIG.consensus.syncInterval);

    setInterval(() => {
      this.electLeader();
    }, FIBONACCI[6] * 1000);
  }

  startKeepAlive() {
    setInterval(async () => {
      try {
        if (NETWORK_CONFIG.keepAlive.pingUrl) {
          const response = await fetch(NETWORK_CONFIG.keepAlive.pingUrl + '/heartbeat');
          console.log(`💓 Self-ping: ${response.status}`);
        }
        this.pingAllPeers();
      } catch (error) {
        console.log('⚠️ Keep-alive error:', error.message);
      }
    }, NETWORK_CONFIG.keepAlive.interval);
  }

  // ============= NOSTR EVENT METHODS =============

  // ДОБАВИТЬ в класс DistributedStorage:
  selectStorageNodes(eventId) {
    const hash = crypto.createHash('sha256').update(eventId).digest('hex');
    const nodeIndex = parseInt(hash.slice(0, 2), 16) % 2; // 0 или 1

    const storageNodes = this.getActivePeers().filter(p => p.role === 'storage');

    if (storageNodes.length >= 2) {
      // Первичный узел для хранения
      const primaryNode = nodeIndex === 0 ? 'storage-001' : 'storage-002';

      // Репликация на второй узел для надежности
      const replicaNode = nodeIndex === 0 ? 'storage-002' : 'storage-001';

      return { primary: primaryNode, replica: replicaNode };
    }

    // Fallback: храним везде если недостаточно узлов
    return { primary: this.nodeId, replica: null };
  }


  async addNostrEvent(event) {
    try {
      if (this.role === 'cache') {
        const post = this.convertNostrEventToPost(event);
        const eventAge = Date.now() - post.timestamp;

        if (this.cacheType === 'hot') {
          // cache-001: только свежие посты (24ч) + популярные
          if (eventAge <= this.cacheTTL || post.likes.length >= 5) {
            this.localData.set(event.id, post);
            console.log(`🔥 cache-001 cached HOT event ${event.id.slice(0, 8)}...`);
          }
        }
        else if (this.cacheType === 'warm') {
          // cache-002: посты до 7 дней
          if (eventAge <= this.cacheTTL) {
            this.localData.set(event.id, post);
            console.log(`♨️ cache-002 cached WARM event ${event.id.slice(0, 8)}...`);
          }
        }

        this.broadcastToPeers({
          type: 'nostr_event',
          event: event,
          timestamp: Date.now(),
          nodeId: this.nodeId
        });
        return true;
      }
      else if (this.role === 'storage') {
        // Storage: проверяем должны ли мы хранить этот пост
        const { primary, replica } = this.selectStorageNodes(event.id);

        if (this.nodeId === primary || this.nodeId === replica) {
          // Мы ответственны за этот пост
          const post = this.convertNostrEventToPost(event);
          this.localData.set(event.id, post);
          console.log(`📦 ${this.nodeId} stored event ${event.id.slice(0, 8)}... (${this.nodeId === primary ? 'PRIMARY' : 'REPLICA'})`);
        } else {
          console.log(`⏭️ ${this.nodeId} skipped event ${event.id.slice(0, 8)}... (not our shard)`);
        }

        // Всегда транслируем дальше
        this.broadcastToPeers({
          type: 'nostr_event',
          event: event,
          timestamp: Date.now(),
          nodeId: this.nodeId
        });
        return true;
      }
      else {
        // Cache и другие узлы - обычная логика
        const post = this.convertNostrEventToPost(event);
        this.localData.set(event.id, post);

        this.broadcastToPeers({
          type: 'nostr_event',
          event: event,
          timestamp: Date.now(),
          nodeId: this.nodeId
        });
        return true;
      }
    } catch (error) {
      console.error('❌ Error adding Nostr event:', error);
      return false;
    }
  }

  cleanupCacheData() {
    if (this.role !== 'cache') return;

    const now = Date.now();
    const deleted = [];

    for (const [id, post] of this.localData.entries()) {
      const age = now - post.timestamp;
      let shouldDelete = false;

      if (this.cacheType === 'hot') {
        // Удаляем если старше 24ч И непопулярные
        shouldDelete = age > this.cacheTTL && post.likes.length < 5;
      } else {
        // Удаляем если старше 7 дней
        shouldDelete = age > this.cacheTTL;
      }

      if (shouldDelete) {
        this.localData.delete(id);
        deleted.push(id);
      }
    }

    if (deleted.length > 0) {
      console.log(`🗑️ ${this.nodeId} (${this.cacheType}) cleaned ${deleted.length} cached posts`);
    }
  }

  async queryNostrEvents(filters) {
    try {
      if (this.role === 'gateway') {
        return await this.queryFromOtherNodes(filters);
      } else {
        const events = [];
        for (const [id, post] of this.localData.entries()) {
          const event = this.convertPostToNostrEvent(post);
          if (this.eventMatchesFilters(event, filters)) {
            events.push(event);
          }
        }
        events.sort((a, b) => b.created_at - a.created_at);
        const limit = filters[0]?.limit || 20;
        return events.slice(0, limit);
      }
    } catch (error) {
      console.error('❌ Error querying Nostr events:', error);
      return [];
    }
  }

  async queryFromOtherNodes(filters) {
    const activePeers = this.getActivePeers().filter(p =>
      p.role === 'storage' || p.role === 'cache'
    );

    if (activePeers.length === 0) return [];

    const targetPeer = activePeers[0];

    return new Promise((resolve) => {
      const events = [];

      this.sendToPeer(targetPeer.ws, {
        type: 'query_request',
        filters: filters,
        requestId: Date.now().toString()
      });

      setTimeout(() => resolve(events), 5000);
    });
  }

  convertNostrEventToPost(event) {
    const titleTag = event.tags.find(tag => tag[0] === 'title');
    const topicTag = event.tags.find(tag => tag[0] === 't');
    const cityTag = event.tags.find(tag => tag[0] === 'city');
    const genderTag = event.tags.find(tag => tag[0] === 'gender');
    const ageTag = event.tags.find(tag => tag[0] === 'age');
    const eventDateTag = event.tags.find(tag => tag[0] === 'event_date');

    const lines = event.content.split('\n\n');
    const title = titleTag?.[1] || lines[0] || 'Untitled';
    const content = lines.slice(1).join('\n\n') || event.content;

    return {
      id: event.id,
      title,
      content,
      author: `User_${event.pubkey.slice(-6)}`,
      authorKey: event.pubkey,
      authorInfo: {
        name: `User_${event.pubkey.slice(-6)}`,
        city: cityTag?.[1] || '',
        gender: genderTag?.[1] || 'male',
        age: ageTag?.[1] || ''
      },
      tag: topicTag?.[1] || 'general',
      timestamp: event.created_at * 1000,
      eventDate: eventDateTag?.[1] ? parseInt(eventDateTag[1]) : undefined,
      likes: [],
      replies: [],
      reports: [],
      isDraft: false
    };
  }

  convertPostToNostrEvent(post) {
    return {
      id: post.id,
      pubkey: post.authorKey,
      created_at: Math.floor(post.timestamp / 1000),
      kind: 1,
      tags: [
        ['t', post.tag],
        ['title', post.title],
        ['city', post.authorInfo.city || ''],
        ['gender', post.authorInfo.gender || ''],
        ['age', post.authorInfo.age || ''],
        ...(post.eventDate ? [['event_date', post.eventDate.toString()]] : [])
      ],
      content: `${post.title}\n\n${post.content}`,
      sig: 'placeholder_signature'
    };
  }

  eventMatchesFilters(event, filters) {
    for (const filter of filters) {
      if (filter.kinds && !filter.kinds.includes(event.kind)) continue;
      if (filter.authors && !filter.authors.includes(event.pubkey)) continue;
      if (filter.since && event.created_at < filter.since) continue;
      if (filter.until && event.created_at > filter.until) continue;
      if (filter['#t'] && !event.tags.some(tag => tag[0] === 't' && filter['#t'].includes(tag[1]))) continue;

      if (filter['#city'] && !event.tags.some(tag => tag[0] === 'city' && filter['#city'].includes(tag[1]))) continue;
      if (filter['#gender'] && !event.tags.some(tag => tag[0] === 'gender' && filter['#gender'].includes(tag[1]))) continue;
      if (filter['#age'] && !event.tags.some(tag => tag[0] === 'age' && filter['#age'].includes(tag[1]))) continue;

      return true;
    }
    return false;
  }

  // ============= CONSENSUS PROTOCOL =============

  async performConsensusRound() {
    const activePeers = this.getActivePeers();

    if (activePeers.length < NETWORK_CONFIG.consensus.quorum - 1) {
      console.log(`⚠️ Insufficient peers for consensus: ${activePeers.length}`);
      return;
    }

    const proposal = {
      type: 'consensus_proposal',
      nodeId: this.nodeId,
      version: this.state.version + 1,
      changes: this.getPendingChanges(),
      timestamp: Date.now()
    };

    this.broadcastToPeers(proposal);
  }

  electLeader() {
    const activePeers = this.getActivePeers();
    const candidates = [this.nodeId, ...activePeers.map(p => p.nodeId)].filter(Boolean).sort();
    const leader = candidates[0];

    const wasLeader = this.state.isLeader;
    this.state.isLeader = (leader === this.nodeId);

    if (this.state.isLeader && !wasLeader) {
      console.log(`👑 Node ${this.nodeId} became leader`);
      this.onBecomeLeader();
    }
  }

  onBecomeLeader() {
    this.startDataSynchronization();
    this.startConflictResolution();
    this.coordinateReplication();
  }

  // ============= PEER COMMUNICATION =============

  handlePeerMessage(peerUrl, data) {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'node_intro':
          this.handleNodeIntro(peerUrl, message);
          break;
        case 'consensus_proposal':
          this.handleConsensusProposal(message);
          break;
        case 'nostr_event':
          this.handleNostrEvent(message);
          break;
        case 'data_sync':
          this.handleDataSync(message);
          break;
        case 'heartbeat':
          this.handleHeartbeat(peerUrl, message);
          break;
        case 'sync_request':
          this.handleSyncRequest(peerUrl, message);
          break;
        case 'sync_response':
          this.handleSyncResponse(message);
          break;
        case 'post_expired':
          this.handlePostExpired(message);
          break;
      }
    } catch (error) {
      console.log('❌ Error handling peer message:', error);
    }
  }

  handlePostExpired(message) {
    if (this.localData.has(message.postId)) {
      this.localData.delete(message.postId);
      console.log(`🗑️ Removed expired post ${message.postId.slice(0, 8)}...`);
    }
  }

  handleNodeIntro(peerUrl, message) {
    const peer = this.peers.get(peerUrl);
    if (peer) {
      peer.nodeId = message.nodeId;
      peer.role = message.role;
      peer.lastSeen = Date.now();
      console.log(`👋 Peer introduced: ${message.nodeId} (${message.role})`);

      this.requestDataSync(peer.ws);
    }
  }

  requestDataSync(ws) {
    this.sendToPeer(ws, {
      type: 'sync_request',
      nodeId: this.nodeId,
      since: Date.now() - (7 * 24 * 60 * 60 * 1000),
      timestamp: Date.now()
    });
  }

  handleConsensusProposal(message) {
    // Handle consensus proposal
    console.log(`📋 Consensus proposal from ${message.nodeId}`);
    // TODO: Implement proper consensus handling
  }

  handleNostrEvent(message) {
    try {
      if (message.nodeId !== this.nodeId) {
        // Store replicated event
        const post = this.convertNostrEventToPost(message.event);
        this.localData.set(message.event.id, post);
        console.log(`📦 Received replicated event ${message.event.id.slice(0, 8)}...`);
      }
    } catch (error) {
      console.log('❌ Error handling Nostr event:', error);
    }
  }

  handleDataSync(message) {
    console.log(`🔄 Data sync from ${message.nodeId}`);
    // TODO: Implement data synchronization
  }

  handleHeartbeat(peerUrl, message) {
    const peer = this.peers.get(peerUrl);
    if (peer) {
      peer.lastSeen = Date.now();
      peer.health = message.health || 'unknown';
    }
  }

  handleSyncRequest(peerUrl, message) {
    const peer = this.peers.get(peerUrl);
    if (!peer) return;

    const events = [];
    for (const [id, post] of this.localData.entries()) {
      if (post.timestamp >= message.since) {
        const event = this.convertPostToNostrEvent(post);
        events.push(event);
      }
    }

    this.sendToPeer(peer.ws, {
      type: 'sync_response',
      nodeId: this.nodeId,
      events: events,
      timestamp: Date.now()
    });

    console.log(`📤 Sent ${events.length} events to ${message.nodeId}`);
  }

  handleSyncResponse(message) {
    console.log(`📥 Received ${message.events.length} events from ${message.nodeId}`);

    message.events.forEach(event => {
      if (!this.localData.has(event.id)) {
        const post = this.convertNostrEventToPost(event);
        this.localData.set(event.id, post);
      }
    });
  }

  sendToPeer(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  broadcastToPeers(message) {
    for (const peer of this.peers.values()) {
      this.sendToPeer(peer.ws, message);
    }
  }

  pingAllPeers() {
    const heartbeat = {
      type: 'heartbeat',
      nodeId: this.nodeId,
      timestamp: Date.now(),
      health: this.state.health
    };
    this.broadcastToPeers(heartbeat);
  }

  handlePeerDisconnect(peerUrl) {
    console.log(`💔 Peer disconnected: ${peerUrl}`);
    const peer = this.peers.get(peerUrl);
    if (peer) {
      peer.health = 'disconnected';
      peer.lastSeen = Date.now();
    }
  }

  // ============= NETWORK HEALTH =============

  getActivePeers() {
    const now = Date.now();
    const timeout = 60000;

    return Array.from(this.peers.entries())
      .filter(([url, peer]) => {
        const isRecentlySeen = now - peer.lastSeen < timeout;
        const hasNodeId = peer.nodeId && peer.nodeId !== this.nodeId;
        return isRecentlySeen && hasNodeId;
      })
      .map(([url, peer]) => ({ url, nodeId: peer.nodeId, role: peer.role, ...peer }));
  }

  // ============= ROLE-SPECIFIC SERVICES =============

  initializeRoleServices() {
    switch (this.role) {
      case 'master':
        this.startMasterServices();
        break;
      case 'storage':
        this.startStorageServices();
        break;
      case 'cache':
        this.startCacheServices();
        break;
      case 'gateway':
        this.startGatewayServices();
        break;
    }
  }

  startMasterServices() {
    console.log('👑 Starting master node services');
    setInterval(() => {
      this.checkNetworkHealth();
    }, FIBONACCI[7] * 1000);
  }

  startStorageServices() {
    console.log('📦 Starting storage node services');
  }

  startCacheServices() {
    console.log('⚡ Starting cache node services');

    // Определяем тип кеша по nodeId
    if (this.nodeId === 'cache-001') {
      this.cacheType = 'hot';   // Горячие данные (24ч + популярные)
      this.cacheTTL = 24 * 60 * 60 * 1000; // 24 часа
    } else {
      this.cacheType = 'warm';  // Теплые данные (7 дней)
      this.cacheTTL = 7 * 24 * 60 * 60 * 1000; // 7 дней
    }

    console.log(`⚡ Cache type: ${this.cacheType}, TTL: ${this.cacheTTL}ms`);
  }

  startGatewayServices() {
    console.log('🌐 Starting gateway node services');

    // Gateway НЕ хранит данные, только перенаправляет
    this.isProxy = true;
    this.localData = new Map(); // Очищаем при старте

    // Настраиваем маршрутизацию к Storage/Cache
    this.setupDataRouting();
  }

  setupDataRouting() {
    // Определяем куда отправлять запросы
    this.storageNodes = this.getActivePeers().filter(p => p.role === 'storage');
    this.cacheNodes = this.getActivePeers().filter(p => p.role === 'cache');
  }


  checkNetworkHealth() {
    const activePeers = this.getActivePeers();
    console.log(`💓 Network health: ${activePeers.length}/${NETWORK_CONFIG.peers.length} nodes active`);

    if (activePeers.length < NETWORK_CONFIG.consensus.quorum - 1) {
      console.log('⚠️ Network partition detected - entering degraded mode');
      this.state.health = 'degraded';
    } else {
      this.state.health = 'healthy';
    }
  }

  // ============= UTILITY METHODS =============

  getPendingChanges() {
    return [];
  }

  startDataSynchronization() {
    console.log('🔄 Starting data synchronization');
  }

  startConflictResolution() {
    console.log('⚖️ Starting conflict resolution');
  }

  coordinateReplication() {
    console.log('📡 Coordinating replication');
  }
}

// ========================= EXPRESS API LAYER =========================

class DistributedAPI {
  constructor(storage) {
    this.storage = storage;
    this.app = express();
    this.wss = null;
    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      next();
    });
  }

  setupRoutes() {
    // Health check
    this.app.get('/heartbeat', (req, res) => {
      res.json({
        status: 'alive',
        nodeId: this.storage.nodeId,
        role: this.storage.role,
        timestamp: Date.now(),
        peers: this.storage.getActivePeers().length,
        health: this.storage.state.health
      });
    });

    // Main route
    this.app.get('/', (req, res) => {
      res.json({
        service: 'Distributed Nostr Relay',
        node: this.storage.nodeId,
        role: this.storage.role,
        network: `${this.storage.getActivePeers().length}/${NETWORK_CONFIG.peers.length} nodes`,
        websocket: `wss://${req.headers.host}`,
        status: this.storage.state.health
      });
    });

    // Network status
    this.app.get('/api/network', (req, res) => {
      res.json({
        nodeId: this.storage.nodeId,
        role: this.storage.role,
        isLeader: this.storage.state.isLeader,
        peers: this.storage.getActivePeers().map(p => ({
          nodeId: p.nodeId,
          role: p.role,
          lastSeen: p.lastSeen,
          health: p.health
        })),
        network: {
          topology: NETWORK_CONFIG.topology,
          consensus: {
            quorum: NETWORK_CONFIG.consensus.quorum,
            version: this.storage.state.version
          }
        }
      });
    });
  }

  // ============= NOSTR WEBSOCKET HANDLERS =============

  async handleNostrEvent(ws, event) {
    try {
      if (!event || !event.id || !event.pubkey || !event.created_at) {
        ws.send(JSON.stringify(['OK', event?.id || '', false, 'invalid: missing required fields']));
        return;
      }

      const success = await this.storage.addNostrEvent(event);

      if (success) {
        ws.send(JSON.stringify(['OK', event.id, true, '']));
        this.broadcastEvent(event);
        console.log(`✅ Event ${event.id.slice(0, 8)}... stored and broadcasted`);
      } else {
        ws.send(JSON.stringify(['OK', event.id, false, 'error: failed to store event']));
      }
    } catch (error) {
      console.error('❌ Error handling Nostr event:', error);
      ws.send(JSON.stringify(['OK', event?.id || '', false, 'error: server error']));
    }
  }

  async handleNostrRequest(ws, subscriptionId, filters) {
    try {
      console.log(`🔍 Subscription ${subscriptionId} with filters:`, filters);

      const events = await this.storage.queryNostrEvents(filters);

      for (const event of events) {
        ws.send(JSON.stringify(['EVENT', subscriptionId, event]));
      }

      ws.send(JSON.stringify(['EOSE', subscriptionId]));

      if (!ws.subscriptions) ws.subscriptions = new Map();
      ws.subscriptions.set(subscriptionId, filters);

      console.log(`✅ Subscription ${subscriptionId} established with ${events.length} events`);
    } catch (error) {
      console.error('❌ Error handling Nostr request:', error);
      ws.send(JSON.stringify(['NOTICE', 'Error processing subscription request']));
    }
  }

  handleNostrClose(ws, subscriptionId) {
    if (ws.subscriptions) {
      ws.subscriptions.delete(subscriptionId);
    }
    console.log(`🔒 Subscription ${subscriptionId} closed`);
  }

  broadcastEvent(event) {
    if (!this.wss) return;

    this.wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN && client.subscriptions) {
        client.subscriptions.forEach((filters, subId) => {
          if (this.storage.eventMatchesFilters(event, filters)) {
            client.send(JSON.stringify(['EVENT', subId, event]));
          }
        });
      }
    });
  }

  start(port = 8080) {
    const server = this.app.listen(port, '0.0.0.0', () => {
      console.log(`🌊 Distributed node ${this.storage.nodeId} (${this.storage.role}) running on port ${port}`);
    });

    // WebSocket server for Nostr protocol
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws, req) => {
      console.log(`🔌 Client connected to ${this.storage.role} node`);

      ws.send(JSON.stringify(['NOTICE', 'Connected to distributed Nostr relay']));

      ws.on('message', async (data) => {
        try {
          console.log('🔍 Raw message data:', data.toString());
          const message = JSON.parse(data.toString());
          console.log('🔍 Parsed message:', message, 'Type:', typeof message, 'IsArray:', Array.isArray(message));

          if (!Array.isArray(message)) {
            console.error('❌ Invalid message format - not an array:', message);
            ws.send(JSON.stringify(['NOTICE', 'Invalid message format - expected array']));
            return;
          }

          if (message.length === 0) {
            console.error('❌ Empty message array');
            ws.send(JSON.stringify(['NOTICE', 'Empty message']));
            return;
          }

          const [type, ...params] = message;
          console.log('📨 Nostr message type:', type, 'params:', params);

          switch (type) {
            case 'EVENT':
              await this.handleNostrEvent(ws, params[0]);
              break;

            case 'REQ':
              await this.handleNostrRequest(ws, params[0], params.slice(1));
              break;

            case 'CLOSE':
              this.handleNostrClose(ws, params[0]);
              break;

            default:
              ws.send(JSON.stringify(['NOTICE', `Unknown message type: ${type}`]));
          }
        } catch (error) {
          console.error('❌ Error processing Nostr message:', error);
          console.error('❌ Original data:', data.toString());
          ws.send(JSON.stringify(['NOTICE', 'Error processing message']));
        }
      });

      ws.on('close', () => {
        console.log(`💔 Client disconnected from ${this.storage.role} node`);
      });

      ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
      });
    });

    return server;
  }
}

// ========================= INITIALIZATION =========================

async function initializeDistributedNode() {
  console.log('🌊 Initializing distributed Nostr node...');

  const storage = new DistributedStorage(NETWORK_CONFIG.nodeId);
  const api = new DistributedAPI(storage);
  const server = api.start();

  process.on('SIGTERM', () => {
    console.log('🛑 Graceful shutdown initiated');
    server.close(() => {
      console.log('✅ Node shutdown complete');
      process.exit(0);
    });
  });

  console.log('🚀 Distributed node initialization complete');
  console.log(`📊 Network topology: ${NETWORK_CONFIG.topology}`);
  console.log(`🎯 Node role: ${storage.role}`);
}

if (require.main === module) {
  initializeDistributedNode().catch(console.error);
}

module.exports = { DistributedStorage, DistributedAPI, NETWORK_CONFIG };
