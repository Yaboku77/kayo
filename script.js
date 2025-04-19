// --- Constants and Global Variables ---
const ANILIST_API_URL = 'https://graphql.anilist.co';
// Use the Vercel URL provided by the user for Consumet API
const CONSUMET_API_URL = 'https://api-pearl-seven-88.vercel.app'; // Changed base URL

let searchTimeoutId = null;
let featuredSwiper = null; // Swiper instance for index page
let hlsInstance = null;    // HLS.js instance for detail page
let p2pEngine = null;   // P2P Engine instance for detail page
let jwPlayerInstance = null; // JW Player instance for detail page

// --- AniList API Queries ---
// (Keep ANILIST_BROWSE_QUERY, ANILIST_DETAIL_QUERY, ANILIST_SEARCH_QUERY as before)
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
        coverImage { extraLarge large color }
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
function getCurrentSeason() { /* ... (same as before) ... */
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
function sanitizeDescription(desc) { /* ... (same as before) ... */
    if (!desc) return 'No description available.';
    return desc.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
}
function debounce(func, delay) { /* ... (same as before) ... */
    return function(...args) {
        clearTimeout(searchTimeoutId);
        searchTimeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

// --- API Fetching ---
// Generic fetch function
async function fetchApi(url, isJson = true) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
        }
        return isJson ? await response.json() : await response.text();
    } catch (error) {
        console.error("API Fetch Error:", error);
        throw error; // Re-throw to be handled by caller
    }
}

// Specific fetch for AniList GraphQL
async function fetchAnilistApi(query, variables) {
    try {
        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ query: query, variables: variables })
        };
        const response = await fetch(ANILIST_API_URL, options);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
        }
        const result = await response.json();
        if (result.errors) {
            console.error('GraphQL Errors:', result.errors);
            const message = result.errors[0]?.message || 'Unknown GraphQL error';
            throw new Error(`Error fetching data from AniList API: ${message}`);
        }
        return result.data;
    } catch (error) {
        console.error("AniList API Fetch Error:", error);
        throw error;
    }
}


