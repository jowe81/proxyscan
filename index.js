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

    // Prepare Storage Services
    let storageServices = [];
    if (config.serviceTypes?.storageVolume?.enabled) {
        storageServices = (config.services || [])
            .filter(s => s.type === 'storageVolume')
            .map(s => ({ ...s, type: 'storageVolume' }));
    }

    const rawServices = [...nginxServices, ...headServices, ...systemNodes, ...pingServices, ...storageServices];

    const allServices = rawServices
        .filter(svc => svc.card !== false)
        .map(svc => {
            const serviceTypeConfig = config.serviceTypes?.[svc.type];
            const groupKey = serviceTypeConfig?.group || 'other';
            const groupConfig = config.groups?.[groupKey];
            
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
            } else if (svc.type === 'storageVolume') {
                uniqueKey = `storage:${svc.key}`;
                const statusEntry = statusData.services[uniqueKey];
                const stats = statusEntry?.stats;
                const raidStatus = statusEntry?.raidStatus;
                subtitle = stats ? `${stats.used} / ${stats.size} (${stats.use})` : svc.key;
                if (raidStatus) {
                    subtitle += ` | RAID: ${raidStatus}`;
                }
            }
            
            return {
                name: svc.name,
                key: uniqueKey,
                subtitle,
                link,
                status: statusData.services[uniqueKey]?.status || 'unknown',
                groupKey,
                showLastChecked: !!(serviceTypeConfig?.showLastChecked || groupConfig?.showLastChecked)
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
                <div class="status-container">
                    <div class="last-checked"></div>
                    <div class="status-dot ${svc.status}"></div>
                </div>
                <span class="name">${svc.name}</span>
                <span class="url">${svc.subtitle}</span>
                <span class="last-seen">last seen</span>
            `;

            if (svc.link) {
                const targetName = `target-${svc.link.replace(/\/+$/, '').replace(/[^a-z0-9]/gi, '-').toLowerCase()}`;
                return `<li class="${typeClass} ${svc.status}" data-key="${svc.key}" data-show-last-checked="${svc.showLastChecked}"><a href="${svc.link}" target="${targetName}">${innerContent}</a></li>`;
            } else {
                return `<li class="${typeClass} ${svc.status}" data-key="${svc.key}" data-show-last-checked="${svc.showLastChecked}"><div class="service-card">${innerContent}</div></li>`;
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

    const hasIssues = allServices.some(s => s.status === 'offline' || s.status === 'partial');
    if (activeCheckboxes.length > 0 || hasIssues) {
        activeCheckboxes.unshift('<label><input type="checkbox" value="all" checked> All Services</label>');

        activeCheckboxes.push(`<label id="degraded-filter" style="display: ${hasIssues ? 'inline' : 'none'}; color: #dc3545;"><input type="checkbox" value="status-issue"> Issues</label>`);
    }

    const filtersHtml = activeCheckboxes.length > 0 ? `<div id="type-filters"><span style="font-weight: 500;"></span>${activeCheckboxes.join('')}</div>` : '';
    const searchInputHtml = totalServices > searchThreshold ? '<input type="search" id="service-search" placeholder="Search services..." aria-label="Search services">' : '';

    // Generate Header Data Items
    const headerItemsHtml = (config.headerData || []).map(item => {
        if (item.headerKey === 'connectivity') {
            const isOffline = statusData.internet === 'offline';
            const label = isOffline ? 'OFFLINE' : 'ONLINE';
            const bgColor = isOffline ? '#dc3545' : '#28a745';

            return `<div class="header-data-item" id="internet-status">
                <span>${item.name}</span>
                <a href="#" id="history-btn" class="value" onclick="return false;">
                    <span class="value badge" style="background-color: ${bgColor}; color: #fff;">${label}</span>
                </a>
            </div>`;
        }

        if (item.headerKey === 'statusSummary') {
            let summaryText = 'Healthy';
            let bgColor = '#28a745';

            if (statusData.globalStatus === 'error') {
                summaryText = statusData.internet === 'offline' ? 'No Internet' : 'Errors';
                bgColor = '#dc3545';
            } else if (statusData.globalStatus === 'alert') {
                summaryText = statusData.internet === 'partial' ? 'Degraded' : 'Alerts';
                bgColor = '#fd7e14';
            }

            return `<div class="header-data-item" id="header-status-summary">
                <span>${item.name}</span>
                <span class="value">
                    <span class="value badge" style="background-color: ${bgColor}; color: #fff;">${summaryText}</span>
                </span>
            </div>`;
        }

        const value = statusData.headerData?.[item.name] || '...';
        const id = `header-item-${item.name.replace(/\s+/g, '-').toLowerCase()}`;
        const targetName = item.url ? `target-${item.url.replace(/\/+$/, '').replace(/[^a-z0-9]/gi, '-').toLowerCase()}` : '_blank';
        
        const valueHtml = item.url 
            ? `<a href="${item.url}" target="${targetName}" class="value">${value}</a>`
            : `<span class="value">${value}</span>`;

        return `<div class="header-data-item" id="${id}">
            <span>${item.name}</span>
            ${valueHtml}
        </div>`;
    }).join('');

    const clientScriptHtml = `<script>window.CONFIG = { pollInterval: ${frontendPollInterval} };</script>
<script src="/client.js" defer></script>`;

    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, htmlTemplate) => {
        if (err) {
            logger.error("Error reading index.html:", err);
            return res.status(500).send("Internal Server Error: Could not load template.");
        }

        const faviconGreen = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%2328a745'/></svg>";
        const faviconRed = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%23dc3545'/></svg>";
        const faviconOrange = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%23fd7e14'/></svg>";
        
        let faviconUrl = faviconGreen;
        if (statusData.globalStatus === 'error') faviconUrl = faviconRed;
        else if (statusData.globalStatus === 'alert') faviconUrl = faviconOrange;

        const bodyClass = statusData.globalStatus !== 'healthy' ? `has-${statusData.globalStatus}` : '';

        const pageTitle = config.settings?.pageTitle || 'Status Hub';
        const html = htmlTemplate
            .replace(/{{pageTitle}}/g, pageTitle)
            .replace('{{header_items}}', headerItemsHtml)
            .replace('{{search_bar}}', filtersHtml + searchInputHtml)
            .replace('{{content}}', content)
            .replace('{{favicon_url}}', faviconUrl)
            .replace('{{client_script}}', clientScriptHtml)
            .replace('<body>', `<body class="${bodyClass}">`);
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
