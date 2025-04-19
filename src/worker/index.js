const { Queue, Worker, QueueScheduler } = require('bullmq');
const IORedis = require('ioredis');
const Gamedig = require('gamedig');
const { MasterServer } = require('valve-server-query');
const { createServiceClient } = require('../utils/supabase');
const { detectGamemode } = require('../utils/gamemode-detector');
const config = require('../utils/config');
const logger = require('../utils/logger');
// Import our Redis client for non-BullMQ operations
const redisClient = require('../utils/redis');

// Setup Redis connection *specifically for BullMQ*
const connection = new IORedis(config.redis.url, {
  maxRetriesPerRequest: null
});

// Create Supabase client
const supabase = createServiceClient();

// Create queues
const masterServerQueue = new Queue('master-server-fetch', { connection });
const serverQueryQueue = new Queue('server-query', { connection });
const cleanupQueue = new Queue('offline-cleanup', { connection });

// Create queue scheduler for repeatable jobs
const masterScheduler = new QueueScheduler('master-server-fetch', { connection });
const cleanupScheduler = new QueueScheduler('offline-cleanup', { connection });

// Master Server Fetch Worker
const masterWorker = new Worker('master-server-fetch', async (job) => {
  logger.info('Starting Master Server query for CS2 servers');
  
  try {
    // Query Master Server for CS2 (AppID 730) servers
    const master = new MasterServer('hl2master.steampowered.com', 27011);
    const servers = await master.getServers({
      region: '0xFF', // All regions
      filter: `\\appid\\730` // CS2 AppID
    });
    
    logger.info(`Found ${servers.length} CS2 servers from Master Server`);
    
    // Queue individual server jobs in batches of 100
    const BATCH_SIZE = 100;
    for (let i = 0; i < servers.length; i += BATCH_SIZE) {
      const batch = servers.slice(i, i + BATCH_SIZE);
      
      const jobs = batch.map(addr => ({
        name: 'query-server',
        data: { addr },
        opts: {
          attempts: 2,
          backoff: { type: 'exponential', delay: 1000 }
        }
      }));
      
      await serverQueryQueue.addBulk(jobs);
      logger.debug(`Queued batch of ${jobs.length} server queries (${i + 1}-${i + batch.length} of ${servers.length})`);
    }
    
    // Update last successful fetch time (useful for monitoring)
    // Use the general-purpose redisClient here instead of the BullMQ connection
    await redisClient.set('last_master_update', new Date().toISOString());
    
    logger.info(`Successfully queued ${servers.length} servers for querying`);
    return { queued: servers.length };
    
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch or process Master Server list');
    throw error; // Let BullMQ handle retry
  }
}, { connection, concurrency: 1 });

// Server Query Worker
const serverWorker = new Worker('server-query', async (job) => {
  const { addr } = job.data;
  
  // Split address into host:port
  const [host, portStr] = addr.split(':');
  const port = parseInt(portStr, 10);
  
  if (!host || !port) {
    logger.warn({ addr }, 'Invalid server address received');
    return null;
  }
  
  try {
    // Query server using Gamedig
    const serverData = await Gamedig.query({
      type: 'cs2',
      host: host,
      port: port,
      requestRules: true, // Get rules for better gamemode detection
      socketTimeout: config.worker.serverQueryTimeout,
      attemptTimeout: config.worker.serverQueryTimeout + 1000
    });
    
    // Detect gamemode
    const gamemode = detectGamemode(serverData);
    
    // Format server data for database
    const serverRecord = {
      addr: addr,
      ip: host,
      port: serverData.connect ? parseInt(serverData.connect.split(':')[1]) : port,
      query_port: serverData.queryPort || port,
      steam_id: serverData.raw?.steamid || null,
      name: serverData.name,
      map: serverData.map,
      gamemode: gamemode,
      password: serverData.password || false,
      vac: serverData.raw?.secure || false,
      version: serverData.raw?.version || null,
      players: serverData.players.length,
      max_players: serverData.maxplayers,
      bots: serverData.bots?.length || 0,
      ping: serverData.ping,
      status: 'online',
      offline_since: null, // Clear offline marker
      seen_count: undefined, // Will be incremented in upsert
      missed_count: 0, // Reset counter
      updated_at: new Date().toISOString()
    };
    
    // Update server in database with upsert
    const { error } = await supabase
      .from('servers')
      .upsert({
        ...serverRecord
      }, { 
        onConflict: 'addr',
        ignoreDuplicates: false
      });
      
    // Also increment seen_count using a separate query
    // (Supabase doesn't support increment in upsert operations)
    await supabase.rpc('increment_server_seen_count', { addr_param: addr });
    
    if (error) throw error;
    
    // logger.debug({ addr }, 'Server successfully queried and updated');
    return serverRecord;
    
  } catch (error) {
    // Server query failed - handle as potentially offline
    logger.debug({ addr, err: error.message }, 'Failed to query server');
    
    try {
      // Check if server exists in database
      const { data: existingServer } = await supabase
        .from('servers')
        .select('missed_count, status')
        .eq('addr', addr)
        .single();
        
      if (existingServer) {
        // Update missed count
        const newMissedCount = (existingServer.missed_count || 0) + 1;
        const updateData = {
          missed_count: newMissedCount,
          updated_at: new Date().toISOString(),
          seen_count: 0 // Reset seen count
        };
        
        // Mark as offline if missed too many times
        if (newMissedCount >= config.worker.serverOfflineThreshold && 
            existingServer.status !== 'offline') {
          updateData.status = 'offline';
          updateData.offline_since = new Date().toISOString();
          logger.info({ addr }, 'Marking server as offline');
        }
        
        // Update server status
        const { error } = await supabase
          .from('servers')
          .update(updateData)
          .eq('addr', addr);
          
        if (error) {
          logger.error({ err: error, addr }, 'Failed to update server offline status');
        }
      } else {
        // Server not in database yet - no action needed
        // We don't want to create entries for servers we couldn't query successfully
      }
    } catch (dbError) {
      logger.error({ err: dbError, addr }, 'Database error handling offline server');
    }
    
    // Don't throw - this is a normal occurrence for offline servers
    return null;
  }
}, { connection, concurrency: config.worker.concurrency });

