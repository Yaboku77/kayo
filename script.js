// --- Constants and Global Variables ---
const ANILIST_API_URL = 'https://graphql.anilist.co';
const STREAMING_API_BASE_URL = 'https://api-pearl-seven-88.vercel.app'; // User-provided API

let searchTimeoutId = null;
let featuredSwiper = null; // Swiper instance for index page
let plyrPlayer = null; // Plyr instance for episode page
let currentEpisodeData = null; // Holds data for the episode page { streamingId, episodeId, aniListId, episodes: [], currentSource: {} }
let hlsInstance = null; // HLS.js instance

// --- AniList API Queries ---
// Browse Query (for index.html) - Unchanged
const ANILIST_BROWSE_QUERY = `
    query ($page: Int, $perPageTrending: Int, $perPagePopularGrid: Int, $perPageTop: Int, $season: MediaSeason, $seasonYear: Int) {
        trending: Page(page: $page, perPage: $perPageTrending) {
            media(sort: TRENDING_DESC, type: ANIME, isAdult: false) { ...mediaBrowseFields }
        }
        popular: Page(page: $page, perPage: $perPagePopularGrid) {
            media(sort: POPULARITY_DESC, type: ANIME, isAdult: false, season: $season, seasonYear: $seasonYear) { ...mediaBrowseFields }
        }
        top: Page(page: $page, perPage: $perPageTop) {
            media(sort: SCORE_DESC, type: ANIME, isAdult: false) { ...mediaBrowseFields }
        }
    }
    fragment mediaBrowseFields on Media {
        id
        title { romaji english native }
        coverImage { extraLarge large medium color }
        bannerImage
        averageScore
        popularity
        episodes
        status
        genres
        format
        description(asHtml: false)
        seasonYear // Added seasonYear for potential matching later if needed
    }
`;

// Detail Query (for anime.html) - Unchanged (already includes format, seasonYear)
const ANILIST_DETAIL_QUERY = `
    query ($id: Int) {
        Media(id: $id, type: ANIME) {
            id
            title { romaji english native }
            description(asHtml: false)
            genres
            averageScore
            popularity
            status
            episodes
            duration
            format # e.g., TV, MOVIE, OVA
            season
            seasonYear # e.g., 2023
            startDate { year month day }
            endDate { year month day }
            coverImage { extraLarge large color }
            bannerImage
            trailer { id site thumbnail }
            characters(sort: [ROLE, RELEVANCE, ID], perPage: 12) {
                edges { role node { id name { full } image { large } } }
            }
            staff(sort: [RELEVANCE, ID], perPage: 12) {
                edges { role node { id name { full } image { large } } }
            }
            relations {
                edges { relationType(version: 2) node { id type format title { romaji english native } coverImage { large } } }
            }
            studios(isMain: true) { nodes { id name } }
        }
    }
`;

// Search Query (used by both pages) - Unchanged
const ANILIST_SEARCH_QUERY = `
    query ($search: String, $perPage: Int) {
        Page(page: 1, perPage: $perPage) {
            media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) {
                id
                title { romaji english native }
                coverImage { medium }
                format
            }
        }
    }
`;


// --- Utility Functions ---
function getCurrentSeason() {
    const now = new Date();
    const month = now.getMonth();
    const year = now.getFullYear();
    let season;
    if (month >= 0 && month <= 2) season = 'WINTER';
    else if (month >= 3 && month <= 5) season = 'SPRING';
    else if (month >= 6 && month <= 8) season = 'SUMMER';
    else season = 'FALL';
    return { season, year };
}

function sanitizeDescription(desc) {
    if (!desc) return 'No description available.';
    let sanitized = desc.replace(/<br\s*\/?>/gi, '\n');
    sanitized = sanitized.replace(/<[^>]+>/g, '');
    return sanitized.trim();
}

function debounce(func, delay) {
    let timeoutId;
    return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

function getUrlParams() {
    const params = {};
    const queryString = window.location.search;
    const urlParams = new URLSearchParams(queryString);
    for (const [key, value] of urlParams.entries()) {
        params[key] = value;
    }
    return params;
}

/**
 * Maps AniList format to the format string typically used in the streaming API search results.
 * This is a heuristic and might need adjustment based on actual API values.
 * @param {string} aniListFormat - Format from AniList (e.g., "TV", "MOVIE", "OVA", "ONA", "SPECIAL", "MUSIC").
 * @returns {string} Corresponding format string (e.g., "TV Series", "Movie", "OVA").
 */
function mapAniListFormatToStreamingFormat(aniListFormat) {
    if (!aniListFormat) return null;
    const format = aniListFormat.toUpperCase();
    switch (format) {
        case 'TV': return 'TV Series';
        case 'TV_SHORT': return 'TV Series'; // Group shorts with TV
        case 'MOVIE': return 'Movie';
        case 'SPECIAL': return 'Special';
        case 'OVA': return 'OVA';
        case 'ONA': return 'ONA';
        case 'MUSIC': return 'Music';
        default: return null; // Unknown or unmappable
    }
}

// --- API Fetching ---
async function fetchAniListApi(query, variables) {
    try {
        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: query, variables: variables })
        };
        console.log('Fetching AniList:', { query: query.substring(0, 100) + '...', variables });
        const response = await fetch(ANILIST_API_URL, options);
        if (!response.ok) {
            throw new Error(`AniList HTTP error! status: ${response.status} ${response.statusText}`);
        }
        const result = await response.json();
        if (result.errors) {
            console.error('AniList GraphQL Errors:', result.errors);
            const message = result.errors[0]?.message || 'Unknown GraphQL error';
            throw new Error(`Error fetching data from AniList API: ${message}`);
        }
        console.log('AniList Response:', result.data);
        return result.data;
    } catch (error) {
        console.error("AniList API Fetch Error:", error);
        throw error;
    }
}

async function fetchStreamingApi(endpoint, errorMessage = 'Error fetching streaming data') {
    const url = `${STREAMING_API_BASE_URL}${endpoint}`;
    try {
        console.log('Fetching Streaming API:', url);
        const response = await fetch(url);
        if (!response.ok) {
            let errorBody = null;
            try { errorBody = await response.json(); } catch (e) { /* ignore */ }
            console.error(`Streaming API HTTP error! Status: ${response.status}`, errorBody);
            const message = errorBody?.message || response.statusText || 'Unknown error';
            throw new Error(`${errorMessage}: ${message} (Status: ${response.status})`);
        }
        const data = await response.json();
        console.log('Streaming API Response:', data);
        // Basic check for empty results that might indicate "not found"
         if (data && endpoint.includes('/search') && (!data.results || data.results.length === 0)) {
             console.warn(`Streaming API returned no search results for ${endpoint}`);
             return { results: [] }; // Ensure consistent structure
         }
         if (data && endpoint.includes('/info') && (!data.episodes || data.episodes.length === 0)) {
             // If info endpoint returns no episodes, it might be valid (e.g., movie) or an error
             console.warn(`Streaming API returned no episodes in info for ${endpoint}`);
             // Return data as is, let caller decide if it's an error
         }
         if (data && endpoint.includes('/watch') && (!data.sources || data.sources.length === 0)) {
             console.warn(`Streaming API returned no sources for watch endpoint ${endpoint}`);
             // Return data as is, caller handles no sources
         }
        return data;
    } catch (error) {
        console.error("Streaming API Fetch Error:", error);
        if (!error.message.startsWith(errorMessage)) {
            throw new Error(`${errorMessage}: ${error.message}`);
        }
        throw error;
    }
}

