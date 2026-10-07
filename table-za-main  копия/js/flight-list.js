// Список рейсов: виртуальная прокрутка
const FLIGHT_ITEM_HEIGHT = 44;
const FLIGHT_VIRTUAL_THRESHOLD = 30;
let flightSearchTimer = null;
let flightListCacheSig = '';

function getFilteredFlightBases() {
    const searchInputEl = document.getElementById('flight-search-input');
    const filterText = searchInputEl ? searchInputEl.value.trim().toLowerCase() : '';

    const allBases = getValidFlightBases().sort((a, b) => {
        const pa = pinnedFlights.has(a) ? 0 : 1;
        const pb = pinnedFlights.has(b) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.localeCompare(b);
    });

    if (!filterText) return allBases;
    return allBases.filter(base => {
        const dir = getFlightDirection(base).toLowerCase();
        return base.toLowerCase().includes(filterText) || dir.includes(filterText);
    });
}

function createFlightListSectionLabel(text) {
    const header = document.createElement('div');
    header.className = 'flight-list-section-label';
    header.textContent = text;
    return header;
}

function createFlightListDivider() {
    const div = document.createElement('div');
    div.className = 'flight-list-divider';
    return div;
}

function buildFlightItemElement(base) {
    const isPinned = pinnedFlights.has(base);
    const isActive = currentFlight === base;

    const wrapper = document.createElement('div');
    wrapper.className = `flight-item group ${isActive ? 'flight-item-active' : ''}${isPinned ? ' flight-item-pinned' : ''}`;
    wrapper.dataset.base = base;

    const esc = typeof Security !== 'undefined' ? Security.escapeHtml : s => String(s || '');
    wrapper.innerHTML = `
        <button type="button" class="star-btn ${isPinned ? 'star-btn-active' : ''}"
            title="${isPinned ? 'Убрать из избранного' : 'В избранное'}">★</button>
        <div class="flight-item-body">
            <div class="flight-item-route">${esc(getFlightDirection(base))}</div>
            <div class="flight-item-code">${esc(base)}</div>
        </div>
    `;

    wrapper.onclick = (e) => {
        if (!e.target.closest('.star-btn')) selectFlight(base);
    };
    wrapper.querySelector('.star-btn').onclick = (e) => togglePinFlight(base, e);
    return wrapper;
}

function appendFlightListSections(container, filtered, showSections) {
    if (!showSections) {
        filtered.forEach(base => container.appendChild(buildFlightItemElement(base)));
        return;
    }

    const pinned = filtered.filter(b => pinnedFlights.has(b));
    const rest = filtered.filter(b => !pinnedFlights.has(b));

    if (pinned.length) {
        container.appendChild(createFlightListSectionLabel('Избранное'));
        pinned.forEach(base => container.appendChild(buildFlightItemElement(base)));
    }
    if (pinned.length && rest.length) {
        container.appendChild(createFlightListDivider());
    }
    if (rest.length) {
        if (pinned.length) container.appendChild(createFlightListSectionLabel('Все рейсы'));
        rest.forEach(base => container.appendChild(buildFlightItemElement(base)));
    }
}

function renderFlightListSimple(container, filtered) {
    container.classList.remove('flight-list-virtual-mode');
    const searchInputEl = document.getElementById('flight-search-input');
    const filterText = searchInputEl ? searchInputEl.value.trim() : '';
    const showSections = !filterText && filtered.some(b => pinnedFlights.has(b));
    appendFlightListSections(container, filtered, showSections);
}

function renderFlightListVirtual(container, filtered) {
    container.classList.add('flight-list-virtual-mode');
    const searchInputEl = document.getElementById('flight-search-input');
    const filterText = searchInputEl ? searchInputEl.value.trim() : '';
    const showSections = !filterText && filtered.some(b => pinnedFlights.has(b));
    const pinnedCount = showSections ? filtered.filter(b => pinnedFlights.has(b)).length : 0;
    const extraH = showSections ? (pinnedCount ? 52 : 0) + (pinnedCount && filtered.length > pinnedCount ? 28 : 0) : 0;
    const totalH = filtered.length * FLIGHT_ITEM_HEIGHT + extraH;

    container.innerHTML = `
        <div class="flight-list-virtual-spacer" style="height:${totalH}px;position:relative">
            <div class="flight-list-virtual-window" style="position:absolute;left:0;right:0;top:0"></div>
        </div>
    `;

    const windowEl = container.querySelector('.flight-list-virtual-window');
    let raf = null;

    function paint() {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            const scrollTop = container.scrollTop;
            const viewH = container.clientHeight || 500;
            const start = Math.max(0, Math.floor(scrollTop / FLIGHT_ITEM_HEIGHT) - 4);
            const end = Math.min(filtered.length, Math.ceil((scrollTop + viewH) / FLIGHT_ITEM_HEIGHT) + 4);
            windowEl.style.transform = `translateY(${start * FLIGHT_ITEM_HEIGHT}px)`;
            windowEl.innerHTML = '';

            if (showSections && start === 0 && pinnedCount) {
                windowEl.appendChild(createFlightListSectionLabel('Избранное'));
            }

            for (let i = start; i < end; i++) {
                if (showSections && i === pinnedCount && pinnedCount > 0 && i >= start) {
                    windowEl.appendChild(createFlightListDivider());
                    windowEl.appendChild(createFlightListSectionLabel('Все рейсы'));
                }
                windowEl.appendChild(buildFlightItemElement(filtered[i]));
            }
        });
    }

    if (container._flightListScroll) {
        container.removeEventListener('scroll', container._flightListScroll);
    }
    container._flightListScroll = paint;
    container.addEventListener('scroll', paint, { passive: true });
    paint();
}

function detachFlightListScroll(c) {
    if (c && c._flightListScroll) {
        c.removeEventListener('scroll', c._flightListScroll);
        c._flightListScroll = null;
    }
}

function getFlightListCacheSig() {
    const search = document.getElementById('flight-search-input')?.value?.trim() || '';
    const pinned = [...pinnedFlights].sort().join('\x1f');
    const sigFn = typeof getMetricsCacheSignature === 'function' ? getMetricsCacheSignature() : Object.keys(groupedData).length;
    return `${sigFn}|${currentFlight || ''}|${pinned}|${search}`;
}

function renderFlightList() {
    const c = document.getElementById('flight-list');
    if (!c) return;

    const sig = getFlightListCacheSig();
    if (flightListCacheSig === sig && c.childElementCount > 0) return;
    flightListCacheSig = sig;

    detachFlightListScroll(c);
    c.innerHTML = '';
    c.classList.remove('flight-list-virtual-mode');

    if (!Object.keys(groupedData).length) {
        c.innerHTML = '<div class="px-4 py-8 text-center text-gray-400 text-sm">Загрузите данные</div>';
        return;
    }

    const filtered = getFilteredFlightBases();
    if (filtered.length === 0) {
        c.innerHTML = '<div class="px-4 py-4 text-center text-gray-400 text-sm">Ничего не найдено</div>';
        return;
    }

    if (filtered.length >= FLIGHT_VIRTUAL_THRESHOLD) {
        renderFlightListVirtual(c, filtered);
    } else {
        renderFlightListSimple(c, filtered);
    }
}

function initFlightSearch() {
    const searchInput = document.getElementById('flight-search-input');
    if (!searchInput) return;
    searchInput.addEventListener('input', () => {
        clearTimeout(flightSearchTimer);
        flightSearchTimer = setTimeout(renderFlightList, 200);
    });
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            searchInput.value = '';
            renderFlightList();
        }
    });
}