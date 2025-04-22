// --- Constants and Global Variables ---
const ANILIST_API_URL = 'https://graphql.anilist.co';
// Ensure this points to your working Consumet/Streaming API instance
const STREAMING_API_BASE_URL = 'https://api-pearl-seven-88.vercel.app'; // User-provided API
const DEFAULT_STREAMING_PROVIDER = 'zoro'; // Default provider for the API

let searchTimeoutId = null; // For debouncing search input
let featuredSwiper = null; // Swiper instance for index page slider
let plyrPlayer = null;     // Plyr instance for episode page video player
let hlsInstance = null;    // HLS.js instance for handling HLS streams

// Structure to hold episode page state
let currentEpisodeData = {
    streamingId: null,       // ID of the anime on the streaming service (e.g., 'spy-x-family-17977')
    baseEpisodeId: null,     // Store the ID without $sub/$dub suffix (e.g., 'spy-x-family-17977$episode$89506')
    currentEpisodeId: null,  // The full ID passed in the URL initially (e.g., 'spy-x-family-17977$episode$89506$sub')
    aniListId: null,         // Original AniList ID for reference and navigation
    episodes: [],            // Full list of episodes for the anime (from streaming service /info endpoint)
    currentSourceData: null, // Holds full API response for current episode { headers, sources, subtitles, intro, outro, ... }
    selectedServer: 'vidcloud', // Default or currently selected streaming server
    selectedType: 'sub',     // 'sub' or 'dub' - currently selected stream type
    animeTitle: 'Loading...',// Title of the anime
    currentEpisodeNumber: '?',// Number of the current episode
    intro: null,             // { start, end } seconds for intro skip
    outro: null,             // { start, end } seconds for outro skip
    subtitles: []            // Formatted subtitle tracks for Plyr
};

// Timeout references for skip button visibility management
let skipIntroTimeout = null;
let skipOutroTimeout = null;
// Keep references to bound event handlers to properly remove them later
let boundHandleTimeUpdate = null;
let boundHandleSkipIntro = null;
let boundHandleSkipOutro = null;


// --- AniList API Queries (Remain the same) ---
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


// --- Utility Functions (Remain largely the same) ---
function getCurrentSeason() {
    const now = new Date(); const month = now.getMonth(); const year = now.getFullYear(); let season;
    if (month >= 0 && month <= 2) season = 'WINTER'; else if (month >= 3 && month <= 5) season = 'SPRING'; else if (month >= 6 && month <= 8) season = 'SUMMER'; else season = 'FALL'; return { season, year };
}
function sanitizeDescription(desc) { if (!desc) return 'No description available.'; let sanitized = desc.replace(/<br\s*\/?>/gi, '\n'); sanitized = sanitized.replace(/<[^>]+>/g, ''); return sanitized.trim(); }
function debounce(func, delay) { let timeoutId; return function(...args) { clearTimeout(timeoutId); timeoutId = setTimeout(() => { func.apply(this, args); }, delay); }; }
function getUrlParams() { const params = {}; const queryString = window.location.search; const urlParams = new URLSearchParams(queryString); for (const [key, value] of urlParams.entries()) { params[key] = decodeURIComponent(value); } return params; } // Use decodeURIComponent
function mapAniListFormatToStreamingFormat(aniListFormat) { if (!aniListFormat) return null; const format = aniListFormat.toUpperCase(); switch (format) { case 'TV': return 'TV Series'; case 'TV_SHORT': return 'TV Series'; case 'MOVIE': return 'Movie'; case 'SPECIAL': return 'Special'; case 'OVA': return 'OVA'; case 'ONA': return 'ONA'; case 'MUSIC': return 'Music'; default: return aniListFormat; } }


// --- API Fetching (Improved Logging and Error Handling) ---
async function fetchAniListApi(query, variables) {
    try {
        const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ query: query, variables: variables }) };
        // console.log('Fetching AniList:', { query: query.substring(0, 100) + '...', variables });
        const response = await fetch(ANILIST_API_URL, options);
        if (!response.ok) { throw new Error(`AniList HTTP error! status: ${response.status} ${response.statusText}`); }
        const result = await response.json();
        if (result.errors) { console.error('AniList GraphQL Errors:', result.errors); const message = result.errors[0]?.message || 'Unknown GraphQL error'; throw new Error(`AniList API Error: ${message}`); }
        // console.log('AniList Response OK'); // Simplified log
        return result.data;
    } catch (error) { console.error("AniList API Fetch Error:", error); throw error; }
}
async function fetchStreamingApi(endpoint, errorMessage = 'Error fetching streaming data') {
    const url = `${STREAMING_API_BASE_URL}${endpoint}`;
    try {
        console.log('Fetching Streaming API:', url); // Keep this log
        const response = await fetch(url);
        if (!response.ok) {
            let errorBody = null;
            try { errorBody = await response.json(); } catch (e) { /* ignore parsing error */ }
            console.error(`Streaming API HTTP error! Status: ${response.status} for URL: ${url}`, errorBody);
            const message = errorBody?.message || response.statusText || 'Unknown error';
            throw new Error(`${errorMessage}: ${message} (Status: ${response.status})`);
        }
        const data = await response.json();
        // console.log('Streaming API Response OK for:', url); // Simplified log

        // Basic validation/warnings (kept from original)
        if (data && endpoint.includes('/search') && (!data.results || data.results.length === 0)) { console.warn(`Streaming API returned no search results for ${endpoint}`); return { results: [] }; }
        if (data && endpoint.includes('/info') && (!data.episodes)) { console.warn(`Streaming API info response missing 'episodes' array for ${endpoint}`); data.episodes = []; }
        if (data && endpoint.includes('/watch') && (!data.sources)) { console.warn(`Streaming API watch response missing 'sources' array for ${endpoint}`); data.sources = []; }
        if (data && endpoint.includes('/watch') && (!data.subtitles)) { console.warn(`Streaming API watch response missing 'subtitles' array for ${endpoint}`); data.subtitles = []; }

        return data;
    } catch (error) {
        console.error(`Streaming API Fetch Error for ${url}:`, error);
        // Don't re-wrap error message if it already starts with our prefix
        if (!error.message.startsWith(errorMessage)) { throw new Error(`${errorMessage}: ${error.message}`); }
        throw error; // Re-throw
    }
}