// --- Specific Streaming API Functions ---
// (searchAnimeOnStreamingAPI is removed as logic is moved into initAnimePage)
// async function searchAnimeOnStreamingAPI(title) { ... } // No longer needed here

async function fetchAnimeInfoFromStreamingAPI(streamingId) {
    if (!streamingId) return null;
    try {
        const data = await fetchStreamingApi(`/anime/zoro/info?id=${encodeURIComponent(streamingId)}`, `Error fetching info for ID "${streamingId}"`);
        return data || null;
    } catch (error) {
        console.error(`Failed to fetch streaming API info for ID "${streamingId}":`, error);
        return null;
    }
}

async function fetchEpisodeStreamLinks(episodeId, server = 'vidcloud') {
    if (!episodeId) return null;
    try {
        const data = await fetchStreamingApi(`/anime/zoro/watch?episodeId=${encodeURIComponent(episodeId)}&server=${server}`, `Error fetching stream links for episode "${episodeId}"`);
        // Ensure sources is always an array, even if null/undefined in response
        if (data && !data.sources) {
            data.sources = [];
        }
        return data || { sources: [] }; // Return empty sources object if null
    } catch (error) {
        console.error(`Failed to fetch stream links for episode "${episodeId}" on server "${server}":`, error);
        return null;
    }
}


// --- HTML Generation Helpers ---
// createFeaturedSlideHTML, createAnimeCardHTML, createTopAnimeListItemHTML, createSearchSuggestionHTML - Unchanged
function createFeaturedSlideHTML(anime) {
    const title = anime.title.english || anime.title.romaji || anime.title.native || 'Untitled';
    const imageUrl = anime.bannerImage || anime.coverImage.extraLarge || `https://placehold.co/1200x450/${(anime.coverImage.color || '7e22ce').substring(1)}/ffffff?text=Featured`;
    const fallbackImage = `https://placehold.co/1200x450/${(anime.coverImage.color || '7e22ce').substring(1)}/ffffff?text=Featured`;
    const description = sanitizeDescription(anime.description);
    const genres = anime.genres ? anime.genres.slice(0, 3).join(' • ') : 'N/A';
    return `
        <a href="anime.html?id=${anime.id}" class="swiper-slide cursor-pointer block group" style="background-image: url('${imageUrl}')" onerror="this.style.backgroundImage='url(\\'${fallbackImage}\\')'">
            <div class="slide-text-content p-6 md:p-8 lg:p-10 w-full md:w-3/4 lg:w-2/3 pointer-events-none">
                <p class="text-xs uppercase tracking-wider text-gray-400 mb-1">${genres}</p>
                <h2 class="text-3xl md:text-4xl lg:text-5xl font-bold text-white mb-2 line-clamp-2 group-hover:text-purple-300 transition-colors duration-200">${title}</h2>
                <p class="text-sm text-gray-300 mb-4 line-clamp-2 hidden sm:block">${description}</p>
                <span class="inline-block bg-purple-600 text-white font-bold py-2 px-4 rounded-lg transition duration-300 text-sm shadow-md pointer-events-auto mt-2 group-hover:bg-purple-700">
                    More Info
                </span>
            </div>
        </a>
    `;
}
function createAnimeCardHTML(anime) {
    const title = anime.title.english || anime.title.romaji || anime.title.native || 'Untitled';
    const imageUrl = anime.coverImage.large || `https://placehold.co/185x265/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=No+Image`;
    const fallbackImage = `https://placehold.co/185x265/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=No+Image`;
    const score = anime.averageScore ? `${anime.averageScore}%` : 'N/A';
    const episodes = anime.episodes ? `${anime.episodes} Ep` : (anime.status === 'RELEASING' ? 'Airing' : 'N/A');
    const genres = anime.genres ? anime.genres.slice(0, 2).join(', ') : 'N/A'; // Show fewer genres
    return `
        <a href="anime.html?id=${anime.id}" class="block bg-gray-800 rounded-lg overflow-hidden shadow-lg cursor-pointer group transition-all duration-300 hover:scale-105 hover:shadow-purple-900/30 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-offset-2 focus:ring-offset-gray-900">
            <img src="${imageUrl}" alt="${title}" class="w-full h-48 sm:h-56 md:h-64 object-cover pointer-events-none" onerror="this.onerror=null;this.src='${fallbackImage}';" loading="lazy"/>
            <div class="p-3 pointer-events-none">
                <h3 class="text-sm font-semibold truncate text-white group-hover:text-purple-300 transition-colors" title="${title}">${title}</h3>
                <div class="flex justify-between items-center text-xs text-gray-400 mt-1">
                    <span>${episodes}</span>
                    <span class="text-yellow-400 flex items-center">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3 h-3 mr-1 text-yellow-400"><path fill-rule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" clip-rule="evenodd" /></svg>
                        ${score}
                    </span>
                </div>
                <div class="text-xs text-gray-500 mt-1 truncate" title="${genres}">${genres}</div>
            </div>
        </a>`;
}
function createTopAnimeListItemHTML(anime, rank) {
    const title = anime.title.english || anime.title.romaji || anime.title.native || 'Untitled';
    const imageUrl = anime.coverImage.medium || `https://placehold.co/50x70/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=N/A`;
    const fallbackImage = `https://placehold.co/50x70/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=N/A`;
    const score = anime.averageScore ? `${anime.averageScore}%` : 'N/A';
    return `
        <li>
            <a href="anime.html?id=${anime.id}" class="flex items-center space-x-3 p-2 hover:bg-gray-700 rounded-md transition duration-200 cursor-pointer group focus:outline-none focus:ring-1 focus:ring-purple-500">
                <span class="text-lg font-bold text-purple-400 w-6 text-center flex-shrink-0">${rank + 1}</span>
                <img src="${imageUrl}" alt="${title}" class="w-10 h-14 object-cover rounded flex-shrink-0 pointer-events-none" onerror="this.onerror=null;this.src='${fallbackImage}';" loading="lazy"/>
                <div class="flex-1 overflow-hidden pointer-events-none">
                    <h4 class="text-sm font-medium truncate text-white group-hover:text-purple-300 transition-colors" title="${title}">${title}</h4>
                    <p class="text-xs text-gray-400">Score: ${score}</p>
                </div>
            </a>
        </li>`;
}
function createSearchSuggestionHTML(media) {
    const title = media.title.english || media.title.romaji || media.title.native || 'Untitled';
    const imageUrl = media.coverImage.medium || `https://placehold.co/40x60/1f2937/4a5568?text=N/A`;
    const fallbackImage = `https://placehold.co/40x60/1f2937/4a5568?text=N/A`;
    const format = media.format ? media.format.replace(/_/g, ' ') : '';
    return `
        <a href="anime.html?id=${media.id}" class="flex items-center p-2 hover:bg-gray-700 cursor-pointer suggestion-item rounded-md focus:outline-none focus:ring-1 focus:ring-purple-500">
            <img src="${imageUrl}" alt="${title}" class="w-10 h-14 object-cover rounded mr-3 flex-shrink-0 pointer-events-none" onerror="this.onerror=null;this.src='${fallbackImage}';" loading="lazy"/>
            <div class="overflow-hidden pointer-events-none">
                <p class="text-sm font-medium text-gray-200 truncate">${title}</p>
                <p class="text-xs text-gray-400">${format || 'Anime'}</p>
            </div>
        </a>
    `;
}
function createDetailEpisodeLinkHTML(episode, streamingId, aniListId) {
    if (!episode || !episode.id || !streamingId || !aniListId) return '';
    const episodeNumber = episode.number || '?';
    const episodeUrl = `episode.html?streamingId=${encodeURIComponent(streamingId)}&episodeId=${encodeURIComponent(episode.id)}&aniListId=${aniListId}`;
    return `
        <li>
            <a href="${episodeUrl}" class="episode-link" title="Watch Episode ${episodeNumber}">
                Ep ${episodeNumber}
            </a>
        </li>
    `;
}
function createSidebarEpisodeItemHTML(episode, streamingId, aniListId, isActive = false) {
    if (!episode || !episode.id || !streamingId || !aniListId) return '';
    const episodeNumber = episode.number || '?';
    const episodeTitle = episode.title ? `: ${episode.title}` : '';
    const episodeUrl = `episode.html?streamingId=${encodeURIComponent(streamingId)}&episodeId=${encodeURIComponent(episode.id)}&aniListId=${aniListId}`;
    const activeClass = isActive ? 'active' : '';
    return `
        <li>
            <a href="${episodeUrl}"
               class="episode-list-item ${activeClass}"
               data-episode-id="${episode.id}"
               title="Episode ${episodeNumber}${episodeTitle}">
                <span class="line-clamp-1">Ep ${episodeNumber}${episodeTitle}</span>
            </a>
        </li>
    `;
}


