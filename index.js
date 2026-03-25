const express = require('express');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const port = process.env.PORT || 3333;

// The path to your nginx sites-enabled directory.
// You can override this with an NGINX_SITES_PATH environment variable.
// The user's example mentioned /var/nginx/sites-enabled.
const nginxPath = process.env.NGINX_SITES_PATH || '/etc/nginx/sites-enabled';

// Comma-separated list of system services to monitor (e.g. "smbd,mongod")
const SYSTEM_SERVICES = process.env.SYSTEM_SERVICES ? process.env.SYSTEM_SERVICES.split(',').map(s => s.trim()).filter(Boolean) : ['smbd', 'mongod', 'remoteCtrlForwarder'];

// The number of services needed to show the search field.
const SEARCH_THRESHOLD = process.env.SEARCH_THRESHOLD || 3;

// The interval for backend health checks in milliseconds (pings the services).
const HEALTH_CHECK_INTERVAL_MS = process.env.HEALTH_CHECK_INTERVAL_MS || 30000;

// The interval for frontend status polling in milliseconds (updates the UI).
const FRONTEND_POLL_INTERVAL_MS = process.env.FRONTEND_POLL_INTERVAL_MS || 15000;

const serviceStatus = {};
let internetStatus = 'unknown';
const outageHistory = [];
let currentOutageStart = null;
const OUTAGES_FILE = path.join(__dirname, 'outages.json');

const logger = {
    info: (...args) => console.log(`[${new Date().toISOString()}]`, ...args),
    error: (...args) => console.error(`[${new Date().toISOString()}]`, ...args)
};

/**
 * Loads the outage history from a JSON file.
 */
function loadOutages() {
    try {
        if (!fs.existsSync(OUTAGES_FILE)) {
            fs.writeFileSync(OUTAGES_FILE, '[]');
            logger.info(`Created outages file at ${OUTAGES_FILE}`);
            return;
        }

        const data = fs.readFileSync(OUTAGES_FILE, 'utf8');
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
        fs.writeFileSync(OUTAGES_FILE, JSON.stringify(outageHistory, null, 2));
    } catch (err) {
        logger.error('Error saving outages:', err);
    }
}

/**
 * Parses Nginx configuration files to find services proxied to localhost.
 *
 * NOTE: This parser is simple and has limitations. It splits configurations
 * by 'server {' and may not work with complex or unconventionally formatted
 * Nginx configs. It assumes server blocks are not nested.
 *
 * @param {string} dirPath - The path to the directory containing Nginx config files.
 * @param {number} excludePort - The port of this service, to exclude it from the list.
 * @returns {{sites: Array<{name: string, url: string}>, error?: string}}
 */
function parseNginxConfigs(dirPath, excludePort) {
    const sites = [];
    try {
        if (!fs.existsSync(dirPath)) {
             throw new Error(`Directory not found at ${dirPath}`);
        }

        const files = fs.readdirSync(dirPath);

        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stats = fs.statSync(filePath);

            // Skip directories and symlinks to directories
            if (stats.isDirectory()) {
                continue;
            }

            const content = fs.readFileSync(filePath, 'utf8');
            // This is a simple way to split server blocks. It might fail on
            // very complex configurations, but works for typical sites-enabled files.
            const serverBlocks = content.split('server {');

            for (const block of serverBlocks) {
                // Check for a proxy_pass directive to 127.0.0.1
                if (!block.includes('proxy_pass') || !block.includes('127.0.0.1')) {
                    continue;
                }

                // If this block proxies to our own service, skip it.
                if (excludePort) {
                    const selfProxyRegex = new RegExp(`proxy_pass\\s+https?://127\\.0\\.0\\.1:${excludePort}`);
                    if (selfProxyRegex.test(block)) {
                        continue;
                    }
                }

                const proxyPassLocalMatch = block.match(/proxy_pass\s+https?:\/\/127\.0\.0\.1(:\d+)?/);
                if (!proxyPassLocalMatch) {
                    continue;
                }

                const serverNameMatch = block.match(/server_name\s+([^;]+);/);
                if (!serverNameMatch) {
                    continue;
                }

                const serverNames = serverNameMatch[1].trim().split(/\s+/);
                const url = serverNames[serverNames.length - 1];

                // Default link name is the last server_name
                let name = url;

                // Look for a "# Name:" comment on a proxy_pass line to override the name.
                const lines = block.split('\n');
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine.startsWith('proxy_pass') && trimmedLine.includes('127.0.0.1')) {
                        const nameMatch = trimmedLine.match(/#\s*Name:\s*(.*)/);
                        if (nameMatch && nameMatch[1]) {
                            name = nameMatch[1].trim();
                            break; // Name found, no need to check other proxy_pass lines in this block
                        }
                    }
                }

                // Avoid duplicates if the same server is defined multiple times.
                if (!sites.some(site => site.url === `http://${url}`)) {
                    sites.push({ name, url: `http://${url}` });
                }
            }
        }
    } catch (error) {
        logger.error(`Error reading nginx config from ${dirPath}:`, error.message);
        return { sites: [], error: `Could not read Nginx config from ${dirPath}. Error: ${error.message}` };
    }

    // Sort sites alphabetically by name for consistent ordering.
    sites.sort((a, b) => a.name.localeCompare(b.name));
    return { sites };
}

