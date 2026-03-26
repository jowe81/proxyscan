const path = require('path');
const logger = require('./logger');

let config = { serviceTypes: {}, services: [] };
try {
    // Load config.json from the project root (one level up from lib)
    config = require('../config.json');
} catch (err) {
    logger.error('Error loading config.json, using defaults:', err.message);
}

const getSystemServices = () => {
    const fromEnv = process.env.SYSTEM_SERVICES 
        ? process.env.SYSTEM_SERVICES.split(',').map(s => s.trim()).filter(Boolean).map(s => ({ name: s, key: s })) 
        : [];
    
    const fromConfig = (config.services || [])
        .filter(s => s.type === 'systemd')
        .map(s => ({ name: s.name || s.key, key: s.key, card: s.card }));

    return [...fromEnv, ...fromConfig];
};

module.exports = {
    config,
    nginxPath: config.serviceTypes?.nginx?.path || process.env.NGINX_SITES_PATH || '/etc/nginx/sites-enabled',
    systemServices: getSystemServices(),
    searchThreshold: process.env.SEARCH_THRESHOLD || 3,
    healthCheckInterval: process.env.HEALTH_CHECK_INTERVAL_MS || 30000,
    frontendPollInterval: process.env.FRONTEND_POLL_INTERVAL_MS || 15000,
    port: process.env.PORT || 3333,
    outagesFile: path.join(__dirname, '..', 'outages.json')
};