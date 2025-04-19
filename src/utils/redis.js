const { Redis } = require('@upstash/redis');
const config = require('./config');
const logger = require('./logger');

// Check if using Upstash Redis REST API
const useUpstashRest = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;

// Create Redis client
let redis;

if (useUpstashRest) {
  // Use Upstash Redis REST client
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  
  logger.info('Using Upstash Redis REST client');
} else {
  // Use standard Redis client (ioredis) for local development
  const IORedis = require('ioredis');
  redis = new IORedis(config.redis.url);
  
  logger.info('Using standard Redis client (ioredis)');
}

module.exports = redis;