/**
 * Checks connectivity to the internet.
 */
const checkInternetStatus = async () => {
    const hosts = ['1.1.1.1', '8.8.8.8', '9.9.9.9']; // Cloudflare, Google, Quad9
    const countFlag = process.platform === 'win32' ? '-n' : '-c';

    const pingHost = (host) => new Promise((resolve) => {
        exec(`ping ${countFlag} 1 ${host}`, { timeout: 5000 }, (error) => {
            resolve(!error);
        });
    });

    // Check all hosts in parallel.
    const results = await Promise.all(hosts.map(pingHost));
    const successCount = results.filter(Boolean).length;

    if (successCount === 0) {
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
        
        if (successCount / hosts.length >= 0.5) {
            internetStatus = 'online';
        } else {
            internetStatus = 'partial';
        }
    }
};

/**
 * Checks if a systemd service is active.
 * @param {string} serviceName 
 * @returns {Promise<boolean>}
 */
const checkSystemService = (serviceName) => new Promise((resolve) => {
    exec(`systemctl is-active ${serviceName}`, { timeout: 5000 }, (error, stdout) => {
        // systemctl is-active returns 'active' and exit code 0 if running.
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
        // Only log offline if it wasn't already offline (and not undefined/initial load)
        if (previousStatus !== 'offline' && previousStatus !== undefined) logger.error(`Service has gone offline: ${serviceName}`);
        serviceStatus[key] = {
            ...serviceStatus[key],
            status: 'offline'
        };
    }
};
/**
 * Pings a single service URL to check its health and updates the status.
 * @param {string} url - The URL of the service to ping.
 */
const updateServiceStatus = async (url) => {
    const previousStatus = serviceStatus[url]?.status;

    try {
        const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        if (response.status < 200 || response.status >= 400) {
            throw new Error('Service offline'); // Treat non-success as an error to be caught
        }
        // Service is ONLINE
        if (previousStatus === 'offline') {
            logger.info(`Service came back online: ${url}`);
        }
        serviceStatus[url] = {
            status: 'online',
            lastSeenOnline: Date.now()
        };
    } catch (error) {
        // Service is OFFLINE (unreachable or non-2xx/3xx status)
        if (previousStatus !== 'offline') {
            logger.error(`Service has gone offline: ${url}`);
        }
        serviceStatus[url] = {
            ...serviceStatus[url], // This preserves lastSeenOnline from previous online state
            status: 'offline'
        };
    }
};

/**
 * Fetches the list of Nginx sites and pings all of them to update their status.
 */
const updateAllStatuses = async () => {
    await checkInternetStatus();
    const { sites } = parseNginxConfigs(nginxPath, port);
    if ((!sites || sites.length === 0) && SYSTEM_SERVICES.length === 0) {
        logger.info('No services found to ping.');
        return;
    }

    // Use Promise.all to ping all services concurrently.
    const sitePromises = sites.map(site => updateServiceStatus(site.url));
    const systemPromises = SYSTEM_SERVICES.map(svc => updateSystemServiceStatus(svc));
    await Promise.all([...sitePromises, ...systemPromises]);

    const sitesOnline = sites.filter(site => serviceStatus[site.url]?.status === 'online').length;
    const systemOnline = SYSTEM_SERVICES.filter(svc => serviceStatus[`system:${svc}`]?.status === 'online').length;
    const total = sites.length + SYSTEM_SERVICES.length;

    logger.info(`Health checks complete: ${sitesOnline + systemOnline}/${total} services online. Internet: ${internetStatus}`);
};

app.get('/styles.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'styles.css'));
});

app.get('/client.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'client.js'));
});