// --- Swiper Initialization ---
function initializeFeaturedSwiper(containerSelector = '#featured-swiper') {
     if (typeof Swiper === 'undefined') { console.error("Swiper library not loaded."); return; }
     if (featuredSwiper) { try { featuredSwiper.destroy(true, true); } catch (e) { console.warn("Error destroying previous Swiper instance:", e); } featuredSwiper = null; }
     const swiperContainer = document.querySelector(containerSelector);
     if (!swiperContainer) { console.warn(containerSelector + " container not found for Swiper."); return; }
     const slides = swiperContainer.querySelectorAll('.swiper-slide');
     if (slides.length === 0) { console.warn("No slides found in " + containerSelector + ". Swiper not initialized."); return; }

     try {
         featuredSwiper = new Swiper(containerSelector, {
             modules: [Swiper.Navigation, Swiper.Pagination, Swiper.Autoplay, Swiper.EffectFade, Swiper.Keyboard, Swiper.A11y],
             loop: slides.length > 1,
             autoplay: { delay: 5000, disableOnInteraction: false, pauseOnMouseEnter: true },
             pagination: { el: containerSelector + ' .swiper-pagination', clickable: true },
             effect: 'fade',
             fadeEffect: { crossFade: true },
             observer: true, observeParents: true,
             keyboard: { enabled: true, onlyInViewport: false },
             a11y: { prevSlideMessage: 'Previous slide', nextSlideMessage: 'Next slide', paginationBulletMessage: 'Go to slide {{index}}' },
         });
         console.log("Swiper initialized successfully.");
     } catch (e) { console.error("Error initializing Swiper:", e); }
}

// --- Search Functionality ---
function setupSearch(searchInputId = 'search-input', suggestionsContainerId = 'search-suggestions', searchIconButtonId = 'search-icon-button', headerTitleSelector = 'header a.text-2xl', mobileMenuButtonId = 'mobile-menu-button') {
    const searchInput = document.getElementById(searchInputId);
    const searchSuggestionsContainer = document.getElementById(suggestionsContainerId);
    const searchIconButton = document.getElementById(searchIconButtonId);
    const headerTitle = document.querySelector(headerTitleSelector);
    const mobileMenuButton = document.getElementById(mobileMenuButtonId);

    if (!searchInput || !searchSuggestionsContainer) {
        console.warn("Search input or suggestions container not found. Search disabled.");
        return;
    }

    function showSearchSuggestions() { searchSuggestionsContainer.classList.remove('hidden'); }
    function hideSearchSuggestions() { searchSuggestionsContainer.classList.add('hidden'); }

    async function fetchAndDisplaySuggestions(term) {
        if (!term || term.length < 3) { hideSearchSuggestions(); return; }
        const variables = { search: term, perPage: 6 };
        try {
            const data = await fetchAniListApi(ANILIST_SEARCH_QUERY, variables);
            const mediaList = data?.Page?.media || [];
            if (mediaList.length === 0) {
                searchSuggestionsContainer.innerHTML = '<p class="text-gray-400 text-sm p-3 text-center">No results found.</p>';
            } else {
                searchSuggestionsContainer.innerHTML = mediaList.map(media => createSearchSuggestionHTML(media)).join('');
            }
            showSearchSuggestions();
        } catch (error) {
            console.error('Fetch Suggestions Error:', error);
            searchSuggestionsContainer.innerHTML = `<p class="text-red-500 text-sm p-3 text-center">Error loading suggestions.</p>`;
            showSearchSuggestions();
        }
    }

    const debouncedFetch = debounce(fetchAndDisplaySuggestions, 350);
    searchInput.addEventListener('input', (e) => { debouncedFetch(e.target.value.trim()); });
    searchInput.addEventListener('focus', () => { if (searchInput.value.trim().length >= 3) { fetchAndDisplaySuggestions(searchInput.value.trim()); } });
    searchInput.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== searchInput && !searchSuggestionsContainer?.contains(document.activeElement)) { hideSearchSuggestions(); if (window.innerWidth < 1024 && !searchInput.classList.contains('hidden') && typeof toggleMobileSearch === 'function') { toggleMobileSearch(false); } } }, 150); });

    function toggleMobileSearch(show) {
        if (window.innerWidth >= 1024) return;
        const searchContainer = searchInput.parentElement;
        if (show) {
            if(headerTitle) headerTitle.classList.add('hidden');
            if(mobileMenuButton) mobileMenuButton.classList.add('hidden');
            if(searchIconButton) searchIconButton.classList.add('hidden');
            searchInput.classList.remove('hidden', 'lg:block');
            searchInput.classList.add('block', 'w-full');
            if(searchContainer) searchContainer.classList.add('flex-grow');
            searchInput.focus();
        } else {
             if(headerTitle) headerTitle.classList.remove('hidden');
             if(mobileMenuButton) mobileMenuButton.classList.remove('hidden');
             if(searchIconButton) searchIconButton.classList.remove('hidden');
             searchInput.classList.remove('block', 'w-full');
             searchInput.classList.add('hidden', 'lg:block');
             if(searchContainer) searchContainer.classList.remove('flex-grow');
             searchInput.value = '';
             hideSearchSuggestions();
        }
    }
    window.toggleMobileSearch = toggleMobileSearch;
    if(searchIconButton) { searchIconButton.addEventListener('click', () => toggleMobileSearch(true)); }
    document.addEventListener('click', (event) => { const isClickInsideSearch = searchInput?.contains(event.target) || searchSuggestionsContainer?.contains(event.target) || searchIconButton?.contains(event.target); if (!isClickInsideSearch) { hideSearchSuggestions(); if (window.innerWidth < 1024 && searchInput && !searchInput.classList.contains('hidden') && typeof toggleMobileSearch === 'function') { toggleMobileSearch(false); } } });
}