// --- HTML Generation Helpers ---
// ** Links point to anime.html?id=... **
function createFeaturedSlideHTML(anime) { /* ... (same as before, uses anime.html?id=...) ... */
    const title = anime.title.english || anime.title.romaji || anime.title.native || 'Untitled';
    const imageUrl = anime.bannerImage || anime.coverImage.extraLarge || `https://placehold.co/1200x450/${(anime.coverImage.color || '7e22ce').substring(1)}/ffffff?text=Featured`;
    const fallbackImage = `https://placehold.co/1200x450/${(anime.coverImage.color || '7e22ce').substring(1)}/ffffff?text=Featured`;
    const description = sanitizeDescription(anime.description);
    const genres = anime.genres ? anime.genres.slice(0, 3).join(' • ') : 'N/A';
    return `
        <a href="anime.html?id=${anime.id}" class="swiper-slide cursor-pointer block" style="background-image: url('${imageUrl}')" onerror="this.style.backgroundImage='url(\\'${fallbackImage}\\')'">
            <div class="slide-text-content p-6 md:p-8 lg:p-10 w-full md:w-3/4 lg:w-2/3 pointer-events-none">
                <p class="text-xs uppercase tracking-wider text-gray-400 mb-1">${genres}</p>
                <h2 class="text-3xl md:text-4xl lg:text-5xl font-bold text-white mb-2 line-clamp-2">${title}</h2>
                <p class="text-sm text-gray-300 mb-4 line-clamp-2 hidden sm:block">${description}</p>
                <span class="inline-block bg-purple-600 text-white font-bold py-2 px-4 rounded-lg transition duration-300 text-sm shadow-md pointer-events-auto mt-2">
                    More Info
                </span>
            </div>
        </a>
    `;
}
function createAnimeCardHTML(anime) { /* ... (same as before, uses anime.html?id=...) ... */
    const title = anime.title.english || anime.title.romaji || anime.title.native || 'Untitled';
    const imageUrl = anime.coverImage.large || `https://placehold.co/185x265/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=No+Image`;
    const fallbackImage = `https://placehold.co/185x265/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=No+Image`;
    const score = anime.averageScore ? `${anime.averageScore}%` : 'N/A';
    const episodes = anime.episodes ? `${anime.episodes} Ep` : (anime.status === 'RELEASING' ? 'Airing' : 'N/A');
    const genres = anime.genres ? anime.genres.slice(0, 3).join(', ') : 'N/A';
    return `
        <a href="anime.html?id=${anime.id}" class="block bg-gray-800 rounded-lg overflow-hidden shadow-lg cursor-pointer group transition-all duration-300 hover:scale-105 hover:shadow-purple-900/30">
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
                <div class="text-xs text-gray-500 mt-1 truncate">${genres}</div>
            </div>
        </a>`;
}
function createTopAnimeListItemHTML(anime, rank) { /* ... (same as before, uses anime.html?id=...) ... */
    const title = anime.title.english || anime.title.romaji || anime.title.native || 'Untitled';
    const imageUrl = anime.coverImage.large || `https://placehold.co/50x70/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=N/A`;
    const fallbackImage = `https://placehold.co/50x70/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=N/A`;
    const score = anime.averageScore ? `${anime.averageScore}%` : 'N/A';
    return `
        <li>
            <a href="anime.html?id=${anime.id}" class="flex items-center space-x-3 p-2 hover:bg-gray-700 rounded-md transition duration-200 cursor-pointer group">
                <span class="text-lg font-bold text-purple-400 w-6 text-center flex-shrink-0">${rank + 1}</span>
                <img src="${imageUrl}" alt="${title}" class="w-10 h-14 object-cover rounded flex-shrink-0 pointer-events-none" onerror="this.onerror=null;this.src='${fallbackImage}';" loading="lazy"/>
                <div class="flex-1 overflow-hidden pointer-events-none">
                    <h4 class="text-sm font-medium truncate text-white group-hover:text-purple-300 transition-colors" title="${title}">${title}</h4>
                    <p class="text-xs text-gray-400">Score: ${score}</p>
                </div>
            </a>
        </li>`;
}
function createSearchSuggestionHTML(media) { /* ... (same as before, uses anime.html?id=...) ... */
    const title = media.title.english || media.title.romaji || media.title.native || 'Untitled';
    const imageUrl = media.coverImage.medium || `https://placehold.co/40x60/1f2937/4a5568?text=N/A`;
    const fallbackImage = `https://placehold.co/40x60/1f2937/4a5568?text=N/A`;
    const format = media.format ? media.format.replace(/_/g, ' ') : '';
    return `
        <a href="anime.html?id=${media.id}" class="flex items-center p-2 hover:bg-gray-700 cursor-pointer suggestion-item">
            <img src="${imageUrl}" alt="${title}" class="w-10 h-14 object-cover rounded mr-3 flex-shrink-0 pointer-events-none" onerror="this.onerror=null;this.src='${fallbackImage}';" loading="lazy"/>
            <div class="overflow-hidden pointer-events-none">
                <p class="text-sm font-medium text-gray-200 truncate">${title}</p>
                <p class="text-xs text-gray-400">${format}</p>
            </div>
        </a>
    `;
}


// --- Swiper Initialization (for index.html) ---
function initializeFeaturedSwiper(containerSelector = '#featured-swiper') { /* ... (same as before) ... */
     if (typeof Swiper === 'undefined') { console.error("Swiper library not loaded."); return; }
     if (featuredSwiper) { try { featuredSwiper.destroy(true, true); } catch (e) { console.warn("Error destroying previous Swiper instance:", e); } featuredSwiper = null; }
     const swiperContainer = document.querySelector(containerSelector);
     if (!swiperContainer) { console.warn(containerSelector + " container not found for Swiper."); return; }
     const slides = swiperContainer.querySelectorAll('.swiper-slide');
     if (slides.length === 0) { console.warn("No slides found in " + containerSelector + ". Swiper not initialized."); return; }

     try {
         featuredSwiper = new Swiper(containerSelector, {
             modules: [Swiper.Pagination, Swiper.Autoplay, Swiper.EffectFade],
             loop: slides.length > 1,
             autoplay: { delay: 5000, disableOnInteraction: false },
             pagination: { el: containerSelector + ' .swiper-pagination', clickable: true },
             effect: 'fade',
             fadeEffect: { crossFade: true },
             observer: true, observeParents: true,
             keyboard: { enabled: true, onlyInViewport: false },
             a11y: { prevSlideMessage: 'Previous slide', nextSlideMessage: 'Next slide', paginationBulletMessage: 'Go to slide {{index}}' },
         });
     } catch (e) { console.error("Error initializing Swiper:", e); }
}

