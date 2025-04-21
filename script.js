// --- Constants and Global Variables ---
const ANILIST_API_URL = 'https://graphql.anilist.co';
const STREAMING_API_BASE_URL = 'https://api-pearl-seven-88.vercel.app'; // User-provided API

let searchTimeoutId = null; // For debouncing search input
let featuredSwiper = null; // Swiper instance for index page slider
let plyrPlayer = null; // Plyr instance for episode page video player
let hlsInstance = null; // HLS.js instance for handling HLS streams
let currentEpisodeData = { // Structure to hold episode page state
    streamingId: null,    // ID of the anime on the streaming service
    episodeId: null,      // ID of the specific episode being watched
    aniListId: null,      // Original AniList ID for reference and navigation
    episodes: [],         // Full list of episodes for the anime (from streaming service)
    currentSourceData: null, // Holds full API response for current episode { headers, sources, subtitles, intro, outro, ... }
    selectedServer: 'vidcloud', // Default or currently selected streaming server
    selectedType: 'sub',  // 'sub' or 'dub' - currently selected stream type
    animeTitle: 'Loading...', // Title of the anime
    currentEpisodeNumber: '?', // Number of the current episode
    intro: null,          // { start, end } seconds for intro skip
    outro: null,          // { start, end } seconds for outro skip
    subtitles: []         // Formatted subtitle tracks for Plyr
};
let skipIntroTimeout = null; // Timeout reference for intro skip button visibility
let skipOutroTimeout = null; // Timeout reference for outro skip button visibility

// --- AniList API Queries ---
// Query to browse anime categories (Trending, Popular, Top Rated)
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
        seasonYear # Needed for matching
    }
