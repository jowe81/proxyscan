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
// Filtering Logic
const searchInput = document.getElementById('service-search');
const typeCheckboxes = document.querySelectorAll('#type-filters input[type="checkbox"]');
const services = document.querySelectorAll('ul li');

// Load saved filter state from localStorage
const savedFilters = JSON.parse(localStorage.getItem('proxyscan_filter_state') || '{}');
typeCheckboxes.forEach(cb => {
    if (Object.prototype.hasOwnProperty.call(savedFilters, cb.value)) {
        cb.checked = savedFilters[cb.value];
    }
});

function filterServices(e) {
    const allCbs = Array.from(typeCheckboxes);
    const allBtn = allCbs.find(cb => cb.value === 'all');
    const groupCbs = allCbs.filter(cb => cb.value !== 'all');

    // Handle interaction logic between "All" and specific groups
    if (e && e.target && e.target.type === 'checkbox') {
        if (e.target === allBtn && allBtn.checked) {
            // If "All" is checked, uncheck all specific groups
            groupCbs.forEach(cb => cb.checked = false);
        } else if (e.target.checked) {
            // If a specific group is checked, uncheck "All"
            if (allBtn) allBtn.checked = false;

            // If all groups are now checked, switch back to "All" mode
            if (groupCbs.length > 0 && groupCbs.every(cb => cb.checked)) {
                if (allBtn) allBtn.checked = true;
                groupCbs.forEach(cb => cb.checked = false);
            }
        }
    }

    // Fallback: If nothing is checked, automatically check "All"
    if (allBtn && !allCbs.some(cb => cb.checked)) {
        allBtn.checked = true;
    }

    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';

    const isAllMode = allBtn && allBtn.checked;
    const checkedTypes = groupCbs.filter(cb => cb.checked).map(cb => cb.value);

    // Visually grey out group filters when "All" is active
    groupCbs.forEach(cb => {
        const label = cb.parentElement;
        if (label) label.style.opacity = isAllMode ? '0.5' : '1';
    });

    // Save current filter state to localStorage
    const filterState = {};
    typeCheckboxes.forEach(cb => { filterState[cb.value] = cb.checked; });
    localStorage.setItem('proxyscan_filter_state', JSON.stringify(filterState));

    services.forEach(service => {
        const textContent = service.textContent.toLowerCase();
        const matchesSearch = textContent.includes(searchTerm);

        const matchesType = isAllMode || checkedTypes.some(type => service.classList.contains(type));
        
        service.style.display = (matchesSearch && matchesType) ? '' : 'none';
    });
}

if (searchInput) {
    searchInput.addEventListener('input', filterServices);
}
typeCheckboxes.forEach(cb => cb.addEventListener('change', filterServices));

// Apply initial filtering based on loaded state
filterServices();

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