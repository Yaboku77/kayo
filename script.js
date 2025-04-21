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
    }
`;

// Detail Query (for anime.html) - Unchanged
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
            format
            season
            seasonYear
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
    // Basic sanitization: remove <br> and other HTML tags
    // Preserve paragraphs by replacing <br> with newlines, then strip other tags
    let sanitized = desc.replace(/<br\s*\/?>/gi, '\n');
    sanitized = sanitized.replace(/<[^>]+>/g, '');
    // Optional: Convert newlines back to <p> tags or handle in CSS with white-space: pre-wrap
    // For simplicity here, just return text with newlines.
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

// Helper to get URL parameters
function getUrlParams() {
    const params = {};
    const queryString = window.location.search;
    const urlParams = new URLSearchParams(queryString);
    for (const [key, value] of urlParams.entries()) {
        params[key] = value;
    }
    return params;
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
        console.log('Fetching AniList:', { query: query.substring(0, 100) + '...', variables }); // Log request
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
        console.log('AniList Response:', result.data); // Log response
        return result.data;
    } catch (error) {
        console.error("AniList API Fetch Error:", error);
        throw error; // Re-throw to be caught by calling function
    }
}

/**
 * Fetches data from the Streaming API (Consumet-based).
 * @param {string} endpoint - The API endpoint path (e.g., '/anime/zoro/naruto').
 * @param {string} [errorMessage='Error fetching streaming data'] - Custom error message prefix.
 * @returns {Promise<object>} - The JSON response data.
 * @throws {Error} - If the fetch fails or returns an error status.
 */
async function fetchStreamingApi(endpoint, errorMessage = 'Error fetching streaming data') {
    const url = `${STREAMING_API_BASE_URL}${endpoint}`;
    try {
        console.log('Fetching Streaming API:', url); // Log request
        const response = await fetch(url);
        if (!response.ok) {
            let errorBody = null;
            try { errorBody = await response.json(); } catch (e) { /* ignore json parsing error */ }
            console.error(`Streaming API HTTP error! Status: ${response.status}`, errorBody);
            const message = errorBody?.message || response.statusText || 'Unknown error';
            throw new Error(`${errorMessage}: ${message} (Status: ${response.status})`);
        }
        const data = await response.json();
        console.log('Streaming API Response:', data); // Log response
        // Basic check if data seems valid (e.g., not empty for expected results)
        if (data && (typeof data === 'object' && Object.keys(data).length === 0) && endpoint.includes('/watch')) {
             // Empty object for watch endpoint might mean no sources found
             console.warn(`Streaming API returned empty object for ${endpoint}`);
             // Let the calling function handle empty sources specifically
        } else if (!data || (Array.isArray(data) && data.length === 0 && (endpoint.includes('/search') || endpoint.includes('/info')))) {
            // Handle cases like empty search results or info not found gracefully
            console.warn(`Streaming API returned no results for ${endpoint}`);
            // Return empty data structure expected by caller
            if (endpoint.includes('/search')) return { results: [] };
            if (endpoint.includes('/info')) return { episodes: [] }; // Or null, depending on how caller handles it
            // For watch endpoint, empty is handled above
        }
        return data;
    } catch (error) {
        console.error("Streaming API Fetch Error:", error);
        // Don't re-throw generic fetch errors if a specific error was already thrown
        if (!error.message.startsWith(errorMessage)) {
            throw new Error(`${errorMessage}: ${error.message}`);
        }
        throw error; // Re-throw the original or wrapped error
    }
}

// --- Specific Streaming API Functions ---

/**
 * Searches for an anime on the streaming API using its title.
 * @param {string} title - The anime title (preferably English or Romaji).
 * @returns {Promise<object|null>} - The first search result object, or null if not found/error.
 */
async function searchAnimeOnStreamingAPI(title) {
    if (!title) return null;
    try {
        const data = await fetchStreamingApi(`/anime/zoro/${encodeURIComponent(title)}`, `Error searching for "${title}"`);
        return data?.results?.[0] || null; // Return the first result
    } catch (error) {
        console.error(`Failed to search streaming API for "${title}":`, error);
        return null;
    }
}

/**
 * Fetches detailed info (including episodes) for an anime from the streaming API.
 * @param {string} streamingId - The anime ID from the streaming API (obtained from search).
 * @returns {Promise<object|null>} - The anime info object, or null if not found/error.
 */
async function fetchAnimeInfoFromStreamingAPI(streamingId) {
    if (!streamingId) return null;
    try {
        // The API seems to use the ID directly in the info endpoint path
        const data = await fetchStreamingApi(`/anime/zoro/info?id=${encodeURIComponent(streamingId)}`, `Error fetching info for ID "${streamingId}"`);
        return data || null; // Return the data object { id, title, episodes, ... }
    } catch (error) {
        console.error(`Failed to fetch streaming API info for ID "${streamingId}":`, error);
        return null;
    }
}

/**
 * Fetches streaming links (SUB/DUB) for a specific episode.
 * @param {string} episodeId - The episode ID from the streaming API.
 * @param {string} server - The server name (e.g., 'vidcloud').
 * @returns {Promise<object|null>} - The streaming sources object, or null if error.
 */
async function fetchEpisodeStreamLinks(episodeId, server = 'vidcloud') {
    if (!episodeId) return null;
    try {
        const data = await fetchStreamingApi(`/anime/zoro/watch?episodeId=${encodeURIComponent(episodeId)}&server=${server}`, `Error fetching stream links for episode "${episodeId}"`);
        return data || null; // Return the sources object { headers, sources: [{ url, quality, isM3U8 }], download }
    } catch (error) {
        console.error(`Failed to fetch stream links for episode "${episodeId}" on server "${server}":`, error);
        return null;
    }
}


// --- HTML Generation Helpers ---

// Create Featured Slide (Index Page) - Unchanged
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

// Create Anime Card (Index Page Grids) - Unchanged
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

// Create Top Anime List Item (Index Page Sidebars) - Unchanged
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

// Create Search Suggestion Item (Common) - Unchanged
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

/**
 * Creates HTML for an episode link on the anime detail page.
 * @param {object} episode - Episode object from the streaming API { id, number, title?, url? }.
 * @param {string} streamingId - The streaming API's ID for the anime.
 * @param {number} aniListId - The AniList ID for the anime.
 * @returns {string} HTML string for the list item.
 */
function createDetailEpisodeLinkHTML(episode, streamingId, aniListId) {
    if (!episode || !episode.id || !streamingId || !aniListId) return ''; // Need essential IDs
    const episodeNumber = episode.number || '?';
    // Construct the URL for episode.html
    const episodeUrl = `episode.html?streamingId=${encodeURIComponent(streamingId)}&episodeId=${encodeURIComponent(episode.id)}&aniListId=${aniListId}`;
    return `
        <li>
            <a href="${episodeUrl}" class="episode-link" title="Watch Episode ${episodeNumber}">
                Ep ${episodeNumber}
            </a>
        </li>
    `;
}

/**
 * Creates HTML for an episode list item in the sidebar of episode.html.
 * @param {object} episode - Episode object { id, number, title? }.
 * @param {string} streamingId - The streaming API's ID for the anime.
 * @param {number} aniListId - The AniList ID for the anime.
 * @param {boolean} isActive - Whether this is the currently playing episode.
 * @returns {string} HTML string for the list item.
 */
function createSidebarEpisodeItemHTML(episode, streamingId, aniListId, isActive = false) {
    if (!episode || !episode.id || !streamingId || !aniListId) return '';
    const episodeNumber = episode.number || '?';
    const episodeTitle = episode.title ? `: ${episode.title}` : ''; // Add title if available
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


// --- Swiper Initialization (for index.html) ---
function initializeFeaturedSwiper(containerSelector = '#featured-swiper') {
     if (typeof Swiper === 'undefined') { console.error("Swiper library not loaded."); return; }
     if (featuredSwiper) { try { featuredSwiper.destroy(true, true); } catch (e) { console.warn("Error destroying previous Swiper instance:", e); } featuredSwiper = null; }
     const swiperContainer = document.querySelector(containerSelector);
     if (!swiperContainer) { console.warn(containerSelector + " container not found for Swiper."); return; }
     const slides = swiperContainer.querySelectorAll('.swiper-slide');
     if (slides.length === 0) { console.warn("No slides found in " + containerSelector + ". Swiper not initialized."); return; }

     try {
         featuredSwiper = new Swiper(containerSelector, {
             // Optional parameters
             // Install Swiper modules
             modules: [Swiper.Navigation, Swiper.Pagination, Swiper.Autoplay, Swiper.EffectFade, Swiper.Keyboard, Swiper.A11y], // Include necessary modules
             loop: slides.length > 1, // Loop only if more than one slide
             autoplay: {
                 delay: 5000,
                 disableOnInteraction: false, // Keep autoplaying after user interaction
                 pauseOnMouseEnter: true, // Pause when mouse is over the slider
             },
             pagination: {
                 el: containerSelector + ' .swiper-pagination',
                 clickable: true,
             },
             effect: 'fade', // Use fade effect
             fadeEffect: {
                 crossFade: true // Enable cross-fade for smoother transitions
             },
             observer: true, // Re-init Swiper on DOM changes within container
             observeParents: true, // Re-init Swiper on DOM changes of parent elements
             keyboard: { // Enable keyboard navigation
                 enabled: true,
                 onlyInViewport: false,
             },
             a11y: { // Accessibility features
                 prevSlideMessage: 'Previous slide',
                 nextSlideMessage: 'Next slide',
                 paginationBulletMessage: 'Go to slide {{index}}',
             },
             // Add navigation arrows if needed (requires HTML elements for them)
             // navigation: {
             //   nextEl: '.swiper-button-next',
             //   prevEl: '.swiper-button-prev',
             // },
         });
         console.log("Swiper initialized successfully.");
     } catch (e) {
         console.error("Error initializing Swiper:", e);
     }
}

// --- Search Functionality (Common) ---
function setupSearch(searchInputId = 'search-input', suggestionsContainerId = 'search-suggestions', searchIconButtonId = 'search-icon-button', headerTitleSelector = 'header a.text-2xl', mobileMenuButtonId = 'mobile-menu-button') {
    const searchInput = document.getElementById(searchInputId);
    const searchSuggestionsContainer = document.getElementById(suggestionsContainerId);
    const searchIconButton = document.getElementById(searchIconButtonId); // Mobile only button
    const headerTitle = document.querySelector(headerTitleSelector); // Use selector for flexibility
    const mobileMenuButton = document.getElementById(mobileMenuButtonId); // Mobile only interaction

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

    searchInput.addEventListener('input', (e) => {
        debouncedFetch(e.target.value.trim());
    });

    searchInput.addEventListener('focus', () => {
        // Show suggestions if there's already text (e.g., after navigation)
        if (searchInput.value.trim().length >= 3) {
            fetchAndDisplaySuggestions(searchInput.value.trim());
        }
    });

    // Hide suggestions on blur, with a delay to allow clicking on a suggestion
    searchInput.addEventListener('blur', () => {
        setTimeout(() => {
            // Check if the focus is now outside the input AND the suggestions container
            if (document.activeElement !== searchInput && !searchSuggestionsContainer?.contains(document.activeElement)) {
                hideSearchSuggestions();
                // Also hide mobile search bar if it's open
                if (window.innerWidth < 1024 && !searchInput.classList.contains('hidden')) {
                    // Check if toggleMobileSearch is defined before calling
                    if (typeof toggleMobileSearch === 'function') {
                        toggleMobileSearch(false);
                    }
                }
            }
        }, 150); // Delay to allow click event on suggestions
    });

    // Mobile search toggle logic (needs access to header elements)
    function toggleMobileSearch(show) {
        if (window.innerWidth >= 1024) return; // Only on small screens

        // Find the parent container of the search input to manage flex layout
        const searchContainer = searchInput.parentElement; // Assumes input is direct child

        if (show) {
            if(headerTitle) headerTitle.classList.add('hidden');
            if(mobileMenuButton) mobileMenuButton.classList.add('hidden');
            if(searchIconButton) searchIconButton.classList.add('hidden');
            // Make search input visible and take full width within its container
            searchInput.classList.remove('hidden', 'lg:block');
            searchInput.classList.add('block', 'w-full');
            // Ensure the container allows the input to grow
            if(searchContainer) searchContainer.classList.add('flex-grow');
            searchInput.focus();
        } else {
             if(headerTitle) headerTitle.classList.remove('hidden');
             if(mobileMenuButton) mobileMenuButton.classList.remove('hidden');
             if(searchIconButton) searchIconButton.classList.remove('hidden');
             // Hide search input and restore original classes
             searchInput.classList.remove('block', 'w-full');
             searchInput.classList.add('hidden', 'lg:block');
             if(searchContainer) searchContainer.classList.remove('flex-grow');
             searchInput.value = ''; // Clear input when hiding
             hideSearchSuggestions();
        }
    }

    // Make toggleMobileSearch globally accessible if needed by other parts
    window.toggleMobileSearch = toggleMobileSearch;

    if(searchIconButton) {
        searchIconButton.addEventListener('click', () => toggleMobileSearch(true));
    }

    // Global click listener to hide suggestions if clicked outside search area
    document.addEventListener('click', (event) => {
        const isClickInsideSearch = searchInput?.contains(event.target) ||
                                    searchSuggestionsContainer?.contains(event.target) ||
                                    searchIconButton?.contains(event.target);

        if (!isClickInsideSearch) {
            hideSearchSuggestions();
            // Also hide mobile search if it's open and click is outside
            if (window.innerWidth < 1024 && searchInput && !searchInput.classList.contains('hidden')) {
                 // Check if toggleMobileSearch is defined before calling
                 if (typeof toggleMobileSearch === 'function') {
                     toggleMobileSearch(false);
                 }
            }
        }
    });
}


// --- Mobile Menu Functionality (Common) ---
function setupMobileMenu(menuButtonId = 'mobile-menu-button', sidebarContainerId = 'mobile-sidebar-container', sidebarId = 'mobile-sidebar', overlayId = 'sidebar-overlay', closeButtonId = 'close-sidebar-button', navLinkClass = '.mobile-nav-link') {
    const mobileMenuButton = document.getElementById(menuButtonId);
    const mobileSidebarContainer = document.getElementById(sidebarContainerId);
    const mobileSidebar = document.getElementById(sidebarId);
    const sidebarOverlay = document.getElementById(overlayId);
    const closeSidebarButton = document.getElementById(closeButtonId);
    const mobileNavLinks = document.querySelectorAll(navLinkClass);

    if (!mobileMenuButton || !mobileSidebarContainer || !mobileSidebar || !sidebarOverlay || !closeSidebarButton) {
        console.warn("Mobile menu elements not found. Menu disabled.");
        return;
    }

    function openMobileMenu() {
        mobileSidebarContainer.classList.remove('pointer-events-none');
        sidebarOverlay.classList.remove('hidden');
        mobileSidebar.classList.remove('-translate-x-full');
        document.body.classList.add('modal-open');
        mobileMenuButton.setAttribute('aria-expanded', 'true');
        mobileSidebar.focus(); // Focus the sidebar for accessibility
    }

    function closeMobileMenu() {
        mobileSidebar.classList.add('-translate-x-full');
        sidebarOverlay.classList.add('hidden');
        mobileSidebarContainer.classList.add('pointer-events-none');
        document.body.classList.remove('modal-open');
        mobileMenuButton.setAttribute('aria-expanded', 'false');
        mobileMenuButton.focus(); // Return focus to the menu button
    }

    mobileMenuButton.addEventListener('click', openMobileMenu);
    closeSidebarButton.addEventListener('click', closeMobileMenu);
    sidebarOverlay.addEventListener('click', closeMobileMenu);

    // Close menu on Escape key press
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !mobileSidebarContainer.classList.contains('pointer-events-none')) {
            closeMobileMenu();
        }
    });

    mobileNavLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            // For anchor links (#), prevent default only if you handle scrolling manually
            // For actual page links (index.html), allow default behavior
            if (link.getAttribute('href')?.startsWith('#')) {
                 // Smooth scroll for anchor links within the page if needed
                 // const targetId = link.getAttribute('href');
                 // const targetElement = document.querySelector(targetId);
                 // if (targetElement) {
                 //     e.preventDefault(); // Prevent instant jump
                 //     targetElement.scrollIntoView({ behavior: 'smooth' });
                 // }
            }
            // Close the menu after a short delay to allow navigation/scrolling
            setTimeout(closeMobileMenu, 100);
        });
    });
}

// --- Footer Year (Common) ---
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

    // Get DOM elements specific to index page
    const swiperWrapperFeatured = document.getElementById('swiper-wrapper-featured');
    const trendingGrid = document.getElementById('trending-grid');
    const popularGrid = document.getElementById('popular-grid');
    const topAnimeListDesktop = document.getElementById('top-anime-list-desktop');
    const topAnimeListMobile = document.getElementById('top-anime-list-mobile');
    const topAnimeListBottomMobile = document.getElementById('top-anime-list-bottom-mobile');
    const errorMessageDiv = document.getElementById('error-message');

    // Show loading state initially (skeletons are in HTML)
    if (errorMessageDiv) errorMessageDiv.classList.add('hidden');

    const { season, year } = getCurrentSeason();
    const variables = {
        page: 1,
        perPageTrending: 10, // Fetch more for grid
        perPagePopularGrid: 10,
        perPageTop: 10,
        season: season,
        seasonYear: year
    };

    try {
        const data = await fetchAniListApi(ANILIST_BROWSE_QUERY, variables);
        const hasTrending = data.trending?.media?.length > 0;
        const hasPopular = data.popular?.media?.length > 0;
        const hasTop = data.top?.media?.length > 0;

        // Clear skeletons / existing content ONLY if data is successfully fetched
        // Skeletons handle the initial loading appearance

        // Populate Featured Slider
        if (hasTrending && swiperWrapperFeatured) {
            swiperWrapperFeatured.innerHTML = ''; // Clear skeleton
            // Use first few trending items for slider
            data.trending.media.slice(0, 5).forEach(anime => {
                swiperWrapperFeatured.innerHTML += createFeaturedSlideHTML(anime);
            });
            // Initialize Swiper AFTER content is added and visible
            setTimeout(() => initializeFeaturedSwiper(), 0);
        } else if (swiperWrapperFeatured) {
            swiperWrapperFeatured.innerHTML = '<div class="swiper-slide flex items-center justify-center h-full"><p class="text-gray-400 p-4">Could not load featured anime.</p></div>';
        }

        // Populate Trending Grid (use remaining trending items)
        if (hasTrending && trendingGrid) {
            trendingGrid.innerHTML = ''; // Clear skeletons
            data.trending.media.slice(0, 10).forEach(anime => { // Limit to 10 for the grid
                trendingGrid.innerHTML += createAnimeCardHTML(anime);
            });
        } else if (trendingGrid) {
            trendingGrid.innerHTML = '<p class="text-gray-400 col-span-full p-4 text-center">Could not load trending anime.</p>';
        }

        // Populate Popular Grid
        if (hasPopular && popularGrid) {
            popularGrid.innerHTML = ''; // Clear skeletons
            data.popular.media.forEach(anime => {
                popularGrid.innerHTML += createAnimeCardHTML(anime);
            });
        } else if (popularGrid) {
            popularGrid.innerHTML = '<p class="text-gray-400 col-span-full p-4 text-center">Could not load popular anime for this season.</p>';
        }

        // Populate Top Anime Lists
        if (hasTop) {
            const topAnimeHTML = data.top.media.map((anime, index) => createTopAnimeListItemHTML(anime, index)).join('');
            if (topAnimeListDesktop) topAnimeListDesktop.innerHTML = topAnimeHTML; // Clear skeletons implicitly
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
        if(errorMessageDiv) {
            errorMessageDiv.textContent = `Failed to load page data. Please try again later. (${error.message})`;
            errorMessageDiv.classList.remove('hidden');
        }
        // Optionally hide or show error messages in specific sections
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
 * Initializes the Anime Detail Page
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
    // New Episode Elements
    const detailEpisodesSection = document.getElementById('detail-episodes-section');
    const detailEpisodesLoading = document.getElementById('detail-episodes-loading');
    const detailEpisodesListContainer = document.getElementById('detail-episodes-list-container');
    const detailEpisodesList = document.getElementById('detail-episodes-list');
    const detailEpisodesError = document.getElementById('detail-episodes-error');

    // --- Get Anime ID from URL ---
    const urlParams = getUrlParams();
    const aniListId = urlParams.id ? parseInt(urlParams.id) : null;

    if (!aniListId) {
        console.error("AniList ID not found in URL query parameters.");
        if (detailLoadingMessage) detailLoadingMessage.classList.add('hidden');
        if (detailErrorMessage) {
            detailErrorMessage.textContent = "Error: No Anime ID specified in the URL.";
            detailErrorMessage.classList.remove('hidden');
        }
        return; // Stop execution
    }

    // --- Setup Back Button ---
    if (backButton) {
        // Try to go back in history, otherwise go to index.html
        backButton.addEventListener('click', () => {
            if (window.history.length > 1) {
                history.back();
            } else {
                window.location.href = 'index.html'; // Fallback to home
            }
        });
    }

    // --- Fetch and Display Anime Details from AniList ---
    try {
        const aniListData = await fetchAniListApi(ANILIST_DETAIL_QUERY, { id: aniListId });
        const media = aniListData?.Media; // Extract the media object

        if (!media) {
            throw new Error('Anime not found on AniList for the given ID.');
        }

        // --- Populate Detail View (from AniList data) ---
        if(detailLoadingMessage) detailLoadingMessage.classList.add('hidden');
        if(detailErrorMessage) detailErrorMessage.classList.add('hidden');
        if(detailContentArea) detailContentArea.classList.remove('hidden'); // Show content area

        // Update Page Title
        const pageTitle = media.title.english || media.title.romaji || 'Anime Details';
        document.title = `AniStream - ${pageTitle}`;

        // Banner
        if(detailBanner) {
            const bannerUrl = media.bannerImage || media.coverImage.extraLarge || '';
            const fallbackBanner = `https://placehold.co/1200x400/${(media.coverImage.color || '1a202c').substring(1)}/374151?text=No+Banner`;
            detailBanner.style.backgroundImage = `url('${bannerUrl}')`;
            detailBanner.onerror = () => { detailBanner.style.backgroundImage = `url('${fallbackBanner}')`; }; // Basic fallback
            detailBanner.classList.remove('animate-pulse', 'bg-gray-700');
        }
        // Cover Image
        if(detailCoverImage) {
            detailCoverImage.src = media.coverImage.large || 'https://placehold.co/160x240/1f2937/4a5568?text=N/A';
            detailCoverImage.alt = `${pageTitle} Cover`;
            detailCoverImage.onerror = () => { detailCoverImage.src = 'https://placehold.co/160x240/1f2937/4a5568?text=N/A'; };
            detailCoverImage.classList.remove('animate-pulse', 'bg-gray-700');
        }
        // Title
        if(detailTitle) {
            detailTitle.textContent = media.title.english || media.title.romaji || media.title.native || 'N/A';
            detailTitle.className = 'text-2xl sm:text-3xl font-bold text-white mb-1 line-clamp-2'; // Reset skeleton classes
        }
        // Genres
        if(detailGenres) {
            detailGenres.textContent = media.genres?.join(' • ') || 'N/A';
            detailGenres.className = 'text-sm text-purple-300 mb-2'; // Reset skeleton classes
        }
        // Stats
        if(detailStats) {
            detailStats.innerHTML = `
                <span class="flex items-center" title="Average Score"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4 mr-1 text-yellow-400"><path fill-rule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" clip-rule="evenodd" /></svg> ${media.averageScore || '--'}%</span>
                <span title="Status">Status: ${media.status?.replace(/_/g, ' ') || '--'}</span>
                <span title="Episodes">Episodes: ${media.episodes || '--'}</span>
                <span title="Format">Format: ${media.format?.replace(/_/g, ' ') || '--'}</span>
                <span title="Season">Season: ${media.season || '--'} ${media.seasonYear || '--'}</span>
            `;
            detailStats.className = 'flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-400 mt-2'; // Reset skeleton classes
        }
        // Description
        if(detailDescription) {
            detailDescription.textContent = sanitizeDescription(media.description) || 'No description available.';
            detailDescription.className = 'text-sm text-gray-300 leading-relaxed whitespace-pre-wrap'; // Reset skeleton, allow line breaks
        }
        // Trailer
        if (media.trailer?.site === 'youtube' && media.trailer?.id) {
            if(detailTrailer) {
                const youtubeEmbedUrl = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(media.trailer.id)}`;
                detailTrailer.innerHTML = `<iframe class="w-full h-full aspect-video" src="${youtubeEmbedUrl}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy"></iframe>`;
                detailTrailer.classList.remove('animate-pulse', 'bg-gray-700');
            }
            if(detailTrailerSection) detailTrailerSection.classList.remove('hidden');
        } else {
            if(detailTrailerSection) detailTrailerSection.classList.add('hidden');
        }
        // Characters
        if (media.characters?.edges?.length > 0 && detailCharacters) {
            detailCharacters.innerHTML = media.characters.edges.map(edge => `
                <div class="detail-list-item">
                    <img src="${edge.node.image?.large || 'https://placehold.co/80x110/1f2937/4a5568?text=N/A'}" alt="${edge.node.name?.full || '?'}" loading="lazy" class="shadow-md" onerror="this.src='https://placehold.co/80x110/1f2937/4a5568?text=N/A';"/>
                    <p class="line-clamp-2">${edge.node.name?.full || 'Unknown'}</p>
                    <p class="text-xs text-gray-500">${edge.role}</p>
                </div>`).join('');
        } else if(detailCharacters) {
            detailCharacters.innerHTML = '<p class="text-sm text-gray-400 italic col-span-full">No character data available.</p>';
        }
        // Staff
        if (media.staff?.edges?.length > 0 && detailStaff) {
            detailStaff.innerHTML = media.staff.edges.map(edge => `
                <div class="detail-list-item">
                    <img src="${edge.node.image?.large || 'https://placehold.co/80x110/1f2937/4a5568?text=N/A'}" alt="${edge.node.name?.full || '?'}" loading="lazy" class="shadow-md" onerror="this.src='https://placehold.co/80x110/1f2937/4a5568?text=N/A';"/>
                    <p class="line-clamp-2">${edge.node.name?.full || 'Unknown'}</p>
                    <p class="text-xs text-gray-500">${edge.role}</p>
                </div>`).join('');
        } else if(detailStaff) {
            detailStaff.innerHTML = '<p class="text-sm text-gray-400 italic col-span-full">No staff data available.</p>';
        }
        // Relations
        if (media.relations?.edges?.length > 0 && detailRelations) {
             detailRelations.innerHTML = media.relations.edges
                 .filter(edge => edge.node.type === 'ANIME') // Only show related ANIME
                 .map(edge => {
                     const relTitle = edge.node.title.english || edge.node.title.romaji || edge.node.title.native || 'Related Title';
                     const relImage = edge.node.coverImage?.large || `https://placehold.co/100x150/1f2937/4a5568?text=N/A`;
                     const relFallbackImage = `https://placehold.co/100x150/1f2937/4a5568?text=N/A`;
                     return `
                         <a href="anime.html?id=${edge.node.id}" class="block bg-gray-700 rounded overflow-hidden text-center text-xs p-1 cursor-pointer hover:bg-gray-600 transition-colors group focus:outline-none focus:ring-1 focus:ring-purple-500" title="${edge.relationType.replace(/_/g, ' ')}">
                             <img src="${relImage}" alt="${relTitle}" class="w-full h-24 object-cover mb-1 pointer-events-none" loading="lazy" onerror="this.onerror=null;this.src='${relFallbackImage}';"/>
                             <p class="line-clamp-2 text-gray-300 pointer-events-none group-hover:text-purple-300">${relTitle}</p>
                             <p class="text-gray-500 pointer-events-none">${edge.relationType.replace(/_/g, ' ')}</p>
                         </a>`;
                 }).join('');

             if(detailRelations.innerHTML.trim() !== '') {
                  if(detailRelationsSection) detailRelationsSection.classList.remove('hidden');
             } else {
                  if(detailRelationsSection) detailRelationsSection.classList.add('hidden');
             }
        } else {
             if(detailRelationsSection) detailRelationsSection.classList.add('hidden');
        }

        // --- Fetch and Display Episode List ---
        if (detailEpisodesSection) {
            const animeTitleForSearch = media.title.english || media.title.romaji;
            if (animeTitleForSearch) {
                try {
                    // 1. Search streaming API to get its internal ID
                    const searchResult = await searchAnimeOnStreamingAPI(animeTitleForSearch);
                    const streamingId = searchResult?.id;

                    if (streamingId) {
                        // 2. Fetch info from streaming API using the ID
                        const streamingInfo = await fetchAnimeInfoFromStreamingAPI(streamingId);

                        if (streamingInfo && streamingInfo.episodes?.length > 0) {
                            // 3. Populate the episode list
                            detailEpisodesList.innerHTML = streamingInfo.episodes
                                .map(ep => createDetailEpisodeLinkHTML(ep, streamingId, aniListId))
                                .join('');
                            if(detailEpisodesLoading) detailEpisodesLoading.classList.add('hidden');
                            if(detailEpisodesError) detailEpisodesError.classList.add('hidden');
                            if(detailEpisodesListContainer) detailEpisodesListContainer.classList.remove('hidden');
                        } else {
                            throw new Error('No episodes found on streaming service.');
                        }
                    } else {
                        throw new Error('Anime not found on streaming service.');
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
                // Handle case where no suitable title exists for searching episodes
                if(detailEpisodesLoading) detailEpisodesLoading.classList.add('hidden');
                if(detailEpisodesError) {
                    detailEpisodesError.textContent = 'Could not load episodes: Anime title missing.';
                    detailEpisodesError.classList.remove('hidden');
                }
            }
        } // End episode section handling

    } catch (error) {
        console.error('Fetch Detail Error:', error);
        if(detailLoadingMessage) detailLoadingMessage.classList.add('hidden');
        if(detailErrorMessage) {
            detailErrorMessage.textContent = `Failed to load details: ${error.message}`;
            detailErrorMessage.classList.remove('hidden');
        }
        if(detailContentArea) detailContentArea.classList.add('hidden'); // Hide content area on error
        document.title = 'AniStream - Error';
    }
}