`;
// Query to get detailed information for a specific anime by its AniList ID
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
            format # Needed for matching
            season
            seasonYear # Needed for matching
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
// Query to search for anime on AniList by title
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

/** Gets the current season and year. */
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

/** Basic HTML tag removal for descriptions. */
function sanitizeDescription(desc) {
    if (!desc) return 'No description available.';
    let sanitized = desc.replace(/<br\s*\/?>/gi, '\n'); // Preserve line breaks
    sanitized = sanitized.replace(/<[^>]+>/g, ''); // Remove other tags
    return sanitized.trim();
}

/** Debounce function to limit execution rate. */
function debounce(func, delay) {
    let timeoutId;
    return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

/** Gets URL query parameters as an object. */
function getUrlParams() {
    const params = {};
    const queryString = window.location.search;
    const urlParams = new URLSearchParams(queryString);
    for (const [key, value] of urlParams.entries()) {
        params[key] = value;
    }
    return params;
}

/** Maps AniList format to potential streaming API format strings (heuristic). */
function mapAniListFormatToStreamingFormat(aniListFormat) {
    if (!aniListFormat) return null;
    const format = aniListFormat.toUpperCase();
    switch (format) {
        case 'TV': return 'TV Series';
        case 'TV_SHORT': return 'TV Series';
        case 'MOVIE': return 'Movie';
        case 'SPECIAL': return 'Special';
        case 'OVA': return 'OVA';
        case 'ONA': return 'ONA';
        case 'MUSIC': return 'Music';
        default: return aniListFormat; // Return original if no specific mapping
    }
}

// --- API Fetching ---

/** Fetches data from the AniList GraphQL API. */
async function fetchAniListApi(query, variables) {
    try {
        const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ query: query, variables: variables }) };
        console.log('Fetching AniList:', { query: query.substring(0, 100) + '...', variables });
        const response = await fetch(ANILIST_API_URL, options);
        if (!response.ok) throw new Error(`AniList HTTP error! status: ${response.status} ${response.statusText}`);
        const result = await response.json();
        if (result.errors) { console.error('AniList GraphQL Errors:', result.errors); throw new Error(`AniList API Error: ${result.errors[0]?.message || 'Unknown'}`); }
        console.log('AniList Response OK');
        return result.data;
    } catch (error) {
        console.error("AniList API Fetch Error:", error);
        throw error; // Re-throw for handling by caller
    }
}

/** Fetches data from the Streaming API (Consumet-based). */
async function fetchStreamingApi(endpoint, errorMessage = 'Error fetching streaming data') {
    const url = `${STREAMING_API_BASE_URL}${endpoint}`;
    try {
        console.log('Fetching Streaming API:', url);
        const response = await fetch(url);
        if (!response.ok) {
            let errorBody = null; try { errorBody = await response.json(); } catch (e) { /* ignore */ }
            console.error(`Streaming API HTTP error! Status: ${response.status}`, errorBody);
            throw new Error(`${errorMessage}: ${errorBody?.message || response.statusText || 'Unknown'} (Status: ${response.status})`);
        }
        const data = await response.json();
        console.log('Streaming API Response OK');
        // Basic validation/warnings for empty results
        if (data && endpoint.includes('/search') && (!data.results || data.results.length === 0)) { console.warn(`Streaming API returned no search results for ${endpoint}`); return { results: [] }; }
        if (data && endpoint.includes('/info') && (!data.episodes)) { console.warn(`Streaming API info response missing 'episodes' array for ${endpoint}`); data.episodes = []; } // Ensure episodes array exists
        if (data && endpoint.includes('/watch') && (!data.sources)) { console.warn(`Streaming API watch response missing 'sources' array for ${endpoint}`); data.sources = []; } // Ensure sources array exists
        if (data && endpoint.includes('/watch') && (!data.subtitles)) { console.warn(`Streaming API watch response missing 'subtitles' array for ${endpoint}`); data.subtitles = []; } // Ensure subtitles array exists
        return data;
    } catch (error) {
        console.error("Streaming API Fetch Error:", error);
        // Don't re-wrap error message if it already starts with our prefix
        if (!error.message.startsWith(errorMessage)) { throw new Error(`${errorMessage}: ${error.message}`); }
        throw error; // Re-throw
    }
}

// --- Specific Streaming API Functions ---

/** Fetches detailed info (including episodes) for an anime from the streaming API. */
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

/** Fetches streaming links, subtitles, intro/outro times for a specific episode. */
async function fetchEpisodeWatchData(episodeId, server = 'vidcloud') {
    if (!episodeId) return null;
    try {
        const data = await fetchStreamingApi(`/anime/zoro/watch?episodeId=${encodeURIComponent(episodeId)}&server=${server}`, `Error fetching watch data for episode "${episodeId}"`);
        // Ensure structure consistency
        return {
            headers: data?.headers || {},
            sources: data?.sources || [],
            subtitles: data?.subtitles || [],
            intro: data?.intro || { start: 0, end: 0 },
            outro: data?.outro || { start: 0, end: 0 },
            download: data?.download
        };
    } catch (error) {
        console.error(`Failed to fetch watch data for episode "${episodeId}" on server "${server}":`, error);
        return null; // Return null on error
    }
}


// --- HTML Generation Helpers ---

/** Creates HTML for a featured anime slide on the index page. */
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

/** Creates HTML for an anime card used in grids on the index page. */
function createAnimeCardHTML(anime) {
    const title = anime.title.english || anime.title.romaji || anime.title.native || 'Untitled';
    const imageUrl = anime.coverImage.large || `https://placehold.co/185x265/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=No+Image`;
    const fallbackImage = `https://placehold.co/185x265/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=No+Image`;
    const score = anime.averageScore ? `${anime.averageScore}%` : 'N/A';
    const episodes = anime.episodes ? `${anime.episodes} Ep` : (anime.status === 'RELEASING' ? 'Airing' : 'N/A');
    const genres = anime.genres ? anime.genres.slice(0, 2).join(', ') : 'N/A';
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

/** Creates HTML for a top anime list item (sidebars). */
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

/** Creates HTML for a search suggestion item. */
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

/** Creates HTML for an episode link on the anime detail page. */
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

/** Creates HTML for an episode list item in the sidebar of episode.html. */
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

