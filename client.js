function formatTimeAgo(timestamp, short = false) {
    if (!timestamp) return '';
    const now = Date.now();
    const seconds = Math.floor((now - timestamp) / 1000);
    const suffix = short ? '' : ' ago';
    if (seconds < 2) return short ? 'now' : 'just now';
    if (seconds < 60) return `${seconds}s${suffix}`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m${suffix}`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h${suffix}`;
    const days = Math.floor(hours / 24);
    return `${days}d${suffix}`;
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
    const lastCheckedEl = tile.querySelector('.last-checked');
    if (!dot || !lastSeenEl || !lastCheckedEl) return;

    const newStatus = statusInfo.status || 'unknown';
    const urlEl = tile.querySelector('.url');

    tile.classList.remove('online', 'offline', 'partial', 'unknown');
    tile.classList.add(newStatus);

    if (urlEl && statusInfo.stats) {
        let text = `${statusInfo.stats.used} / ${statusInfo.stats.size} (${statusInfo.stats.use})`;
        if (statusInfo.raidStatus) {
            text += ` | RAID: ${statusInfo.raidStatus}`;
        }
        urlEl.textContent = text;
    }

    if (!dot.classList.contains(newStatus)) {
        dot.className = 'status-dot ' + newStatus;
    }

    if (newStatus === 'offline' && statusInfo.lastSeenOnline) {
        lastSeenEl.textContent = `Last seen: ${formatTimeAgo(statusInfo.lastSeenOnline)}`;
    } else {
        lastSeenEl.textContent = '';
    }

    if (tile.dataset.showLastChecked === 'true' && statusInfo.lastChecked) {
        lastCheckedEl.textContent = formatTimeAgo(statusInfo.lastChecked, true);
    } else {
        lastCheckedEl.textContent = '';
    }
}

// Since this script is loaded with 'defer', the DOM is guaranteed to be ready.
// Filtering Logic
const originalTitle = document.title;
let titleCycleInterval = null;
let titleCycleIndex = 0;
let currentTitles = [originalTitle];
let lastAnyDown = false;
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

        const matchesType = isAllMode || checkedTypes.some(type => {
            if (type === 'status-issue') return service.classList.contains('offline') || service.classList.contains('partial');
            return service.classList.contains(type);
        });
        
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

        const internetLabel = document.getElementById('history-btn');
        if (internetLabel && data.internet) {
            const badge = internetLabel.querySelector('.badge');
            if (badge) {
                const isOffline = data.internet === 'offline';
                badge.textContent = isOffline ? 'OFFLINE' : 'ONLINE';
                badge.style.backgroundColor = isOffline ? '#dc3545' : '#28a745';
                badge.style.color = '#fff';
            }
        }

        if (historyBtn && data.outageHistory) {
            // The button is now the status text, so we keep it visible.
            
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

        if (data.headerData) {
            Object.entries(data.headerData).forEach(([name, value]) => {
                const id = `header-item-${name.replace(/\s+/g, '-').toLowerCase()}`;
                const el = document.getElementById(id);
                if (el) {
                    const valueEl = el.querySelector('.value');
                    if (valueEl) valueEl.innerHTML = value;
                }
            });
        }

        const statuses = data.services || data;
        document.querySelectorAll('li[data-key]').forEach(serviceLi => {
            const key = serviceLi.dataset.key;
            if (statuses[key]) {
                updateTileUI(serviceLi, statuses[key]);
            }
        });

        const summaryContainer = document.getElementById('header-status-summary');
        if (summaryContainer && data.services) {
            const summaryBadge = summaryContainer.querySelector('.badge');
            const services = Object.values(data.services);
            const anyDown = services.some(s => s.status === 'offline' || s.status === 'partial');
            let summaryClass = 'online';
            let summaryText = 'Healthy';
            let bgColor = '#28a745';
            if (data.internet === 'offline') {
                summaryClass = 'offline';
                summaryText = 'No Internet';
                bgColor = '#dc3545';
            } else if (anyDown) {
                summaryClass = 'partial';
                summaryText = 'Issues';
                bgColor = "#dc3545";
            }
            if (summaryBadge) {
                summaryBadge.style.backgroundColor = bgColor;
                summaryBadge.style.color = '#fff';
                summaryBadge.textContent = summaryText;
            }

            document.body.classList.toggle('has-issues', data.internet === 'offline' || anyDown);

            const degradedFilter = document.getElementById('degraded-filter');
            if (degradedFilter) {
                const cb = degradedFilter.querySelector('input');
                if (anyDown && !lastAnyDown && cb) {
                    // Auto-check when issues first appear and uncheck others
                    cb.checked = true;
                    typeCheckboxes.forEach(other => {
                        if (other !== cb) other.checked = false;
                    });
                    filterServices();
                } else if (!anyDown && cb && cb.checked) {
                    cb.checked = false;
                    filterServices();
                }
                degradedFilter.style.display = anyDown ? 'inline' : 'none';
            }
            lastAnyDown = anyDown;
        }

        if (data.pageTitles) {
            const nextTitles = [originalTitle, ...data.pageTitles];
            const hasChanged = nextTitles.length !== currentTitles.length || 
                               nextTitles.some((t, i) => t !== currentTitles[i]);

            if (hasChanged) {
                currentTitles = nextTitles;
                if (titleCycleInterval) clearInterval(titleCycleInterval);

                if (currentTitles.length > 1) {
                    titleCycleIndex = 0;
                    document.title = currentTitles[0];
                    titleCycleInterval = setInterval(() => {
                        titleCycleIndex = (titleCycleIndex + 1) % currentTitles.length;
                        document.title = currentTitles[titleCycleIndex];
                    }, 3000);
                } else {
                    document.title = originalTitle;
                }
            }
        }

    } catch (error) {
        console.error('Failed to fetch service statuses:', error);
    }
};

updateAllStatuses();
setInterval(updateAllStatuses, window.CONFIG.pollInterval);