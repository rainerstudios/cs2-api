/**
 * Detects the gamemode of a CS2 server based on name, map, and tags
 */
function detectGamemode(serverData) {
    const name = (serverData.name || '').toLowerCase();
    const map = (serverData.map || '').toLowerCase();
    const tags = Array.isArray(serverData.raw?.tags) 
      ? serverData.raw.tags 
      : (typeof serverData.raw?.tags === 'string' ? serverData.raw.tags.split(',') : []);
    
    // Rules can contain additional info but might not always be available
    const rules = serverData.raw?.rules || {};
    
    // Gamemode detection rules
    
    // Surf servers
    if (map.startsWith('surf_') || name.includes('surf') || tags.some(tag => tag.includes('surf'))) {
      return 'surf';
    }
    
    // Bunny hop servers
    if (map.startsWith('bhop_') || name.includes('bhop') || name.includes('bunnyhop') || 
        tags.some(tag => tag.includes('bhop') || tag.includes('bunnyhop'))) {
      return 'bhop';
    }
    
    // Zombie Escape
    if (map.startsWith('ze_') || name.includes('zombie') || name.includes('ze ') || 
        tags.some(tag => tag.includes('ze') || tag.includes('zombie'))) {
      return 'ze';
    }
    
    // KZ / Climb
    if (map.startsWith('kz_') || name.includes(' kz') || name.includes('climb') || 
        tags.some(tag => tag.includes('kz') || tag.includes('climb'))) {
      return 'kz';
    }
    
    // Deathmatch
    if (name.includes('deathmatch') || name.includes(' dm ') || 
        tags.some(tag => tag.includes('dm') || tag.includes('deathmatch'))) {
      return 'dm';
    }
    
    // Retake
    if (name.includes('retake') || tags.some(tag => tag.includes('retake'))) {
      return 'retake';
    }
    
    // AWP Only
    if (name.includes('awp') || map.startsWith('awp_') || 
        tags.some(tag => tag.includes('awp'))) {
      return 'awp';
    }
    
    // Aim / 1v1
    if (map.startsWith('aim_') || name.includes('aim') || name.includes('1v1') || 
        tags.some(tag => tag.includes('aim') || tag.includes('1v1'))) {
      return 'aim';
    }
    
    // Jailbreak
    if (map.startsWith('jb_') || name.includes('jail') || name.includes('jailbreak') || 
        tags.some(tag => tag.includes('jail') || tag.includes('jb'))) {
      return 'jb';
    }
    
    // GunGame / Arms Race
    if (name.includes('gungame') || name.includes('arms race') || 
        tags.some(tag => tag.includes('gungame') || tag.includes('gg'))) {
      return 'gungame';
    }
    
    // Combat Surf
    if ((map.startsWith('surf_') || name.includes('surf')) && 
        (name.includes('combat') || name.includes('dm'))) {
      return 'csurf';
    }
    
    // Minigames
    if (name.includes('minigame') || map.startsWith('mg_') || 
        tags.some(tag => tag.includes('minigame') || tag.includes('mg'))) {
      return 'mg';
    }
    
    // Hide and Seek
    if (name.includes('hide') || name.includes('prop hunt') || 
        tags.some(tag => tag.includes('hide') || tag.includes('hns'))) {
      return 'hns';
    }
    
    // Default to public/casual
    return 'public';
  }
  
  module.exports = { detectGamemode };