/** Formats subtitles from the API response into the structure Plyr expects. */
function formatSubtitlesForPlyr(apiSubtitles) {
    if (!apiSubtitles || apiSubtitles.length === 0) return [];
    const langCodeMap = { 'english': 'en', 'spanish': 'es', 'portuguese': 'pt', 'french': 'fr', 'german': 'de', 'italian': 'it', 'russian': 'ru' /* Add more */ };
    return apiSubtitles.map((sub, index) => {
        const langLower = sub.lang?.toLowerCase() || 'unknown';
        let srclang = langCodeMap[langLower] || langLower.substring(0, 2);
        const isDefault = langLower.includes('english'); // Default English if available
        return { kind: 'captions', label: sub.lang || `Subtitle ${index + 1}`, srclang: srclang, src: sub.url, default: isDefault };
    }).filter(track => track.src); // Ensure track has a source URL
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
            effect: 'fade', fadeEffect: { crossFade: true },
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
    if (!searchInput || !searchSuggestionsContainer) { console.warn("Search elements not found."); return; }

    function showSearchSuggestions() { searchSuggestionsContainer.classList.remove('hidden'); }
    function hideSearchSuggestions() { searchSuggestionsContainer.classList.add('hidden'); }
    async function fetchAndDisplaySuggestions(term) { /* ... (same as before) ... */ }
    const debouncedFetch = debounce(fetchAndDisplaySuggestions, 350);
    searchInput.addEventListener('input', (e) => debouncedFetch(e.target.value.trim()));
    searchInput.addEventListener('focus', () => { if (searchInput.value.trim().length >= 3) fetchAndDisplaySuggestions(searchInput.value.trim()); });
    searchInput.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== searchInput && !searchSuggestionsContainer?.contains(document.activeElement)) { hideSearchSuggestions(); if (window.innerWidth < 1024 && !searchInput.classList.contains('hidden') && typeof toggleMobileSearch === 'function') toggleMobileSearch(false); } }, 150); });
    function toggleMobileSearch(show) { /* ... (same as before) ... */ }
    window.toggleMobileSearch = toggleMobileSearch;
    if (searchIconButton) searchIconButton.addEventListener('click', () => toggleMobileSearch(true));
    document.addEventListener('click', (event) => { const isClickInsideSearch = searchInput?.contains(event.target) || searchSuggestionsContainer?.contains(event.target) || searchIconButton?.contains(event.target); if (!isClickInsideSearch) { hideSearchSuggestions(); if (window.innerWidth < 1024 && searchInput && !searchInput.classList.contains('hidden') && typeof toggleMobileSearch === 'function') toggleMobileSearch(false); } });
}

// --- Mobile Menu Functionality ---
function setupMobileMenu(menuButtonId = 'mobile-menu-button', sidebarContainerId = 'mobile-sidebar-container', sidebarId = 'mobile-sidebar', overlayId = 'sidebar-overlay', closeButtonId = 'close-sidebar-button', navLinkClass = '.mobile-nav-link') {
    const mobileMenuButton = document.getElementById(menuButtonId);
    const mobileSidebarContainer = document.getElementById(sidebarContainerId);
    const mobileSidebar = document.getElementById(sidebarId);
    const sidebarOverlay = document.getElementById(overlayId);
    const closeSidebarButton = document.getElementById(closeButtonId);
    const mobileNavLinks = document.querySelectorAll(navLinkClass);
    if (!mobileMenuButton || !mobileSidebarContainer || !mobileSidebar || !sidebarOverlay || !closeSidebarButton) { console.warn("Mobile menu elements not found."); return; }
    function openMobileMenu() { mobileSidebarContainer.classList.remove('pointer-events-none'); sidebarOverlay.classList.remove('hidden'); mobileSidebar.classList.remove('-translate-x-full'); document.body.classList.add('modal-open'); mobileMenuButton.setAttribute('aria-expanded', 'true'); mobileSidebar.focus(); }
    function closeMobileMenu() { mobileSidebar.classList.add('-translate-x-full'); sidebarOverlay.classList.add('hidden'); mobileSidebarContainer.classList.add('pointer-events-none'); document.body.classList.remove('modal-open'); mobileMenuButton.setAttribute('aria-expanded', 'false'); mobileMenuButton.focus(); }
    mobileMenuButton.addEventListener('click', openMobileMenu);
    closeSidebarButton.addEventListener('click', closeMobileMenu);
    sidebarOverlay.addEventListener('click', closeMobileMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mobileSidebarContainer.classList.contains('pointer-events-none')) closeMobileMenu(); });
    mobileNavLinks.forEach(link => { link.addEventListener('click', () => { setTimeout(closeMobileMenu, 100); }); });
}

// --- Footer Year ---
function setFooterYear(footerYearId = 'footer-year') {
    const footerYearSpan = document.getElementById(footerYearId);
    if (footerYearSpan) footerYearSpan.textContent = new Date().getFullYear();
}


// --- Page Specific Initialization ---