app.get('/api/status', (req, res) => {
    // Include the current ongoing outage in the history sent to client
    const historyToSend = [...outageHistory];
    if (currentOutageStart) {
        historyToSend.push({ start: currentOutageStart, end: null });
    }
    // Return newest outages first
    res.json({ services: serviceStatus, internet: internetStatus, outageHistory: historyToSend.reverse() });
});

app.get('/', (req, res) => {
    const { sites, error } = parseNginxConfigs(nginxPath, port);
    const sitesWithStatus = sites.map(site => ({
        ...site,
        status: serviceStatus[site.url]?.status || 'unknown'
    }));

    let content = '';

    // Websites Section
    if (sitesWithStatus.length > 0) {
        const listItems = sitesWithStatus.map(site => `<li data-key="${site.url}">
                <a href="${site.url}" rel="noopener noreferrer">
                    <span class="status-dot ${site.status}"></span>
                    <span class="name">${site.name}</span>
                    <span class="url">${site.url}</span>
                    <span class="last-seen"></span>
                </a>
            </li>`).join('');
        content += `<h2>Websites</h2><ul>${listItems}</ul>`;
    } else if (error) {
        content += `<p style="color: red;">${error}</p>`;
    } else if (SYSTEM_SERVICES.length === 0) {
        content += `<p>No server blocks with a 'proxy_pass' to 127.0.0.1 were found in <code>${nginxPath}</code>.</p>`;
    }

    // System Services Section
    if (SYSTEM_SERVICES.length > 0) {
        const listItems = SYSTEM_SERVICES.map(svc => {
            const key = `system:${svc}`;
            const status = serviceStatus[key]?.status || 'unknown';
            return `<li data-key="${key}">
                <div class="service-card">
                    <span class="status-dot ${status}"></span>
                    <span class="name">${svc}</span>
                    <span class="url">System Service</span>
                    <span class="last-seen"></span>
                </div>
            </li>`;
        }).join('');
        content += `<h2>System Services</h2><ul>${listItems}</ul>`;
    }

    const totalServices = sitesWithStatus.length + SYSTEM_SERVICES.length;
    const searchBarHtml = totalServices > SEARCH_THRESHOLD ? '<input type="search" id="service-search" placeholder="Search services..." aria-label="Search services">' : '';

    const clientScriptHtml = `<script>window.CONFIG = { pollInterval: ${FRONTEND_POLL_INTERVAL_MS} };</script>
<script src="/client.js" defer></script>`;

    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, htmlTemplate) => {
        if (err) {
            logger.error("Error reading index.html:", err);
            return res.status(500).send("Internal Server Error: Could not load template.");
        }

        const html = htmlTemplate
            .replace('{{search_bar}}', searchBarHtml)
            .replace('{{internet_status}}', internetStatus)
            .replace('{{content}}', content)
            .replace('{{client_script}}', clientScriptHtml);
        res.send(html);
    });
});

const server = app.listen(port, () => {
    logger.info(`Server listening at http://localhost:${port}`);
    logger.info(`Reading Nginx configs from: ${nginxPath}`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        logger.error(`Error: Port ${port} is already in use. Please choose a different port.`);
    } else {
        logger.error('An error occurred while starting the server:', err);
    }
    process.exit(1);
});

// Run an initial health check on startup, then set the interval for subsequent checks.
logger.info(`Health Check Interval: ${HEALTH_CHECK_INTERVAL_MS}ms`);
logger.info(`Frontend Poll Interval: ${FRONTEND_POLL_INTERVAL_MS}ms`);
loadOutages();
updateAllStatuses();
setInterval(updateAllStatuses, HEALTH_CHECK_INTERVAL_MS);
