// --- Constants and Global Variables ---
const ANILIST_API_URL = 'https://graphql.anilist.co';
const STREAMING_API_BASE_URL = 'https://api-pearl-seven-88.vercel.app'; // User-provided API

let searchTimeoutId = null; // For debouncing search input
let featuredSwiper = null; // Swiper instance for index page slider
let dplayerInstance = null; // DPlayer instance

let currentEpisodeData = { // Structure to hold episode page state
    streamingId: null,    // ID of the anime on the streaming service
    baseEpisodeId: null, // Store the ID without $sub/$dub suffix
    currentEpisodeId: null, // The full ID passed in the URL initially
    aniListId: null,      // Original AniList ID for reference and navigation
    episodes: [],         // Full list of episodes for the anime (from streaming service)
    currentSourceData: null, // Holds full API response for current episode { headers, sources, subtitles, intro, outro, ... }
    selectedServer: 'vidcloud', // Default or currently selected streaming server
    selectedType: 'sub',  // 'sub' or 'dub' - currently selected stream type
    animeTitle: 'Loading...', // Title of the anime
    currentEpisodeNumber: '?', // Number of the current episode
    intro: null,          // { start, end } seconds for intro skip
    outro: null,          // { start, end } seconds for outro skip
    // Subtitles handled directly in DPlayer options
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

/**
 * Gets the current season and year.
 * @returns {object} - Object with season ('WINTER', 'SPRING', 'SUMMER', 'FALL') and year.
 */
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

/**
 * Basic HTML tag removal for descriptions, preserving line breaks.
 * @param {string} desc - The HTML description string.
 * @returns {string} - Plain text description with newlines.
 */
function sanitizeDescription(desc) {
    if (!desc) return 'No description available.';
    let sanitized = desc.replace(/<br\s*\/?>/gi, '\n'); // Preserve line breaks
    sanitized = sanitized.replace(/<[^>]+>/g, ''); // Remove other tags
    return sanitized.trim();
}

/**
 * Debounce function to limit the rate at which a function can fire.
 * @param {Function} func - The function to debounce.
 * @param {number} delay - The debounce delay in milliseconds.
 * @returns {Function} - The debounced function.
 */
function debounce(func, delay) {
    let timeoutId;
    return function(...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

/**
 * Gets URL query parameters as an object.
 * @returns {object} - An object containing key-value pairs of URL parameters.
 */
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
 * Maps AniList format to potential streaming API format strings (heuristic).
 * Used for improving matching between AniList details and streaming search results.
 * @param {string} aniListFormat - Format from AniList (e.g., "TV", "MOVIE", "OVA").
 * @returns {string|null} Corresponding format string (e.g., "TV Series", "Movie") or null.
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
        default: return aniListFormat; // Return original if no specific mapping found
    }
}

// --- API Fetching ---

/**
 * Fetches data from the AniList GraphQL API.
 * @param {string} query - The GraphQL query string.
 * @param {object} variables - Variables for the query.
 * @returns {Promise<object>} - The data part of the API response.
 * @throws {Error} - If the fetch or GraphQL query fails.
 */
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
            throw new Error(`AniList API Error: ${message}`);
        }
        console.log('AniList Response OK'); // Simplified log
        return result.data;
    } catch (error) {
        console.error("AniList API Fetch Error:", error);
        throw error; // Re-throw for handling by caller
    }
}

/**
 * Fetches data from the Streaming API (Consumet-based).
 * Includes basic validation for empty results.
 * @param {string} endpoint - The API endpoint path (e.g., '/anime/zoro/naruto').
 * @param {string} [errorMessage='Error fetching streaming data'] - Custom error message prefix.
 * @returns {Promise<object>} - The JSON response data.
 * @throws {Error} - If the fetch fails or returns an error status.
 */
async function fetchStreamingApi(endpoint, errorMessage = 'Error fetching streaming data') {
    const url = `${STREAMING_API_BASE_URL}${endpoint}`;
    try {
        console.log('Fetching Streaming API:', url);
        const response = await fetch(url);
        if (!response.ok) {
            let errorBody = null;
            try { errorBody = await response.json(); } catch (e) { /* ignore parsing error */ }
            console.error(`Streaming API HTTP error! Status: ${response.status}`, errorBody);
            const message = errorBody?.message || response.statusText || 'Unknown error';
            throw new Error(`${errorMessage}: ${message} (Status: ${response.status})`);
        }
        const data = await response.json();
        console.log('Streaming API Response OK'); // Simplified log

        // Basic validation/warnings for empty or unexpected results
        if (data && endpoint.includes('/search') && (!data.results || data.results.length === 0)) {
            console.warn(`Streaming API returned no search results for ${endpoint}`);
            return { results: [] }; // Ensure consistent structure for search
        }
        if (data && endpoint.includes('/info') && (!data.episodes)) {
            console.warn(`Streaming API info response missing 'episodes' array for ${endpoint}`);
            data.episodes = []; // Ensure episodes array exists
        }
        if (data && endpoint.includes('/watch') && (!data.sources)) {
            console.warn(`Streaming API watch response missing 'sources' array for ${endpoint}`);
            data.sources = []; // Ensure sources array exists
        }
         if (data && endpoint.includes('/watch') && (!data.subtitles)) {
            console.warn(`Streaming API watch response missing 'subtitles' array for ${endpoint}`);
            data.subtitles = []; // Ensure subtitles array exists
        }
        return data;
    } catch (error) {
        console.error("Streaming API Fetch Error:", error);
        // Don't re-wrap error message if it already starts with our prefix
        if (!error.message.startsWith(errorMessage)) {
            throw new Error(`${errorMessage}: ${error.message}`);
        }
        throw error; // Re-throw
    }
}

