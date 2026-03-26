const fs = require('fs');
const { exec } = require('child_process');
const { config, nginxPath, port, systemServices, outagesFile, healthCheckInterval } = require('./config');
const logger = require('./logger');
const parseNginxConfigs = require('./nginx');

const serviceStatus = {};

const shouldSkipUpdate = (key, interval) => {
    if (!interval || interval <= 0) return false;
    const lastChecked = serviceStatus[key]?.lastChecked || 0;
    return (Date.now() - lastChecked < interval);
};

let internetStatus = 'unknown';
const outageHistory = [];
let currentOutageStart = null;

/**
 * Loads the outage history from a JSON file.
 */
function loadOutages() {
    try {
        if (!fs.existsSync(outagesFile)) {
            fs.writeFileSync(outagesFile, '[]');
            logger.info(`Created outages file at ${outagesFile}`);
            return;
        }

        const data = fs.readFileSync(outagesFile, 'utf8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
            outageHistory.push(...parsed);
        }
    } catch (err) {
        logger.error('Error loading/creating outages file:', err);
    }
}

/**
 * Saves the outage history to a JSON file.
 */
function saveOutages() {
    try {
        fs.writeFileSync(outagesFile, JSON.stringify(outageHistory, null, 2));
    } catch (err) {
        logger.error('Error saving outages:', err);
    }
}

const pingHost = (host) => new Promise((resolve) => {
    const countFlag = process.platform === 'win32' ? '-n' : '-c';
    exec(`ping ${countFlag} 1 ${host}`, { timeout: 5000 }, (error) => {
        resolve(!error);
    });
});

const evaluateInternetStatus = (pingServices) => {
    // Get status from serviceStatus for the ping services used for connectivity
    const connectivityServices = pingServices.filter(s => s.useForConnectivityCheck);
    
    if (connectivityServices.length === 0) {
         return;
    }

    const onlineCount = connectivityServices.filter(s => serviceStatus[`ping:${s.key}`]?.status === 'online').length;
    const total = connectivityServices.length;

    if (onlineCount === 0) {
        if (internetStatus !== 'offline') {
            currentOutageStart = Date.now();
        }
        internetStatus = 'offline';
    } else {
        if (internetStatus === 'offline' && currentOutageStart) {
            outageHistory.push({ start: currentOutageStart, end: Date.now() });
            currentOutageStart = null;
            saveOutages();
        }
        
        if (onlineCount / total >= 0.5) {
            internetStatus = 'online';
        } else {
            internetStatus = 'partial';
        }
    }
};

const checkSystemService = (serviceName) => new Promise((resolve) => {
    exec(`systemctl is-active ${serviceName}`, { timeout: 5000 }, (error, stdout) => {
        resolve(stdout && stdout.trim() === 'active');
    });
});

const checkRaidHealth = (device) => new Promise((resolve) => {
    // Use /proc/mdstat to avoid root permission requirements of mdadm
    const arrayName = device.replace('/dev/', '');
    fs.readFile('/proc/mdstat', 'utf8', (err, data) => {
        if (err) {
            logger.error(`Error reading /proc/mdstat: ${err.message}`);
            return resolve(null);
        }

        const lines = data.split('\n');
        const arrayIdx = lines.findIndex(l => l.startsWith(arrayName + ' :'));
        if (arrayIdx === -1) return resolve(null);

        const statusLine = lines[arrayIdx];
        const infoLine = lines[arrayIdx + 1] || '';
        const syncLine = lines[arrayIdx + 2] || '';
        if (!statusLine.includes('active')) return resolve('inactive');

        // Check for syncing actions - usually on the 3rd line of the block
        if (syncLine.includes('recovery') || syncLine.includes('resync') || syncLine.includes('reshape')) {
            return resolve('rebuilding');
        }

        // Check for degraded status indicators like [2/1] or [_U]
        const countMatch = infoLine.match(/\[(\d+)\/(\d+)\]/);
        if ((countMatch && countMatch[1] !== countMatch[2]) || infoLine.includes('_')) {
            return resolve('degraded');
        }

        resolve('clean');
    });
});

const checkStorageVolume = (path) => new Promise((resolve) => {
    // Using df to get human-readable stats for the specific path
    exec(`df -h "${path}" --output=size,used,pcent | tail -1`, { timeout: 5000 }, (error, stdout) => {
        if (error) return resolve(null);
        const parts = stdout.trim().split(/\s+/);
        if (parts.length < 3) return resolve(null);
        resolve({
            size: parts[0],
            used: parts[1],
            use: parts[2]
        });
    });
});

const updateStorageStatus = async (service) => {
    const key = `storage:${service.key}`;
    const stats = await checkStorageVolume(service.key);
    let raidStatus = null;

    if (service.options?.raid) {
        raidStatus = await checkRaidHealth(service.key);
    }

    if (stats) {
        // If RAID is degraded, mark the service as 'partial' (orange) instead of 'online'
        let overallStatus = 'online';
        if (service.options?.raid && (raidStatus === null || raidStatus === 'inactive')) {
            overallStatus = 'offline';
        } else if (raidStatus && (raidStatus.toLowerCase().includes('degraded') || raidStatus.toLowerCase().includes('rebuilding'))) {
            overallStatus = 'partial';
        }

        serviceStatus[key] = { 
            status: overallStatus, 
            stats, 
            raidStatus, 
            lastSeenOnline: overallStatus === 'offline' ? (serviceStatus[key]?.lastSeenOnline || null) : Date.now(), 
            lastChecked: Date.now() 
        };
    } else {
        serviceStatus[key] = { ...serviceStatus[key], status: 'offline', lastChecked: Date.now() };
    }
};

