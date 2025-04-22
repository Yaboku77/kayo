// --- Constants and Global Variables ---
const ANILIST_API_URL = 'https://graphql.anilist.co';
// Ensure this points to your working Consumet/Streaming API instance
const STREAMING_API_BASE_URL = 'https://api-pearl-seven-88.vercel.app'; // User-provided API
const DEFAULT_STREAMING_PROVIDER = 'zoro'; // Default provider for the API

let searchTimeoutId = null; // For debouncing search input
let featuredSwiper = null; // Swiper instance for index page slider
let playerJsInstance = null; // Player.js instance for episode page video player

// Structure to hold episode page state (remains mostly the same)
let currentEpisodeData = {
    streamingId: null,
    baseEpisodeId: null,
    currentEpisodeId: null,
    aniListId: null,
    episodes: [],
    currentSourceData: null,
    selectedServer: 'vidcloud',
    selectedType: 'sub',
    animeTitle: 'Loading...',
    currentEpisodeNumber: '?',
    intro: null,
    outro: null,
    subtitles: [], // Store API subtitles here
    playerJsFileFormat: null // Store the formatted string for Player.js 'file' option
};

// Timeout references for skip button visibility management
let skipIntroTimeout = null;
let skipOutroTimeout = null;
// Keep references to bound event handlers for Player.js
let boundPlayerJsTimeUpdate = null;
let boundPlayerJsSkipIntro = null;
let boundPlayerJsSkipOutro = null;


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
function getCurrentSeason() { /* ... */ } // No changes
function sanitizeDescription(desc) { /* ... */ } // No changes
function debounce(func, delay) { /* ... */ } // No changes
function getUrlParams() { /* ... */ } // No changes
function mapAniListFormatToStreamingFormat(aniListFormat) { /* ... */ } // No changes


// --- API Fetching (Remain the same) ---
async function fetchAniListApi(query, variables) { /* ... */ } // No changes
async function fetchStreamingApi(endpoint, errorMessage = 'Error fetching streaming data') { /* ... */ } // No changes


// --- Specific Streaming API Functions (Remain the same) ---
async function fetchAnimeInfoFromStreamingAPI(streamingId) { /* ... */ } // No changes
async function fetchEpisodeWatchData(episodeIdToFetch, server = 'vidcloud') { /* ... */ } // No changes


// --- HTML Generation Helpers (Remain largely the same) ---
// These functions generate HTML for index.html and anime.html, no changes needed.
function createFeaturedSlideHTML(anime) { /* ... */ }
function createAnimeCardHTML(anime) { /* ... */ }
function createTopAnimeListItemHTML(anime, rank) { /* ... */ }
function createSearchSuggestionHTML(media) { /* ... */ }
function createDetailEpisodeLinkHTML(episode, streamingId, aniListId) { /* ... */ }