// --- Mobile Menu Functionality ---
function setupMobileMenu(menuButtonId = 'mobile-menu-button', sidebarContainerId = 'mobile-sidebar-container', sidebarId = 'mobile-sidebar', overlayId = 'sidebar-overlay', closeButtonId = 'close-sidebar-button', navLinkClass = '.mobile-nav-link') {
    const mobileMenuButton = document.getElementById(menuButtonId);
    const mobileSidebarContainer = document.getElementById(sidebarContainerId);
    const mobileSidebar = document.getElementById(sidebarId);
    const sidebarOverlay = document.getElementById(overlayId);
    const closeSidebarButton = document.getElementById(closeButtonId);
    const mobileNavLinks = document.querySelectorAll(navLinkClass);

    if (!mobileMenuButton || !mobileSidebarContainer || !mobileSidebar || !sidebarOverlay || !closeSidebarButton) { console.warn("Mobile menu elements not found. Menu disabled."); return; }

    function openMobileMenu() { mobileSidebarContainer.classList.remove('pointer-events-none'); sidebarOverlay.classList.remove('hidden'); mobileSidebar.classList.remove('-translate-x-full'); document.body.classList.add('modal-open'); mobileMenuButton.setAttribute('aria-expanded', 'true'); mobileSidebar.focus(); }
    function closeMobileMenu() { mobileSidebar.classList.add('-translate-x-full'); sidebarOverlay.classList.add('hidden'); mobileSidebarContainer.classList.add('pointer-events-none'); document.body.classList.remove('modal-open'); mobileMenuButton.setAttribute('aria-expanded', 'false'); mobileMenuButton.focus(); }

    mobileMenuButton.addEventListener('click', openMobileMenu);
    closeSidebarButton.addEventListener('click', closeMobileMenu);
    sidebarOverlay.addEventListener('click', closeMobileMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mobileSidebarContainer.classList.contains('pointer-events-none')) { closeMobileMenu(); } });
    mobileNavLinks.forEach(link => { link.addEventListener('click', () => { setTimeout(closeMobileMenu, 100); }); });
}

// --- Footer Year ---
function setFooterYear(footerYearId = 'footer-year') {
    const footerYearSpan = document.getElementById(footerYearId);
    if(footerYearSpan) footerYearSpan.textContent = new Date().getFullYear();
}


// --- Page Specific Initialization ---

/**
 * Initializes the Index (Browse) Page
 */
async function initIndexPage() {
    console.log("Initializing Index Page");
    setFooterYear();
    setupSearch();
    setupMobileMenu();

    const swiperWrapperFeatured = document.getElementById('swiper-wrapper-featured');
    const trendingGrid = document.getElementById('trending-grid');
    const popularGrid = document.getElementById('popular-grid');
    const topAnimeListDesktop = document.getElementById('top-anime-list-desktop');
    const topAnimeListMobile = document.getElementById('top-anime-list-mobile');
    const topAnimeListBottomMobile = document.getElementById('top-anime-list-bottom-mobile');
    const errorMessageDiv = document.getElementById('error-message');

    if (errorMessageDiv) errorMessageDiv.classList.add('hidden');
    const { season, year } = getCurrentSeason();
    const variables = { page: 1, perPageTrending: 10, perPagePopularGrid: 10, perPageTop: 10, season: season, seasonYear: year };

    try {
        const data = await fetchAniListApi(ANILIST_BROWSE_QUERY, variables);
        const hasTrending = data.trending?.media?.length > 0;
        const hasPopular = data.popular?.media?.length > 0;
        const hasTop = data.top?.media?.length > 0;

        if (hasTrending && swiperWrapperFeatured) {
            swiperWrapperFeatured.innerHTML = '';
            data.trending.media.slice(0, 5).forEach(anime => { swiperWrapperFeatured.innerHTML += createFeaturedSlideHTML(anime); });
            setTimeout(() => initializeFeaturedSwiper(), 0);
        } else if (swiperWrapperFeatured) { swiperWrapperFeatured.innerHTML = '<div class="swiper-slide flex items-center justify-center h-full"><p class="text-gray-400 p-4">Could not load featured anime.</p></div>'; }

        if (hasTrending && trendingGrid) {
            trendingGrid.innerHTML = '';
            data.trending.media.slice(0, 10).forEach(anime => { trendingGrid.innerHTML += createAnimeCardHTML(anime); });
        } else if (trendingGrid) { trendingGrid.innerHTML = '<p class="text-gray-400 col-span-full p-4 text-center">Could not load trending anime.</p>'; }

        if (hasPopular && popularGrid) {
            popularGrid.innerHTML = '';
            data.popular.media.forEach(anime => { popularGrid.innerHTML += createAnimeCardHTML(anime); });
        } else if (popularGrid) { popularGrid.innerHTML = '<p class="text-gray-400 col-span-full p-4 text-center">Could not load popular anime for this season.</p>'; }

        if (hasTop) {
            const topAnimeHTML = data.top.media.map((anime, index) => createTopAnimeListItemHTML(anime, index)).join('');
            if (topAnimeListDesktop) topAnimeListDesktop.innerHTML = topAnimeHTML;
            if (topAnimeListMobile) topAnimeListMobile.innerHTML = topAnimeHTML;
            if (topAnimeListBottomMobile) topAnimeListBottomMobile.innerHTML = topAnimeHTML;
        } else {
            const errorMsg = '<li><p class="text-gray-400 p-2">Could not load top anime.</p></li>';
            if (topAnimeListDesktop) topAnimeListDesktop.innerHTML = errorMsg;
            if (topAnimeListMobile) topAnimeListMobile.innerHTML = errorMsg;
            if (topAnimeListBottomMobile) topAnimeListBottomMobile.innerHTML = errorMsg;
        }
    } catch (error) {
        console.error('Fetch Browse Error:', error);
        if(errorMessageDiv) { errorMessageDiv.textContent = `Failed to load page data. Please try again later. (${error.message})`; errorMessageDiv.classList.remove('hidden'); }
        if (swiperWrapperFeatured) swiperWrapperFeatured.innerHTML = '<div class="swiper-slide flex items-center justify-center h-full"><p class="text-red-400 p-4">Failed to load featured.</p></div>';
        if (trendingGrid) trendingGrid.innerHTML = '<p class="text-red-400 col-span-full p-4 text-center">Failed to load trending.</p>';
        if (popularGrid) popularGrid.innerHTML = '<p class="text-red-400 col-span-full p-4 text-center">Failed to load popular.</p>';
        const errorMsgTop = '<li><p class="text-red-400 p-2">Failed to load top anime.</p></li>';
        if (topAnimeListDesktop) topAnimeListDesktop.innerHTML = errorMsgTop;
        if (topAnimeListMobile) topAnimeListMobile.innerHTML = errorMsgTop;
        if (topAnimeListBottomMobile) topAnimeListBottomMobile.innerHTML = errorMsgTop;
    }
}