// --- Search Functionality (Common) ---
function setupSearch(searchInputId = 'search-input', suggestionsContainerId = 'search-suggestions', searchIconButtonId = 'search-icon-button', headerTitleId = 'header-title', mobileMenuButtonId = 'mobile-menu-button') { /* ... (same as before) ... */
    const searchInput = document.getElementById(searchInputId);
    const searchSuggestionsContainer = document.getElementById(suggestionsContainerId);
    const searchIconButton = document.getElementById(searchIconButtonId);
    const headerTitle = document.getElementById(headerTitleId);
    const mobileMenuButton = document.getElementById(mobileMenuButtonId);


    function showSearchSuggestions() { if(searchSuggestionsContainer) searchSuggestionsContainer.classList.remove('hidden'); }
    function hideSearchSuggestions() { if(searchSuggestionsContainer) searchSuggestionsContainer.classList.add('hidden'); }

    async function fetchAndDisplaySuggestions(term) {
         if (!term || term.length < 3) { hideSearchSuggestions(); return; }
         const variables = { search: term, perPage: 6 };
         try {
             // Use fetchAnilistApi for GraphQL search query
             const data = await fetchAnilistApi(ANILIST_SEARCH_QUERY, variables);
             const mediaList = data?.Page?.media || [];
             if (!searchSuggestionsContainer) return;
             if (mediaList.length === 0) {
                 searchSuggestionsContainer.innerHTML = '<p class="text-gray-400 text-sm p-3 text-center">No results found.</p>';
             } else {
                 searchSuggestionsContainer.innerHTML = mediaList.map(media => createSearchSuggestionHTML(media)).join('');
             }
             showSearchSuggestions();
         } catch (error) {
             console.error('Fetch Suggestions Error:', error);
             if(searchSuggestionsContainer) searchSuggestionsContainer.innerHTML = `<p class="text-red-500 text-sm p-3 text-center">Error loading suggestions.</p>`;
             showSearchSuggestions();
         }
    }

    const debouncedFetch = debounce(fetchAndDisplaySuggestions, 350);

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            debouncedFetch(e.target.value.trim());
        });
        searchInput.addEventListener('blur', () => {
            setTimeout(() => {
                if (document.activeElement !== searchInput && !searchSuggestionsContainer?.contains(document.activeElement)) {
                    hideSearchSuggestions();
                    if (window.innerWidth < 1024 && !searchInput.classList.contains('hidden')) {
                       toggleMobileSearch(false);
                    }
                }
            }, 150);
        });
    }

    function toggleMobileSearch(show) {
         if (window.innerWidth >= 1024) return;
         if (show) {
             if(headerTitle) headerTitle.classList.add('hidden');
             if(mobileMenuButton) mobileMenuButton.classList.add('hidden');
             if(searchIconButton) searchIconButton.classList.add('hidden');
             if(searchInput) {
                 searchInput.classList.remove('hidden', 'lg:block');
                 searchInput.classList.add('block','w-full');
                 searchInput.focus();
             }
         } else {
              if(headerTitle) headerTitle.classList.remove('hidden');
              if(mobileMenuButton) mobileMenuButton.classList.remove('hidden');
              if(searchIconButton) searchIconButton.classList.remove('hidden');
              if(searchInput) {
                  searchInput.classList.remove('block','w-full');
                  searchInput.classList.add('hidden', 'lg:block');
                  searchInput.value = '';
              }
              hideSearchSuggestions();
         }
     }

    if(searchIconButton) {
        searchIconButton.addEventListener('click', () => toggleMobileSearch(true));
    }

    document.addEventListener('click', (event) => {
        const isClickInsideSearch = searchInput?.contains(event.target) ||
                                   searchSuggestionsContainer?.contains(event.target) ||
                                   searchIconButton?.contains(event.target);
        if (!isClickInsideSearch) {
            hideSearchSuggestions();
            if (window.innerWidth < 1024 && searchInput && !searchInput.classList.contains('hidden')) {
                 toggleMobileSearch(false);
            }
        }
    });
}