/** Initializes the Index (Browse) Page */
async function initIndexPage() {
    console.log("Initializing Index Page");
    setFooterYear();
    setupSearch();
    setupMobileMenu();
    // DOM Element references...
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

        // Populate Featured Slider
        if (hasTrending && swiperWrapperFeatured) {
            swiperWrapperFeatured.innerHTML = ''; // Clear skeleton
            data.trending.media.slice(0, 5).forEach(anime => { swiperWrapperFeatured.innerHTML += createFeaturedSlideHTML(anime); });
            setTimeout(() => initializeFeaturedSwiper(), 0); // Init after DOM update
        } else if (swiperWrapperFeatured) { /* Handle no featured */ }

        // Populate Trending Grid
        if (hasTrending && trendingGrid) {
            trendingGrid.innerHTML = ''; // Clear skeletons
            data.trending.media.slice(0, 10).forEach(anime => { trendingGrid.innerHTML += createAnimeCardHTML(anime); });
        } else if (trendingGrid) { /* Handle no trending */ }

        // Populate Popular Grid
        if (hasPopular && popularGrid) {
            popularGrid.innerHTML = ''; // Clear skeletons
            data.popular.media.forEach(anime => { popularGrid.innerHTML += createAnimeCardHTML(anime); });
        } else if (popularGrid) { /* Handle no popular */ }

        // Populate Top Anime Lists
        if (hasTop) {
            const topAnimeHTML = data.top.media.map((anime, index) => createTopAnimeListItemHTML(anime, index)).join('');
            if (topAnimeListDesktop) topAnimeListDesktop.innerHTML = topAnimeHTML;
            if (topAnimeListMobile) topAnimeListMobile.innerHTML = topAnimeHTML;
            if (topAnimeListBottomMobile) topAnimeListBottomMobile.innerHTML = topAnimeHTML;
        } else { /* Handle no top anime */ }

    } catch (error) {
        console.error('Fetch Browse Error:', error);
        if(errorMessageDiv) { errorMessageDiv.textContent = `Failed to load page data. Please try again later. (${error.message})`; errorMessageDiv.classList.remove('hidden'); }
        // Show errors in specific sections...
    }
}

/** Initializes the Anime Detail Page - WITH IMPROVED EPISODE MATCHING */
async function initAnimePage() {
    console.log("Initializing Anime Detail Page");
    setFooterYear();
    setupSearch();
    setupMobileMenu();
    // DOM Element references...
    const detailContentArea = document.getElementById('detail-content-area');
    const detailErrorMessage = document.getElementById('detail-error-message');
    const detailLoadingMessage = document.getElementById('detail-loading-message');
    const backButton = document.getElementById('back-button');
    const detailBanner = document.getElementById('detail-view-banner'); // etc...
    const detailTitle = document.getElementById('detail-title');
    const detailEpisodesSection = document.getElementById('detail-episodes-section');
    const detailEpisodesLoading = document.getElementById('detail-episodes-loading');
    const detailEpisodesListContainer = document.getElementById('detail-episodes-list-container');
    const detailEpisodesList = document.getElementById('detail-episodes-list');
    const detailEpisodesError = document.getElementById('detail-episodes-error');
    // ... (get all other detail elements: cover, genres, stats, desc, trailer, chars, staff, relations)

    const urlParams = getUrlParams();
    const aniListId = urlParams.id ? parseInt(urlParams.id) : null;
    if (!aniListId) { /* ... error handling ... */ return; }
    if (backButton) { /* ... back button logic ... */ }

    try {
        const aniListData = await fetchAniListApi(ANILIST_DETAIL_QUERY, { id: aniListId });
        const aniListMedia = aniListData?.Media;
        if (!aniListMedia) throw new Error('Anime not found on AniList.');

        // --- Populate Detail View (from AniList data) ---
        if(detailLoadingMessage) detailLoadingMessage.classList.add('hidden');
        if(detailErrorMessage) detailErrorMessage.classList.add('hidden');
        if(detailContentArea) detailContentArea.classList.remove('hidden');
        document.title = `AniStream - ${aniListMedia.title.english || aniListMedia.title.romaji || 'Details'}`;
        // Populate ALL detail fields (banner, cover, title, genres, stats, desc, trailer, chars, staff, relations)
        // ... (ensure all population steps from previous version are here) ...
        if(detailTitle) { detailTitle.textContent = aniListMedia.title.english || aniListMedia.title.romaji || aniListMedia.title.native || 'N/A'; detailTitle.className = 'text-2xl sm:text-3xl font-bold text-white mb-1 line-clamp-2'; }
        // ... (populate others) ...


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
                    if (searchResults.length === 0) throw new Error(`Anime "${animeTitleForSearch}" not found on streaming service.`);

                    // 2. Find the best match based on format and year
                    let bestMatch = null;
                    const aniListFormatMapped = mapAniListFormatToStreamingFormat(aniListMedia.format);
                    const aniListYear = aniListMedia.seasonYear;
                    const potentialMatches = searchResults.filter(result => {
                        const resultType = result.type; // e.g., "TV Series", "Movie"
                        const resultYear = result.releaseDate ? parseInt(result.releaseDate) : null;
                        const formatMatch = !aniListFormatMapped || !resultType || resultType.includes(aniListFormatMapped) || aniListFormatMapped.includes(resultType);
                        const yearMatch = !aniListYear || !resultYear || resultYear === aniListYear;
                        return formatMatch && yearMatch;
                    });
                    console.log(`Found ${potentialMatches.length} potential matches after filtering.`);
                    if (potentialMatches.length === 1) { bestMatch = potentialMatches[0]; }
                    else if (potentialMatches.length > 1) {
                         const exactTitleMatch = potentialMatches.find(p => p.title.toLowerCase() === (aniListMedia.title.english?.toLowerCase() || '') || p.title.toLowerCase() === (aniListMedia.title.romaji?.toLowerCase() || ''));
                         bestMatch = exactTitleMatch || potentialMatches[0]; // Prioritize exact title, fallback to first potential
                         console.warn(exactTitleMatch ? "Found exact title match." : "Multiple matches, falling back to first potential.");
                    } else { throw new Error(`Could not find a reliable match (Format/Year mismatch? AL: ${aniListFormatMapped}/${aniListYear})`); }
                    console.log("Selected match:", bestMatch);

                    const streamingId = bestMatch?.id;
                    if (streamingId) {
                        // 3. Fetch episode info using the matched ID
                        const streamingInfo = await fetchAnimeInfoFromStreamingAPI(streamingId);
                        if (streamingInfo && streamingInfo.episodes?.length > 0) {
                            // 4. Populate the episode list
                            detailEpisodesList.innerHTML = streamingInfo.episodes.map(ep => createDetailEpisodeLinkHTML(ep, streamingId, aniListId)).join('');
                            if(detailEpisodesLoading) detailEpisodesLoading.classList.add('hidden');
                            if(detailEpisodesError) detailEpisodesError.classList.add('hidden');
                            if(detailEpisodesListContainer) detailEpisodesListContainer.classList.remove('hidden');
                        } else { throw new Error('No episodes found for this entry on streaming service.'); }
                    } else { throw new Error('Failed to identify a valid streaming ID.'); }
                } catch (episodeError) { // Catch errors specific to episode fetching/matching
                    console.error("Error fetching/displaying episodes:", episodeError);
                    if(detailEpisodesLoading) detailEpisodesLoading.classList.add('hidden');
                    if(detailEpisodesListContainer) detailEpisodesListContainer.classList.add('hidden');
                    if(detailEpisodesError) { detailEpisodesError.textContent = `Could not load episodes: ${episodeError.message}`; detailEpisodesError.classList.remove('hidden'); }
                }
            } else { /* Handle missing title for search */ }
        } // End episode section handling

    } catch (error) { // Catch errors from AniList fetch or main logic
        console.error('Fetch Detail Error:', error);
        if(detailLoadingMessage) detailLoadingMessage.classList.add('hidden');
        if(detailErrorMessage) { detailErrorMessage.textContent = `Failed to load details: ${error.message}`; detailErrorMessage.classList.remove('hidden'); }
        if(detailContentArea) detailContentArea.classList.add('hidden');
        document.title = 'AniStream - Error';
    }
}