/**
 * Initializes the Anime Detail Page - WITH IMPROVED EPISODE MATCHING
 */
async function initAnimePage() {
    console.log("Initializing Anime Detail Page");
    setFooterYear();
    setupSearch();
    setupMobileMenu();

    // Get DOM elements
    const detailContentArea = document.getElementById('detail-content-area');
    const detailErrorMessage = document.getElementById('detail-error-message');
    const detailLoadingMessage = document.getElementById('detail-loading-message');
    const backButton = document.getElementById('back-button');
    const detailBanner = document.getElementById('detail-view-banner');
    const detailCoverImage = document.getElementById('detail-view-cover-image');
    const detailTitle = document.getElementById('detail-title');
    const detailGenres = document.getElementById('detail-genres');
    const detailStats = document.getElementById('detail-stats');
    const detailDescription = document.getElementById('detail-description');
    const detailTrailerSection = document.getElementById('detail-trailer-section');
    const detailTrailer = document.getElementById('detail-trailer');
    const detailCharacters = document.getElementById('detail-characters');
    const detailStaff = document.getElementById('detail-staff');
    const detailRelationsSection = document.getElementById('detail-relations-section');
    const detailRelations = document.getElementById('detail-relations');
    const detailEpisodesSection = document.getElementById('detail-episodes-section');
    const detailEpisodesLoading = document.getElementById('detail-episodes-loading');
    const detailEpisodesListContainer = document.getElementById('detail-episodes-list-container');
    const detailEpisodesList = document.getElementById('detail-episodes-list');
    const detailEpisodesError = document.getElementById('detail-episodes-error');

    // --- Get Anime ID from URL ---
    const urlParams = getUrlParams();
    const aniListId = urlParams.id ? parseInt(urlParams.id) : null;

    if (!aniListId) { /* ... error handling ... */ return; }

    // --- Setup Back Button ---
    if (backButton) { /* ... back button logic ... */ }

    // --- Fetch and Display Anime Details from AniList ---
    try {
        const aniListData = await fetchAniListApi(ANILIST_DETAIL_QUERY, { id: aniListId });
        const aniListMedia = aniListData?.Media;

        if (!aniListMedia) { throw new Error('Anime not found on AniList for the given ID.'); }

        // --- Populate Detail View (from AniList data) ---
        // (Same population logic as before for banner, title, description, etc.)
        if(detailLoadingMessage) detailLoadingMessage.classList.add('hidden');
        if(detailErrorMessage) detailErrorMessage.classList.add('hidden');
        if(detailContentArea) detailContentArea.classList.remove('hidden');
        const pageTitle = aniListMedia.title.english || aniListMedia.title.romaji || 'Anime Details';
        document.title = `AniStream - ${pageTitle}`;
        // ... (rest of the population logic for banner, cover, title, genres, stats, desc, trailer, chars, staff, relations) ...
        // Example for title:
         if(detailTitle) {
             detailTitle.textContent = aniListMedia.title.english || aniListMedia.title.romaji || aniListMedia.title.native || 'N/A';
             detailTitle.className = 'text-2xl sm:text-3xl font-bold text-white mb-1 line-clamp-2';
         }
         // ... Add ALL other population steps here from previous version ...
         // Banner
         if(detailBanner) { /* ... */ }
         // Cover Image
         if(detailCoverImage) { /* ... */ }
         // Genres
         if(detailGenres) { /* ... */ }
         // Stats
         if(detailStats) { /* ... */ }
         // Description
         if(detailDescription) { /* ... */ }
         // Trailer
         if (aniListMedia.trailer?.site === 'youtube' && aniListMedia.trailer?.id) { /* ... */ }
         // Characters
         if (aniListMedia.characters?.edges?.length > 0 && detailCharacters) { /* ... */ } else if(detailCharacters) { /* ... */ }
         // Staff
         if (aniListMedia.staff?.edges?.length > 0 && detailStaff) { /* ... */ } else if(detailStaff) { /* ... */ }
         // Relations
         if (aniListMedia.relations?.edges?.length > 0 && detailRelations) { /* ... */ } else { /* ... */ }


        // --- Fetch and Display Episode List (with improved matching) ---
        if (detailEpisodesSection) {
            const animeTitleForSearch = aniListMedia.title.english || aniListMedia.title.romaji;
            if (animeTitleForSearch) {
                try {
                    // 1. Search streaming API
                    console.log(`Searching streaming API for: "${animeTitleForSearch}"`);
                    const searchData = await fetchStreamingApi(`/anime/zoro/${encodeURIComponent(animeTitleForSearch)}`);
                    const searchResults = searchData?.results || [];
                    console.log(`Found ${searchResults.length} results from streaming search.`);

                    if (searchResults.length === 0) {
                        throw new Error(`Anime "${animeTitleForSearch}" not found on the streaming service.`);
                    }

                    // 2. Find the best match
                    let bestMatch = null;
                    const aniListFormatMapped = mapAniListFormatToStreamingFormat(aniListMedia.format);
                    const aniListYear = aniListMedia.seasonYear;

                    // Filter results based on format and year
                    const potentialMatches = searchResults.filter(result => {
                        const resultType = result.type; // e.g., "TV Series", "Movie"
                        const resultYear = result.releaseDate ? parseInt(result.releaseDate) : null; // Assuming releaseDate is year

                        // Check format match (allow null match if one is unknown)
                        const formatMatch = !aniListFormatMapped || !resultType || resultType.includes(aniListFormatMapped) || aniListFormatMapped.includes(resultType);
                        // Check year match (allow null match if one is unknown)
                        const yearMatch = !aniListYear || !resultYear || resultYear === aniListYear;

                        console.log(`Comparing: AL=[${aniListFormatMapped}, ${aniListYear}] vs SR=[${resultType}, ${resultYear}] -> FormatMatch=${formatMatch}, YearMatch=${yearMatch}`);
                        return formatMatch && yearMatch;
                    });

                    console.log(`Found ${potentialMatches.length} potential matches after filtering.`);

                    if (potentialMatches.length === 1) {
                        bestMatch = potentialMatches[0];
                        console.log("Found unique best match:", bestMatch);
                    } else if (potentialMatches.length > 1) {
                        // If multiple matches remain (e.g., same format/year), prioritize exact title match (case-insensitive)
                        console.warn("Multiple potential matches found after filtering. Attempting exact title match.");
                        const exactTitleMatch = potentialMatches.find(p =>
                            p.title.toLowerCase() === (aniListMedia.title.english?.toLowerCase() || '') ||
                            p.title.toLowerCase() === (aniListMedia.title.romaji?.toLowerCase() || '')
                        );
                        if (exactTitleMatch) {
                            bestMatch = exactTitleMatch;
                            console.log("Found exact title match among potentials:", bestMatch);
                        } else {
                            bestMatch = potentialMatches[0]; // Fallback to the first potential match
                             console.warn("No exact title match found among potentials. Falling back to the first potential match:", bestMatch);
                        }
                    } else {
                        // If filtering removed all results, maybe fall back to the first original result? Or error out.
                        // Let's error out for now for better accuracy indication.
                        // bestMatch = searchResults[0]; // Optional: Fallback to first result overall
                        // console.warn("No matches found after filtering. Falling back to the very first search result:", bestMatch);
                         throw new Error(`Could not find a reliable match on the streaming service. Format/Year mismatch? (AniList: ${aniListFormatMapped}/${aniListYear})`);
                    }

                    const streamingId = bestMatch?.id;

                    if (streamingId) {
                        // 3. Fetch info from streaming API using the matched ID
                        console.log(`Fetching episode info using streaming ID: ${streamingId}`);
                        const streamingInfo = await fetchAnimeInfoFromStreamingAPI(streamingId);

                        if (streamingInfo && streamingInfo.episodes?.length > 0) {
                            // 4. Populate the episode list
                            detailEpisodesList.innerHTML = streamingInfo.episodes
                                .map(ep => createDetailEpisodeLinkHTML(ep, streamingId, aniListId))
                                .join('');
                            if(detailEpisodesLoading) detailEpisodesLoading.classList.add('hidden');
                            if(detailEpisodesError) detailEpisodesError.classList.add('hidden');
                            if(detailEpisodesListContainer) detailEpisodesListContainer.classList.remove('hidden');
                        } else {
                             // Handle cases like movies or anime with no episodes listed yet
                             if (streamingInfo && (!streamingInfo.episodes || streamingInfo.episodes.length === 0)) {
                                 console.log("Streaming info found, but no episodes listed (maybe a movie or not released yet?).");
                                 throw new Error('No episodes found for this entry on the streaming service.');
                             } else {
                                throw new Error('Could not fetch episode details from streaming service.');
                             }
                        }
                    } else {
                        // This case should ideally be caught by the bestMatch logic above
                        throw new Error('Failed to identify a valid streaming ID for the anime.');
                    }
                } catch (episodeError) {
                    console.error("Error fetching/displaying episodes:", episodeError);
                    if(detailEpisodesLoading) detailEpisodesLoading.classList.add('hidden');
                    if(detailEpisodesListContainer) detailEpisodesListContainer.classList.add('hidden');
                    if(detailEpisodesError) {
                        detailEpisodesError.textContent = `Could not load episodes: ${episodeError.message}`;
                        detailEpisodesError.classList.remove('hidden');
                    }
                }
            } else {
                if(detailEpisodesLoading) detailEpisodesLoading.classList.add('hidden');
                if(detailEpisodesError) { detailEpisodesError.textContent = 'Could not load episodes: Anime title missing.'; detailEpisodesError.classList.remove('hidden'); }
            }
        } // End episode section handling

    } catch (error) { // Catch errors from AniList fetch or main logic
        console.error('Fetch Detail Error:', error);
        if(detailLoadingMessage) detailLoadingMessage.classList.add('hidden');
        if(detailErrorMessage) { detailErrorMessage.textContent = `Failed to load details: ${error.message}`; detailErrorMessage.classList.remove('hidden'); }
        if(detailContentArea) detailContentArea.classList.add('hidden');
        document.title = 'AniStream - Error';
    }
}