// --- Mobile Menu Functionality (Common) ---
function setupMobileMenu(menuButtonId = 'mobile-menu-button', sidebarContainerId = 'mobile-sidebar-container', sidebarId = 'mobile-sidebar', overlayId = 'sidebar-overlay', closeButtonId = 'close-sidebar-button', navLinkClass = '.mobile-nav-link') { /* ... (same as before) ... */
    const mobileMenuButton = document.getElementById(menuButtonId);
    const mobileSidebarContainer = document.getElementById(sidebarContainerId);
    const mobileSidebar = document.getElementById(sidebarId);
    const sidebarOverlay = document.getElementById(overlayId);
    const closeSidebarButton = document.getElementById(closeButtonId);
    const mobileNavLinks = document.querySelectorAll(navLinkClass);

    function openMobileMenu() {
        if (mobileSidebarContainer && mobileSidebar && sidebarOverlay) {
            mobileSidebarContainer.classList.remove('pointer-events-none');
            sidebarOverlay.classList.remove('hidden');
            mobileSidebar.classList.remove('-translate-x-full');
            document.body.classList.add('modal-open');
        }
    }

    function closeMobileMenu() {
        if (mobileSidebarContainer && mobileSidebar && sidebarOverlay) {
            mobileSidebar.classList.add('-translate-x-full');
            sidebarOverlay.classList.add('hidden');
            mobileSidebarContainer.classList.add('pointer-events-none');
            document.body.classList.remove('modal-open');
        }
    }

    if (mobileMenuButton) mobileMenuButton.addEventListener('click', openMobileMenu);
    if (closeSidebarButton) closeSidebarButton.addEventListener('click', closeMobileMenu);
    if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeMobileMenu);

    mobileNavLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            setTimeout(closeMobileMenu, 50);
        });
    });
}

// --- Footer Year (Common) ---
function setFooterYear(footerYearId = 'footer-year') { /* ... (same as before) ... */
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
    const variables = {
        page: 1, perPageTrending: 7, perPagePopularGrid: 10, perPageTop: 10,
        season: season, seasonYear: year
    };

    try {
        const data = await fetchAnilistApi(ANILIST_BROWSE_QUERY, variables);
        const hasTrending = data.trending?.media?.length > 0;
        const hasPopular = data.popular?.media?.length > 0;
        const hasTop = data.top?.media?.length > 0;

        // Clear skeletons
        if (swiperWrapperFeatured) swiperWrapperFeatured.innerHTML = '';
        if (trendingGrid) trendingGrid.innerHTML = '';
        if (popularGrid) popularGrid.innerHTML = '';
        if (topAnimeListDesktop) topAnimeListDesktop.innerHTML = '';
        if (topAnimeListMobile) topAnimeListMobile.innerHTML = '';
        if (topAnimeListBottomMobile) topAnimeListBottomMobile.innerHTML = '';

        // Populate sections... (using the HTML generation functions)
        if (hasTrending && swiperWrapperFeatured) {
            data.trending.media.slice(0, 5).forEach(anime => { swiperWrapperFeatured.innerHTML += createFeaturedSlideHTML(anime); });
            setTimeout(() => initializeFeaturedSwiper(), 0);
        } else if (swiperWrapperFeatured) { /* Show error/empty state */ }

        if (hasTrending && trendingGrid) {
            data.trending.media.forEach(anime => { trendingGrid.innerHTML += createAnimeCardHTML(anime); });
        } else if (trendingGrid) { /* Show error/empty state */ }

        if (hasPopular && popularGrid) {
            data.popular.media.forEach(anime => { popularGrid.innerHTML += createAnimeCardHTML(anime); });
        } else if (popularGrid) { /* Show error/empty state */ }

        if (hasTop) {
            const topAnimeHTML = data.top.media.map((anime, index) => createTopAnimeListItemHTML(anime, index)).join('');
            if (topAnimeListDesktop) topAnimeListDesktop.innerHTML = topAnimeHTML;
            if (topAnimeListMobile) topAnimeListMobile.innerHTML = topAnimeHTML;
            if (topAnimeListBottomMobile) topAnimeListBottomMobile.innerHTML = topAnimeHTML;
        } else { /* Show error/empty state */ }

    } catch (error) {
        console.error('Fetch Browse Error:', error);
        if(errorMessageDiv) {
            errorMessageDiv.textContent = `Failed to load page data: ${error.message}`;
            errorMessageDiv.classList.remove('hidden');
        }
        // Optionally display errors within sections too
    }
}