/** Initializes the Episode Player Page - ENHANCED */
async function initEpisodePage() {
    console.log("Initializing Episode Page");
    setFooterYear();
    setupSearch();
    setupMobileMenu();
    // DOM Element references...
    const loadingMessage = document.getElementById('episode-loading-message');
    const errorMessage = document.getElementById('episode-error-message');
    const mainContent = document.getElementById('episode-main-content');
    const playerWrapper = document.getElementById('player-wrapper');
    const videoElement = document.getElementById('video-player');
    const playerOverlay = document.getElementById('player-overlay');
    const playerOverlayMessage = document.getElementById('player-overlay-message');
    const episodeTitleArea = document.getElementById('episode-title-area');
    const backButton = document.getElementById('back-to-detail-button');
    const subButton = document.getElementById('sub-button');
    const dubButton = document.getElementById('dub-button');
    const serverSelect = document.getElementById('server-select');
    const sidebarAnimeTitle = document.getElementById('sidebar-anime-title');
    const episodeListUL = document.getElementById('episode-list');
    const episodeListLoading = document.getElementById('episode-list-loading');
    const episodeListContainer = document.getElementById('episode-list-container');
    const episodeListError = document.getElementById('episode-list-error');
    const skipIntroButton = document.getElementById('skip-intro-button');
    const skipOutroButton = document.getElementById('skip-outro-button');

    const urlParams = getUrlParams();
    // Reset state on page load
    currentEpisodeData = { ...currentEpisodeData, streamingId: urlParams.streamingId, episodeId: urlParams.episodeId, aniListId: urlParams.aniListId, selectedServer: serverSelect ? serverSelect.value : 'vidcloud', selectedType: 'sub', episodes: [], currentSourceData: null, intro: null, outro: null, subtitles: [], animeTitle: 'Loading...', currentEpisodeNumber: '?' };

    if (!currentEpisodeData.streamingId || !currentEpisodeData.episodeId || !currentEpisodeData.aniListId) { /* ... error handling ... */ return; }
    if (backButton && currentEpisodeData.aniListId) { /* ... back button setup ... */ }
    if(loadingMessage) loadingMessage.classList.remove('hidden');
    if(errorMessage) errorMessage.classList.add('hidden');
    if(mainContent) mainContent.classList.add('hidden');

    /** Loads video source, subtitles, skip times */
    async function loadVideoSource(type = 'sub') {
        console.log(`Attempting load: type=${type}, server=${currentEpisodeData.selectedServer}`);
        currentEpisodeData.selectedType = type;
        if(playerOverlay && playerOverlayMessage) { playerOverlayMessage.textContent = `Loading ${type.toUpperCase()}...`; playerOverlay.classList.remove('hidden'); }
        if (plyrPlayer) plyrPlayer.stop();
        if (skipIntroButton) skipIntroButton.classList.remove('visible');
        if (skipOutroButton) skipOutroButton.classList.remove('visible');

        try {
            const watchData = await fetchEpisodeWatchData(currentEpisodeData.episodeId, currentEpisodeData.selectedServer);
            currentEpisodeData.currentSourceData = watchData;
            if (!watchData) throw new Error(`Failed to fetch watch data.`);
            if (!watchData.sources || watchData.sources.length === 0) {
                 if (watchData.download) { /* ... handle download link fallback ... */ return; }
                 throw new Error(`No sources found on server ${currentEpisodeData.selectedServer}.`);
            }

            currentEpisodeData.intro = watchData.intro || { start: 0, end: 0 };
            currentEpisodeData.outro = watchData.outro || { start: 0, end: 0 };
            currentEpisodeData.subtitles = formatSubtitlesForPlyr(watchData.subtitles);
            console.log("Formatted Subs:", currentEpisodeData.subtitles);

            let sourceUrl = null, isHls = false;
            // Find source based on selected type (SUB/DUB)
            const isDub = (s) => (s.quality?.toLowerCase().includes('dub') || s.url?.toLowerCase().includes('dub'));
            const targetSources = watchData.sources.filter(s => type === 'dub' ? isDub(s) : !isDub(s));
            const sourcesToUse = targetSources.length > 0 ? targetSources : watchData.sources;
            // Prioritize HLS
            const hlsSource = sourcesToUse.find(s => s.isM3U8 || s.url?.includes('.m3u8'));
            if (hlsSource) { sourceUrl = hlsSource.url; isHls = true; }
            else { /* ... fallback logic (auto, default, first) ... */ sourceUrl = sourcesToUse[0]?.url; isHls = sourceUrl?.includes('.m3u8') || false; }
            if (!sourceUrl) throw new Error(`Could not find suitable ${type.toUpperCase()} URL.`);
            console.log(`Selected Source: ${sourceUrl} (HLS: ${isHls})`);

            updateStreamTypeButtons(); // Update SUB/DUB button states

            if (!plyrPlayer) initializePlyrPlayer(videoElement, sourceUrl, isHls, type, currentEpisodeData.subtitles);
            else updatePlyrSource(sourceUrl, isHls, type, currentEpisodeData.subtitles);

            // setupSkipButtons is called from player 'ready' event

            if(playerOverlay) playerOverlay.classList.add('hidden');

        } catch (error) { /* ... error handling, update UI ... */
             console.error("Error loading video source:", error);
             if(playerOverlay && playerOverlayMessage) { playerOverlayMessage.textContent = `Error: ${error.message}`; playerOverlay.classList.remove('hidden'); }
             if (errorMessage) { errorMessage.textContent = `Failed to load video: ${error.message}`; errorMessage.classList.remove('hidden'); }
             updateStreamTypeButtons(true); // Disable buttons on error
        }
    }

    /** Initializes Plyr player */
    function initializePlyrPlayer(videoEl, sourceUrl, isHls, type, tracks = []) {
        if (plyrPlayer) { try { plyrPlayer.destroy(); } catch(e){} plyrPlayer = null; }
        if (hlsInstance) { try { hlsInstance.destroy(); } catch(e){} hlsInstance = null; }

        const plyrOptions = {
            title: `${currentEpisodeData.animeTitle} - Ep ${currentEpisodeData.currentEpisodeNumber} (${type.toUpperCase()})`,
            controls: [ 'play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen' ],
            settings: ['captions', 'quality', 'speed', 'loop'],
            captions: { active: true, language: 'en', update: true }, // Default subs on
            tooltips: { controls: true, seek: true },
            keyboard: { focused: true, global: true },
            tracks: tracks // Pass formatted subtitles
        };

        if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
            console.log("Initializing Plyr with HLS.js");
            hlsInstance = new Hls({ capLevelToPlayerSize: true });
            hlsInstance.loadSource(sourceUrl);
            hlsInstance.attachMedia(videoEl);
            window.hls = hlsInstance;
            hlsInstance.on(Hls.Events.ERROR, (event, data) => { /* ... HLS error handling ... */ });
            plyrPlayer = new Plyr(videoEl, plyrOptions);
            plyrPlayer.on('qualitychange', (event) => { /* ... optional HLS quality mapping ... */ });
        } else {
            console.log("Initializing Plyr with native source");
            videoEl.src = sourceUrl;
            plyrPlayer = new Plyr(videoEl, plyrOptions);
        }
        window.player = plyrPlayer; // For debugging
        plyrPlayer.on('ready', () => { console.log("Plyr ready."); setupSkipButtons(); }); // Setup skips when ready
        plyrPlayer.on('error', (event) => { console.error("Plyr Error:", event); /* ... handle player errors ... */ });
    }

    /** Updates source and tracks of existing Plyr player */
    function updatePlyrSource(sourceUrl, isHls, type, tracks = []) {
        if (!plyrPlayer) { initializePlyrPlayer(videoElement, sourceUrl, isHls, type, tracks); return; }
        console.log(`Updating Plyr source: ${sourceUrl} (HLS: ${isHls})`);
        const newSource = { type: 'video', title: `${currentEpisodeData.animeTitle} - Ep ${currentEpisodeData.currentEpisodeNumber} (${type.toUpperCase()})`, sources: [{ src: sourceUrl, type: isHls ? 'application/x-mpegURL' : 'video/mp4' }], tracks: tracks };
        if (isHls && typeof Hls !== 'undefined' && Hls.isSupported() && hlsInstance) { hlsInstance.loadSource(sourceUrl); plyrPlayer.source = newSource; }
        else if (isHls && typeof Hls !== 'undefined' && Hls.isSupported() && !hlsInstance) { initializePlyrPlayer(videoElement, sourceUrl, isHls, type, tracks); } // Re-init if HLS instance lost
        else { plyrPlayer.source = newSource; }
    }

    /** Updates SUB/DUB button states */
    function updateStreamTypeButtons(isError = false) {
        let subAvailable = false, dubAvailable = false;
        if (!isError && currentEpisodeData?.currentSourceData?.sources?.length > 0) {
            const sources = currentEpisodeData.currentSourceData.sources;
            const isDub = (s) => (s.quality?.toLowerCase().includes('dub') || s.url?.toLowerCase().includes('dub'));
            dubAvailable = sources.some(isDub);
            subAvailable = sources.some(s => !isDub(s)); // Available if at least one non-dub source exists
        }
        // Update button classes based on availability and selection...
        if(subButton) { subButton.disabled = !subAvailable; subButton.classList.toggle('bg-purple-600', currentEpisodeData.selectedType === 'sub' && subAvailable); /* ... other classes ... */ }
        if(dubButton) { dubButton.disabled = !dubAvailable; dubButton.classList.toggle('bg-purple-600', currentEpisodeData.selectedType === 'dub' && dubAvailable); /* ... other classes ... */ }
    }

    /** Sets up skip intro/outro buttons */
    function setupSkipButtons() {
        if (!plyrPlayer || !skipIntroButton || !skipOutroButton) return;
        const intro = currentEpisodeData.intro;
        const outro = currentEpisodeData.outro;
        let introVisible = false, outroVisible = false;

        plyrPlayer.off('timeupdate', handleTimeUpdate); // Remove previous listener
        clearTimeout(skipIntroTimeout); clearTimeout(skipOutroTimeout);
        skipIntroButton.removeEventListener('click', handleSkipIntro);
        skipOutroButton.removeEventListener('click', handleSkipOutro);
        skipIntroButton.classList.remove('visible'); skipOutroButton.classList.remove('visible'); // Reset visibility

        function handleTimeUpdate() { /* ... (logic to show/hide buttons based on currentTime, intro.end, outro.start) ... */
             if (!plyrPlayer) return;
             const currentTime = plyrPlayer.currentTime;
             const duration = plyrPlayer.duration;

             // Intro Button
             if (intro && intro.end > 0 && currentTime >= intro.start && currentTime < intro.end) {
                 if (!introVisible) { skipIntroButton.classList.add('visible'); introVisible = true; }
             } else if (introVisible) { skipIntroButton.classList.remove('visible'); introVisible = false; }

             // Outro Button (only if duration is known and outro start is valid)
             if (outro && outro.start > 0 && duration > 0 && currentTime >= outro.start && currentTime < (outro.end || duration)) {
                  if (!outroVisible) { skipOutroButton.classList.add('visible'); outroVisible = true; }
             } else if (outroVisible) { skipOutroButton.classList.remove('visible'); outroVisible = false; }
        }
        function handleSkipIntro() { if (plyrPlayer && intro?.end > 0) { plyrPlayer.currentTime = intro.end; skipIntroButton.classList.remove('visible'); introVisible = false; } }
        function handleSkipOutro() { if (plyrPlayer && outro?.end > 0) { plyrPlayer.currentTime = outro.end; skipOutroButton.classList.remove('visible'); outroVisible = false; } else if (plyrPlayer) { plyrPlayer.currentTime = plyrPlayer.duration; } } // Skip to end if no outro.end

        if ((intro && intro.end > 0) || (outro && outro.start > 0)) { plyrPlayer.on('timeupdate', handleTimeUpdate); }
        if (intro && intro.end > 0) skipIntroButton.addEventListener('click', handleSkipIntro);
        if (outro && outro.start > 0) skipOutroButton.addEventListener('click', handleSkipOutro);
    }

    // --- Fetch Initial Data ---
    try {
        const animeInfo = await fetchAnimeInfoFromStreamingAPI(currentEpisodeData.streamingId);
        if (!animeInfo) throw new Error("Could not retrieve anime details.");
        if (!animeInfo.episodes) animeInfo.episodes = [];

        currentEpisodeData.episodes = animeInfo.episodes;
        currentEpisodeData.animeTitle = animeInfo.title?.english || animeInfo.title?.romaji || 'Anime';
        const currentEp = animeInfo.episodes.find(ep => ep.id === currentEpisodeData.episodeId);
        currentEpisodeData.currentEpisodeNumber = currentEp?.number || (animeInfo.episodes.length === 1 ? 'Movie/Special' : '?');

        document.title = `Watching ${currentEpisodeData.animeTitle} - Ep ${currentEpisodeData.currentEpisodeNumber}`;
        if(episodeTitleArea) episodeTitleArea.textContent = `${currentEpisodeData.animeTitle} - Episode ${currentEpisodeData.currentEpisodeNumber}`;
        if (sidebarAnimeTitle) sidebarAnimeTitle.textContent = currentEpisodeData.animeTitle;

        // Populate Episode List Sidebar
        if (episodeListUL && episodeListContainer) {
             if (currentEpisodeData.episodes.length > 0) {
                 episodeListUL.innerHTML = currentEpisodeData.episodes.map(ep => createSidebarEpisodeItemHTML(ep, currentEpisodeData.streamingId, currentEpisodeData.aniListId, ep.id === currentEpisodeData.episodeId)).join('');
                 const activeItem = episodeListUL.querySelector('.active');
                 if (activeItem) activeItem.scrollIntoView({ behavior: 'auto', block: 'center' });
                 episodeListUL.classList.remove('hidden');
                 if(episodeListError) episodeListError.classList.add('hidden');
             } else { /* Handle no episodes listed */ }
             if(episodeListLoading) episodeListLoading.classList.add('hidden');
        } else { /* Handle missing list elements */ }

        // Fetch initial video source (will also setup skip buttons via player 'ready' event)
        await loadVideoSource(currentEpisodeData.selectedType);

        if(loadingMessage) loadingMessage.classList.add('hidden');
        if(mainContent) mainContent.classList.remove('hidden');

    } catch (initError) { /* ... error handling ... */
        console.error("Initialization Error:", initError);
        if (loadingMessage) loadingMessage.classList.add('hidden');
        if (errorMessage) { errorMessage.textContent = `Error loading episode page: ${initError.message}`; errorMessage.classList.remove('hidden'); }
        if(mainContent) mainContent.classList.add('hidden');
    }

    // --- Event Listeners for Controls ---
    if (subButton) subButton.addEventListener('click', () => { if (!subButton.disabled && currentEpisodeData.selectedType !== 'sub') loadVideoSource('sub'); });
    if (dubButton) dubButton.addEventListener('click', () => { if (!dubButton.disabled && currentEpisodeData.selectedType !== 'dub') loadVideoSource('dub'); });
    if (serverSelect) serverSelect.addEventListener('change', (e) => { currentEpisodeData.selectedServer = e.target.value; loadVideoSource(currentEpisodeData.selectedType); });
}

// --- End of initEpisodePage ---

// IMPORTANT: Ensure the corresponding init function (initIndexPage, initAnimePage, or initEpisodePage)
// is called within a DOMContentLoaded listener at the bottom of each respective HTML file.