/**
 * Initializes the Episode Player Page
 */
async function initEpisodePage() {
    console.log("Initializing Episode Page");
    setFooterYear();
    setupSearch();
    setupMobileMenu();

    // Get DOM elements
    const loadingMessage = document.getElementById('episode-loading-message');
    const errorMessage = document.getElementById('episode-error-message');
    const mainContent = document.getElementById('episode-main-content');
    const playerContainer = document.getElementById('player-container');
    const videoElement = document.getElementById('video-player');
    const playerOverlay = document.getElementById('player-overlay');
    const playerOverlayMessage = document.getElementById('player-overlay-message');
    const episodeTitleArea = document.getElementById('episode-title-area');
    const backButton = document.getElementById('back-to-detail-button');
    const subButton = document.getElementById('sub-button');
    const dubButton = document.getElementById('dub-button');
    const serverSelect = document.getElementById('server-select');
    const episodeListSidebar = document.getElementById('episode-sidebar');
    const sidebarAnimeTitle = document.getElementById('sidebar-anime-title');
    const episodeListContainer = document.getElementById('episode-list-container');
    const episodeListLoading = document.getElementById('episode-list-loading');
    const episodeListUL = document.getElementById('episode-list');
    const episodeListError = document.getElementById('episode-list-error');

    // --- Get IDs from URL ---
    const urlParams = getUrlParams();
    const streamingId = urlParams.streamingId;
    const episodeId = urlParams.episodeId;
    const aniListId = urlParams.aniListId;

    if (!streamingId || !episodeId || !aniListId) {
        console.error("Missing required IDs (streamingId, episodeId, aniListId) in URL.");
        if (loadingMessage) loadingMessage.classList.add('hidden');
        if (errorMessage) { errorMessage.textContent = "Error: Missing required information to load this episode."; errorMessage.classList.remove('hidden'); }
        return;
    }

    // Store current state
    currentEpisodeData = { streamingId, episodeId, aniListId, episodes: [], currentSource: null, selectedServer: serverSelect ? serverSelect.value : 'vidcloud', selectedType: 'sub', animeTitle: 'Loading...', currentEpisodeNumber: '?' };

    // --- Setup Back Button ---
    if (backButton && aniListId) {
        backButton.href = `anime.html?id=${aniListId}`;
        backButton.onclick = (e) => { e.preventDefault(); if (document.referrer && document.referrer.includes(`anime.html?id=${aniListId}`)) { history.back(); } else { window.location.href = `anime.html?id=${aniListId}`; } };
    }

    // --- Show Loading State ---
    if(loadingMessage) loadingMessage.classList.remove('hidden');
    if(errorMessage) errorMessage.classList.add('hidden');
    if(mainContent) mainContent.classList.add('hidden');

    /** Loads and updates the video player source. */
    async function loadVideoSource(type = 'sub') {
        console.log(`Attempting to load source: type=${type}, server=${currentEpisodeData.selectedServer}`);
        if(playerOverlay && playerOverlayMessage) { playerOverlayMessage.textContent = `Loading ${type.toUpperCase()} stream...`; playerOverlay.classList.remove('hidden'); }
        if (plyrPlayer) plyrPlayer.stop();

        try {
            // Ensure episodeId is valid before fetching
            if (!currentEpisodeData.episodeId) throw new Error("Invalid Episode ID.");

            const sourcesData = await fetchEpisodeStreamLinks(currentEpisodeData.episodeId, currentEpisodeData.selectedServer);
            currentEpisodeData.currentSource = sourcesData; // Store fetched data

            if (!sourcesData || !sourcesData.sources || sourcesData.sources.length === 0) {
                 // Check if download link exists as a fallback (less ideal)
                 if (sourcesData?.download) {
                     console.warn(`No streaming sources found, attempting to use download link: ${sourcesData.download}`);
                     // Note: Direct playback of download links might be blocked by CORS or require specific headers.
                     // This is a basic attempt and might not work reliably.
                     updatePlyrSource(sourcesData.download, false, type); // Treat as non-HLS
                     updateStreamTypeButtons(); // Update buttons based on available types if possible
                     if(playerOverlay) playerOverlay.classList.add('hidden');
                     return; // Exit after attempting download link
                 }
                throw new Error(`No streaming sources found for this episode on server ${currentEpisodeData.selectedServer}. Try another server.`);
            }

            let sourceUrl = null;
            let isHls = false;

            // Heuristic check for DUB based on quality label or URL segment
            const isDubUrl = (url) => url?.toLowerCase().includes('dub');
            const isDubQuality = (quality) => quality?.toLowerCase().includes('dub');

            const targetSources = sourcesData.sources.filter(s => {
                const dubDetected = isDubQuality(s.quality) || isDubUrl(s.url);
                return type === 'dub' ? dubDetected : !dubDetected;
            });

            const sourcesToUse = targetSources.length > 0 ? targetSources : sourcesData.sources;

            // Prioritize HLS
            const hlsSource = sourcesToUse.find(s => s.isM3U8 || s.url?.includes('.m3u8'));
            if (hlsSource) {
                sourceUrl = hlsSource.url;
                isHls = true;
            } else {
                // Fallback: Find 'auto' or 'default' quality, or highest resolution if numerical
                const autoSource = sourcesToUse.find(s => s.quality?.toLowerCase() === 'auto' || s.quality?.toLowerCase() === 'default');
                if (autoSource) {
                    sourceUrl = autoSource.url;
                } else {
                    // Simple fallback to first source if no better option found
                    sourceUrl = sourcesToUse[0]?.url;
                }
                 isHls = sourceUrl?.includes('.m3u8') || false; // Re-check fallback URL
            }

            if (!sourceUrl) { throw new Error(`Could not find a suitable ${type.toUpperCase()} video URL.`); }

            console.log(`Selected Source URL (${type.toUpperCase()}):`, sourceUrl);
            console.log(`Is HLS:`, isHls);

            updateStreamTypeButtons(); // Update buttons based on fetched data

            if (!plyrPlayer) {
                initializePlyrPlayer(videoElement, sourceUrl, isHls, type);
            } else {
                updatePlyrSource(sourceUrl, isHls, type);
            }

            if(playerOverlay) playerOverlay.classList.add('hidden');

        } catch (error) {
            console.error("Error loading video source:", error);
            if(playerOverlay && playerOverlayMessage) { playerOverlayMessage.textContent = `Error: ${error.message}`; playerOverlay.classList.remove('hidden'); }
            if (errorMessage) { errorMessage.textContent = `Failed to load video: ${error.message}`; errorMessage.classList.remove('hidden'); }
            if (loadingMessage) loadingMessage.classList.add('hidden');
        }
    }

    /** Initializes the Plyr video player. */
    function initializePlyrPlayer(videoEl, sourceUrl, isHls, type) {
        if (plyrPlayer) return;
        const plyrOptions = { /* ... options ... */ }; // Same options as before

        if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
            console.log("Initializing Plyr with HLS.js");
            if (hlsInstance) { hlsInstance.destroy(); }
            hlsInstance = new Hls({ /* HLS config options if needed */ });
            hlsInstance.loadSource(sourceUrl);
            hlsInstance.attachMedia(videoEl);
            window.hls = hlsInstance;
            hlsInstance.on(Hls.Events.ERROR, function (event, data) { /* ... HLS error handling ... */ });
            plyrPlayer = new Plyr(videoEl, plyrOptions);
        } else {
            console.log("Initializing Plyr with native source");
            videoEl.src = sourceUrl;
            plyrPlayer = new Plyr(videoEl, plyrOptions);
        }
        window.player = plyrPlayer;
    }

    /** Updates the source of an existing Plyr player. */
    function updatePlyrSource(sourceUrl, isHls, type) {
        if (!plyrPlayer) { console.error("Plyr player not initialized..."); return; }
        console.log(`Updating Plyr source: ${sourceUrl} (HLS: ${isHls})`);
        const newSource = { type: 'video', title: `${currentEpisodeData.animeTitle} - Ep ${currentEpisodeData.currentEpisodeNumber} (${type.toUpperCase()})`, sources: [{ src: sourceUrl, type: isHls ? 'application/x-mpegURL' : 'video/mp4' }] };

        if (isHls && typeof Hls !== 'undefined' && Hls.isSupported() && hlsInstance) {
            console.log("Updating Plyr source using HLS.js");
            hlsInstance.loadSource(sourceUrl); // Load new source into existing HLS instance
            plyrPlayer.source = newSource; // Update Plyr's source info
        } else if (isHls && typeof Hls !== 'undefined' && Hls.isSupported() && !hlsInstance) {
             // If HLS instance doesn't exist (shouldn't happen if initialized correctly), re-initialize
             console.warn("HLS instance not found, re-initializing HLS for source update.");
             initializePlyrPlayer(videoElement, sourceUrl, isHls, type); // This will create plyrPlayer again, might need better handling
        } else {
            console.log("Updating Plyr source natively");
             // For native playback, setting plyrPlayer.source should be enough
             plyrPlayer.source = newSource;
        }
    }

    /** Updates the visual state (active/disabled) of SUB/DUB buttons. */
    function updateStreamTypeButtons() {
        // Simplified check: Assume both might be available unless sources explicitly tell otherwise
        // A more robust check would analyze all source URLs/qualities if the API provides them consistently
        let subAvailable = true;
        let dubAvailable = true;

         if (currentEpisodeData?.currentSource?.sources && currentEpisodeData.currentSource.sources.length > 0) {
             // Slightly better check: see if *any* source looks like dub or sub
             const isDubUrl = (url) => url?.toLowerCase().includes('dub');
             const isDubQuality = (quality) => quality?.toLowerCase().includes('dub');
             dubAvailable = currentEpisodeData.currentSource.sources.some(s => isDubQuality(s.quality) || isDubUrl(s.url));
             // Assume SUB is available if any source exists that isn't clearly DUB
             subAvailable = currentEpisodeData.currentSource.sources.some(s => !(isDubQuality(s.quality) || isDubUrl(s.url)));
             // If only one type is detected, assume the other isn't available
             if (dubAvailable && !subAvailable) subAvailable = false;
             if (subAvailable && !dubAvailable) dubAvailable = false;
         } else {
             // If no sources, disable both
              subAvailable = false;
              dubAvailable = false;
         }


        if(subButton) {
            subButton.disabled = !subAvailable;
            subButton.classList.toggle('bg-purple-600', currentEpisodeData.selectedType === 'sub' && subAvailable);
            subButton.classList.toggle('text-white', currentEpisodeData.selectedType === 'sub' && subAvailable);
            subButton.classList.toggle('bg-gray-700', currentEpisodeData.selectedType !== 'sub' || !subAvailable);
            subButton.classList.toggle('text-gray-200', currentEpisodeData.selectedType !== 'sub' || !subAvailable);
            subButton.classList.toggle('opacity-50', !subAvailable);
            subButton.classList.toggle('cursor-not-allowed', !subAvailable);
        }
        if(dubButton) {
            dubButton.disabled = !dubAvailable;
            dubButton.classList.toggle('bg-purple-600', currentEpisodeData.selectedType === 'dub' && dubAvailable);
            dubButton.classList.toggle('text-white', currentEpisodeData.selectedType === 'dub' && dubAvailable);
            dubButton.classList.toggle('bg-gray-700', currentEpisodeData.selectedType !== 'dub' || !dubAvailable);
            dubButton.classList.toggle('text-gray-200', currentEpisodeData.selectedType !== 'dub' || !dubAvailable);
            dubButton.classList.toggle('opacity-50', !dubAvailable);
            dubButton.classList.toggle('cursor-not-allowed', !dubAvailable);
        }
    }

    // --- Fetch Initial Data ---
    try {
        const animeInfo = await fetchAnimeInfoFromStreamingAPI(streamingId);
        if (!animeInfo) { throw new Error("Could not retrieve anime details from streaming service."); }
        // Handle cases where episodes might be missing (e.g., movie)
        if (!animeInfo.episodes) {
            animeInfo.episodes = []; // Ensure episodes is an array
            console.warn("No 'episodes' array found in anime info response.");
        }


        currentEpisodeData.episodes = animeInfo.episodes;
        currentEpisodeData.animeTitle = animeInfo.title?.english || animeInfo.title?.romaji || 'Anime';
        const currentEp = animeInfo.episodes.find(ep => ep.id === episodeId);
        currentEpisodeData.currentEpisodeNumber = currentEp?.number || (animeInfo.episodes.length === 1 ? 'Movie/Special' : '?'); // Handle single-episode entries

        document.title = `Watching ${currentEpisodeData.animeTitle} - Ep ${currentEpisodeData.currentEpisodeNumber}`;
        if(episodeTitleArea) episodeTitleArea.textContent = `${currentEpisodeData.animeTitle} - Episode ${currentEpisodeData.currentEpisodeNumber}`;
        if (sidebarAnimeTitle) sidebarAnimeTitle.textContent = currentEpisodeData.animeTitle;

        // Populate Episode List Sidebar
        if (episodeListUL && episodeListContainer) {
            if (currentEpisodeData.episodes.length > 0) {
                episodeListUL.innerHTML = currentEpisodeData.episodes
                    .map(ep => createSidebarEpisodeItemHTML(ep, streamingId, aniListId, ep.id === episodeId))
                    .join('');
                const activeItem = episodeListUL.querySelector('.active');
                if (activeItem) { activeItem.scrollIntoView({ behavior: 'auto', block: 'center' }); } // Use 'auto' for faster scroll on load
                 episodeListUL.classList.remove('hidden');
                 if(episodeListError) episodeListError.classList.add('hidden');
            } else {
                 // Show message if no episodes are listed (e.g., for a movie)
                 if(episodeListError) {
                     episodeListError.textContent = 'No further episodes listed for this entry.';
                     episodeListError.classList.remove('hidden');
                 }
                 episodeListUL.classList.add('hidden');
            }
             if(episodeListLoading) episodeListLoading.classList.add('hidden');
        } else {
             if(episodeListLoading) episodeListLoading.classList.add('hidden');
             if(episodeListError) { episodeListError.textContent = 'Could not display episode list.'; episodeListError.classList.remove('hidden'); }
        }

        // Fetch initial video source
        await loadVideoSource(currentEpisodeData.selectedType);

        if(loadingMessage) loadingMessage.classList.add('hidden');
        if(mainContent) mainContent.classList.remove('hidden');

    } catch (initError) {
        console.error("Initialization Error:", initError);
        if (loadingMessage) loadingMessage.classList.add('hidden');
        if (errorMessage) { errorMessage.textContent = `Error loading episode page: ${initError.message}`; errorMessage.classList.remove('hidden'); }
        if(mainContent) mainContent.classList.add('hidden');
    }

    // --- Event Listeners ---
    if (subButton) { subButton.addEventListener('click', () => { if (currentEpisodeData.selectedType !== 'sub') { currentEpisodeData.selectedType = 'sub'; loadVideoSource('sub'); } }); }
    if (dubButton) { dubButton.addEventListener('click', () => { if (currentEpisodeData.selectedType !== 'dub') { currentEpisodeData.selectedType = 'dub'; loadVideoSource('dub'); } }); }
    if (serverSelect) { serverSelect.addEventListener('change', (e) => { currentEpisodeData.selectedServer = e.target.value; loadVideoSource(currentEpisodeData.selectedType); }); }
}


// IMPORTANT: The calls to initIndexPage(), initAnimePage(), initEpisodePage()
// are expected to be at the bottom of their respective HTML files within a
// DOMContentLoaded listener, as previously implemented.
