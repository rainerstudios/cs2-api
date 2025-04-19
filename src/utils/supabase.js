const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

// Create Supabase client with service key for worker (full access)
const createServiceClient = () => 
  createClient(config.supabase.url, config.supabase.serviceKey);

// Create Supabase client with anon key for API (restricted access)
const createAnonClient = () => 
  createClient(config.supabase.url, config.supabase.anonKey);

module.exports = {
  createServiceClient,
  createAnonClient
};