const updateSystemServiceStatus = async (serviceName) => {
    const key = `system:${serviceName}`;
    const previousStatus = serviceStatus[key]?.status;
    const isOnline = await checkSystemService(serviceName);

    if (isOnline) {
        if (previousStatus === 'offline') logger.info(`Service came back online: ${serviceName}`);
        serviceStatus[key] = { status: 'online', lastSeenOnline: Date.now(), lastChecked: Date.now() };
    } else {
        if (previousStatus !== 'offline' && previousStatus !== undefined) logger.error(`Service has gone offline: ${serviceName}`);
        serviceStatus[key] = { ...serviceStatus[key], status: 'offline', lastChecked: Date.now() };
    }
};

const updateServiceStatus = async (url) => {
    const previousStatus = serviceStatus[url]?.status;
    try {
        const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        if (response.status < 200 || response.status >= 400) {
            throw new Error('Service offline');
        }
        if (previousStatus === 'offline') logger.info(`Service came back online: ${url}`);
        serviceStatus[url] = { status: 'online', lastSeenOnline: Date.now(), lastChecked: Date.now() };
    } catch (error) {
        if (previousStatus !== 'offline') logger.error(`Service has gone offline: ${url}`);
        serviceStatus[url] = { ...serviceStatus[url], status: 'offline', lastChecked: Date.now() };
    }
};

const updatePingServiceStatus = async (service) => {
    const key = `ping:${service.key}`;
    const previousStatus = serviceStatus[key]?.status;
    const isOnline = await pingHost(service.key);

    if (isOnline) {
        if (previousStatus === 'offline') logger.info(`Ping service came back online: ${service.name}`);
        serviceStatus[key] = { status: 'online', lastSeenOnline: Date.now(), lastChecked: Date.now() };
    } else {
        if (previousStatus !== 'offline' && previousStatus !== undefined) logger.error(`Ping service has gone offline: ${service.name}`);
        serviceStatus[key] = { ...serviceStatus[key], status: 'offline', lastChecked: Date.now() };
    }
};

const updateAllStatuses = async () => {
    let sites = [];
    if (config.serviceTypes?.nginx?.enabled) {
        const result = parseNginxConfigs(nginxPath, port);
        sites = result.sites;
    }

    let headServices = [];
    if (config.serviceTypes?.head?.enabled && Array.isArray(config.services)) {
        headServices = config.services.filter(s => s.type === 'head');
    }

    let pingServices = [];
    if (config.serviceTypes?.ping?.enabled && Array.isArray(config.services)) {
        pingServices = config.services.filter(s => s.type === 'ping');
    }

    let storageServices = [];
    if (config.serviceTypes?.storageVolume?.enabled && Array.isArray(config.services)) {
        storageServices = config.services.filter(s => s.type === 'storageVolume');
    }

    if ((!sites || sites.length === 0) && systemServices.length === 0 && headServices.length === 0 && pingServices.length === 0 && storageServices.length === 0) {
        logger.info('No services found to ping.');
        return;
    }

    const headInterval = config.serviceTypes?.head?.interval || 0;
    const storageInterval = config.serviceTypes?.storageVolume?.interval || 0;

    const sitePromises = sites.map(site => updateServiceStatus(site.url));
    const headPromises = headServices.map(service => {
        if (shouldSkipUpdate(service.key, headInterval)) return Promise.resolve();
        return updateServiceStatus(service.key);
    });
    const systemPromises = systemServices.map(svc => updateSystemServiceStatus(svc.key));
    const pingPromises = pingServices.map(service => updatePingServiceStatus(service));
    const storagePromises = storageServices.map(service => {
        const key = `storage:${service.key}`;
        if (shouldSkipUpdate(key, storageInterval)) return Promise.resolve();
        return updateStorageStatus(service);
    });
    
    await Promise.all([...sitePromises, ...headPromises, ...systemPromises, ...pingPromises, ...storagePromises]);

    // Evaluate internet status after ping services have been updated
    evaluateInternetStatus(pingServices);

    const sitesOnline = sites.filter(site => serviceStatus[site.url]?.status === 'online').length;
    const headOnline = headServices.filter(s => serviceStatus[s.key]?.status === 'online').length;
    const systemOnline = systemServices.filter(svc => serviceStatus[`system:${svc.key}`]?.status === 'online').length;
    const pingOnline = pingServices.filter(s => serviceStatus[`ping:${s.key}`]?.status === 'online').length;
    
    const total = sites.length + headServices.length + systemServices.length + pingServices.length;

    logger.info(`Health checks complete: ${sitesOnline + headOnline + systemOnline + pingOnline}/${total} services online. Internet: ${internetStatus}`);
};

function getStatus() {
    const historyToSend = [...outageHistory];
    if (currentOutageStart) {
        historyToSend.push({ start: currentOutageStart, end: null });
    }
    return { 
        services: serviceStatus, 
        internet: internetStatus, 
        outageHistory: historyToSend.reverse() 
    };
}

function start() {
    loadOutages();
    updateAllStatuses();
    setInterval(updateAllStatuses, healthCheckInterval);
    logger.info(`Health Check Interval: ${healthCheckInterval}ms`);
}

module.exports = {
    start,
    getStatus
};