/**
 * Initializes the Episode Player Page
 */
async function initEpisodePage() {
    console.log("Initializing Episode Page");
    setFooterYear();
    setupSearch(); // Keep search available
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
    const streamingId = urlParams.streamingId; // ID from the streaming service (e.g., zoro)
    const episodeId = urlParams.episodeId; // Specific episode ID from the streaming service
    const aniListId = urlParams.aniListId; // Original AniList ID for back button etc.

    if (!streamingId || !episodeId || !aniListId) {
        console.error("Missing required IDs (streamingId, episodeId, aniListId) in URL.");
        if (loadingMessage) loadingMessage.classList.add('hidden');
        if (errorMessage) {
            errorMessage.textContent = "Error: Missing required information to load this episode. Please navigate from the anime detail page.";
            errorMessage.classList.remove('hidden');
        }
        return;
    }

    // Store current state
    currentEpisodeData = {
        streamingId: streamingId,
        episodeId: episodeId,
        aniListId: aniListId,
        episodes: [], // Will be filled by fetchAnimeInfo
        currentSource: null, // Will hold fetched stream links { headers, sources, download }
        selectedServer: serverSelect ? serverSelect.value : 'vidcloud',
        selectedType: 'sub', // Default to SUB
        animeTitle: 'Loading...', // Placeholder
        currentEpisodeNumber: '?', // Placeholder
    };

    // --- Setup Back Button ---
    if (backButton && aniListId) {
        backButton.href = `anime.html?id=${aniListId}`; // Link back to the correct detail page
        backButton.onclick = (e) => { // Use JS navigation to potentially go back in history if appropriate
             e.preventDefault();
             // Check if the previous page was the corresponding anime detail page
             if (document.referrer && document.referrer.includes(`anime.html?id=${aniListId}`)) {
                 history.back();
             } else {
                 window.location.href = `anime.html?id=${aniListId}`; // Navigate directly
             }
        };
    }

    // --- Show Loading State ---
    if(loadingMessage) loadingMessage.classList.remove('hidden');
    if(errorMessage) errorMessage.classList.add('hidden');
    if(mainContent) mainContent.classList.add('hidden');


    /**
     * Loads and updates the video player source.
     * @param {string} type - 'sub' or 'dub'.
     */
    async function loadVideoSource(type = 'sub') {
        console.log(`Attempting to load source: type=${type}, server=${currentEpisodeData.selectedServer}`);
        if(playerOverlay && playerOverlayMessage) {
            playerOverlayMessage.textContent = `Loading ${type.toUpperCase()} stream...`;
            playerOverlay.classList.remove('hidden');
        }
        if (plyrPlayer) plyrPlayer.stop(); // Stop current playback

        try {
            const sourcesData = await fetchEpisodeStreamLinks(currentEpisodeData.episodeId, currentEpisodeData.selectedServer);
            currentEpisodeData.currentSource = sourcesData; // Store fetched data

            if (!sourcesData || !sourcesData.sources || sourcesData.sources.length === 0) {
                throw new Error(`No streaming sources found for this episode on server ${currentEpisodeData.selectedServer}.`);
            }

            // Find the appropriate source (prefer HLS/m3u8)
            let sourceUrl = null;
            let isHls = false;

            // Try to find SUB or DUB based on the 'type' parameter
            const targetSources = sourcesData.sources.filter(s => {
                // Heuristic: Check if URL contains 'dub' or if quality label indicates it
                const qualityLower = s.quality?.toLowerCase() || '';
                const urlLower = s.url?.toLowerCase() || '';
                const isDub = qualityLower.includes('dub') || urlLower.includes('dub');
                return type === 'dub' ? isDub : !isDub; // If type is 'dub', find dub; otherwise find non-dub (assume sub)
            });

            // If specific type not found, fall back to any available source
            const sourcesToUse = targetSources.length > 0 ? targetSources : sourcesData.sources;

            // Prioritize HLS (m3u8)
            const hlsSource = sourcesToUse.find(s => s.isM3U8 || s.url?.includes('.m3u8'));
            if (hlsSource) {
                sourceUrl = hlsSource.url;
                isHls = true;
            } else {
                // Fallback to the first available source (often 'default' or a specific resolution)
                sourceUrl = sourcesToUse[0]?.url;
                isHls = sourceUrl?.includes('.m3u8') || false; // Double check fallback URL
            }

            if (!sourceUrl) {
                throw new Error(`Could not find a suitable ${type.toUpperCase()} video URL.`);
            }

            console.log(`Selected Source URL (${type.toUpperCase()}):`, sourceUrl);
            console.log(`Is HLS:`, isHls);

            // Update buttons state
            updateStreamTypeButtons();

            // Initialize or update Plyr player
            if (!plyrPlayer) {
                initializePlyrPlayer(videoElement, sourceUrl, isHls, type);
            } else {
                updatePlyrSource(sourceUrl, isHls, type);
            }

            if(playerOverlay) playerOverlay.classList.add('hidden'); // Hide loading overlay

        } catch (error) {
            console.error("Error loading video source:", error);
            if(playerOverlay && playerOverlayMessage) {
                playerOverlayMessage.textContent = `Error: ${error.message}`;
                playerOverlay.classList.remove('hidden'); // Show error overlay
            }
            // Display error in the main error message area too
            if (errorMessage) {
                errorMessage.textContent = `Failed to load video: ${error.message}`;
                errorMessage.classList.remove('hidden');
            }
            if (loadingMessage) loadingMessage.classList.add('hidden');
        }
    }

    /**
     * Initializes the Plyr video player.
     * @param {HTMLVideoElement} videoEl - The video element.
     * @param {string} sourceUrl - The URL of the video source.
     * @param {boolean} isHls - Whether the source is HLS.
     * @param {string} type - 'sub' or 'dub' (for title).
     */
    function initializePlyrPlayer(videoEl, sourceUrl, isHls, type) {
        if (plyrPlayer) return; // Already initialized

        const plyrOptions = {
            title: `${currentEpisodeData.animeTitle} - Episode ${currentEpisodeData.currentEpisodeNumber} (${type.toUpperCase()})`,
            controls: [
                'play-large', 'play', 'progress', 'current-time', 'mute', 'volume',
                'captions', 'settings', 'pip', 'airplay', 'fullscreen'
            ],
            settings: ['captions', 'quality', 'speed', 'loop'],
            // Add other Plyr options as needed
        };

        if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
            console.log("Initializing Plyr with HLS.js");
            if (hlsInstance) {
                hlsInstance.destroy(); // Destroy previous instance if exists
            }
            hlsInstance = new Hls();
            hlsInstance.loadSource(sourceUrl);
            hlsInstance.attachMedia(videoEl);
            window.hls = hlsInstance; // Make accessible for debugging

            // HLS error handling
            hlsInstance.on(Hls.Events.ERROR, function (event, data) {
                console.error('HLS Error:', data);
                if (data.fatal) {
                    switch(data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.error('Fatal network error encountered, trying to recover...');
                            hlsInstance.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.error('Fatal media error encountered, trying to recover...');
                            hlsInstance.recoverMediaError();
                            break;
                        default:
                            // Cannot recover, show error to user
                            if(playerOverlay && playerOverlayMessage) {
                                playerOverlayMessage.textContent = `Playback Error (HLS: ${data.details})`;
                                playerOverlay.classList.remove('hidden');
                            }
                            hlsInstance.destroy();
                            break;
                    }
                }
            });

            plyrPlayer = new Plyr(videoEl, plyrOptions);

        } else {
            console.log("Initializing Plyr with native source");
            // Use native HTML5 playback for non-HLS or if HLS.js is not supported
            videoEl.src = sourceUrl;
            plyrPlayer = new Plyr(videoEl, plyrOptions);
        }

        window.player = plyrPlayer; // Make accessible for debugging
    }

    /**
     * Updates the source of an existing Plyr player.
     * @param {string} sourceUrl - The new video source URL.
     * @param {boolean} isHls - Whether the new source is HLS.
     * @param {string} type - 'sub' or 'dub' (for title).
     */
    function updatePlyrSource(sourceUrl, isHls, type) {
        if (!plyrPlayer) {
            console.error("Plyr player not initialized, cannot update source.");
            return;
        }
        console.log(`Updating Plyr source: ${sourceUrl} (HLS: ${isHls})`);

        const newSource = {
            type: 'video',
            title: `${currentEpisodeData.animeTitle} - Episode ${currentEpisodeData.currentEpisodeNumber} (${type.toUpperCase()})`,
            sources: [{
                src: sourceUrl,
                // Plyr might need type for HLS detection if HLS.js isn't used explicitly
                 type: isHls ? 'application/x-mpegURL' : 'video/mp4', // Adjust MIME type if needed
            }],
        };

        if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
             console.log("Updating Plyr source using HLS.js");
             if (!hlsInstance) { // Should not happen if initialized correctly
                 hlsInstance = new Hls();
                 hlsInstance.attachMedia(videoElement); // Re-attach if needed
             }
             hlsInstance.loadSource(sourceUrl);
             // Plyr might automatically pick up the HLS stream if attached,
             // or you might need to update Plyr's source object as well.
             // Let's update Plyr's source object for consistency.
             plyrPlayer.source = newSource;

        } else {
            console.log("Updating Plyr source natively");
            plyrPlayer.source = newSource;
        }
         // Optional: Auto-play the new source
         // plyrPlayer.play();
    }

    /**
     * Updates the visual state (active/disabled) of SUB/DUB buttons.
     */
    function updateStreamTypeButtons() {
        if (!currentEpisodeData?.currentSource?.sources) {
            if(subButton) subButton.disabled = true;
            if(dubButton) dubButton.disabled = true;
            return;
        }

        // Check availability based on heuristics (might need refinement based on API response)
        const sources = currentEpisodeData.currentSource.sources;
        const hasSub = sources.some(s => !(s.quality?.toLowerCase().includes('dub') || s.url?.toLowerCase().includes('dub')));
        const hasDub = sources.some(s => s.quality?.toLowerCase().includes('dub') || s.url?.toLowerCase().includes('dub'));

        if(subButton) {
            subButton.disabled = !hasSub;
            subButton.classList.toggle('bg-purple-600', currentEpisodeData.selectedType === 'sub' && hasSub);
            subButton.classList.toggle('text-white', currentEpisodeData.selectedType === 'sub' && hasSub);
            subButton.classList.toggle('bg-gray-700', currentEpisodeData.selectedType !== 'sub' || !hasSub);
            subButton.classList.toggle('text-gray-200', currentEpisodeData.selectedType !== 'sub' || !hasSub);
        }
        if(dubButton) {
            dubButton.disabled = !hasDub;
            dubButton.classList.toggle('bg-purple-600', currentEpisodeData.selectedType === 'dub' && hasDub);
            dubButton.classList.toggle('text-white', currentEpisodeData.selectedType === 'dub' && hasDub);
            dubButton.classList.toggle('bg-gray-700', currentEpisodeData.selectedType !== 'dub' || !hasDub);
            dubButton.classList.toggle('text-gray-200', currentEpisodeData.selectedType !== 'dub' || !hasDub);
        }
    }

    // --- Fetch Initial Data (Episode List and First Stream) ---
    try {
        // Fetch anime info first to get title and full episode list
        const animeInfo = await fetchAnimeInfoFromStreamingAPI(streamingId);
        if (!animeInfo || !animeInfo.episodes || animeInfo.episodes.length === 0) {
            throw new Error("Could not retrieve anime details or episode list from streaming service.");
        }

        currentEpisodeData.episodes = animeInfo.episodes;
        currentEpisodeData.animeTitle = animeInfo.title?.english || animeInfo.title?.romaji || 'Anime';

        // Find current episode number
        const currentEp = animeInfo.episodes.find(ep => ep.id === episodeId);
        currentEpisodeData.currentEpisodeNumber = currentEp?.number || '?';

        // Populate Page Title and Header
        document.title = `Watching ${currentEpisodeData.animeTitle} - Ep ${currentEpisodeData.currentEpisodeNumber}`;
        if(episodeTitleArea) episodeTitleArea.textContent = `${currentEpisodeData.animeTitle} - Episode ${currentEpisodeData.currentEpisodeNumber}`;

        // Populate Episode List Sidebar
        if (sidebarAnimeTitle) sidebarAnimeTitle.textContent = currentEpisodeData.animeTitle;
        if (episodeListUL && episodeListContainer) {
            episodeListUL.innerHTML = currentEpisodeData.episodes
                .map(ep => createSidebarEpisodeItemHTML(ep, streamingId, aniListId, ep.id === episodeId))
                .join('');
            if(episodeListLoading) episodeListLoading.classList.add('hidden');
            if(episodeListError) episodeListError.classList.add('hidden');
            episodeListUL.classList.remove('hidden');
            // Scroll to active episode
            const activeItem = episodeListUL.querySelector('.active');
            if (activeItem) {
                activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        } else {
             if(episodeListLoading) episodeListLoading.classList.add('hidden');
             if(episodeListError) {
                 episodeListError.textContent = 'Could not display episode list.';
                 episodeListError.classList.remove('hidden');
             }
        }

        // Fetch initial video source (default to SUB)
        await loadVideoSource(currentEpisodeData.selectedType);

        // Hide main loading message and show content
        if(loadingMessage) loadingMessage.classList.add('hidden');
        if(mainContent) mainContent.classList.remove('hidden');

    } catch (initError) {
        console.error("Initialization Error:", initError);
        if (loadingMessage) loadingMessage.classList.add('hidden');
        if (errorMessage) {
            errorMessage.textContent = `Error loading episode page: ${initError.message}`;
            errorMessage.classList.remove('hidden');
        }
        if(mainContent) mainContent.classList.add('hidden'); // Keep content hidden on error
    }

    // --- Event Listeners ---
    if (subButton) {
        subButton.addEventListener('click', () => {
            if (currentEpisodeData.selectedType !== 'sub') {
                currentEpisodeData.selectedType = 'sub';
                loadVideoSource('sub'); // Reload with SUB
            }
        });
    }
    if (dubButton) {
        dubButton.addEventListener('click', () => {
            if (currentEpisodeData.selectedType !== 'dub') {
                currentEpisodeData.selectedType = 'dub';
                loadVideoSource('dub'); // Reload with DUB
            }
        });
    }
    if (serverSelect) {
        serverSelect.addEventListener('change', (e) => {
            currentEpisodeData.selectedServer = e.target.value;
            loadVideoSource(currentEpisodeData.selectedType); // Reload with new server, same type
        });
    }

    // Note: Episode list links use standard href navigation,
    // which will trigger a full page reload and re-initialization.
    // For SPA-like behavior, you'd need more complex routing and state management.
}