// --- Specific Streaming API Functions ---

/**
 * Fetches detailed info (including episodes) for an anime from the streaming API.
 * @param {string} streamingId - The anime ID from the streaming API (obtained from search).
 * @returns {Promise<object|null>} - The anime info object, or null if not found/error.
 */
async function fetchAnimeInfoFromStreamingAPI(streamingId) {
    if (!streamingId) return null;
    try {
        // The API uses the ID in the info endpoint path or query param
        const data = await fetchStreamingApi(`/anime/zoro/info?id=${encodeURIComponent(streamingId)}`, `Error fetching info for ID "${streamingId}"`);
        return data || null; // Return the data object { id, title, episodes, ... }
    } catch (error) {
        console.error(`Failed to fetch streaming API info for ID "${streamingId}":`, error);
        return null;
    }
}

/**
 * Fetches streaming links, subtitles, intro/outro times for a specific episode ID.
 * Ensures sources and subtitles arrays exist in the returned object.
 * @param {string} episodeIdToFetch - The specific episode ID (e.g., with $sub or $dub suffix) for the API call.
 * @param {string} server - The server name (e.g., 'vidcloud').
 * @returns {Promise<object|null>} - The full watch data object, or null if error.
 */
async function fetchEpisodeWatchData(episodeIdToFetch, server = 'vidcloud') {
    if (!episodeIdToFetch) {
        console.error("fetchEpisodeWatchData called with invalid episodeId:", episodeIdToFetch);
        return null;
    }
    try {
        // Use the specifically constructed episode ID for the API call
        const data = await fetchStreamingApi(`/anime/zoro/watch?episodeId=${encodeURIComponent(episodeIdToFetch)}&server=${server}`, `Error fetching watch data for episode "${episodeIdToFetch}"`);

        // *** DEBUGGING: Log the raw API response ***
        console.log(`--- Raw Watch Data Response for ${episodeIdToFetch} ---`);
        console.log(JSON.stringify(data, null, 2)); // Log the full structure
        console.log("-------------------------------");

        // Ensure structure consistency, even if API returns null/undefined fields
        return {
            headers: data?.headers || {},
            sources: data?.sources || [],
            subtitles: data?.subtitles || [],
            intro: data?.intro || { start: 0, end: 0 },
            outro: data?.outro || { start: 0, end: 0 },
            download: data?.download // Keep download link if available
        };
    } catch (error) {
        console.error(`Failed to fetch watch data for episode "${episodeIdToFetch}" on server "${server}":`, error);
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
    // Link uses the base episode ID from the /info endpoint
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
    // Link uses the base episode ID from the /info endpoint
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
    async function fetchAndDisplaySuggestions(term) {
        if (!term || term.length < 3) { hideSearchSuggestions(); return; }
        const variables = { search: term, perPage: 6 };
        try {
            const data = await fetchAniListApi(ANILIST_SEARCH_QUERY, variables);
            const mediaList = data?.Page?.media || [];
            if (mediaList.length === 0) { searchSuggestionsContainer.innerHTML = '<p class="text-gray-400 text-sm p-3 text-center">No results found.</p>'; }
            else { searchSuggestionsContainer.innerHTML = mediaList.map(media => createSearchSuggestionHTML(media)).join(''); }
            showSearchSuggestions();
        } catch (error) { console.error('Fetch Suggestions Error:', error); searchSuggestionsContainer.innerHTML = `<p class="text-red-500 text-sm p-3 text-center">Error loading suggestions.</p>`; showSearchSuggestions(); }
    }
    const debouncedFetch = debounce(fetchAndDisplaySuggestions, 350);
    searchInput.addEventListener('input', (e) => debouncedFetch(e.target.value.trim()));
    searchInput.addEventListener('focus', () => { if (searchInput.value.trim().length >= 3) fetchAndDisplaySuggestions(searchInput.value.trim()); });
    searchInput.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== searchInput && !searchSuggestionsContainer?.contains(document.activeElement)) { hideSearchSuggestions(); if (window.innerWidth < 1024 && !searchInput.classList.contains('hidden') && typeof toggleMobileSearch === 'function') toggleMobileSearch(false); } }, 150); });
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
    window.toggleMobileSearch = toggleMobileSearch; // Expose globally if needed
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
        } else if (swiperWrapperFeatured) { swiperWrapperFeatured.innerHTML = '<div class="swiper-slide flex items-center justify-center h-full"><p class="text-gray-400 p-4">Could not load featured anime.</p></div>'; }

        // Populate Trending Grid
        if (hasTrending && trendingGrid) {
            trendingGrid.innerHTML = ''; // Clear skeletons
            data.trending.media.slice(0, 10).forEach(anime => { trendingGrid.innerHTML += createAnimeCardHTML(anime); });
        } else if (trendingGrid) { trendingGrid.innerHTML = '<p class="text-gray-400 col-span-full p-4 text-center">Could not load trending anime.</p>'; }

        // Populate Popular Grid
        if (hasPopular && popularGrid) {
            popularGrid.innerHTML = ''; // Clear skeletons
            data.popular.media.forEach(anime => { popularGrid.innerHTML += createAnimeCardHTML(anime); });
        } else if (popularGrid) { popularGrid.innerHTML = '<p class="text-gray-400 col-span-full p-4 text-center">Could not load popular anime for this season.</p>'; }

        // Populate Top Anime Lists
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
        // Show errors in specific sections...
        if (swiperWrapperFeatured) swiperWrapperFeatured.innerHTML = '<div class="swiper-slide flex items-center justify-center h-full"><p class="text-red-400 p-4">Failed to load featured.</p></div>';
        if (trendingGrid) trendingGrid.innerHTML = '<p class="text-red-400 col-span-full p-4 text-center">Failed to load trending.</p>';
        if (popularGrid) popularGrid.innerHTML = '<p class="text-red-400 col-span-full p-4 text-center">Failed to load popular.</p>';
        const errorMsgTop = '<li><p class="text-red-400 p-2">Failed to load top anime.</p></li>';
        if (topAnimeListDesktop) topAnimeListDesktop.innerHTML = errorMsgTop;
        if (topAnimeListMobile) topAnimeListMobile.innerHTML = errorMsgTop;
        if (topAnimeListBottomMobile) topAnimeListBottomMobile.innerHTML = errorMsgTop;
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

    const urlParams = getUrlParams();
    const aniListId = urlParams.id ? parseInt(urlParams.id) : null;
    if (!aniListId) {
         console.error("AniList ID not found in URL.");
         if (detailLoadingMessage) detailLoadingMessage.classList.add('hidden');
         if (detailErrorMessage) { detailErrorMessage.textContent = "Error: No Anime ID specified."; detailErrorMessage.classList.remove('hidden'); }
         return;
    }
    if (backButton) {
         backButton.addEventListener('click', () => { if (window.history.length > 1) history.back(); else window.location.href = 'index.html'; });
    }

    try {
        const aniListData = await fetchAniListApi(ANILIST_DETAIL_QUERY, { id: aniListId });
        const aniListMedia = aniListData?.Media;
        if (!aniListMedia) throw new Error('Anime not found on AniList.');

        // --- Populate Detail View (from AniList data) ---
        if(detailLoadingMessage) detailLoadingMessage.classList.add('hidden');
        if(detailErrorMessage) detailErrorMessage.classList.add('hidden');
        if(detailContentArea) detailContentArea.classList.remove('hidden');
        const pageTitle = aniListMedia.title.english || aniListMedia.title.romaji || 'Details';
        document.title = `AniStream - ${pageTitle}`;

        // Banner
        if(detailBanner) {
            const bannerUrl = aniListMedia.bannerImage || aniListMedia.coverImage.extraLarge || '';
            const fallbackBanner = `https://placehold.co/1200x400/${(aniListMedia.coverImage.color || '1a202c').substring(1)}/374151?text=No+Banner`;
            detailBanner.style.backgroundImage = `url('${bannerUrl}')`;
            detailBanner.onerror = () => { detailBanner.style.backgroundImage = `url('${fallbackBanner}')`; };
            detailBanner.classList.remove('animate-pulse', 'bg-gray-700');
        }
        // Cover Image
        if(detailCoverImage) {
            detailCoverImage.src = aniListMedia.coverImage.large || 'https://placehold.co/160x240/1f2937/4a5568?text=N/A';
            detailCoverImage.alt = `${pageTitle} Cover`;
            detailCoverImage.onerror = () => { detailCoverImage.src = 'https://placehold.co/160x240/1f2937/4a5568?text=N/A'; };
            detailCoverImage.classList.remove('animate-pulse', 'bg-gray-700');
        }
        // Title
        if(detailTitle) {
            detailTitle.textContent = aniListMedia.title.english || aniListMedia.title.romaji || aniListMedia.title.native || 'N/A';
            detailTitle.className = 'text-2xl sm:text-3xl font-bold text-white mb-1 line-clamp-2';
        }
        // Genres
        if(detailGenres) {
            detailGenres.textContent = aniListMedia.genres?.join(' • ') || 'N/A';
            detailGenres.className = 'text-sm text-purple-300 mb-2';
        }
        // Stats
        if(detailStats) {
            detailStats.innerHTML = `
                <span class="flex items-center" title="Average Score"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4 mr-1 text-yellow-400"><path fill-rule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" clip-rule="evenodd" /></svg> ${aniListMedia.averageScore || '--'}%</span>
                <span title="Status">Status: ${aniListMedia.status?.replace(/_/g, ' ') || '--'}</span>
                <span title="Episodes">Episodes: ${aniListMedia.episodes || '--'}</span>
                <span title="Format">Format: ${aniListMedia.format?.replace(/_/g, ' ') || '--'}</span>
                <span title="Season">Season: ${aniListMedia.season || '--'} ${aniListMedia.seasonYear || '--'}</span>
            `;
            detailStats.className = 'flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-400 mt-2';
        }
        // Description
        if(detailDescription) {
            detailDescription.textContent = sanitizeDescription(aniListMedia.description) || 'No description available.';
            detailDescription.className = 'text-sm text-gray-300 leading-relaxed whitespace-pre-wrap';
        }
        // Trailer
        if (aniListMedia.trailer?.site === 'youtube' && aniListMedia.trailer?.id) {
            if(detailTrailer) {
                const youtubeEmbedUrl = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(aniListMedia.trailer.id)}`;
                detailTrailer.innerHTML = `<iframe class="w-full h-full aspect-video" src="${youtubeEmbedUrl}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy"></iframe>`;
                detailTrailer.classList.remove('animate-pulse', 'bg-gray-700');
            }
            if(detailTrailerSection) detailTrailerSection.classList.remove('hidden');
        } else { if(detailTrailerSection) detailTrailerSection.classList.add('hidden'); }
        // Characters
        if (aniListMedia.characters?.edges?.length > 0 && detailCharacters) {
            detailCharacters.innerHTML = aniListMedia.characters.edges.map(edge => `
                <div class="detail-list-item">
                    <img src="${edge.node.image?.large || 'https://placehold.co/80x110/1f2937/4a5568?text=N/A'}" alt="${edge.node.name?.full || '?'}" loading="lazy" class="shadow-md" onerror="this.src='https://placehold.co/80x110/1f2937/4a5568?text=N/A';"/>
                    <p class="line-clamp-2">${edge.node.name?.full || 'Unknown'}</p>
                    <p class="text-xs text-gray-500">${edge.role}</p>
                </div>`).join('');
        } else if(detailCharacters) { detailCharacters.innerHTML = '<p class="text-sm text-gray-400 italic col-span-full">No character data available.</p>'; }
        // Staff
        if (aniListMedia.staff?.edges?.length > 0 && detailStaff) {
            detailStaff.innerHTML = aniListMedia.staff.edges.map(edge => `
                <div class="detail-list-item">
                    <img src="${edge.node.image?.large || 'https://placehold.co/80x110/1f2937/4a5568?text=N/A'}" alt="${edge.node.name?.full || '?'}" loading="lazy" class="shadow-md" onerror="this.src='https://placehold.co/80x110/1f2937/4a5568?text=N/A';"/>
                    <p class="line-clamp-2">${edge.node.name?.full || 'Unknown'}</p>
                    <p class="text-xs text-gray-500">${edge.role}</p>
                </div>`).join('');
        } else if(detailStaff) { detailStaff.innerHTML = '<p class="text-sm text-gray-400 italic col-span-full">No staff data available.</p>'; }
        // Relations
        if (aniListMedia.relations?.edges?.length > 0 && detailRelations) {
             detailRelations.innerHTML = aniListMedia.relations.edges.filter(edge => edge.node.type === 'ANIME').map(edge => {
                 const relTitle = edge.node.title.english || edge.node.title.romaji || edge.node.title.native || 'Related Title';
                 const relImage = edge.node.coverImage?.large || `https://placehold.co/100x150/1f2937/4a5568?text=N/A`;
                 const relFallbackImage = `https://placehold.co/100x150/1f2937/4a5568?text=N/A`;
                 return `<a href="anime.html?id=${edge.node.id}" class="block bg-gray-700 rounded overflow-hidden text-center text-xs p-1 cursor-pointer hover:bg-gray-600 transition-colors group focus:outline-none focus:ring-1 focus:ring-purple-500" title="${edge.relationType.replace(/_/g, ' ')}"><img src="${relImage}" alt="${relTitle}" class="w-full h-24 object-cover mb-1 pointer-events-none" loading="lazy" onerror="this.onerror=null;this.src='${relFallbackImage}';"/><p class="line-clamp-2 text-gray-300 pointer-events-none group-hover:text-purple-300">${relTitle}</p><p class="text-gray-500 pointer-events-none">${edge.relationType.replace(/_/g, ' ')}</p></a>`;
             }).join('');
             if(detailRelations.innerHTML.trim() !== '') { if(detailRelationsSection) detailRelationsSection.classList.remove('hidden'); }
             else { if(detailRelationsSection) detailRelationsSection.classList.add('hidden'); }
        } else { if(detailRelationsSection) detailRelationsSection.classList.add('hidden'); }


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
                        const resultType = result.type;
                        const resultYear = result.releaseDate ? parseInt(result.releaseDate) : null;
                        const formatMatch = !aniListFormatMapped || !resultType || resultType.includes(aniListFormatMapped) || aniListFormatMapped.includes(resultType);
                        const yearMatch = !aniListYear || !resultYear || resultYear === aniListYear;
                        return formatMatch && yearMatch;
                    });
                    console.log(`Found ${potentialMatches.length} potential matches after filtering.`);

                    if (potentialMatches.length === 1) { bestMatch = potentialMatches[0]; }
                    else if (potentialMatches.length > 1) {
                         const exactTitleMatch = potentialMatches.find(p => p.title.toLowerCase() === (aniListMedia.title.english?.toLowerCase() || '') || p.title.toLowerCase() === (aniListMedia.title.romaji?.toLowerCase() || ''));
                         bestMatch = exactTitleMatch || potentialMatches[0];
                         console.warn(exactTitleMatch ? "Found exact title match." : "Multiple matches, falling back to first potential.");
                    } else { throw new Error(`Could not find a reliable match (Format/Year mismatch? AL: ${aniListFormatMapped}/${aniListYear})`); }
                    console.log("Selected match from streaming service:", bestMatch);

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
                        } else {
                            if (streamingInfo && (!streamingInfo.episodes || streamingInfo.episodes.length === 0)) { throw new Error('No episodes found for this entry on streaming service.'); }
                            else { throw new Error('Could not fetch episode details from streaming service.'); }
                        }
                    } else { throw new Error('Failed to identify a valid streaming ID.'); }
                } catch (episodeError) { // Catch errors specific to episode fetching/matching
                    console.error("Error fetching/displaying episodes:", episodeError);
                    if(detailEpisodesLoading) detailEpisodesLoading.classList.add('hidden');
                    if(detailEpisodesListContainer) detailEpisodesListContainer.classList.add('hidden');
                    if(detailEpisodesError) { detailEpisodesError.textContent = `Could not load episodes: ${episodeError.message}`; detailEpisodesError.classList.remove('hidden'); }
                }
            } else { // Handle missing title for search
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

/** Initializes the Episode Player Page - Using DPlayer (Fixed Init & Events) */
async function initEpisodePage() {
    console.log("Initializing Episode Page with DPlayer");
    setFooterYear();
    setupSearch();
    setupMobileMenu();
    // DOM Element references...
    const loadingMessage = document.getElementById('episode-loading-message');
    const errorMessage = document.getElementById('episode-error-message');
    const mainContent = document.getElementById('episode-main-content');
    const playerWrapper = document.getElementById('player-wrapper');
    const dplayerContainer = document.getElementById('dplayer-container'); // DPlayer container
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

    // Check if DPlayer container exists
    if (!dplayerContainer) {
        console.error("DPlayer container element (#dplayer-container) not found!");
        if (loadingMessage) loadingMessage.classList.add('hidden');
        if (errorMessage) { errorMessage.textContent = "Error: Player container missing in HTML."; errorMessage.classList.remove('hidden'); }
        return;
    }
    // Check if DPlayer library is loaded
     if (typeof DPlayer === 'undefined') {
         console.error("DPlayer library is not loaded. Check script tags in episode.html.");
         if (loadingMessage) loadingMessage.classList.add('hidden');
         if (errorMessage) { errorMessage.textContent = "Error: Player library failed to load."; errorMessage.classList.remove('hidden'); }
         return;
     }
     // Check if Hls.js library is loaded (required for HLS in DPlayer)
      if (typeof Hls === 'undefined') {
          console.error("Hls.js library is not loaded. Check script tags in episode.html.");
          // Player might still work for non-HLS, but show warning
          if (errorMessage && !errorMessage.textContent) { // Show only if no other error
              errorMessage.textContent = "Warning: HLS playback library missing, quality options may be limited.";
              errorMessage.classList.remove('hidden');
          }
      }

    const urlParams = getUrlParams();
    const initialEpisodeId = urlParams.episodeId;
    const aniListId = urlParams.aniListId;
    const streamingId = urlParams.streamingId;

    if (!streamingId || !initialEpisodeId || !aniListId) {
        console.error("Missing required IDs (streamingId, episodeId, aniListId) in URL.");
        if (loadingMessage) loadingMessage.classList.add('hidden');
        if (errorMessage) { errorMessage.textContent = "Error: Missing required information."; errorMessage.classList.remove('hidden'); }
        return;
    }

    // --- Parse Base Episode ID ---
    let baseEpisodeId = initialEpisodeId;
    const lastDollarIndex = initialEpisodeId.lastIndexOf('$');
    if (lastDollarIndex > 0) {
        const suffix = initialEpisodeId.substring(lastDollarIndex + 1);
        if (suffix === 'sub' || suffix === 'dub' || suffix === 'both') {
            baseEpisodeId = initialEpisodeId.substring(0, lastDollarIndex);
        } else { baseEpisodeId = initialEpisodeId; }
    } else { baseEpisodeId = initialEpisodeId; }

    // Reset state
    currentEpisodeData = {
        streamingId: streamingId, baseEpisodeId: baseEpisodeId, currentEpisodeId: initialEpisodeId, aniListId: aniListId,
        episodes: [], currentSourceData: null, selectedServer: serverSelect ? serverSelect.value : 'vidcloud',
        selectedType: initialEpisodeId.includes('$dub') ? 'dub' : 'sub', animeTitle: 'Loading...', currentEpisodeNumber: '?',
        intro: null, outro: null,
    };
    console.log("Initial State:", currentEpisodeData);

    if (backButton && currentEpisodeData.aniListId) {
         backButton.href = `anime.html?id=${currentEpisodeData.aniListId}`;
         backButton.onclick = (e) => { e.preventDefault(); if (document.referrer && document.referrer.includes(`anime.html?id=${currentEpisodeData.aniListId}`)) { history.back(); } else { window.location.href = `anime.html?id=${currentEpisodeData.aniListId}`; } };
    }
    // Hide loading message now that basic checks passed
    if(loadingMessage) loadingMessage.classList.add('hidden');
    if(errorMessage) errorMessage.classList.add('hidden');
    if(mainContent) mainContent.classList.add('hidden'); // Keep hidden until data fetch


    /** Loads video source, subtitles, skip times and initializes/updates DPlayer */
    async function loadVideoSource(type = 'sub') {
        console.log(`Load Request: type=${type}, server=${currentEpisodeData.selectedServer}`);
        currentEpisodeData.selectedType = type;
        // Show loading state
        if (dplayerInstance) dplayerInstance.pause();
        if (skipIntroButton) skipIntroButton.classList.remove('visible');
        if (skipOutroButton) skipOutroButton.classList.remove('visible');
        if (errorMessage) errorMessage.classList.add('hidden');
        dplayerContainer.innerHTML = '<p class="text-center text-gray-400 p-4">Loading player...</p>'; // Placeholder

        const episodeIdToFetch = `${currentEpisodeData.baseEpisodeId}$${type}`;
        console.log(`Fetching watch data for constructed ID: ${episodeIdToFetch}`);

        try {
            const watchData = await fetchEpisodeWatchData(episodeIdToFetch, currentEpisodeData.selectedServer);
            currentEpisodeData.currentSourceData = watchData;

            if (!watchData) throw new Error(`Failed to fetch watch data for ${type.toUpperCase()}.`);
            if (!watchData.sources || watchData.sources.length === 0) {
                 if (watchData.download) {
                     console.warn(`No streaming sources found, attempting download link: ${watchData.download}`);
                     currentEpisodeData.intro = { start: 0, end: 0 }; currentEpisodeData.outro = { start: 0, end: 0 };
                     initializeOrUpdateDPlayer(watchData.download, type, null, false); // Load download link, no subs, not HLS
                     updateStreamTypeButtons();
                     return;
                 }
                 throw new Error(`No sources found for ${type.toUpperCase()} on server ${currentEpisodeData.selectedServer}.`);
            }

            currentEpisodeData.intro = watchData.intro || { start: 0, end: 0 };
            currentEpisodeData.outro = watchData.outro || { start: 0, end: 0 };

            let sourceUrl = null, isHls = false;
            const sourcesToUse = watchData.sources;
            const hlsSource = sourcesToUse.find(s => s.isM3U8 || s.url?.includes('.m3u8'));
            if (hlsSource) { sourceUrl = hlsSource.url; isHls = true; }
            else { const autoSource = sourcesToUse.find(s => s.quality?.toLowerCase() === 'auto' || s.quality?.toLowerCase() === 'default'); sourceUrl = autoSource ? autoSource.url : sourcesToUse[0]?.url; isHls = sourceUrl?.includes('.m3u8') || false; }

            if (!sourceUrl) throw new Error(`Could not find a suitable video URL for ${type.toUpperCase()}.`);
            console.log(`Selected Source: ${sourceUrl} (HLS: ${isHls})`);

            // Find first English subtitle URL (excluding thumbnails)
            const firstEnglishSub = watchData.subtitles?.find(s => s.lang?.toLowerCase().includes('english') && s.lang?.toLowerCase() !== 'thumbnails');
            const subtitleUrl = firstEnglishSub?.url || null;
            console.log("Selected Subtitle URL for DPlayer:", subtitleUrl);

            updateStreamTypeButtons();
            initializeOrUpdateDPlayer(sourceUrl, type, subtitleUrl, isHls);

        } catch (error) {
             console.error(`Error loading video source for ${type.toUpperCase()}:`, error);
             if (errorMessage) { errorMessage.textContent = `Failed to load video: ${error.message}`; errorMessage.classList.remove('hidden'); }
             updateStreamTypeButtons(true);
             dplayerContainer.innerHTML = `<p class="text-center text-red-500 p-4">Failed to load player: ${error.message}</p>`;
        }
    }

    /** Initializes or updates the DPlayer instance */
    function initializeOrUpdateDPlayer(sourceUrl, type, subtitleUrl, isHls) {
        console.log("Initializing/Updating DPlayer...");

        // Destroy previous instance if it exists
        if (dplayerInstance) {
            try {
                // Remove event listeners before destroying if possible
                if (dplayerInstance.video) {
                     dplayerInstance.video.removeEventListener('timeupdate', handleTimeUpdate); // Use stored handler reference
                }
                dplayerInstance.destroy();
                console.log("Previous DPlayer instance destroyed.");
            } catch (e) {
                console.error("Error destroying previous DPlayer instance:", e);
            }
            dplayerInstance = null; // Clear reference
        }

        // Prepare DPlayer options
        const dplayerOptions = {
            container: dplayerContainer,
            theme: '#7c3aed', // Purple theme color
            loop: false,
            lang: 'en', // UI language
            screenshot: true,
            hotkey: true,
            preload: 'auto',
            autoplay: false, // Autoplay often blocked by browsers
            video: {
                url: sourceUrl,
                type: isHls && typeof Hls !== 'undefined' ? 'hls' : 'auto', // Use 'hls' if HLS.js is loaded, otherwise 'auto'
                // pic: '', // Optional poster image
                // thumbnails: '', // Optional thumbnails VTT
            },
            subtitle: subtitleUrl ? {
                url: subtitleUrl,
                type: 'webvtt',
                fontSize: '20px',
                bottom: '10%',
                color: '#FFF',
            } : undefined, // Only add subtitle object if URL exists
            contextmenu: [ { text: 'AniStream', link: 'index.html' } ],
            // Add more DPlayer options if needed
        };

        // If using HLS, provide hls.js instance to DPlayer if needed (check DPlayer docs for specific version)
        // Some versions might pick up global Hls automatically when type is 'hls'
        // If explicit configuration is needed:
        // if (isHls && typeof Hls !== 'undefined') {
        //     dplayerOptions.video.customType = {
        //         hls: (video, player) => {
        //             const hls = new Hls();
        //             hls.loadSource(sourceUrl);
        //             hls.attachMedia(video);
        //             window.hls = hls; // Make accessible if needed
        //             hls.on(Hls.Events.ERROR, (event, data) => { console.error('HLS Error in DPlayer:', data); });
        //         }
        //     };
        // }

        console.log("DPlayer Options:", dplayerOptions);

        try {
            // Create new DPlayer instance
            dplayerInstance = new DPlayer(dplayerOptions);
            console.log("DPlayer instance created.");

            // Attach event listeners for skip buttons etc. AFTER instance created
            setupSkipButtons(); // Setup skip buttons now player exists

            // Optional: Listen for DPlayer events
            dplayerInstance.on('error', () => {
                 console.error('DPlayer reported an error.');
                 if (errorMessage && !errorMessage.textContent.includes('Failed to load')) {
                     errorMessage.textContent = 'Video player encountered an error.';
                     errorMessage.classList.remove('hidden');
                 }
            });
             dplayerInstance.on('loadeddata', () => {
                 console.log('DPlayer loadeddata event fired.');
                 // Can potentially re-run setupSkipButtons here if needed, e.g., if duration wasn't known initially
                 // setupSkipButtons();
             });
             dplayerInstance.on('canplay', () => {
                 console.log('DPlayer canplay event fired.');
             });
             dplayerInstance.on('subtitle_show', () => console.log('DPlayer subtitle_show'));
             dplayerInstance.on('subtitle_hide', () => console.log('DPlayer subtitle_hide'));
             dplayerInstance.on('quality_start', (q) => console.log('DPlayer quality_start', q));
             dplayerInstance.on('quality_end', () => console.log('DPlayer quality_end'));


        } catch (error) {
            console.error("!!! CRITICAL ERROR INITIALIZING DPLAYER !!!", error);
            if (errorMessage) { errorMessage.textContent = `Failed to initialize player: ${error.message}`; errorMessage.classList.remove('hidden'); }
            dplayerContainer.innerHTML = `<p class="text-center text-red-500 p-4">Failed to initialize player: ${error.message}</p>`;
        }
    }


    /** Updates SUB/DUB button states - simplified */
    function updateStreamTypeButtons(isError = false) {
        const subAvailable = !isError; const dubAvailable = !isError; // Simplified check
        console.log(`Updating buttons: SUB=${subAvailable}, DUB=${dubAvailable}, Selected=${currentEpisodeData.selectedType}`);
        if(subButton) { subButton.disabled = !subAvailable; subButton.classList.toggle('bg-purple-600', currentEpisodeData.selectedType === 'sub' && subAvailable); subButton.classList.toggle('text-white', currentEpisodeData.selectedType === 'sub' && subAvailable); subButton.classList.toggle('bg-gray-700', currentEpisodeData.selectedType !== 'sub' || !subAvailable); subButton.classList.toggle('text-gray-200', currentEpisodeData.selectedType !== 'sub' || !subAvailable); subButton.classList.toggle('opacity-50', !subAvailable); subButton.classList.toggle('cursor-not-allowed', !subAvailable); }
        if(dubButton) { dubButton.disabled = !dubAvailable; dubButton.classList.toggle('bg-purple-600', currentEpisodeData.selectedType === 'dub' && dubAvailable); dubButton.classList.toggle('text-white', currentEpisodeData.selectedType === 'dub' && dubAvailable); dubButton.classList.toggle('bg-gray-700', currentEpisodeData.selectedType !== 'dub' || !dubAvailable); dubButton.classList.toggle('text-gray-200', currentEpisodeData.selectedType !== 'dub' || !dubAvailable); dubButton.classList.toggle('opacity-50', !dubAvailable); dubButton.classList.toggle('cursor-not-allowed', !dubAvailable); }
    }

    // Define these handlers in a scope accessible by setupSkipButtons and the event listeners
    let handleTimeUpdate;
    let handleSkipIntro;
    let handleSkipOutro;

    /** Sets up skip intro/outro buttons for DPlayer */
    function setupSkipButtons() {
        console.log("Setting up skip buttons for DPlayer...");
        if (!dplayerInstance || !dplayerInstance.video || !skipIntroButton || !skipOutroButton) {
            console.warn("Skip buttons or DPlayer instance/video not ready.");
            return;
        }

        const intro = currentEpisodeData.intro;
        const outro = currentEpisodeData.outro;
        let introVisible = false, outroVisible = false;

        // --- Remove previous listeners using the correct method ---
        // DPlayer uses .on() and .off() OR standard add/remove on .video
        if (handleTimeUpdate) { // Check if handler exists from previous setup
             dplayerInstance.video.removeEventListener('timeupdate', handleTimeUpdate);
             console.log("Removed previous timeupdate listener.");
        }
        clearTimeout(skipIntroTimeout); clearTimeout(skipOutroTimeout);
        skipIntroButton.removeEventListener('click', handleSkipIntro);
        skipOutroButton.removeEventListener('click', handleSkipOutro);
        skipIntroButton.classList.remove('visible'); skipOutroButton.classList.remove('visible'); // Reset visibility
        // --- End remove previous ---

        handleTimeUpdate = () => { // Assign to the outer scope variable
            if (!dplayerInstance || !dplayerInstance.video || dplayerInstance.video.paused) return;
            const currentTime = dplayerInstance.video.currentTime;
            const duration = dplayerInstance.video.duration;
            if (!duration || duration === Infinity) return;

            // Show/Hide Intro Button
            if (intro && intro.end > 0 && currentTime >= intro.start && currentTime < intro.end) {
                if (!introVisible) { skipIntroButton.classList.add('visible'); introVisible = true; }
            } else if (introVisible) { skipIntroButton.classList.remove('visible'); introVisible = false; }

            // Show/Hide Outro Button
            if (outro && outro.start > 0 && currentTime >= outro.start && currentTime < (outro.end || duration)) {
                 if (!outroVisible) { skipOutroButton.classList.add('visible'); outroVisible = true; }
            } else if (outroVisible) { skipOutroButton.classList.remove('visible'); outroVisible = false; }
        };

        handleSkipIntro = () => { // Assign to the outer scope variable
            if (dplayerInstance && intro?.end > 0) {
                 dplayerInstance.seek(intro.end);
                 skipIntroButton.classList.remove('visible'); introVisible = false;
            }
        };

        handleSkipOutro = () => { // Assign to the outer scope variable
            if (dplayerInstance && outro?.end > 0) {
                 dplayerInstance.seek(outro.end);
                 skipOutroButton.classList.remove('visible'); outroVisible = false;
            } else if (dplayerInstance && dplayerInstance.video.duration) {
                 dplayerInstance.seek(dplayerInstance.video.duration); // Seek to end if no specific outro end time
            }
        };

        // Attach listeners only if times are valid
        if ((intro && intro.end > 0) || (outro && outro.start > 0)) {
             console.log("Attaching DPlayer timeupdate listener for skip buttons.");
             // Use standard addEventListener on the video element
             dplayerInstance.video.addEventListener('timeupdate', handleTimeUpdate);
        } else { console.log("No valid intro/outro times, skip buttons disabled."); }

        if (intro && intro.end > 0) skipIntroButton.addEventListener('click', handleSkipIntro);
        if (outro && outro.start > 0) skipOutroButton.addEventListener('click', handleSkipOutro);
        console.log("Skip buttons setup complete.");
    }

    // --- Fetch Initial Data ---
    try {
        const animeInfo = await fetchAnimeInfoFromStreamingAPI(currentEpisodeData.streamingId);
        if (!animeInfo) throw new Error("Could not retrieve anime details.");
        if (!animeInfo.episodes) animeInfo.episodes = [];

        currentEpisodeData.episodes = animeInfo.episodes;
        currentEpisodeData.animeTitle = animeInfo.title?.english || animeInfo.title?.romaji || 'Anime';
        const currentEpInfo = animeInfo.episodes.find(ep => ep.id === currentEpisodeData.baseEpisodeId);
        currentEpisodeData.currentEpisodeNumber = currentEpInfo?.number || (animeInfo.episodes.length === 1 ? 'Movie/Special' : '?');

        document.title = `Watching ${currentEpisodeData.animeTitle} - Ep ${currentEpisodeData.currentEpisodeNumber}`;
        if(episodeTitleArea) episodeTitleArea.textContent = `${currentEpisodeData.animeTitle} - Episode ${currentEpisodeData.currentEpisodeNumber}`;
        if (sidebarAnimeTitle) sidebarAnimeTitle.textContent = currentEpisodeData.animeTitle;

        // Populate Episode List Sidebar
        if (episodeListUL && episodeListContainer) {
             if (currentEpisodeData.episodes.length > 0) {
                 episodeListUL.innerHTML = currentEpisodeData.episodes.map(ep => createSidebarEpisodeItemHTML(ep, currentEpisodeData.streamingId, currentEpisodeData.aniListId, ep.id === currentEpisodeData.baseEpisodeId)).join('');
                 const activeItem = episodeListUL.querySelector('.active');
                 if (activeItem) activeItem.scrollIntoView({ behavior: 'auto', block: 'center' });
                 episodeListUL.classList.remove('hidden');
                 if(episodeListError) episodeListError.classList.add('hidden');
             } else { /* Handle no episodes */ if(episodeListError) { episodeListError.textContent = 'No further episodes listed.'; episodeListError.classList.remove('hidden'); } episodeListUL.classList.add('hidden'); }
             if(episodeListLoading) episodeListLoading.classList.add('hidden');
        } else { /* Handle missing list elements */ }

        // Fetch initial video source
        await loadVideoSource(currentEpisodeData.selectedType);

        if(mainContent) mainContent.classList.remove('hidden'); // Show main content now

    } catch (initError) {
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