/**
 * Initializes the Anime Detail Page (with Streaming)
 */
async function initAnimePage() {
    console.log("Initializing Anime Detail Page");
    setFooterYear();
    setupSearch();
    setupMobileMenu();

    // --- Get DOM Elements ---
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
    const episodeListContainer = document.getElementById('episode-list');
    const episodeListLoading = document.getElementById('episode-list-loading');
    const episodeListError = document.getElementById('episode-list-error');
    const playerErrorMessage = document.getElementById('player-error-message');

    // --- Get Anime ID from URL ---
    const urlParams = new URLSearchParams(window.location.search);
    const animeId = urlParams.get('id'); // This is the AniList ID

    if (!animeId) {
        console.error("Anime ID not found in URL query parameters.");
        if (detailLoadingMessage) detailLoadingMessage.classList.add('hidden');
        if (detailErrorMessage) {
            detailErrorMessage.textContent = "Error: No Anime ID specified in the URL.";
            detailErrorMessage.classList.remove('hidden');
        }
        return;
    }

    // --- Setup Back Button ---
    if (backButton) {
        backButton.addEventListener('click', () => { history.back(); });
    }

    // --- Fetch Anime Details (AniList) & Episode Info (Consumet) ---
    try {
        // Fetch basic details from AniList first
        const anilistData = await fetchAnilistApi(ANILIST_DETAIL_QUERY, { id: parseInt(animeId) });
        const media = anilistData.Media;

        if (!media) {
            throw new Error('Anime details not found on AniList.');
        }

        // --- Populate Detail View (Metadata) ---
        displayAnimeMetadata(media); // Use a helper to display non-episode info

        // --- Fetch Episode Info from Consumet ---
        if (episodeListLoading) episodeListLoading.classList.remove('hidden');
        if (episodeListContainer) episodeListContainer.classList.add('hidden');
        if (episodeListError) episodeListError.classList.add('hidden');

        const consumetInfoUrl = `${CONSUMET_API_URL}/anime/zoro/info?id=${animeId}`; // Use AniList ID with Consumet
        const episodeData = await fetchApi(consumetInfoUrl); // fetchApi handles errors

        if (!episodeData || !episodeData.episodes || episodeData.episodes.length === 0) {
            throw new Error('No episodes found for this anime.');
        }

        // --- Populate Episode List ---
        if (episodeListContainer) {
            episodeListContainer.innerHTML = ''; // Clear previous buttons
            episodeData.episodes.forEach(ep => {
                const button = document.createElement('button');
                button.textContent = `Episode ${ep.number}` + (ep.title ? ` - ${ep.title}` : '');
                button.classList.add('episode-button');
                button.dataset.episodeId = ep.id; // Store episode ID
                button.addEventListener('click', () => {
                    loadEpisode(ep.id); // Load stream on click
                     // Highlight clicked button
                    document.querySelectorAll('.episode-button.playing').forEach(btn => btn.classList.remove('playing'));
                    button.classList.add('playing');
                });
                episodeListContainer.appendChild(button);
            });
            episodeListContainer.classList.remove('hidden');
        }

        if (episodeListLoading) episodeListLoading.classList.add('hidden');

        // --- Hide overall loading message and show content ---
        if (detailLoadingMessage) detailLoadingMessage.classList.add('hidden');
        if (detailContentArea) detailContentArea.classList.remove('hidden');


    } catch (error) {
        console.error('Error fetching details or episodes:', error);
        if (detailLoadingMessage) detailLoadingMessage.classList.add('hidden');
        if (episodeListLoading) episodeListLoading.classList.add('hidden');
        if (detailErrorMessage) {
            detailErrorMessage.textContent = `Failed to load anime data: ${error.message}`;
            detailErrorMessage.classList.remove('hidden');
        }
        if (episodeListError) {
             episodeListError.textContent = `Failed to load episodes: ${error.message}`;
             episodeListError.classList.remove('hidden');
        }
        if (detailContentArea) detailContentArea.classList.add('hidden'); // Keep content hidden on error
    }
}

/**
 * Helper to display non-episode metadata from AniList data
 */
