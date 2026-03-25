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

function formatDateTime(timestamp) {
    if (!timestamp) return 'Now';
    return new Date(timestamp).toLocaleString();
}

function formatDuration(start, end) {
    const endTime = end || Date.now();
    const diffMs = endTime - start;
    const diffSecs = Math.floor(diffMs / 1000);
    return diffSecs < 60 ? `${diffSecs}s` : `${Math.floor(diffSecs/60)}m ${diffSecs%60}s`;
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

// Modal Logic
const historyBtn = document.getElementById('history-btn');
const modalBackdrop = document.getElementById('modal-backdrop');
const modal = document.getElementById('outage-modal');

function toggleModal(show) {
    const display = show ? 'block' : 'none';
    if (modalBackdrop) modalBackdrop.style.display = display;
    if (modal) modal.style.display = display;
}

if (historyBtn) historyBtn.addEventListener('click', () => toggleModal(true));
if (modalBackdrop) modalBackdrop.addEventListener('click', () => toggleModal(false));
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleModal(false);
});

const updateAllStatuses = async () => {
    try {
        const response = await fetch('/api/status');
        if (!response.ok) return;
        const data = await response.json();

        const internetDot = document.querySelector('#internet-status .status-dot');
        if (internetDot && data.internet) {
            internetDot.className = 'status-dot ' + data.internet;
        }

        if (historyBtn && data.outageHistory) {
            historyBtn.style.display = 'inline-block';
            
            const list = document.getElementById('outage-list');
            if (list) {
                if (data.outageHistory.length > 0) {
                    list.innerHTML = data.outageHistory.map(entry => `
                        <li>
                            <strong>${entry.end ? '🔴 Outage' : '⚠️ Ongoing Outage'}</strong><br>
                            ${formatDateTime(entry.start)} - ${formatDateTime(entry.end)}<br>
                            <small>Duration: ${formatDuration(entry.start, entry.end)}</small>
                        </li>
                    `).join('');
                } else {
                    list.innerHTML = '<li style="text-align: center; color: #666; font-style: italic; border: none;">No outages recorded so far.</li>';
                }
            }
        }

        const statuses = data.services || data;
        document.querySelectorAll('li[data-key]').forEach(serviceLi => {
            const key = serviceLi.dataset.key;
            if (statuses[key]) {
                updateTileUI(serviceLi, statuses[key]);
            }
        });
    } catch (error) {
        console.error('Failed to fetch service statuses:', error);
    }
};

updateAllStatuses();
setInterval(updateAllStatuses, window.CONFIG.pollInterval);