// Sidebar episode item generation needs slight adjustment for Player.js context if needed,
// but mostly relies on URL params which remain the same conceptually.
function createSidebarEpisodeItemHTML(episode, streamingId, aniListId, isActive = false) {
    if (!episode || !episode.id || !streamingId || !aniListId) return '';
    const episodeNumber = episode.number ?? '?'; // Use ?? for nullish coalescing
    const episodeTitle = episode.title ? `: ${episode.title}` : '';
    // Link should preserve the currently selected type (sub/dub) if possible, or default to sub
    // Fetch the current type from the global state when generating the link
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

/** Formats subtitles from the API response into the string format Player.js expects. */
function formatSubtitlesForPlayerJS(apiSubtitles) {
    if (!apiSubtitles || !Array.isArray(apiSubtitles) || apiSubtitles.length === 0) return '';
    // console.log("Formatting subtitles for Player.js:", apiSubtitles);

    const langCodeMap = { 'english': 'EN', 'spanish': 'ES', 'portuguese': 'PT', 'french': 'FR', 'german': 'DE', 'italian': 'IT', 'russian': 'RU', 'arabic': 'AR', 'indonesian': 'ID', 'thai': 'TH', 'vietnamese': 'VI' /* Add more as needed */ };
    let subtitlesString = "";

    apiSubtitles.forEach((sub, index) => {
        if (!sub || typeof sub !== 'object' || !sub.url || sub.lang?.toLowerCase() === 'thumbnails') {
            return; // Skip invalid or thumbnail tracks
        }

        const langLower = sub.lang?.toLowerCase() || `unk${index}`;
        const simpleLang = langLower.split('-')[0].trim();
        let langCode = langCodeMap[simpleLang] || simpleLang.substring(0, 2).toUpperCase() || `L${index}`; // Use mapped code or 2-char uppercase

        if (subtitlesString) subtitlesString += ","; // Add comma separator
        subtitlesString += `[${langCode}]${sub.url}`;
    });

    // console.log("Formatted Player.js subtitle string:", subtitlesString);
    return subtitlesString;
}


// --- Swiper Initialization (Remains the same) ---
function initializeFeaturedSwiper(containerSelector = '#featured-swiper') {
    if (typeof Swiper === 'undefined') { console.error("Swiper library not loaded."); return; }
    if (featuredSwiper) { try { featuredSwiper.destroy(true, true); } catch (e) { console.warn("Error destroying previous Swiper instance:", e); } featuredSwiper = null; }
    const swiperContainer = document.querySelector(containerSelector);
    if (!swiperContainer) { console.warn(containerSelector + " container not found for Swiper."); return; }
    const slides = swiperContainer.querySelectorAll('.swiper-slide');
    if (slides.length === 0) { console.warn("No slides found in " + containerSelector + ". Swiper not initialized."); return; }
    try {
        featuredSwiper = new Swiper(containerSelector, {
            // Swiper options remain the same
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

// --- Search Functionality (Remains the same) ---
function setupSearch(searchInputId = 'search-input', suggestionsContainerId = 'search-suggestions', searchIconButtonId = 'search-icon-button', headerTitleSelector = 'header a.text-2xl', mobileMenuButtonId = 'mobile-menu-button') {
    // Search logic remains the same
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

// --- Mobile Menu Functionality (Remains the same) ---
function setupMobileMenu(menuButtonId = 'mobile-menu-button', sidebarContainerId = 'mobile-sidebar-container', sidebarId = 'mobile-sidebar', overlayId = 'sidebar-overlay', closeButtonId = 'close-sidebar-button', navLinkClass = '.mobile-nav-link') {
    // Mobile menu logic remains the same
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

// --- Footer Year (Remains the same) ---
function setFooterYear(footerYearId = 'footer-year') { /* ... */ } // No changes


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
    // --- DOM Element references (Remain the same) ---
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
        backButton.addEventListener('click', (e) => { e.preventDefault(); if (window.history.length > 1) history.back(); else window.location.href = 'index.html'; });
    }

    try {
        const aniListData = await fetchAniListApi(ANILIST_DETAIL_QUERY, { id: aniListId });
        const aniListMedia = aniListData?.Media;
        if (!aniListMedia) throw new Error('Anime not found on AniList.');

        // --- Populate Detail View (from AniList data - Remains the same) ---
        if(detailLoadingMessage) detailLoadingMessage.classList.add('hidden');
        if(detailErrorMessage) detailErrorMessage.classList.add('hidden');
        if(detailContentArea) detailContentArea.classList.remove('hidden');
        const pageTitle = aniListMedia.title.english || aniListMedia.title.romaji || 'Details';
        document.title = `AniStream - ${pageTitle}`;

        // Banner, Cover Image, Title, Genres, Stats, Description, Trailer, Characters, Staff, Relations population logic...
        // (This part is identical to the previous version and is quite long, so omitting for brevity here,
        // but it should be included in the final script.)
        // ... (Insert the DOM population logic from the previous script here) ...


        // --- Fetch and Display Episode List (with improved matching - Remains the same) ---
        if (detailEpisodesSection) {
            const animeTitleForSearch = aniListMedia.title.english || aniListMedia.title.romaji;
            if (animeTitleForSearch) {
                try {
                    console.log(`Searching streaming API for: "${animeTitleForSearch}"`);
                    const searchEndpoint = `/anime/${DEFAULT_STREAMING_PROVIDER}/${encodeURIComponent(animeTitleForSearch)}`;
                    const searchData = await fetchStreamingApi(searchEndpoint);
                    const searchResults = searchData?.results || [];
                    console.log(`Found ${searchResults.length} results from streaming search.`);
                    if (searchResults.length === 0) throw new Error(`Anime "${animeTitleForSearch}" not found on streaming service.`);

                    // Find the best match (logic remains the same)
                    let bestMatch = null;
                    const aniListFormatMapped = mapAniListFormatToStreamingFormat(aniListMedia.format);
                    const aniListYear = aniListMedia.seasonYear;
                    const potentialMatches = searchResults.filter(result => {
                        const resultType = result.type; // API response structure might vary ('type' or 'format')
                        const resultYear = result.releaseDate ? parseInt(result.releaseDate) : null;
                        // Looser format matching might be needed depending on API consistency
                        const formatMatch = !aniListFormatMapped || !resultType || resultType.toUpperCase().includes(aniListFormatMapped.toUpperCase()) || aniListFormatMapped.toUpperCase().includes(resultType.toUpperCase());
                        const yearMatch = !aniListYear || !resultYear || Math.abs(resultYear - aniListYear) <= 1; // Allow +/- 1 year difference
                        return formatMatch && yearMatch;
                    });
                     console.log(`Found ${potentialMatches.length} potential matches after filtering by format/year.`);

                    if (potentialMatches.length === 1) { bestMatch = potentialMatches[0]; }
                    else if (potentialMatches.length > 1) {
                        // Prefer exact title match if multiple format/year matches
                        const exactTitleMatch = potentialMatches.find(p =>
                            p.title?.toLowerCase() === (aniListMedia.title.english?.toLowerCase() || '##nomatch##') || // Use placeholder if null
                            p.title?.toLowerCase() === (aniListMedia.title.romaji?.toLowerCase() || '##nomatch##')
                        );
                        bestMatch = exactTitleMatch || potentialMatches[0]; // Fallback to first potential match
                        console.warn(exactTitleMatch ? "Multiple potential matches, found exact title." : "Multiple potential matches, falling back to the first one.");
                    } else {
                         // If no format/year match, try searching again *without* format/year filter (broader search)
                         console.warn(`No strict format/year match found (AL: ${aniListFormatMapped}/${aniListYear}). Falling back to first search result if available.`);
                         bestMatch = searchResults[0]; // Use the very first result as a last resort
                         if(!bestMatch) throw new Error(`Could not find any match on streaming service (Format/Year mismatch?).`);
                    }
                    console.log("Selected match from streaming service:", bestMatch);

                    const streamingId = bestMatch?.id;
                    if (streamingId) {
                        const streamingInfo = await fetchAnimeInfoFromStreamingAPI(streamingId);
                        if (streamingInfo && streamingInfo.episodes?.length > 0) {
                            detailEpisodesList.innerHTML = streamingInfo.episodes
                                .map(ep => createDetailEpisodeLinkHTML(ep, streamingId, aniListId)) // Use the correct helper
                                .join('');
                            if(detailEpisodesLoading) detailEpisodesLoading.classList.add('hidden');
                            if(detailEpisodesError) detailEpisodesError.classList.add('hidden');
                            if(detailEpisodesListContainer) detailEpisodesListContainer.classList.remove('hidden');
                        } else {
                             if (streamingInfo && (!streamingInfo.episodes || streamingInfo.episodes.length === 0)) { throw new Error('Streaming service found the anime but lists no episodes.'); }
                             else { throw new Error('Could not fetch episode details from streaming service after finding a match.'); }
                        }
                    } else { throw new Error('Failed to identify a valid streaming ID from the best match.'); }
                } catch (episodeError) {
                    console.error("Error fetching/displaying episodes:", episodeError);
                    if(detailEpisodesLoading) detailEpisodesLoading.classList.add('hidden');
                    if(detailEpisodesListContainer) detailEpisodesListContainer.classList.add('hidden');
                    if(detailEpisodesError) { detailEpisodesError.textContent = `Could not load episodes: ${episodeError.message}`; detailEpisodesError.classList.remove('hidden'); }
                }
            } else { // Handle missing title for search
                if(detailEpisodesLoading) detailEpisodesLoading.classList.add('hidden');
                if(detailEpisodesError) { detailEpisodesError.textContent = 'Could not load episodes: Anime title missing from AniList data.'; detailEpisodesError.classList.remove('hidden'); }
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


/** Initializes the Episode Player Page - Using Player.js */
async function initEpisodePage() {
    console.log("Initializing Episode Page with Player.js...");
    setFooterYear();
    setupSearch();
    setupMobileMenu();

    // --- DOM Element references ---
    const loadingMessage = document.getElementById('episode-loading-message');
    const errorMessage = document.getElementById('episode-error-message');
    const mainContent = document.getElementById('episode-main-content');
    const playerWrapper = document.getElementById('player-wrapper');
    // const videoElement = document.getElementById('video-player'); // No longer used
    const playerContainer = document.getElementById('player-container'); // This now holds the Player.js div
    const playerJsDivId = 'playerjs'; // ID for the Player.js container div
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
    if (!playerContainer) { console.error("Player container element (#player-container) not found!"); displayError("Player container element missing in HTML."); return; }
    if (typeof Playerjs === 'undefined') { console.error("Player.js library is not loaded."); displayError("Player library (Player.js) failed to load. Check script tag."); return; }

    // --- Add Player.js div ---
    playerContainer.innerHTML = `<div id="${playerJsDivId}"></div>`; // Add the target div for Player.js

    // --- Get URL Params and Validate (same as before) ---
    const urlParams = getUrlParams();
    const initialEpisodeIdFromUrl = urlParams.episodeId;
    const aniListId = urlParams.aniListId;
    const streamingId = urlParams.streamingId;

    if (!streamingId || !initialEpisodeIdFromUrl || !aniListId) {
        console.error("Missing required IDs (streamingId, episodeId, aniListId) in URL parameters.", urlParams);
        displayError("Error: Missing required information in URL to load the episode.");
        return;
    }

    // --- Parse Base Episode ID and Initial Type (same as before) ---
    let baseEpisodeId = initialEpisodeIdFromUrl;
    let initialType = 'sub';
    const lastDollarIndex = initialEpisodeIdFromUrl.lastIndexOf('$');
    if (lastDollarIndex > 0) {
        const suffix = initialEpisodeIdFromUrl.substring(lastDollarIndex + 1).toLowerCase();
        if (suffix === 'sub' || suffix === 'dub') {
            baseEpisodeId = initialEpisodeIdFromUrl.substring(0, lastDollarIndex);
            initialType = suffix;
        }
    }
    console.log(`Parsed IDs: streamingId=${streamingId}, baseEpisodeId=${baseEpisodeId}, initialType=${initialType}, aniListId=${aniListId}`);

    // --- Reset Global State ---
    currentEpisodeData = {
        streamingId: streamingId, baseEpisodeId: baseEpisodeId, currentEpisodeId: initialEpisodeIdFromUrl, aniListId: aniListId,
        episodes: [], currentSourceData: null, selectedServer: serverSelect ? serverSelect.value : 'vidcloud',
        selectedType: initialType, animeTitle: 'Loading...', currentEpisodeNumber: '?',
        intro: null, outro: null, subtitles: [], playerJsFileFormat: null
    };
    console.log("Initial State (Player.js):", JSON.parse(JSON.stringify(currentEpisodeData))); // Deep copy log

    // --- Setup UI Elements (same as before) ---
    if (backButton && currentEpisodeData.aniListId) { /* ... back button logic ... */ }
    showLoading();

    // --- Core Functions (Adapted for Player.js) ---

    function displayError(message, isEpisodeListError = false) { /* ... same as before ... */ }
    function showLoading() { /* ... same as before ... */ }
    function showContent() { /* ... same as before ... */ }

    /** Loads video source, subtitles, skip times and initializes/updates Player.js */
    async function loadVideoSource(type = 'sub') {
        console.log(`Load Request (Player.js): type=${type}, server=${currentEpisodeData.selectedServer}, baseEpisodeId=${currentEpisodeData.baseEpisodeId}`);
        currentEpisodeData.selectedType = type;

        // Show loading state
        if (playerJsInstance) { playerJsInstance.api("stop"); } // Use Player.js API
        resetSkipButtons();
        if (errorMessage) errorMessage.classList.add('hidden');
        if (playerContainer) playerContainer.style.opacity = '0.5';

        const episodeIdToFetch = `${currentEpisodeData.baseEpisodeId}$${type}`;
        console.log(`Workspaceing watch data for constructed ID: ${episodeIdToFetch}`);

        try {
            const watchData = await fetchEpisodeWatchData(episodeIdToFetch, currentEpisodeData.selectedServer);
            currentEpisodeData.currentSourceData = watchData;

            if (!watchData) { throw new Error(`API returned null/undefined for watch data.`); }

            // --- Check for Sources ---
            if (!watchData.sources || watchData.sources.length === 0) {
                 if (watchData.download) {
                    console.warn(`No streaming sources found, attempting download link: ${watchData.download}`);
                    currentEpisodeData.intro = { start: 0, end: 0 };
                    currentEpisodeData.outro = { start: 0, end: 0 };
                    currentEpisodeData.subtitles = []; // Store empty from API
                    currentEpisodeData.playerJsFileFormat = watchData.download; // Use download link as file
                    initializeOrUpdatePlayerJSPlayer(currentEpisodeData.playerJsFileFormat); // Load download link
                 } else {
                    throw new Error(`No sources or download link found for ${type.toUpperCase()} on server ${currentEpisodeData.selectedServer}. Try another server.`);
                 }
            } else {
                // --- Process Streaming Sources ---
                currentEpisodeData.intro = watchData.intro || { start: 0, end: 0 };
                currentEpisodeData.outro = watchData.outro || { start: 0, end: 0 };
                currentEpisodeData.subtitles = watchData.subtitles || []; // Store raw subtitles

                let sourceUrl = null;
                const sourcesToUse = watchData.sources;
                const hlsSource = sourcesToUse.find(s => s.isM3U8 || s.url?.includes('.m3u8'));

                if (hlsSource) {
                    sourceUrl = hlsSource.url;
                    console.log("Selected HLS source for Player.js:", sourceUrl);
                } else {
                    const autoSource = sourcesToUse.find(s => s.quality?.toLowerCase() === 'auto' || s.quality?.toLowerCase() === 'default');
                    sourceUrl = autoSource ? autoSource.url : sourcesToUse[0]?.url;
                    console.log(`Selected non-HLS source (or first source) for Player.js: ${sourceUrl}`);
                }

                if (!sourceUrl) { throw new Error(`Could not extract a valid video URL from sources for ${type.toUpperCase()}.`); }

                // --- Format for Player.js 'file' option ---
                const subtitlesString = formatSubtitlesForPlayerJS(currentEpisodeData.subtitles);
                // Basic format: just the URL. Add subtitles if available.
                currentEpisodeData.playerJsFileFormat = subtitlesString ? `${sourceUrl},${subtitlesString}` : sourceUrl;
                // Example for multiple qualities (more complex parsing needed if API provides it):
                // currentEpisodeData.playerJsFileFormat = `[{title:"Auto", file:"${sourceUrl}", subtitle:"${subtitlesString}"}]`;

                console.log("Formatted 'file' option for Player.js:", currentEpisodeData.playerJsFileFormat);

                initializeOrUpdatePlayerJSPlayer(currentEpisodeData.playerJsFileFormat); // Initialize with formatted source/subs
            }

            updateStreamTypeButtons(); // Update button states

        } catch (error) {
            console.error(`Error loading video source for ${type.toUpperCase()}:`, error);
            displayError(`Failed to load video (${type.toUpperCase()}): ${error.message}`);
            updateStreamTypeButtons(true);
            // Clear the player div on error
            const playerDiv = document.getElementById(playerJsDivId);
            if (playerDiv) playerDiv.innerHTML = '<p class="text-red-400 p-4 text-center">Failed to load video.</p>';
        } finally {
            if (playerContainer) playerContainer.style.opacity = '1';
        }
    }

    /** Initializes or updates the Player.js instance */
    function initializeOrUpdatePlayerJSPlayer(fileOption) {
        console.log("Attempting to initialize/update Player.js...");

        // Destroy previous instance if exists
        if (playerJsInstance) {
            try {
                playerJsInstance.api("destroy");
                console.log("Previous Player.js instance destroyed.");
            } catch(e) { console.error("Error destroying previous Player.js instance", e); }
            playerJsInstance = null;
        }
         // Clear the container div before creating a new player
         const playerDiv = document.getElementById(playerJsDivId);
         if(playerDiv) playerDiv.innerHTML = '';
         else {
             console.error(`Player target div '#${playerJsDivId}' not found! Cannot initialize player.`);
             displayError("Internal Error: Player target missing.");
             return;
         }

        // --- Player.js options ---
        const playerJsOptions = {
            id: playerJsDivId, // Target div ID
            file: fileOption,  // The formatted source URL + subtitles string
            title: `${currentEpisodeData.animeTitle || 'Video'} - Ep ${currentEpisodeData.currentEpisodeNumber || '?'} (${currentEpisodeData.selectedType.toUpperCase()})`,
            // Add other Player.js options as needed:
            // poster: "path/to/poster.jpg",
             width: "100%",    // Make it responsive
             height: "100%",   // Make it responsive
            // aspectratio: "16:9", // Handled by CSS aspect-ratio on container
            // skin_color: "7c3aed", // Set theme color (optional)
        };
        console.log("Player.js Options:", playerJsOptions);

        try {
            playerJsInstance = new Playerjs(playerJsOptions);
            console.log("Player.js instance created.");
            window.pjs = playerJsInstance; // For debugging

            // --- Attach Player.js Event Listeners ---
            playerJsInstance.on('ready', () => {
                console.log("Player.js 'ready' event.");
                setupSkipButtons(); // Setup skip buttons when player is ready
            });
            playerJsInstance.on('error', (e) => {
                 console.error("Player.js Error Event:", e);
                 displayError(`Video Playback Error: ${e.message || 'Unknown player error'}`);
            });
            playerJsInstance.on('play', () => console.log('Player.js playing'));
            playerJsInstance.on('pause', () => console.log('Player.js paused'));
            playerJsInstance.on('time', (currentTime) => {
                // Call the skip button time update handler
                if (boundPlayerJsTimeUpdate) boundPlayerJsTimeUpdate(currentTime);
            });
             playerJsInstance.on('duration', (duration) => {
                 console.log(`Player.js duration set: ${duration}`);
                 // Duration might be needed for skip button logic, can update state here if necessary
                 // Re-setup skip buttons if duration was needed and now available
                 setupSkipButtons();
             });
             playerJsInstance.on('subtitle', (track_num) => { // Track num starts from 1, 0 is off
                console.log(`Player.js subtitle track changed to: ${track_num}`);
             });
             playerJsInstance.on('quality', (quality_id) => {
                 console.log(`Player.js quality changed to: ${quality_id}`); // Quality ID might be index or specific name
             });


        } catch (initError) {
            console.error("!!! CRITICAL ERROR INITIALIZING PLAYER.JS !!!", initError);
            displayError(`Failed to initialize player: ${initError.message}`);
        }
    }

    /** Updates SUB/DUB button states (same as before) */
    function updateStreamTypeButtons(isErrorState = false) { /* ... */ }

    /** Resets skip buttons (hides, clears timeouts, removes listeners) */
    function resetSkipButtons() {
        clearTimeout(skipIntroTimeout);
        clearTimeout(skipOutroTimeout);
        if(skipIntroButton) skipIntroButton.classList.remove('visible');
        if(skipOutroButton) skipOutroButton.classList.remove('visible');

        // Remove listeners using the *bound* references if they exist
        // Time update is handled by player.on('time', ...) now
        if (skipIntroButton && boundPlayerJsSkipIntro) skipIntroButton.removeEventListener('click', boundPlayerJsSkipIntro);
        if (skipOutroButton && boundPlayerJsSkipOutro) skipOutroButton.removeEventListener('click', boundPlayerJsSkipOutro);
        // console.log("Skip buttons reset for Player.js.");
    }

    /** Sets up skip intro/outro buttons based on currentEpisodeData for Player.js */
    function setupSkipButtons() {
        console.log("Setting up skip buttons for Player.js...");
        resetSkipButtons(); // Ensure clean state

        if (!playerJsInstance) { console.warn("Player.js instance not ready for skip button setup."); return; }

        const intro = currentEpisodeData.intro;
        const outro = currentEpisodeData.outro;
        // Player.js duration might not be immediately available, get it via API if needed
        let duration = 0;
        try { duration = playerJsInstance.api("duration"); } catch (e) { console.warn("Could not get duration from Player.js yet."); }

        const hasIntro = intro && intro.start < intro.end && intro.end > 0;
        const hasOutro = outro && outro.start > 0 && (duration === 0 || outro.start < duration); // Check start time validity, allow if duration unknown

         console.log("Skip Times (Player.js):", { intro, outro, duration });

        if (!hasIntro && !hasOutro) { console.log("No valid intro/outro times found."); return; }

        // --- Create bound handlers ---
        boundPlayerJsTimeUpdate = (currentTime) => {
            if (!playerJsInstance || !playerJsInstance.api("playing")) return; // Check if playing
            if(duration === 0) { // Try to get duration again if it wasn't ready initially
                 try { duration = playerJsInstance.api("duration"); } catch (e) { /* ignore */ }
            }
            if(duration === 0) return; // Still no duration, can't reliably check outro end

            let introVisible = skipIntroButton.classList.contains('visible');
            let outroVisible = skipOutroButton.classList.contains('visible');

            // Show/Hide Intro Button
            if (hasIntro && currentTime >= intro.start && currentTime < intro.end) {
                if (!introVisible) { skipIntroButton.classList.add('visible'); }
            } else if (introVisible) { skipIntroButton.classList.remove('visible'); }

            // Show/Hide Outro Button
            const outroEndTime = outro.end > outro.start ? outro.end : duration; // Use specific end or full duration
            if (hasOutro && currentTime >= outro.start && currentTime < outroEndTime) {
                if (!outroVisible) { skipOutroButton.classList.add('visible'); }
            } else if (outroVisible) { skipOutroButton.classList.remove('visible'); }
        };

        boundPlayerJsSkipIntro = () => {
            if (playerJsInstance && hasIntro) {
                console.log(`Player.js: Skipping intro - Seeking to ${intro.end}`);
                playerJsInstance.api("seek", intro.end);
                skipIntroButton.classList.remove('visible');
            }
        };

        boundPlayerJsSkipOutro = () => {
            if (playerJsInstance && hasOutro) {
                if(duration === 0) { // Try to get duration one last time
                    try { duration = playerJsInstance.api("duration"); } catch (e) { duration = 0; }
                }
                const seekTime = outro.end > outro.start ? outro.end : (duration > 0 ? duration : outro.start + 10); // Seek to end time or duration or just skip a bit
                console.log(`Player.js: Skipping outro - Seeking to ${seekTime}`);
                playerJsInstance.api("seek", seekTime);
                skipOutroButton.classList.remove('visible');
            }
        };

        // --- Attach listeners ---
        // Time update is handled by player.on('time', ...) attaching boundPlayerJsTimeUpdate
        if (hasIntro) skipIntroButton.addEventListener('click', boundPlayerJsSkipIntro);
        if (hasOutro) skipOutroButton.addEventListener('click', boundPlayerJsSkipOutro);
        console.log("Player.js skip button event listeners attached.");
    }

    // --- Fetch Initial Page Data (Anime Info + Episodes) ---
    try {
        console.log(`Workspaceing anime info for streamingId: ${currentEpisodeData.streamingId}`);
        const animeInfo = await fetchAnimeInfoFromStreamingAPI(currentEpisodeData.streamingId);

        if (!animeInfo) throw new Error("Could not retrieve anime details from streaming service.");
        if (!animeInfo.episodes) animeInfo.episodes = [];

        currentEpisodeData.episodes = animeInfo.episodes;
        currentEpisodeData.animeTitle = animeInfo.title?.english || animeInfo.title?.romaji || animeInfo.title?.native || 'Anime Title';

        const currentEpInfo = animeInfo.episodes.find(ep => ep.id === currentEpisodeData.baseEpisodeId);
        currentEpisodeData.currentEpisodeNumber = currentEpInfo?.number ?? (animeInfo.episodes.length === 1 && (animeInfo.format === 'Movie' || animeInfo.format === 'Special') ? 'Film' : (currentEpInfo?.number || '?'));

        console.log(`Current Episode Info found: Number ${currentEpisodeData.currentEpisodeNumber}`, currentEpInfo);

        // Update UI Titles (same as before)
        document.title = `Watching ${currentEpisodeData.animeTitle} - Ep ${currentEpisodeData.currentEpisodeNumber}`;
        if (episodeTitleArea) { /* ... update title ... */ }
        if (sidebarAnimeTitle) { /* ... update title ... */ }

        // Populate Episode List Sidebar (same as before, but uses createSidebarEpisodeItemHTML which now checks global state for type)
        if (episodeListUL && episodeListContainer) {
             if (currentEpisodeData.episodes.length > 0) {
                 // Regenerate list HTML whenever info loads, ensuring active class is correct
                 episodeListUL.innerHTML = currentEpisodeData.episodes.map(ep =>
                     createSidebarEpisodeItemHTML(ep, currentEpisodeData.streamingId, currentEpisodeData.aniListId, ep.id === currentEpisodeData.baseEpisodeId)
                 ).join('');
                 const activeItem = episodeListUL.querySelector('.episode-list-item.active');
                 if (activeItem) { setTimeout(() => { activeItem.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 100); }
                 else { console.warn("Active episode item not found in the sidebar list."); }
                 episodeListUL.classList.remove('hidden');
                 if (episodeListError) episodeListError.classList.add('hidden');
             } else { displayError("No episodes found for this anime.", true); }
             if (episodeListLoading) episodeListLoading.classList.add('hidden');
        } else { console.error("Episode list UL or Container element not found."); }


        // --- Fetch initial video source ---
        showContent(); // Show layout first
        await loadVideoSource(currentEpisodeData.selectedType); // Load video data and initialize player

    } catch (initError) {
        console.error("Initialization Error (fetching anime info/episodes):", initError);
        displayError(`Error loading page data: ${initError.message}`);
    }

    // --- Event Listeners for Controls (SUB/DUB/Server) ---
    if (subButton) subButton.addEventListener('click', () => { if (!subButton.disabled && currentEpisodeData.selectedType !== 'sub') loadVideoSource('sub'); });
    if (dubButton) dubButton.addEventListener('click', () => { if (!dubButton.disabled && currentEpisodeData.selectedType !== 'dub') loadVideoSource('dub'); });
    if (serverSelect) serverSelect.addEventListener('change', (e) => { currentEpisodeData.selectedServer = e.target.value; loadVideoSource(currentEpisodeData.selectedType); });

    console.log("initEpisodePage (Player.js) setup complete.");
}
// --- End of initEpisodePage (Player.js Version) ---