function displayAnimeMetadata(media) {
    const detailContentArea = document.getElementById('detail-content-area');
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

    // Update Page Title
    const pageTitle = media.title.english || media.title.romaji || 'Anime Details';
    document.title = `AniStream - ${pageTitle}`;

    // Populate Banner, Cover Image, Title, Genres, Stats, Desc, Trailer, Chars, Staff, Relations...
    // (This code is the same as the display logic within the previous initAnimePage)
    if(detailBanner) { /* ... */
        detailBanner.style.backgroundImage = `url('${media.bannerImage || media.coverImage.extraLarge || ''}')`;
        detailBanner.classList.remove('animate-pulse', 'bg-gray-700');
    }
    if(detailCoverImage) { /* ... */
        detailCoverImage.src = media.coverImage.large || 'https://placehold.co/160x240/1f2937/4a5568?text=N/A';
        detailCoverImage.alt = `${media.title.english || media.title.romaji} Cover`;
        detailCoverImage.classList.remove('animate-pulse', 'bg-gray-700');
    }
    if(detailTitle) { /* ... */
        detailTitle.textContent = media.title.english || media.title.romaji || media.title.native || 'N/A';
        detailTitle.className = 'text-2xl sm:text-3xl font-bold text-white mb-1 line-clamp-2';
    }
    if(detailGenres) { /* ... */
        detailGenres.textContent = media.genres?.join(' • ') || 'N/A';
        detailGenres.className = 'text-sm text-purple-300 mb-2';
    }
    if(detailStats) { /* ... */
        detailStats.innerHTML = `
            <span class="flex items-center"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-4 h-4 mr-1 text-yellow-400"><path fill-rule="evenodd" d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z" clip-rule="evenodd" /></svg> ${media.averageScore || '--'}%</span>
            <span>Status: ${media.status?.replace(/_/g, ' ') || '--'}</span>
            <span>Episodes: ${media.episodes || '--'}</span>
            <span>Format: ${media.format?.replace(/_/g, ' ') || '--'}</span>
            <span>Season: ${media.season || '--'} ${media.seasonYear || '--'}</span>
        `;
        detailStats.className = 'flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-400 mt-2';
    }
    if(detailDescription) { /* ... */
        detailDescription.textContent = sanitizeDescription(media.description) || 'No description available.';
        detailDescription.className = 'text-sm text-gray-300 leading-relaxed';
    }
    if (media.trailer?.site === 'youtube' && media.trailer?.id) { /* ... */
        if(detailTrailer) {
            const youtubeEmbedUrl = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(media.trailer.id)}`;
            detailTrailer.innerHTML = `<iframe class="w-full h-full aspect-video" src="${youtubeEmbedUrl}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`;
            detailTrailer.classList.remove('animate-pulse', 'bg-gray-700');
        }
        if(detailTrailerSection) detailTrailerSection.classList.remove('hidden');
    } else {
        if(detailTrailer) detailTrailer.innerHTML = '';
        if(detailTrailerSection) detailTrailerSection.classList.add('hidden');
    }
    if (media.characters?.edges?.length > 0 && detailCharacters) { /* ... */
        detailCharacters.innerHTML = media.characters.edges.map(edge => `...`).join(''); // Use previous map logic
         detailCharacters.innerHTML = media.characters.edges.map(edge => `
            <div class="detail-list-item">
                <img src="${edge.node.image?.large || 'https://placehold.co/80x110/1f2937/4a5568?text=N/A'}" alt="${edge.node.name?.full || '?'}" loading="lazy" class="shadow-md"/>
                <p class="line-clamp-2">${edge.node.name?.full || 'Unknown'}</p>
                <p class="text-xs text-gray-500">${edge.role}</p>
            </div>`).join('');
    } else if(detailCharacters) {
        detailCharacters.innerHTML = '<p class="text-sm text-gray-400 italic col-span-full">No character data available.</p>';
    }
    if (media.staff?.edges?.length > 0 && detailStaff) { /* ... */
        detailStaff.innerHTML = media.staff.edges.map(edge => `...`).join(''); // Use previous map logic
        detailStaff.innerHTML = media.staff.edges.map(edge => `
            <div class="detail-list-item">
                <img src="${edge.node.image?.large || 'https://placehold.co/80x110/1f2937/4a5568?text=N/A'}" alt="${edge.node.name?.full || '?'}" loading="lazy" class="shadow-md"/>
                <p class="line-clamp-2">${edge.node.name?.full || 'Unknown'}</p>
                <p class="text-xs text-gray-500">${edge.role}</p>
            </div>`).join('');
    } else if(detailStaff) {
        detailStaff.innerHTML = '<p class="text-sm text-gray-400 italic col-span-full">No staff data available.</p>';
    }
    if (media.relations?.edges?.length > 0 && detailRelations) { /* ... */
         detailRelations.innerHTML = media.relations.edges
             .filter(edge => edge.node.type === 'ANIME')
             .map(edge => { /* ... use previous map logic with anime.html?id=... links ... */
                 const relTitle = edge.node.title.english || edge.node.title.romaji || edge.node.title.native || 'Related Title';
                 const relImage = edge.node.coverImage?.large || `https://placehold.co/100x150/1f2937/4a5568?text=N/A`;
                 const relFallbackImage = `https://placehold.co/100x150/1f2937/4a5568?text=N/A`;
                 return `
                     <a href="anime.html?id=${edge.node.id}" class="block bg-gray-700 rounded overflow-hidden text-center text-xs p-1 cursor-pointer hover:bg-gray-600 transition-colors" title="${edge.relationType.replace(/_/g, ' ')}">
                         <img src="${relImage}" alt="${relTitle}" class="w-full h-24 object-cover mb-1 pointer-events-none" loading="lazy" onerror="this.onerror=null;this.src='${relFallbackImage}';"/>
                         <p class="line-clamp-2 text-gray-300 pointer-events-none">${relTitle}</p>
                         <p class="text-gray-500 pointer-events-none">${edge.relationType.replace(/_/g, ' ')}</p>
                     </a>`;
             }).join('');

         if(detailRelations.innerHTML.trim() !== '') {
              if(detailRelationsSection) detailRelationsSection.classList.remove('hidden');
         } else {
              if(detailRelationsSection) detailRelationsSection.classList.add('hidden');
         }
    } else {
         if(detailRelations) detailRelations.innerHTML = '';
         if(detailRelationsSection) detailRelationsSection.classList.add('hidden');
    }
}


