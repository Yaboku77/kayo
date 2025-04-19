// --- Constants and Global Variables ---
const ANILIST_API_URL = 'https://graphql.anilist.co';
let searchTimeoutId = null;
let featuredSwiper = null; // Keep Swiper instance reference if used on index

// --- AniList API Queries ---
// Browse Query (for index.html)
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

// Detail Query (for anime.html)
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

// Search Query (used by both pages)
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
    return desc.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '');
}

function debounce(func, delay) {
    return function(...args) {
        clearTimeout(searchTimeoutId);
        searchTimeoutId = setTimeout(() => {
            func.apply(this, args);
        }, delay);
    };
}

// --- API Fetching ---
async function fetchApi(query, variables) {
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
        console.error("API Fetch Error:", error);
        // Re-throw the error so the calling function can handle UI updates
        throw error;
    }
}

// --- HTML Generation Helpers ---
// ** IMPORTANT: Links now point to anime.html?id=... **

function createFeaturedSlideHTML(anime) {
    const title = anime.title.english || anime.title.romaji || anime.title.native || 'Untitled';
    const imageUrl = anime.bannerImage || anime.coverImage.extraLarge || `https://placehold.co/1200x450/${(anime.coverImage.color || '7e22ce').substring(1)}/ffffff?text=Featured`;
    const fallbackImage = `https://placehold.co/1200x450/${(anime.coverImage.color || '7e22ce').substring(1)}/ffffff?text=Featured`;
    const description = sanitizeDescription(anime.description);
    const genres = anime.genres ? anime.genres.slice(0, 3).join(' • ') : 'N/A';
    // Link directly to anime.html with query parameter
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

function createAnimeCardHTML(anime) {
    const title = anime.title.english || anime.title.romaji || anime.title.native || 'Untitled';
    const imageUrl = anime.coverImage.large || `https://placehold.co/185x265/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=No+Image`;
    const fallbackImage = `https://placehold.co/185x265/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=No+Image`;
    const score = anime.averageScore ? `${anime.averageScore}%` : 'N/A';
    const episodes = anime.episodes ? `${anime.episodes} Ep` : (anime.status === 'RELEASING' ? 'Airing' : 'N/A');
    const genres = anime.genres ? anime.genres.slice(0, 3).join(', ') : 'N/A';
    // Link directly to anime.html with query parameter
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

function createTopAnimeListItemHTML(anime, rank) {
    const title = anime.title.english || anime.title.romaji || anime.title.native || 'Untitled';
    const imageUrl = anime.coverImage.large || `https://placehold.co/50x70/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=N/A`;
    const fallbackImage = `https://placehold.co/50x70/${(anime.coverImage.color || '1a202c').substring(1)}/e2e8f0?text=N/A`;
    const score = anime.averageScore ? `${anime.averageScore}%` : 'N/A';
    // Link directly to anime.html with query parameter
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

function createSearchSuggestionHTML(media) {
    const title = media.title.english || media.title.romaji || media.title.native || 'Untitled';
    const imageUrl = media.coverImage.medium || `https://placehold.co/40x60/1f2937/4a5568?text=N/A`;
    const fallbackImage = `https://placehold.co/40x60/1f2937/4a5568?text=N/A`;
    const format = media.format ? media.format.replace(/_/g, ' ') : '';
    // Link directly to anime.html with query parameter
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
function initializeFeaturedSwiper(containerSelector = '#featured-swiper') {
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
function setupSearch(searchInputId = 'search-input', suggestionsContainerId = 'search-suggestions', searchIconButtonId = 'search-icon-button', headerTitleId = 'header-title', mobileMenuButtonId = 'mobile-menu-button') {
    const searchInput = document.getElementById(searchInputId);
    const searchSuggestionsContainer = document.getElementById(suggestionsContainerId);
    const searchIconButton = document.getElementById(searchIconButtonId); // Mobile only button
    const headerTitle = document.getElementById(headerTitleId); // Mobile only interaction
    const mobileMenuButton = document.getElementById(mobileMenuButtonId); // Mobile only interaction


    function showSearchSuggestions() { if(searchSuggestionsContainer) searchSuggestionsContainer.classList.remove('hidden'); }
    function hideSearchSuggestions() { if(searchSuggestionsContainer) searchSuggestionsContainer.classList.add('hidden'); }

    async function fetchAndDisplaySuggestions(term) {
         if (!term || term.length < 3) { hideSearchSuggestions(); return; }
         const variables = { search: term, perPage: 6 };
         try {
             const data = await fetchApi(ANILIST_SEARCH_QUERY, variables);
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

        // Hide suggestions on blur, with a delay to allow clicking on a suggestion
        searchInput.addEventListener('blur', () => {
            setTimeout(() => {
                // Check if the focus is now outside the input AND the suggestions container
                if (document.activeElement !== searchInput && !searchSuggestionsContainer?.contains(document.activeElement)) {
                    hideSearchSuggestions();
                    // Also hide mobile search bar if needed
                    if (window.innerWidth < 1024 && !searchInput.classList.contains('hidden')) {
                       toggleMobileSearch(false); // Assuming toggleMobileSearch is available globally or passed in
                    }
                }
            }, 150); // Delay to allow click event on suggestions
        });
    }

    // Mobile search toggle logic (needs access to header elements)
    function toggleMobileSearch(show) {
         if (window.innerWidth >= 1024) return; // Only on small screens
         if (show) {
             if(headerTitle) headerTitle.classList.add('hidden');
             if(mobileMenuButton) mobileMenuButton.classList.add('hidden');
             if(searchIconButton) searchIconButton.classList.add('hidden');
             if(searchInput) {
                 searchInput.classList.remove('hidden', 'lg:block'); // Ensure it's not hidden and remove lg:block
                 searchInput.classList.add('block','w-full'); // Make it block and full width
                 searchInput.focus();
             }
         } else {
              if(headerTitle) headerTitle.classList.remove('hidden');
              if(mobileMenuButton) mobileMenuButton.classList.remove('hidden');
              if(searchIconButton) searchIconButton.classList.remove('hidden');
              if(searchInput) {
                  searchInput.classList.remove('block','w-full'); // Remove block/width styles
                  searchInput.classList.add('hidden', 'lg:block'); // Add back hidden and lg:block
                  searchInput.value = '';
              }
              hideSearchSuggestions();
         }
     }

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
                 toggleMobileSearch(false);
            }
        }
    });

     // Expose toggleMobileSearch if needed by other parts (like mobile menu closing)
     // window.toggleMobileSearch = toggleMobileSearch;
}


// --- Mobile Menu Functionality (Common) ---
function setupMobileMenu(menuButtonId = 'mobile-menu-button', sidebarContainerId = 'mobile-sidebar-container', sidebarId = 'mobile-sidebar', overlayId = 'sidebar-overlay', closeButtonId = 'close-sidebar-button', navLinkClass = '.mobile-nav-link') {
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
            // Allow default navigation for actual links (like index.html)
            // Allow default behavior for anchor links (#...)
            // Just close the menu
            // Use setTimeout to ensure navigation isn't interrupted on slower devices
            setTimeout(closeMobileMenu, 50);
        });
    })