// --- Specific Streaming API Functions (Minor path adjustment) ---
async function fetchAnimeInfoFromStreamingAPI(streamingId) {
    if (!streamingId) return null;
    try {
        // Construct the info endpoint path correctly using the provider
        const endpoint = `/anime/${DEFAULT_STREAMING_PROVIDER}/info?id=${encodeURIComponent(streamingId)}`;
        const data = await fetchStreamingApi(endpoint, `Error fetching info for ID "${streamingId}"`);
        return data || null;
    } catch (error) { console.error(`Failed to fetch streaming API info for ID "${streamingId}":`, error); return null; }
}
async function fetchEpisodeWatchData(episodeIdToFetch, server = 'vidcloud') {
    if (!episodeIdToFetch) { console.error("fetchEpisodeWatchData called with invalid episodeId:", episodeIdToFetch); return null; }
    try {
        // Construct the watch endpoint path correctly
        const endpoint = `/anime/${DEFAULT_STREAMING_PROVIDER}/watch?episodeId=${encodeURIComponent(episodeIdToFetch)}&server=${server}`;
        const data = await fetchStreamingApi(endpoint, `Error fetching watch data for episode "${episodeIdToFetch}"`);

        // *** DEBUGGING: Log the raw API response ***
        // console.log(`--- Raw Watch Data Response for ${episodeIdToFetch} (Server: ${server}) ---`);
        // console.log(JSON.stringify(data, null, 2)); // Log the full structure
        // console.log("-------------------------------");

        // Ensure structure consistency, even if API returns null/undefined fields
        return {
            headers: data?.headers || {},
            sources: data?.sources || [],
            subtitles: data?.subtitles || [],
            intro: data?.intro || { start: 0, end: 0 },
            outro: data?.outro || { start: 0, end: 0 },
            download: data?.download // Keep download link if available
        };
    } catch (error) { console.error(`Failed to fetch watch data for episode "${episodeIdToFetch}" on server "${server}":`, error); return null; }
}

