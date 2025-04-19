const express = require('express');
const cors = require('cors');
// Replace direct IORedis import with our redis utility
const redis = require('../utils/redis');
const { createAnonClient } = require('../utils/supabase');
const config = require('../utils/config');
const logger = require('../utils/logger');

// Initialize Express app
const app = express();
const port = config.api.port;

// Initialize Supabase client with anonymous key
const supabase = createAnonClient();

// CORS Configuration
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS ? 
    process.env.ALLOWED_ORIGINS.split(',') : 
    ['http://localhost:3000', 'https://gbrowser.io'],
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};

// Middleware
app.use(cors(corsOptions));
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();
  
  // Log request details when completed
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`
    }, 'Request processed');
  });
  
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now()
  });
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    // Get metrics data from database
    const [
      { count: totalCount },
      { count: onlineCount },
      playerSumResult,
      lastUpdateStr
    ] = await Promise.all([
      supabase.from('servers').select('*', { count: 'exact', head: true }),
      supabase.from('servers').select('*', { count: 'exact', head: true }).eq('status', 'online'),
      supabase.from('servers').select('players').eq('status', 'online'),
      redis.get('last_master_update')
    ]);
    
    // Calculate total players
    const totalPlayers = playerSumResult.data.reduce((sum, server) => sum + (server.players || 0), 0);
    
    // Format response
    res.json({
      totalServers: totalCount,
      onlineServers: onlineCount,
      totalPlayersOnline: totalPlayers,
      lastMasterListUpdate: lastUpdateStr ? new Date(lastUpdateStr) : null,
      timestamp: Date.now()
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to retrieve metrics');
    res.status(500).json({ error: 'Failed to retrieve metrics' });
  }
});

// Get available gamemodes endpoint
app.get('/api/gamemodes', async (req, res) => {
  try {
    // Get list of all gamemodes with server count
    const { data, error } = await supabase
      .from('servers')
      .select('gamemode')
      .eq('status', 'online')
      .not('gamemode', 'is', null);
      
    if (error) throw error;
    
    // Count occurrences of each gamemode
    const gamemodeCounts = data.reduce((counts, server) => {
      const gamemode = server.gamemode || 'unknown';
      counts[gamemode] = (counts[gamemode] || 0) + 1;
      return counts;
    }, {});
    
    // Format response
    const result = Object.entries(gamemodeCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
      
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, 'Failed to retrieve gamemodes');
    res.status(500).json({ error: 'Failed to retrieve gamemodes' });
  }
});

// Main servers endpoint with caching and filtering
app.get('/api/servers', async (req, res) => {
  // Extract query parameters with defaults
  const {
    page = '1',
    limit = '50',
    gamemode,
    map,
    search,
    minPlayers = '0',
    maxPlayers,
    hideEmpty = 'false',
    showFull = 'true',
    sortBy = 'players',
    sortOrder = 'desc'
  } = req.query;
  
  // Create cache key based on query parameters
  const cacheKey = `servers:${JSON.stringify(req.query)}`;
  
  try {
    // Try to get data from cache
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      logger.debug({ cacheKey }, 'Cache hit for servers request');
      res.setHeader('X-Cache', 'HIT');
      return res.json(JSON.parse(cachedData));
    }
    
    logger.debug({ cacheKey }, 'Cache miss for servers request');
    res.setHeader('X-Cache', 'MISS');
    
    // Build database query
    let query = supabase
      .from('servers')
      .select('*', { count: 'exact' })
      .eq('status', 'online');
    
    // Apply filters
    if (gamemode && gamemode !== 'all') {
      query = query.eq('gamemode', gamemode);
    }
    
    if (map) {
      query = query.ilike('map', `%${map}%`);
    }
    
    if (search) {
      query = query.ilike('name', `%${search}%`);
    }
    
    if (hideEmpty === 'true') {
      query = query.gt('players', 0);
    }
    
    if (showFull === 'false') {
      query = query.lt('players', query.raw('max_players'));
    }
    
    const minPlayersInt = parseInt(minPlayers);
    if (minPlayersInt > 0) {
      query = query.gte('players', minPlayersInt);
    }
    
    if (maxPlayers) {
      query = query.lte('players', parseInt(maxPlayers));
    }
    
    // Apply sorting
    const validSortFields = ['name', 'players', 'map', 'ping', 'last_seen'];
    const field = validSortFields.includes(sortBy) ? sortBy : 'players';
    const order = sortOrder.toLowerCase() === 'asc';
    query = query.order(field, { ascending: order });
    
    // Apply pagination
    const pageInt = Math.max(parseInt(page) || 1, 1);
    const limitInt = Math.min(parseInt(limit) || 50, 100);
    const start = (pageInt - 1) * limitInt;
    
    query = query.range(start, start + limitInt - 1);
    
    // Execute query
    const { data, error, count } = await query;
    
    if (error) throw error;
    
    // Format response
    const response = {
      meta: {
        total: count,
        page: pageInt,
        limit: limitInt,
        pages: Math.ceil(count / limitInt)
      },
      data: data.map(server => ({
        id: server.id,
        type: 'server',
        attributes: {
          addr: server.addr,
          ip: server.ip,
          port: server.port,
          name: server.name,
          map: server.map,
          gamemode: server.gamemode,
          players: server.players,
          maxPlayers: server.max_players,
          ping: server.ping,
          password: server.password,
          vac: server.vac,
          lastSeen: server.last_seen
        }
      }))
    };
    
    // Cache the response for 30 seconds
    await redis.set(cacheKey, JSON.stringify(response), 'EX', 30);
    
    // Send response
    res.json(response);
    
  } catch (error) {
    logger.error({ err: error, query: req.query }, 'Failed to retrieve servers');
    res.status(500).json({ error: 'Failed to retrieve servers' });
  }
});

// Get a single server by address
app.get('/api/servers/:addr', async (req, res) => {
  const { addr } = req.params;
  
  try {
    const { data, error } = await supabase
      .from('servers')
      .select('*')
      .eq('addr', addr)
      .single();
      
    if (error) throw error;
    
    if (!data) {
      return res.status(404).json({ error: 'Server not found' });
    }
    
    // Format response
    res.json({
      data: {
        id: data.id,
        type: 'server',
        attributes: {
          addr: data.addr,
          ip: data.ip,
          port: data.port,
          name: data.name,
          map: data.map,
          gamemode: data.gamemode,
          players: data.players,
          maxPlayers: data.max_players,
          ping: data.ping,
          password: data.password,
          vac: data.vac,
          status: data.status,
          lastSeen: data.last_seen,
          firstSeen: data.first_seen
        }
      }
    });
    
  } catch (error) {
    logger.error({ err: error, addr }, 'Failed to retrieve server');
    res.status(500).json({ error: 'Failed to retrieve server' });
  }
});

// Central error handling middleware
app.use((err, req, res, next) => {
  logger.error({ err: err, url: req.originalUrl }, "API Error");
  
  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    error: {
      status: statusCode.toString(),
      title: err.message || 'Internal Server Error',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.stack
    }
  });
});

// Start server if not running in a serverless environment
if (process.env.VERCEL !== '1') {
  app.listen(port, () => {
    logger.info(`API server listening on port ${port}`);
  });
}

// Handle graceful shutdown
const gracefulShutdown = async () => {
  logger.info('Shutting down API server...');
  await redis.quit();
  logger.info('API server shutdown complete');
  process.exit(0);
};

// Register shutdown handlers
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Export app for serverless environments
module.exports = app;