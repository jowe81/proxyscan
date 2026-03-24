function formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    const now = Date.now();
    const seconds = Math.floor((now - timestamp) / 1000);
    if (seconds < 2) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function updateTileUI(tile, statusInfo) {
    const dot = tile.querySelector('.status-dot');
    const lastSeenEl = tile.querySelector('.last-seen');
    if (!dot || !lastSeenEl) return;

    const newStatus = statusInfo.status || 'unknown';
    if (!dot.classList.contains(newStatus)) {
        dot.className = 'status-dot ' + newStatus;
    }

    if (newStatus === 'offline' && statusInfo.lastSeenOnline) {
        lastSeenEl.textContent = `Last seen: ${formatTimeAgo(statusInfo.lastSeenOnline)}`;
    } else {
        lastSeenEl.textContent = '';
    }
}

// Since this script is loaded with 'defer', the DOM is guaranteed to be ready.
const searchInput = document.getElementById('service-search');
if (searchInput) {
    const services = document.querySelectorAll('ul li');
    searchInput.addEventListener('input', (e) => {
        const searchTerm = e.target.value.toLowerCase();
        services.forEach(service => {
            const textContent = service.textContent.toLowerCase();
            service.style.display = textContent.includes(searchTerm) ? '' : 'none';
        });
    });
}

const updateAllStatuses = async () => {
    try {
        const response = await fetch('/api/status');
        if (!response.ok) return;
        const data = await response.json();

        const internetDot = document.querySelector('#internet-status .status-dot');
        if (internetDot && data.internet) {
            internetDot.className = 'status-dot ' + data.internet;
        }

        const statuses = data.services || data;
        document.querySelectorAll('li[data-url]').forEach(serviceLi => {
            const url = serviceLi.dataset.url;
            if (statuses[url]) {
                updateTileUI(serviceLi, statuses[url]);
            }
        });
    } catch (error) {
        console.error('Failed to fetch service statuses:', error);
    }
};

updateAllStatuses();
setInterval(updateAllStatuses, window.CONFIG.pollInterval);