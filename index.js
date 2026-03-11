const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3333;

// The path to your nginx sites-enabled directory.
// You can override this with an NGINX_SITES_PATH environment variable.
// The user's example mentioned /var/nginx/sites-enabled.
const nginxPath = process.env.NGINX_SITES_PATH || '/etc/nginx/sites-enabled';

// The number of services needed to show the search field.
const SEARCH_THRESHOLD = process.env.SEARCH_THRESHOLD || 3;

// The interval for backend health checks in milliseconds (pings the services).
const HEALTH_CHECK_INTERVAL_MS = process.env.HEALTH_CHECK_INTERVAL_MS || 30000;

// The interval for frontend status polling in milliseconds (updates the UI).
const FRONTEND_POLL_INTERVAL_MS = process.env.FRONTEND_POLL_INTERVAL_MS || 15000;

const serviceStatus = {};

const logger = {
    info: (...args) => console.log(`[${new Date().toISOString()}]`, ...args),
    error: (...args) => console.error(`[${new Date().toISOString()}]`, ...args)
};

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
    const { sites } = parseNginxConfigs(nginxPath, port);
    if (!sites || sites.length === 0) {
        logger.info('No services found to ping.');
        return;
    }

    // Use Promise.all to ping all services concurrently.
    await Promise.all(sites.map(site => updateServiceStatus(site.url)));
    const onlineCount = sites.filter(site => serviceStatus[site.url]?.status === 'online').length;
    logger.info(`Health checks complete: ${onlineCount}/${sites.length} services online`);
};

app.get('/styles.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'styles.css'));
});

app.get('/client.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'client.js'));
});

app.get('/api/status', (req, res) => {
    res.json(serviceStatus);
});

app.get('/', (req, res) => {
    const { sites, error } = parseNginxConfigs(nginxPath, port);
    const sitesWithStatus = sites.map(site => ({
        ...site,
        status: serviceStatus[site.url]?.status || 'unknown'
    }));

    let content;
    if (error) {
        content = `<p style="color: red;">${error}</p>`;
    } else if (sitesWithStatus.length === 0) {
        content = `<p>No server blocks with a 'proxy_pass' to 127.0.0.1 were found in <code>${nginxPath}</code>.</p>`;
    } else {
        const listItems = sitesWithStatus.map(site => `<li data-url="${site.url}">
                <a href="${site.url}" rel="noopener noreferrer">
                    <span class="status-dot ${site.status}"></span>
                    <span class="name">${site.name}</span>
                    <span class="url">${site.url}</span>
                    <span class="last-seen"></span>
                </a>
            </li>`).join('');
        content = `<ul>${listItems}</ul>`;
    }

    const searchBarHtml = sitesWithStatus.length > SEARCH_THRESHOLD ? '<input type="search" id="service-search" placeholder="Search services..." aria-label="Search services">' : '';

    const clientScriptHtml = `<script>window.CONFIG = { pollInterval: ${FRONTEND_POLL_INTERVAL_MS} };</script>
<script src="/client.js" defer></script>`;

    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, htmlTemplate) => {
        if (err) {
            logger.error("Error reading index.html:", err);
            return res.status(500).send("Internal Server Error: Could not load template.");
        }

        const html = htmlTemplate
            .replace('{{search_bar}}', searchBarHtml)
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
updateAllStatuses();
setInterval(updateAllStatuses, HEALTH_CHECK_INTERVAL_MS);
