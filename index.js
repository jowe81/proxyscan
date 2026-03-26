const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

const logger = require('./lib/logger');
const { config, nginxPath, port, systemServices, searchThreshold, frontendPollInterval } = require('./lib/config');
const parseNginxConfigs = require('./lib/nginx');
const monitor = require('./lib/monitor');

app.get('/styles.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'styles.css'));
});

app.get('/client.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'client.js'));
});

app.get('/api/status', (req, res) => {
    res.json(monitor.getStatus());
});

app.get('/', (req, res) => {
    const statusData = monitor.getStatus();
    
    let sites = [];
    let error = null;
    if (config.serviceTypes?.nginx?.enabled) {
        const result = parseNginxConfigs(nginxPath, port);
        sites = result.sites;
        error = result.error;
    }
    
    // Add HEAD services from config
    let headServices = [];
    if (config.serviceTypes?.head?.enabled && Array.isArray(config.services)) {
        // Map to structure compatible with sites {name, url}
        headServices = config.services
            .filter(s => s.type === 'head')
            .map(s => ({ name: s.name, url: s.key, card: s.card, type: 'head' }));
    }

    // Prepare Nginx Services
    const nginxServices = sites.map(s => ({ ...s, type: 'nginx' }));

    // Prepare System Services
    const systemNodes = systemServices.map(s => ({
        name: s.name,
        key: s.key,
        card: s.card,
        type: 'systemd'
    }));

    // Prepare Ping Services
    let pingServices = [];
    if (config.serviceTypes?.ping?.enabled) {
        pingServices = (config.services || [])
            .filter(s => s.type === 'ping')
            .map(s => ({ ...s, type: 'ping' }));
    }

    const rawServices = [...nginxServices, ...headServices, ...systemNodes, ...pingServices];

    const allServices = rawServices
        .filter(svc => svc.card !== false)
        .map(svc => {
            const serviceTypeConfig = config.serviceTypes?.[svc.type];
            const groupKey = serviceTypeConfig?.group || 'other';
            
            let uniqueKey, subtitle, link = null;
            
            if (svc.type === 'nginx' || svc.type === 'head') {
                uniqueKey = svc.url;
                subtitle = svc.url;
                link = svc.url;
            } else if (svc.type === 'systemd') {
                uniqueKey = `system:${svc.key}`;
                subtitle = 'System Service';
            } else if (svc.type === 'ping') {
                uniqueKey = `ping:${svc.key}`;
                subtitle = svc.key;
            }
            
            return {
                name: svc.name,
                key: uniqueKey,
                subtitle,
                link,
                status: statusData.services[uniqueKey]?.status || 'unknown',
                groupKey
            };
        })
        .sort((a, b) => {
            const groupOrder = { 'websites': 1, 'systemServices': 2, 'networkChecks': 3 };
            const orderA = groupOrder[a.groupKey] || 99;
            const orderB = groupOrder[b.groupKey] || 99;
            if (orderA !== orderB) return orderA - orderB;
            return a.name.localeCompare(b.name);
        });

    let content = '';
    if (allServices.length > 0) {
        const listItems = allServices.map(svc => {
            const typeClass = `type-${svc.groupKey}`;
            const innerContent = `
                <span class="status-dot ${svc.status}"></span>
                <span class="name">${svc.name}</span>
                <span class="url">${svc.subtitle}</span>
                <span class="last-seen"></span>
            `;

            if (svc.link) {
                return `<li class="${typeClass}" data-key="${svc.key}"><a href="${svc.link}" rel="noopener noreferrer">${innerContent}</a></li>`;
            } else {
                return `<li class="${typeClass}" data-key="${svc.key}"><div class="service-card">${innerContent}</div></li>`;
            }
        }).join('');
        content = `<ul>${listItems}</ul>`;
    } else if (error) {
        content = `<p style="color: red;">${error}</p>`;
    } else if (config.serviceTypes?.nginx?.enabled) {
        content = `<p>No server blocks with a 'proxy_pass' to 127.0.0.1 were found in <code>${nginxPath}</code>.</p>`;
    }

    const totalServices = allServices.length;
    
    // Generate Filters
    const presentGroupKeys = [...new Set(allServices.map(s => s.groupKey))];
    const activeCheckboxes = presentGroupKeys
        .map(gKey => {
            const groupDef = config.groups?.[gKey];
            if (groupDef && groupDef.checkbox) {
                return `<label><input type="checkbox" value="type-${gKey}"> ${groupDef.name}</label>`;
            }
            return null;
        })
        .filter(Boolean);

    if (activeCheckboxes.length > 0) {
        activeCheckboxes.unshift('<label><input type="checkbox" value="all" checked> All Services</label>');
    }

    const filtersHtml = activeCheckboxes.length > 0 ? `<div id="type-filters"><span style="font-weight: 500;">Show:</span>${activeCheckboxes.join('')}</div>` : '';
    const searchInputHtml = totalServices > searchThreshold ? '<input type="search" id="service-search" placeholder="Search services..." aria-label="Search services">' : '';

    const clientScriptHtml = `<script>window.CONFIG = { pollInterval: ${frontendPollInterval} };</script>
<script src="/client.js" defer></script>`;

    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, htmlTemplate) => {
        if (err) {
            logger.error("Error reading index.html:", err);
            return res.status(500).send("Internal Server Error: Could not load template.");
        }

        const html = htmlTemplate
            .replace('{{search_bar}}', filtersHtml + searchInputHtml)
            .replace('{{internet_status}}', statusData.internet)
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
logger.info(`Frontend Poll Interval: ${frontendPollInterval}ms`);
monitor.start();
