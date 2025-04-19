require('dotenv').config();

module.exports = {
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
    anonKey: process.env.SUPABASE_ANON_KEY
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    upstash: {
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    }
  },
  
  api: {
    port: process.env.PORT || 3000
  },
  worker: {
    concurrency: parseInt(process.env.WORKER_CONCURRENCY || '20'),
    masterServerQueryInterval: parseInt(process.env.MASTER_SERVER_QUERY_INTERVAL || '300000'), // 5 min
    serverQueryTimeout: parseInt(process.env.SERVER_QUERY_TIMEOUT || '5000'), // 5 seconds
    serverOfflineThreshold: parseInt(process.env.SERVER_OFFLINE_THRESHOLD || '3'),
    serverDeleteThresholdDays: parseInt(process.env.SERVER_DELETE_THRESHOLD_DAYS || '7')
  }
};