/**
 * Loads a specific episode stream using Consumet and sets up the player.
 * @param {string} episodeId - The episode ID from Consumet.
 */
async function loadEpisode(episodeId) {
    console.log(`Loading episode: ${episodeId}`);
    const playerErrorMessage = document.getElementById('player-error-message');
    if (playerErrorMessage) playerErrorMessage.classList.add('hidden'); // Hide previous errors

    try {
        const watchUrl = `${CONSUMET_API_URL}/anime/zoro/watch?episodeId=${encodeURIComponent(episodeId)}`;
        const streamData = await fetchApi(watchUrl);

        if (!streamData || !streamData.sources || streamData.sources.length === 0) {
            throw new Error('No streaming sources found for this episode.');
        }

        // Find the HLS source (usually .m3u8)
        // Look for 'default' quality or the first HLS source
        let hlsSource = streamData.sources.find(s => s.quality === 'default' && s.url.includes('.m3u8'));
        if (!hlsSource) {
            hlsSource = streamData.sources.find(s => s.url.includes('.m3u8'));
        }

        if (!hlsSource || !hlsSource.url) {
            throw new Error('Could not find a valid HLS (m3u8) source.');
        }

        console.log("Found HLS source:", hlsSource.url);
        setupPlayer(hlsSource.url);

    } catch (error) {
        console.error("Error loading episode stream:", error);
        if (playerErrorMessage) {
            playerErrorMessage.textContent = `Error loading stream: ${error.message}`;
            playerErrorMessage.classList.remove('hidden');
        }
        // Optionally destroy existing player instances if error occurs
        destroyPlayer();
    }
}

/**
 * Destroys existing player instances (HLS, P2P Engine, JW Player)
 */
function destroyPlayer() {
     if (jwPlayerInstance) {
        try {
            jwPlayerInstance.remove(); // Use JW Player's remove method
        } catch (e) { console.warn("Error removing JW Player instance:", e); }
        jwPlayerInstance = null;
    }
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
     if (p2pEngine) {
        p2pEngine.destroy();
        p2pEngine = null;
    }
    // Clear player div content as fallback
    const playerDiv = document.getElementById('player');
    if (playerDiv) playerDiv.innerHTML = 'Player stopped.';
}


