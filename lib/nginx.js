const fs = require('fs');
const path = require('path');
const logger = require('./logger');

/**
 * Parses Nginx configuration files to find services proxied to localhost.
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
            // This is a simple way to split server blocks.
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
                            break;
                        }
                    }
                }

                if (!sites.some(site => site.url === `http://${url}`)) {
                    sites.push({ name, url: `http://${url}` });
                }
            }
        }
    } catch (error) {
        logger.error(`Error reading nginx config from ${dirPath}:`, error.message);
        return { sites: [], error: `Could not read Nginx config from ${dirPath}. Error: ${error.message}` };
    }

    sites.sort((a, b) => a.name.localeCompare(b.name));
    return { sites };
}

module.exports = parseNginxConfigs;