// --- HTML Generation Helpers (Largely the same, minor tweaks) ---
function createFeaturedSlideHTML(anime) {
    const title = anime.title.english || anime.title.romaji || anime.title.native || 'Untitled';
    const imageUrl = anime.bannerImage || anime.coverImage.extraLarge || `https://placehold.co/1200x450/${(anime.coverImage.color || '7e22ce').substring(1)}/ffffff?text=Featured`;
    const fallbackImage = `https://placehold.co/1200x450/${(anime.coverImage.color || '7e22ce').substring(1)}/ffffff?text=Featured`;
    const description = sanitizeDescription(anime.description);
    const genres = anime.genres ? anime.genres.slice(0, 3).join(' • ') : 'N/A';
    return `
        <a href="anime.html?id=${anime.id}" class="swiper-slide cursor-pointer block group relative" style="background-image: url('${imageUrl}'); background-size: cover; background-position: center;" onerror="this.style.backgroundImage='url(\\'${fallbackImage}\\')'">
            <div class="absolute inset-0 bg-gradient-to-r from-black/80 via-black/50 to-transparent"></div> <div class="slide-text-content relative z-10 p-6 md:p-8 lg:p-10 w-full md:w-3/4 lg:w-2/3 pointer-events-none">
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
    const episodeNumber = episode.number ?? '?';
    const episodeTitle = episode.title ? `: ${episode.title}` : '';
    // Link uses the base episode ID + default type ('sub')
    const episodeUrl = `episode.html?streamingId=${encodeURIComponent(streamingId)}&episodeId=${encodeURIComponent(episode.id)}$sub&aniListId=${aniListId}`; // Default to sub
    return `
        <li>
            <a href="${episodeUrl}" class="episode-link" title="Watch Episode ${episodeNumber}${episodeTitle}">
                Ep ${episodeNumber}${episodeTitle.length > 40 ? episodeTitle.substring(0, 37) + '...' : episodeTitle}
            </a>
        </li>
    `;
}
function createSidebarEpisodeItemHTML(episode, streamingId, aniListId, isActive = false) {
    if (!episode || !episode.id || !streamingId || !aniListId) return '';
    const episodeNumber = episode.number ?? '?'; // Use ?? for nullish coalescing
    const episodeTitle = episode.title ? `: ${episode.title}` : '';
    // Link should preserve the currently selected type (sub/dub) if possible, or default to sub
    const currentTypeSuffix = currentEpisodeData.selectedType === 'dub' ? '$dub' : '$sub';
    const episodeUrl = `episode.html?streamingId=${encodeURIComponent(streamingId)}&episodeId=${encodeURIComponent(episode.id)}${currentTypeSuffix}&aniListId=${aniListId}`; // Construct URL with current type
    const activeClass = isActive ? 'active' : '';
    return `
        <li>
            <a href="${episodeUrl}"
               class="episode-list-item ${activeClass}"
               data-episode-id="${episode.id}"  /* Store base ID */
               title="Episode ${episodeNumber}${episodeTitle}">
                <span class="line-clamp-1">Ep ${episodeNumber}${episodeTitle}</span>
            </a>
        </li>
    `;
}
/** Formats subtitles from the API response into the structure Plyr expects. */
function formatSubtitlesForPlyr(apiSubtitles) {
    if (!apiSubtitles || !Array.isArray(apiSubtitles) || apiSubtitles.length === 0) return []; // Add Array check
    // console.log("Formatting subtitles received from API:", apiSubtitles);

    const langCodeMap = { 'english': 'en', 'spanish': 'es', 'portuguese': 'pt', 'french': 'fr', 'german': 'de', 'italian': 'it', 'russian': 'ru', 'arabic': 'ar', 'indonesian': 'id', 'thai': 'th', 'vietnamese': 'vi' /* Add more as needed */ };
    let hasEnglishDefault = false;

    const formatted = apiSubtitles.map((sub, index) => {
        // Skip "thumbnails" track or tracks without a URL
        if (!sub || typeof sub !== 'object' || !sub.url || sub.lang?.toLowerCase() === 'thumbnails') {
            return null;
        }

        const langLower = sub.lang?.toLowerCase() || `unknown-${index}`; // Ensure unique key if lang is missing
        // Handle complex lang strings like "Portuguese - Portuguese(Brazil)" -> "portuguese"
        const simpleLang = langLower.split('-')[0].trim();
        let srclang = langCodeMap[simpleLang] || simpleLang.substring(0, 2) || `unk${index}`; // Use mapped code, first 2 chars, or unique fallback
        const isDefault = simpleLang === 'english';
        if (isDefault) hasEnglishDefault = true;

        return {
            kind: 'captions',
            label: sub.lang || `Subtitle ${index + 1}`, // Display label from API
            srclang: srclang,                           // Standard language code for matching
            src: sub.url,
            default: isDefault
        };
    }).filter(track => track !== null); // Filter out nulls

    // Ensure only one track is marked as default (Plyr prefers this)
    let defaultSet = false;
    formatted.forEach(track => {
        if (track.default) {
            if (defaultSet) { track.default = false; } // Unset subsequent defaults
            else { defaultSet = true; }                // Mark first default as found
        }
    });

    // If no English default was found, make the *first* track default ONLY if there isn't already a default set.
    if (!defaultSet && formatted.length > 0) {
        // formatted[0].default = true; // Optional: default the first available track - decided against this to avoid defaulting non-English subs
        console.log("No English subtitle track found or marked as default.");
    }

    // console.log("Formatted Plyr tracks:", formatted);
    return formatted;
}

// --- Swiper Initialization (Remains the same) ---
function initializeFeaturedSwiper(containerSelector = '#featured-swiper') { /* ... */ }

// --- Search Functionality (Remains the same) ---
function setupSearch(searchInputId = 'search-input', suggestionsContainerId = 'search-suggestions', searchIconButtonId = 'search-icon-button', headerTitleSelector = 'header a.text-2xl', mobileMenuButtonId = 'mobile-menu-button') { /* ... */ }

// --- Mobile Menu Functionality (Remains the same) ---
function setupMobileMenu(menuButtonId = 'mobile-menu-button', sidebarContainerId = 'mobile-sidebar-container', sidebarId = 'mobile-sidebar', overlayId = 'sidebar-overlay', closeButtonId = 'close-sidebar-button', navLinkClass = '.mobile-nav-link') { /* ... */ }

// --- Footer Year (Remains the same) ---
function setFooterYear(footerYearId = 'footer-year') { const footerYearSpan = document.getElementById(footerYearId); if (footerYearSpan) footerYearSpan.textContent = new Date().getFullYear(); }

// --- Page Specific Initialization ---

/** Initializes the Index (Browse) Page */
async function initIndexPage() { /* ... (Remains largely the same) ... */ }

/** Initializes the Anime Detail Page - WITH IMPROVED EPISODE MATCHING */
async function initAnimePage() { /* ... (Remains largely the same) ... */ }

/** Initializes the Episode Player Page - Using Plyr (Fixed Init & Events) */
async function initEpisodePage() {
    console.log("Initializing Episode Page with Plyr...");
    setFooterYear();
    setupSearch();
    setupMobileMenu();

    // --- DOM Element references ---
    const loadingMessage = document.getElementById('episode-loading-message');
    const errorMessage = document.getElementById('episode-error-message');
    const mainContent = document.getElementById('episode-main-content');
    const playerWrapper = document.getElementById('player-wrapper');
    const videoElement = document.getElementById('video-player');
    const playerContainer = document.getElementById('player-container');
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

    // --- Initial Checks ---
    if (!videoElement) { console.error("Video element (#video-player) not found!"); displayError("Player element missing in HTML."); return; }
    if (typeof Plyr === 'undefined') { console.error("Plyr library is not loaded."); displayError("Player library (Plyr) failed to load."); return; }
    if (typeof Hls === 'undefined') { console.warn("Hls.js library is not loaded. HLS playback/quality options might be limited."); /* Don't block, but warn */ }

    // --- Get URL Params and Validate ---
    const urlParams = getUrlParams();
    const initialEpisodeIdFromUrl = urlParams.episodeId; // e.g., spy-x-family-17977$episode$89506$sub
    const aniListId = urlParams.aniListId;
    const streamingId = urlParams.streamingId; // e.g., spy-x-family-17977

    if (!streamingId || !initialEpisodeIdFromUrl || !aniListId) {
        console.error("Missing required IDs (streamingId, episodeId, aniListId) in URL parameters.", urlParams);
        displayError("Error: Missing required information in URL to load the episode.");
        return;
    }

    // --- Parse Base Episode ID and Initial Type ---
    let baseEpisodeId = initialEpisodeIdFromUrl;
    let initialType = 'sub'; // Default to sub
    const lastDollarIndex = initialEpisodeIdFromUrl.lastIndexOf('$');
    if (lastDollarIndex > 0) {
        const suffix = initialEpisodeIdFromUrl.substring(lastDollarIndex + 1).toLowerCase();
        if (suffix === 'sub' || suffix === 'dub') {
            baseEpisodeId = initialEpisodeIdFromUrl.substring(0, lastDollarIndex);
            initialType = suffix;
        }
        // If suffix is something else or missing, keep the full ID as base and default to sub
    }
     console.log(`Parsed IDs: streamingId=${streamingId}, baseEpisodeId=${baseEpisodeId}, initialType=${initialType}, aniListId=${aniListId}`);


    // --- Reset Global State ---
    currentEpisodeData = {
        streamingId: streamingId,
        baseEpisodeId: baseEpisodeId,
        currentEpisodeId: initialEpisodeIdFromUrl, // Store the original full ID from URL
        aniListId: aniListId,
        episodes: [],
        currentSourceData: null,
        selectedServer: serverSelect ? serverSelect.value : 'vidcloud',
        selectedType: initialType, // Use parsed type
        animeTitle: 'Loading...',
        currentEpisodeNumber: '?',
        intro: null,
        outro: null,
        subtitles: []
    };
    console.log("Initial State:", JSON.parse(JSON.stringify(currentEpisodeData))); // Deep copy log

    // --- Setup UI Elements ---
    if (backButton && currentEpisodeData.aniListId) {
        const detailUrl = `anime.html?id=${currentEpisodeData.aniListId}`;
        backButton.href = detailUrl;
        // Try to go back if the previous page was the detail page, otherwise navigate
        backButton.onclick = (e) => {
            e.preventDefault();
            if (document.referrer && document.referrer.includes(detailUrl)) { history.back(); }
            else { window.location.href = detailUrl; }
        };
    }
    showLoading(); // Show initial loading message

    // --- Core Functions ---

    /** Displays an error message and hides loading/content */
    function displayError(message, isEpisodeListError = false) {
        console.error("Displaying Error:", message);
        if (isEpisodeListError) {
            if(episodeListError) { episodeListError.textContent = message; episodeListError.classList.remove('hidden'); }
            if(episodeListLoading) episodeListLoading.classList.add('hidden');
            if(episodeListUL) episodeListUL.classList.add('hidden');
        } else {
            if (errorMessage) { errorMessage.textContent = message; errorMessage.classList.remove('hidden'); }
            if (loadingMessage) loadingMessage.classList.add('hidden');
            if (mainContent) mainContent.classList.add('hidden');
        }
    }

    /** Shows loading message and hides error/content */
    function showLoading() {
        if (loadingMessage) loadingMessage.classList.remove('hidden');
        if (errorMessage) errorMessage.classList.add('hidden');
        if (mainContent) mainContent.classList.add('hidden');
        if(episodeListLoading) episodeListLoading.classList.remove('hidden'); // Show episode list loading too
        if(episodeListUL) episodeListUL.classList.add('hidden');
        if(episodeListError) episodeListError.classList.add('hidden');
    }

    /** Hides loading/error messages and shows main content */
    function showContent() {
        if (loadingMessage) loadingMessage.classList.add('hidden');
        if (errorMessage) errorMessage.classList.add('hidden');
        if (mainContent) mainContent.classList.remove('hidden');
        // Episode list visibility is handled separately after fetching info
    }

    /** Loads video source, subtitles, skip times and initializes/updates Plyr */
    async function loadVideoSource(type = 'sub') {
        console.log(`Load Request: type=${type}, server=${currentEpisodeData.selectedServer}, baseEpisodeId=${currentEpisodeData.baseEpisodeId}`);
        currentEpisodeData.selectedType = type; // Update state *before* fetching

        // Show loading state for the player area
        if (plyrPlayer) { plyrPlayer.stop(); } // Use stop() for Plyr
        resetSkipButtons(); // Hide and clear listeners
        if (errorMessage) errorMessage.classList.add('hidden'); // Hide previous errors
        if (playerContainer) playerContainer.style.opacity = '0.5'; // Visual loading cue

        // *** Construct the episode ID for the API call ***
        // Some APIs might just need the base ID, others might need the type suffix.
        // Based on the user's example, the suffix is needed.
        const episodeIdToFetch = `${currentEpisodeData.baseEpisodeId}$${type}`;
        console.log(`Workspaceing watch data for constructed ID: ${episodeIdToFetch}`);

        try {
            const watchData = await fetchEpisodeWatchData(episodeIdToFetch, currentEpisodeData.selectedServer);
            currentEpisodeData.currentSourceData = watchData; // Store the latest fetched data

            if (!watchData) { throw new Error(`API returned null/undefined for watch data.`); }

            // --- Check for Sources ---
            if (!watchData.sources || watchData.sources.length === 0) {
                 if (watchData.download) { // Fallback to download link if no stream sources
                    console.warn(`No streaming sources found, attempting download link: ${watchData.download}`);
                    currentEpisodeData.intro = { start: 0, end: 0 }; // Reset skip times
                    currentEpisodeData.outro = { start: 0, end: 0 };
                    currentEpisodeData.subtitles = []; // No subs for download link typically
                    initializeOrUpdatePlyrPlayer(watchData.download, type, [], false); // Load download link, no subs, not HLS
                 } else {
                    // No sources and no download link
                    throw new Error(`No sources or download link found for ${type.toUpperCase()} on server ${currentEpisodeData.selectedServer}. Try another server.`);
                 }
            } else {
                 // --- Process Streaming Sources ---
                 currentEpisodeData.intro = watchData.intro || { start: 0, end: 0 };
                 currentEpisodeData.outro = watchData.outro || { start: 0, end: 0 };
                 currentEpisodeData.subtitles = formatSubtitlesForPlyr(watchData.subtitles); // Format for Plyr

                 let sourceUrl = null, isHls = false;
                 const sourcesToUse = watchData.sources;

                 // Prioritize HLS source
                 const hlsSource = sourcesToUse.find(s => s.isM3U8 || s.url?.includes('.m3u8'));
                 if (hlsSource) {
                    sourceUrl = hlsSource.url;
                    isHls = true;
                    console.log("Selected HLS source:", sourceUrl);
                 } else {
                    // Fallback to 'auto' or 'default' quality if no HLS
                    const autoSource = sourcesToUse.find(s => s.quality?.toLowerCase() === 'auto' || s.quality?.toLowerCase() === 'default');
                    sourceUrl = autoSource ? autoSource.url : sourcesToUse[0]?.url; // Fallback to the first source if no 'auto'
                    isHls = sourceUrl?.includes('.m3u8') || false; // Double-check if the fallback is HLS
                    console.log(`Selected non-HLS source (or first source): ${sourceUrl} (Is HLS: ${isHls})`);
                 }

                 if (!sourceUrl) { throw new Error(`Could not extract a valid video URL from sources for ${type.toUpperCase()}.`); }

                 // Initialize player with the found source
                 initializeOrUpdatePlyrPlayer(sourceUrl, type, currentEpisodeData.subtitles, isHls);
            }

             updateStreamTypeButtons(); // Update button states based on success/availability (implicitly successful here)

        } catch (error) {
            console.error(`Error loading video source for ${type.toUpperCase()}:`, error);
            displayError(`Failed to load video (${type.toUpperCase()}): ${error.message}`); // Show specific error
            updateStreamTypeButtons(true); // Indicate error state for buttons
            // Optionally clear the player visually on error
            if (videoElement) videoElement.src = '';
        } finally {
            // Ensure opacity is restored regardless of success or failure
            if (playerContainer) playerContainer.style.opacity = '1';
        }
    }

    /** Initializes or updates the Plyr player instance with HLS.js integration */
    function initializeOrUpdatePlyrPlayer(sourceUrl, type, tracks = [], isHls) {
        console.log("Attempting to initialize/update Plyr Player...", { sourceUrl, type, isHls, tracksCount: tracks.length });

        // --- Destroy previous instances ---
        if (plyrPlayer) { try { plyrPlayer.destroy(); console.log("Previous Plyr instance destroyed."); } catch (e) { console.error("Error destroying previous Plyr instance:", e); } plyrPlayer = null; }
        if (hlsInstance) { try { hlsInstance.destroy(); console.log("Previous HLS instance destroyed."); } catch (e) { console.error("Error destroying previous HLS instance:", e); } hlsInstance = null; }

        // --- Ensure video element is clean ---
        videoElement.removeAttribute('src'); // Remove src attribute if set previously
        videoElement.innerHTML = '';         // Clear any manually added track elements

        // --- Plyr options ---
        const plyrOptions = {
            // debug: true, // Enable for verbose console logs from Plyr
            title: `${currentEpisodeData.animeTitle || 'Video'} - Ep ${currentEpisodeData.currentEpisodeNumber || '?'} (${type.toUpperCase()})`,
            controls: [ 'play-large', 'restart', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen' ],
            settings: ['captions', 'quality', 'speed', 'loop'],
            captions: { active: true, language: 'auto', update: true }, // Default to browser lang, allow updates
            tooltips: { controls: true, seek: true },
            keyboard: { focused: true, global: true },
            // Quality options can be dynamically updated by HLS.js integration
            quality: { default: 720, options: [4320, 2880, 2160, 1440, 1080, 720, 576, 480, 360, 240] }, // Provide standard options
             // Ensure tracks are passed correctly
            // Note: For HLS, tracks are sometimes better handled by setting player.source after init
        };
        console.log("Plyr Options:", JSON.parse(JSON.stringify(plyrOptions))); // Log options
        console.log("Tracks to be passed to Plyr:", JSON.parse(JSON.stringify(tracks))); // Log tracks

        try {
            if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
                // --- HLS.js Integration ---
                console.log("Setting up Plyr with HLS.js...");
                hlsInstance = new Hls({
                    // HLS config options can go here if needed
                    // Example: enableWorker: true, lowLatencyMode: true
                    // capLevelToPlayerSize: true, // Consider enabling this - might help auto quality
                });

                // --- Important: Attach HLS listeners BEFORE loading source ---
                hlsInstance.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                    console.log(`HLS Manifest Parsed: Found ${data.levels.length} quality levels.`);
                    // You could potentially update Plyr's quality options here if needed,
                    // but Plyr often handles this automatically when HLS.js is detected.
                     if (plyrPlayer && plyrPlayer.quality !== data.levels.map(l => l.height)) {
                         // Example of how you might update Plyr's quality options if needed
                         // plyrPlayer.quality = data.levels.map(l => l.height);
                         // console.log("Updated Plyr quality options based on HLS manifest.");
                     }
                });
                 hlsInstance.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
                    const levels = hlsInstance.levels;
                    if (levels && levels[data.level]) {
                        console.log(`HLS Quality Switched: ${levels[data.level].height}p`);
                    }
                 });
                hlsInstance.on(Hls.Events.ERROR, (event, data) => { handleHlsError(event, data, hlsInstance); });

                // Initialize Plyr first *without* source if using HLS source setter later
                // plyrPlayer = new Plyr(videoElement, plyrOptions);

                // Or, set source directly in options (simpler, often works)
                plyrOptions.source = {
                    type: 'video',
                    title: plyrOptions.title,
                    sources: [{ src: sourceUrl, type: 'application/x-mpegURL' }], // Specify HLS type
                    tracks: tracks // Pass tracks here
                };
                plyrPlayer = new Plyr(videoElement, plyrOptions);
                window.player = plyrPlayer; // For debugging convenience


                // Attach HLS to the media element managed by Plyr
                hlsInstance.loadSource(sourceUrl);
                hlsInstance.attachMedia(videoElement);
                window.hls = hlsInstance; // For debugging

                console.log("Plyr initialized, HLS instance created and attached.");

            } else {
                // --- Native HTML5 Video ---
                console.log("Setting up Plyr with native source (MP4/WebM etc.)...");
                if (isHls) { console.warn("HLS source detected but Hls.js is not available/supported. Playback might fail."); }

                plyrOptions.source = {
                    type: 'video',
                    title: plyrOptions.title,
                    sources: [{ src: sourceUrl }], // Let Plyr/browser determine type
                    tracks: tracks
                };
                plyrPlayer = new Plyr(videoElement, plyrOptions);
                window.player = plyrPlayer; // Debugging
                console.log("Plyr initialized with native source.");
            }

            // --- Attach Common Plyr Event Listeners (AFTER player is initialized) ---
            if (plyrPlayer) {
                plyrPlayer.on('ready', (event) => {
                    console.log("Plyr 'ready' event fired.");
                    // Setup skip buttons once the player is ready and potentially knows duration/metadata
                    setupSkipButtons();
                    // Optionally auto-play (consider user experience)
                    // event.detail.plyr.play();
                });
                plyrPlayer.on('error', (event) => {
                    console.error("Plyr Player Error Event:", event);
                    displayError(`Video Playback Error: ${event.detail?.error?.message || 'Unknown player error'}`);
                });
                plyrPlayer.on('enterfullscreen', () => { console.log("Entered fullscreen"); });
                plyrPlayer.on('exitfullscreen', () => { console.log("Exited fullscreen"); });
                plyrPlayer.on('captionsenabled', () => console.log('Plyr captions enabled'));
                plyrPlayer.on('captionsdisabled', () => console.log('Plyr captions disabled'));
                plyrPlayer.on('languagechange', (event) => console.log(`Plyr language changed to: ${event.detail.plyr.language}`));
                plyrPlayer.on('qualitychange', (event) => console.log(`Plyr quality change requested/detected: ${event.detail.quality}`)); // May not fire reliably with external HLS control
                 plyrPlayer.on('timeupdate', () => {
                     if (boundHandleTimeUpdate) boundHandleTimeUpdate(); // Call the bound skip button handler
                 });

            } else { throw new Error("Plyr player instance was not created successfully."); }

        } catch (initError) {
            console.error("!!! CRITICAL ERROR INITIALIZING PLYR/HLS !!!", initError);
            displayError(`Failed to initialize player: ${initError.message}`);
        }
    }

     /** Handles HLS.js errors */
    function handleHlsError(event, data, hls) {
        console.error('HLS Error:', data);
        if (data.fatal) {
            switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                    console.warn('HLS network error - trying to recover...');
                    if (hls) hls.startLoad(); // or hls.recoverMediaError()
                    // Optionally notify user: "Network issue, attempting to recover..."
                    break;
                case Hls.ErrorTypes.MEDIA_ERROR:
                    console.warn('HLS media error - trying to recover...');
                    if (hls) hls.recoverMediaError();
                     // Optionally notify user: "Media error, attempting to recover..."
                    break;
                default:
                    console.error('Unrecoverable HLS error.');
                     displayError(`Playback Error (HLS): ${data.details || 'Unknown HLS error'}`);
                    // Destroy HLS instance?
                    if (hls) hls.destroy();
                    hlsInstance = null; // Reset global ref
                    break;
            }
        } else {
            // Non-fatal errors (e.g., buffer stall, fragment load issues)
            console.warn(`Non-fatal HLS error: ${data.details || data.type}`);
             // Could potentially implement custom retry logic here for specific non-fatal errors
        }
    }


    /** Updates SUB/DUB button states based on current selection and availability */
    function updateStreamTypeButtons(isErrorState = false) {
        // In this simplified model, we assume both are potentially available unless an error occurred.
        // A more complex approach would check the `currentEpisodeData.episodes` availability flags if the API provided them.
        const subAvailable = !isErrorState; // Assume available if no error loading *current* type
        const dubAvailable = !isErrorState; // Assume available if no error loading *current* type
        const selected = currentEpisodeData.selectedType;

        // console.log(`Updating buttons: SUB=${subAvailable}, DUB=${dubAvailable}, Selected=${selected}`);

        if (subButton) {
            subButton.disabled = !subAvailable;
            subButton.classList.toggle('bg-purple-600', selected === 'sub' && subAvailable);
            subButton.classList.toggle('text-white', selected === 'sub' && subAvailable);
            subButton.classList.toggle('bg-gray-700', selected !== 'sub' || !subAvailable);
            subButton.classList.toggle('text-gray-200', selected !== 'sub'); // Keep text color even if disabled
            subButton.classList.toggle('opacity-50', !subAvailable);
            subButton.classList.toggle('cursor-not-allowed', !subAvailable);
        }
        if (dubButton) {
            dubButton.disabled = !dubAvailable;
            dubButton.classList.toggle('bg-purple-600', selected === 'dub' && dubAvailable);
            dubButton.classList.toggle('text-white', selected === 'dub' && dubAvailable);
            dubButton.classList.toggle('bg-gray-700', selected !== 'dub' || !dubAvailable);
            dubButton.classList.toggle('text-gray-200', selected !== 'dub'); // Keep text color even if disabled
            dubButton.classList.toggle('opacity-50', !dubAvailable);
            dubButton.classList.toggle('cursor-not-allowed', !dubAvailable);
        }
    }

     /** Resets skip buttons (hides, clears timeouts, removes listeners) */
    function resetSkipButtons() {
        clearTimeout(skipIntroTimeout);
        clearTimeout(skipOutroTimeout);
        if(skipIntroButton) skipIntroButton.classList.remove('visible');
        if(skipOutroButton) skipOutroButton.classList.remove('visible');

        // Remove listeners using the *bound* references if they exist
        if (plyrPlayer) {
             // We manage timeupdate via a listener directly on plyrPlayer now
            // if (boundHandleTimeUpdate) plyrPlayer.off('timeupdate', boundHandleTimeUpdate);
        }
        if (skipIntroButton && boundHandleSkipIntro) skipIntroButton.removeEventListener('click', boundHandleSkipIntro);
        if (skipOutroButton && boundHandleSkipOutro) skipOutroButton.removeEventListener('click', boundHandleSkipOutro);
         // console.log("Skip buttons reset.");
    }


    /** Sets up skip intro/outro buttons based on currentEpisodeData */
    function setupSkipButtons() {
        console.log("Setting up skip buttons...");
        resetSkipButtons(); // Ensure clean state before setting up

        if (!plyrPlayer || !skipIntroButton || !skipOutroButton) { console.warn("Skip buttons or Plyr instance not ready for setup."); return; }

        const intro = currentEpisodeData.intro;
        const outro = currentEpisodeData.outro;
        const hasIntro = intro && intro.start < intro.end && intro.end > 0;
        const hasOutro = outro && outro.start > 0 && outro.start < (plyrPlayer.duration || Infinity); // Check start time validity

         console.log("Skip Times:", { intro, outro, duration: plyrPlayer.duration });

        if (!hasIntro && !hasOutro) { console.log("No valid intro/outro times found."); return; }

        // --- Create bound handlers ---
        boundHandleTimeUpdate = () => {
            if (!plyrPlayer || !plyrPlayer.playing || !plyrPlayer.duration) return; // Check if playing & duration known
            const currentTime = plyrPlayer.currentTime;
            const duration = plyrPlayer.duration;
            let introVisible = skipIntroButton.classList.contains('visible');
            let outroVisible = skipOutroButton.classList.contains('visible');

            // Show/Hide Intro Button
            if (hasIntro && currentTime >= intro.start && currentTime < intro.end) {
                if (!introVisible) { skipIntroButton.classList.add('visible'); }
            } else if (introVisible) { skipIntroButton.classList.remove('visible'); }

            // Show/Hide Outro Button
            if (hasOutro && currentTime >= outro.start && currentTime < (outro.end || duration)) { // Use outro.end if available, else duration
                if (!outroVisible) { skipOutroButton.classList.add('visible'); }
            } else if (outroVisible) { skipOutroButton.classList.remove('visible'); }
        };

        boundHandleSkipIntro = () => {
            if (plyrPlayer && hasIntro) {
                console.log(`Skipping intro: Seeking to ${intro.end}`);
                plyrPlayer.currentTime = intro.end; // Use currentTime setter
                skipIntroButton.classList.remove('visible');
            }
        };

        boundHandleSkipOutro = () => {
            if (plyrPlayer && hasOutro) {
                 const seekTime = outro.end > outro.start ? outro.end : plyrPlayer.duration; // Seek to end time or full duration
                 console.log(`Skipping outro: Seeking to ${seekTime}`);
                plyrPlayer.currentTime = seekTime;
                skipOutroButton.classList.remove('visible');
            }
        };

        // --- Attach listeners ---
        // Timeupdate is now handled by the main Plyr listener setup in initializeOrUpdatePlyrPlayer

        if (hasIntro) skipIntroButton.addEventListener('click', boundHandleSkipIntro);
        if (hasOutro) skipOutroButton.addEventListener('click', boundHandleSkipOutro);
        console.log("Skip button event listeners attached.");
    }


    // --- Fetch Initial Page Data (Anime Info + Episodes) ---
    try {
        console.log(`Workspaceing anime info for streamingId: ${currentEpisodeData.streamingId}`);
        const animeInfo = await fetchAnimeInfoFromStreamingAPI(currentEpisodeData.streamingId);

        if (!animeInfo) throw new Error("Could not retrieve anime details from streaming service.");
        if (!animeInfo.episodes) animeInfo.episodes = []; // Ensure episodes array exists

        currentEpisodeData.episodes = animeInfo.episodes;
        currentEpisodeData.animeTitle = animeInfo.title?.english || animeInfo.title?.romaji || animeInfo.title?.native || 'Anime Title';

        // Find the specific info for the *current* base episode ID
        const currentEpInfo = animeInfo.episodes.find(ep => ep.id === currentEpisodeData.baseEpisodeId);
        currentEpisodeData.currentEpisodeNumber = currentEpInfo?.number ?? (animeInfo.episodes.length === 1 && (animeInfo.format === 'Movie' || animeInfo.format === 'Special') ? 'Film' : (currentEpInfo?.number || '?')); // Handle movies/specials better

        console.log(`Current Episode Info found: Number ${currentEpisodeData.currentEpisodeNumber}`, currentEpInfo);

        // --- Update UI Titles ---
        document.title = `Watching ${currentEpisodeData.animeTitle} - Ep ${currentEpisodeData.currentEpisodeNumber}`;
        if (episodeTitleArea) {
            episodeTitleArea.textContent = `${currentEpisodeData.animeTitle} - Episode ${currentEpisodeData.currentEpisodeNumber}`;
            episodeTitleArea.classList.remove('skeleton-block', 'h-6', 'w-64', 'inline-block', 'rounded'); // Remove skeleton styles
        }
        if (sidebarAnimeTitle) {
             sidebarAnimeTitle.textContent = currentEpisodeData.animeTitle;
             const titleSpan = sidebarAnimeTitle.querySelector('span'); // Remove skeleton span if present
             if(titleSpan) titleSpan.remove();
        }


        // --- Populate Episode List Sidebar ---
        if (episodeListUL && episodeListContainer) {
            if (currentEpisodeData.episodes.length > 0) {
                episodeListUL.innerHTML = currentEpisodeData.episodes.map(ep =>
                    createSidebarEpisodeItemHTML(ep, currentEpisodeData.streamingId, currentEpisodeData.aniListId, ep.id === currentEpisodeData.baseEpisodeId)
                ).join('');

                // Scroll the active episode into view
                const activeItem = episodeListUL.querySelector('.episode-list-item.active');
                if (activeItem) {
                     // Use setTimeout to ensure rendering is complete before scrolling
                     setTimeout(() => {
                         activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                         console.log("Scrolled active episode into view.");
                     }, 100); // Small delay might be needed
                } else { console.warn("Active episode item not found in the sidebar list."); }

                episodeListUL.classList.remove('hidden');
                if (episodeListError) episodeListError.classList.add('hidden');
            } else {
                // Handle case where API returns info but no episodes
                 displayError("No episodes found for this anime on the streaming service.", true); // Display in episode list area
            }
            if (episodeListLoading) episodeListLoading.classList.add('hidden');
        } else { console.error("Episode list UL or Container element not found in DOM."); }

        // --- Fetch initial video source for the selected type ---
        showContent(); // Show the main layout before fetching video
        await loadVideoSource(currentEpisodeData.selectedType); // Use the initially determined type

    } catch (initError) {
        console.error("Initialization Error (fetching anime info/episodes):", initError);
        displayError(`Error loading page data: ${initError.message}`); // Show general page error
    }

    // --- Event Listeners for Controls (SUB/DUB/Server) ---
    if (subButton) subButton.addEventListener('click', () => { if (!subButton.disabled && currentEpisodeData.selectedType !== 'sub') loadVideoSource('sub'); });
    if (dubButton) dubButton.addEventListener('click', () => { if (!dubButton.disabled && currentEpisodeData.selectedType !== 'dub') loadVideoSource('dub'); });
    if (serverSelect) serverSelect.addEventListener('change', (e) => { currentEpisodeData.selectedServer = e.target.value; loadVideoSource(currentEpisodeData.selectedType); });

    console.log("initEpisodePage setup complete.");
}
// --- End of initEpisodePage ---