/**
 * Sets up the HLS P2P player with JW Player integration.
 * @param {string} m3u8Url - The URL of the HLS stream.
 */
function setupPlayer(m3u8Url) {
    // Destroy previous instances if they exist
    destroyPlayer();

    const playerDivId = 'player'; // ID of the div for JW Player

    // --- Check if libraries are loaded ---
    if (typeof jwplayer === 'undefined') {
        console.error('JW Player library is not loaded. Check script tag and license key.');
         document.getElementById(playerDivId).innerHTML = '<p class="text-red-500 p-4">Error: JW Player library not found.</p>';
        return;
    }
     if (typeof Hls === 'undefined') {
        console.error('hls.js library is not loaded.');
        document.getElementById(playerDivId).innerHTML = '<p class="text-red-500 p-4">Error: hls.js library not found.</p>';
        return;
    }
    if (typeof P2PEngine === 'undefined') {
        console.error('hlsjs-p2p-engine library is not loaded.');
         // Continue without P2P if engine is missing? Or show error? Let's show error.
         document.getElementById(playerDivId).innerHTML = '<p class="text-red-500 p-4">Error: P2P engine library not found.</p>';
        return;
    }

    try {
        // --- P2P Engine Config ---
        p2pEngine = new P2PEngine.Engine(); // Use default config or customize

        // --- HLS.js Config ---
        const hlsConfig = {
            // Enable P2P loader
            loader: p2pEngine.createLoaderClass(),
            // Other hls.js config options if needed
            // liveSyncDurationCount: 7, // Example option
            // enableWorker: true,      // Example option
        };

        hlsInstance = new Hls(hlsConfig);

        // --- JW Player Setup ---
        jwPlayerInstance = jwplayer(playerDivId).setup({
            // file: m3u8Url, // JW Player might try to load directly, we'll use hls.js
            // width: "100%", // Handled by CSS aspect-ratio
            // aspectratio: "16:9", // Handled by CSS aspect-ratio
            autostart: true, // Start playing automatically
            // Add other JW Player config options here if needed
            // controls: true,
            // primary: 'html5', // Usually default
        });

        // --- Integrate hls.js with JW Player ---
        // Listen for the JW Player 'ready' event to get the video element
        jwPlayerInstance.on('ready', function() {
            const videoElement = document.querySelector(`#${playerDivId} video`); // Get the video element inside JW Player
            if (videoElement) {
                console.log("Attaching hls.js to video element");
                hlsInstance.attachMedia(videoElement);
            } else {
                console.error("Could not find video element within JW Player.");
                 document.getElementById(playerDivId).innerHTML = '<p class="text-red-500 p-4">Error: Could not initialize player video element.</p>';
            }
        });

         // Load the source into HLS.js AFTER JW Player setup might have started
         // Listen for HLS manifest parsed event before trying to attach? No, attach first.
         hlsInstance.loadSource(m3u8Url);

         // Optional: Listen for HLS errors
         hlsInstance.on(Hls.Events.ERROR, function (event, data) {
             console.error('HLS.js Error:', data);
             const playerErrorMessage = document.getElementById('player-error-message');
             if (playerErrorMessage && data.fatal) {
                  playerErrorMessage.textContent = `Playback Error: ${data.type} - ${data.details}`;
                  playerErrorMessage.classList.remove('hidden');
             }
             // Handle specific errors if needed
             // switch (data.type) {
             //     case Hls.ErrorTypes.NETWORK_ERROR:
             //         // try to recover network error
             //         console.log("fatal network error encountered, try to recover");
             //         hlsInstance.startLoad();
             //         break;
             //     case Hls.ErrorTypes.MEDIA_ERROR:
             //         console.log("fatal media error encountered, try to recover");
             //         hlsInstance.recoverMediaError();
             //         break;
             //     default:
             //         // cannot recover
             //         destroyPlayer(); // Destroy on fatal error?
             //         break;
             // }
         });

         console.log("Player setup initiated.");

    } catch (error) {
        console.error("Error setting up player:", error);
        const playerErrorMessage = document.getElementById('player-error-message');
        if (playerErrorMessage) {
            playerErrorMessage.textContent = `Player setup failed: ${error.message}`;
            playerErrorMessage.classList.remove('hidden');
        }
        destroyPlayer(); // Clean up on setup error
    }
}