// --- Auto-detect and Initialize Page ---
// This simple check determines which init function to run based on body ID or unique element.
// Ensure your HTML body tags have appropriate IDs (e.g., <body id="page-index">, <body id="page-anime">, <body id="page-episode">)
// OR check for the existence of a unique main container ID.

/* // Example using body ID (add IDs to your HTML body tags)
document.addEventListener('DOMContentLoaded', () => {
    const bodyId = document.body.id;
    if (bodyId === 'page-index' && typeof initIndexPage === 'function') {
        initIndexPage();
    } else if (bodyId === 'page-anime' && typeof initAnimePage === 'function') {
        initAnimePage();
    } else if (bodyId === 'page-episode' && typeof initEpisodePage === 'function') {
        initEpisodePage();
    } else {
        console.log("No specific page initialization function found for this page.");
        // Run common setup if needed, even if no specific init found
        setFooterYear();
        setupSearch();
        setupMobileMenu();
    }
});
*/

// Example using element existence (more robust if body IDs aren't set)
// The individual init calls are already placed at the bottom of each HTML file,
// so this auto-detection block might be redundant if using that approach.
// Keep the individual calls in HTML for simplicity unless you prefer this centralized method.

/*
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('browse-view') && typeof initIndexPage === 'function') {
        console.log("Detected Index Page via #browse-view");
        initIndexPage();
    } else if (document.getElementById('detail-view') && typeof initAnimePage === 'function') {
        console.log("Detected Anime Detail Page via #detail-view");
        initAnimePage();
    } else if (document.getElementById('episode-main-content') && typeof initEpisodePage === 'function') {
        console.log("Detected Episode Page via #episode-main-content");
        initEpisodePage();
    } else {
        console.log("Could not detect specific page type for initialization. Running common setup.");
        // Run common setup if needed
        setFooterYear();
        // Setup search/menu only if relevant elements exist
        if (document.getElementById('search-input')) setupSearch();
        if (document.getElementById('mobile-menu-button')) setupMobileMenu();
    }
});
*/

// IMPORTANT: Make sure HLS.js is included *before* this script in episode.html
// <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
// <script src="script.js"></script>