// Cleanup Worker - Delete servers that have been offline too long
const cleanupWorker = new Worker('offline-cleanup', async () => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - config.worker.serverDeleteThresholdDays);
  
  logger.info(`Cleaning up servers offline since ${cutoffDate.toISOString()}`);
  
  try {
    // Delete servers that have been offline for too long
    const { data, error, count } = await supabase
      .from('servers')
      .delete({ count: 'exact' })
      .eq('status', 'offline')
      .lt('offline_since', cutoffDate.toISOString());
      
    if (error) throw error;
    
    logger.info(`Deleted ${count} servers that have been offline for more than ${config.worker.serverDeleteThresholdDays} days`);
    return { deleted: count };
    
  } catch (error) {
    logger.error({ err: error }, 'Failed to clean up offline servers');
    throw error;
  }
}, { connection, concurrency: 1 });

// Create a stored procedure in Supabase for incrementing seen_count
async function createStoredProcedures() {
  try {
    const { error } = await supabase.rpc('create_increment_procedure', {});
    if (error && !error.message.includes('already exists')) {
      throw error;
    }
    logger.info('Stored procedures checked/created');
  } catch (error) {
    logger.warn({ err: error }, 'Failed to create stored procedures - trying direct SQL');
    
    // Try direct SQL execution as fallback
    try {
      const { error } = await supabase.sql`
        CREATE OR REPLACE FUNCTION increment_server_seen_count(addr_param TEXT)
        RETURNS void AS $$
        BEGIN
          UPDATE servers SET seen_count = seen_count + 1 WHERE addr = addr_param;
        END;
        $$ LANGUAGE plpgsql;
      `;
      if (error) throw error;
      logger.info('Stored procedure created via direct SQL');
    } catch (sqlError) {
      logger.error({ err: sqlError }, 'Failed to create stored procedures via direct SQL');
      // Continue anyway - application will work without this optimization
    }
  }
}

// Function to schedule repeatable jobs
async function scheduleJobs() {
  // Remove any existing repeatable jobs
  await masterServerQueue.obliterate({ force: true });
  await cleanupQueue.obliterate({ force: true });
  
  // Schedule Master Server fetch job (every 5 minutes)
  await masterServerQueue.add(
    'fetch-master-list',
    {},
    {
      jobId: 'master-fetch-schedule',
      repeat: {
        every: config.worker.masterServerQueryInterval
      },
      removeOnComplete: true,
      removeOnFail: 10 // Keep 10 failed job records
    }
  );
  
  // Schedule cleanup job (once per day)
  await cleanupQueue.add(
    'cleanup-offline-servers',
    {},
    {
      jobId: 'offline-cleanup-schedule',
      repeat: {
        pattern: '0 0 * * *' // Every day at midnight
      },
      removeOnComplete: true,
      removeOnFail: 10
    }
  );
  
  logger.info('Scheduled repeatable jobs');
}

// Function to initialize the worker process
async function initWorker() {
  try {
    logger.info('Initializing worker process');
    
    // Check for required stored procedures
    await createStoredProcedures();
    
    // Schedule repeatable jobs
    await scheduleJobs();
    
    // Add an initial job to fetch the master list immediately
    await masterServerQueue.add('fetch-master-list', {}, {
      jobId: 'master-fetch-initial',
      removeOnComplete: true
    });
    
    // Add an initial cleanup job
    await cleanupQueue.add('cleanup-offline-servers', {}, {
      jobId: 'offline-cleanup-initial',
      removeOnComplete: true
    });
    
    logger.info('Worker process initialized successfully');
  } catch (error) {
    logger.error({ err: error }, 'Failed to initialize worker process');
    process.exit(1);
  }
}

// Register event handlers for workers
masterWorker.on('completed', job => {
  logger.info(`Master Server fetch job ${job.id} completed. Queued ${job.returnvalue?.queued || 0} servers.`);
});

masterWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, `Master Server fetch job ${job?.id} failed`);
});

serverWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err, addr: job?.data?.addr }, `Server query job ${job?.id} failed with error`);
});

cleanupWorker.on('completed', job => {
  logger.info(`Cleanup job ${job.id} completed. Deleted ${job.returnvalue?.deleted || 0} servers.`);
});

cleanupWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, `Cleanup job ${job?.id} failed`);
});

// Handle graceful shutdown
const gracefulShutdown = async () => {
  logger.info('Shutting down worker process...');
  
  // Close workers and schedulers
  await Promise.allSettled([
    masterWorker.close(),
    serverWorker.close(),
    cleanupWorker.close(),
    masterScheduler.close(),
    cleanupScheduler.close()
  ]);
  
  // Close Redis connections (both BullMQ's and the general one)
  await Promise.allSettled([
    connection.quit(),
    redisClient.quit() // Assuming redisClient has a quit() or disconnect() method
  ]);
  
  logger.info('Worker process shutdown complete');
  process.exit(0);
};

// Handle termination signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Initialize worker process
initWorker();