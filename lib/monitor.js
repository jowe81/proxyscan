const fs = require('fs');
const { exec } = require('child_process');
const { config, nginxPath, port, systemServices, outagesFile, healthCheckInterval } = require('./config');
const logger = require('./logger');
const parseNginxConfigs = require('./nginx');

const serviceStatus = {};
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

const updateSystemServiceStatus = async (serviceName) => {
    const key = `system:${serviceName}`;
    const previousStatus = serviceStatus[key]?.status;
    const isOnline = await checkSystemService(serviceName);

    if (isOnline) {
        if (previousStatus === 'offline') logger.info(`Service came back online: ${serviceName}`);
        serviceStatus[key] = { status: 'online', lastSeenOnline: Date.now() };
    } else {
        if (previousStatus !== 'offline' && previousStatus !== undefined) logger.error(`Service has gone offline: ${serviceName}`);
        serviceStatus[key] = { ...serviceStatus[key], status: 'offline' };
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

    if ((!sites || sites.length === 0) && systemServices.length === 0 && headServices.length === 0 && pingServices.length === 0) {
        logger.info('No services found to ping.');
        return;
    }

    const headInterval = config.serviceTypes?.head?.interval || 0;

    const sitePromises = sites.map(site => updateServiceStatus(site.url));
    const headPromises = headServices.map(service => {
        if (headInterval > 0) {
            const lastChecked = serviceStatus[service.key]?.lastChecked || 0;
            if (Date.now() - lastChecked < headInterval) {
                return Promise.resolve();
            }
        }
        return updateServiceStatus(service.key);
    });
    const systemPromises = systemServices.map(svc => updateSystemServiceStatus(svc.key));
    const pingPromises = pingServices.map(service => updatePingServiceStatus(service));
    
    await Promise.all([...sitePromises, ...headPromises, ...systemPromises, ...pingPromises]);

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