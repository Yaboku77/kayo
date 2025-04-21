// --- Constants and Global Variables ---
const ANILIST_API_URL = 'https://graphql.anilist.co';
const STREAMING_API_BASE_URL = 'https://api-pearl-seven-88.vercel.app'; // User-provided API

let searchTimeoutId = null;
let featuredSwiper = null;
let plyrPlayer = null;
let hlsInstance = null;
let currentEpisodeData = { // Structure to hold episode page state
    streamingId: null,
    episodeId: null,
    aniListId: null,
    episodes: [],
    currentSourceData: null, // Holds full API response for current episode { headers, sources, subtitles, intro, outro, ... }
    selectedServer: 'vidcloud',
    selectedType: 'sub', // 'sub' or 'dub'
    animeTitle: 'Loading...',
    currentEpisodeNumber: '?',
    intro: null, // { start, end }
    outro: null, // { start, end }
    subtitles: [] // Formatted for Plyr
};
let skipIntroTimeout = null;
let skipOutroTimeout = null;

// --- AniList API Queries ---
// (ANILIST_BROWSE_QUERY, ANILIST_DETAIL_QUERY, ANILIST_SEARCH_QUERY remain the same)
const ANILIST_BROWSE_QUERY = `/* ... Query ... */`;
const ANILIST_DETAIL_QUERY = `/* ... Query ... */`;
const ANILIST_SEARCH_QUERY = `/* ... Query ... */`;


// --- Utility Functions ---
// (getCurrentSeason, sanitizeDescription, debounce, getUrlParams, mapAniListFormatToStreamingFormat remain the same)
function getCurrentSeason() { /* ... */ }
function sanitizeDescription(desc) { /* ... */ }
function debounce(func, delay) { /* ... */ }
function getUrlParams() { /* ... */ }
function mapAniListFormatToStreamingFormat(aniListFormat) { /* ... */ }


// --- API Fetching ---
// (fetchAniListApi, fetchStreamingApi remain the same)
async function fetchAniListApi(query, variables) { /* ... */ }
async function fetchStreamingApi(endpoint, errorMessage = 'Error fetching streaming data') { /* ... */ }

// --- Specific Streaming API Functions ---
// (fetchAnimeInfoFromStreamingAPI remains the same)
async function fetchAnimeInfoFromStreamingAPI(streamingId) { /* ... */ }

/** Fetches streaming links, subtitles, intro/outro times for a specific episode. */
async function fetchEpisodeWatchData(episodeId, server = 'vidcloud') {
    if (!episodeId) return null;
    try {
        const data = await fetchStreamingApi(`/anime/zoro/watch?episodeId=${encodeURIComponent(episodeId)}&server=${server}`, `Error fetching watch data for episode "${episodeId}"`);

        // *** DEBUGGING: Log the raw API response ***
        console.log("--- Raw Watch Data Response ---");
        console.log(JSON.stringify(data, null, 2));
        console.log("-------------------------------");

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
// (createFeaturedSlideHTML, createAnimeCardHTML, createTopAnimeListItemHTML, createSearchSuggestionHTML, createDetailEpisodeLinkHTML, createSidebarEpisodeItemHTML remain the same)
function createFeaturedSlideHTML(anime) { /* ... */ }
function createAnimeCardHTML(anime) { /* ... */ }
function createTopAnimeListItemHTML(anime, rank) { /* ... */ }
function createSearchSuggestionHTML(media) { /* ... */ }
function createDetailEpisodeLinkHTML(episode, streamingId, aniListId) { /* ... */ }
function createSidebarEpisodeItemHTML(episode, streamingId, aniListId, isActive = false) { /* ... */ }

/** Formats subtitles from the API response into the structure Plyr expects. */
function formatSubtitlesForPlyr(apiSubtitles) {
    if (!apiSubtitles || apiSubtitles.length === 0) return [];
    console.log("Formatting subtitles:", apiSubtitles); // Debug subtitles
    const langCodeMap = { 'english': 'en', 'spanish': 'es', 'portuguese': 'pt', 'french': 'fr', 'german': 'de', 'italian': 'it', 'russian': 'ru' /* Add more */ };
    const formatted = apiSubtitles.map((sub, index) => {
        const langLower = sub.lang?.toLowerCase() || 'unknown';
        let srclang = langCodeMap[langLower] || langLower.substring(0, 2);
        const isDefault = langLower.includes('english');
        return { kind: 'captions', label: sub.lang || `Subtitle ${index + 1}`, srclang: srclang, src: sub.url, default: isDefault };
    }).filter(track => track.src);
    console.log("Formatted Plyr tracks:", formatted); // Debug formatted tracks
    return formatted;
}


// --- Swiper Initialization ---
function initializeFeaturedSwiper(containerSelector = '#featured-swiper') { /* ... */ }

// --- Search Functionality ---
function setupSearch(searchInputId = 'search-input', /*...*/) { /* ... */ }

// --- Mobile Menu Functionality ---
function setupMobileMenu(menuButtonId = 'mobile-menu-button', /*...*/) { /* ... */ }

// --- Footer Year ---
function setFooterYear(footerYearId = 'footer-year') { /* ... */ }


// --- Page Specific Initialization ---

/** Initializes the Index (Browse) Page */
async function initIndexPage() { /* ... (same as previous version) ... */ }


/** Initializes the Anime Detail Page - WITH IMPROVED EPISODE MATCHING */
async function initAnimePage() { /* ... (same as previous version with improved matching) ... */ }


/** Initializes the Episode Player Page - ENHANCED + DEBUGGING */
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
            currentEpisodeData.currentSourceData = watchData; // Store full response

            if (!watchData) throw new Error(`Failed to fetch watch data.`);
            // Check sources specifically
            if (!watchData.sources || watchData.sources.length === 0) {
                 if (watchData.download) { /* ... handle download link fallback ... */ return; }
                 throw new Error(`No sources found on server ${currentEpisodeData.selectedServer}.`);
            }

            currentEpisodeData.intro = watchData.intro || { start: 0, end: 0 };
            currentEpisodeData.outro = watchData.outro || { start: 0, end: 0 };
            currentEpisodeData.subtitles = formatSubtitlesForPlyr(watchData.subtitles);

            let sourceUrl = null, isHls = false;

            // --- Refined DUB/SUB Source Identification ---
            console.log("Identifying sources for type:", type);
            const isDub = (s) => (s.quality?.toLowerCase().includes('dub') || s.url?.toLowerCase().includes('dub'));

            // Filter sources based on the desired type (SUB or DUB)
            const targetSources = watchData.sources.filter(s => {
                const detectedDub = isDub(s);
                return type === 'dub' ? detectedDub : !detectedDub; // If type is 'dub', find dub; otherwise find non-dub
            });
            console.log(`Found ${targetSources.length} potential sources for type "${type}"`);

            // If no specific sources found for the type, fall back to ALL available sources
            // This handles cases where API might not label DUB correctly, or only one type exists
            const sourcesToUse = targetSources.length > 0 ? targetSources : watchData.sources;
            if (sourcesToUse.length === 0) { // Check if even fallback is empty
                 throw new Error(`No suitable video sources found at all for this episode.`);
            }
            console.log("Sources being considered:", sourcesToUse);

            // Prioritize HLS within the chosen sources
            const hlsSource = sourcesToUse.find(s => s.isM3U8 || s.url?.includes('.m3u8'));
            if (hlsSource) {
                sourceUrl = hlsSource.url;
                isHls = true;
                console.log("Selected HLS source:", hlsSource);
            } else {
                // Fallback logic (auto, default, first) within chosen sources
                const autoSource = sourcesToUse.find(s => s.quality?.toLowerCase() === 'auto' || s.quality?.toLowerCase() === 'default');
                sourceUrl = autoSource ? autoSource.url : sourcesToUse[0]?.url; // Fallback to first if no auto/default
                isHls = sourceUrl?.includes('.m3u8') || false;
                console.log("Selected non-HLS source (or fallback):", sourceUrl);
            }
            // --- End Refined Identification ---

            if (!sourceUrl) throw new Error(`Could not find a suitable ${type.toUpperCase()} video URL.`);

            updateStreamTypeButtons(); // Update SUB/DUB button states

            if (!plyrPlayer) initializePlyrPlayer(videoElement, sourceUrl, isHls, type, currentEpisodeData.subtitles);
            else updatePlyrSource(sourceUrl, isHls, type, currentEpisodeData.subtitles);

            // setupSkipButtons is called from player 'ready' event

            if(playerOverlay) playerOverlay.classList.add('hidden');

        } catch (error) { /* ... error handling ... */
             console.error("Error loading video source:", error);
             if(playerOverlay && playerOverlayMessage) { playerOverlayMessage.textContent = `Error: ${error.message}`; playerOverlay.classList.remove('hidden'); }
             if (errorMessage) { errorMessage.textContent = `Failed to load video: ${error.message}`; errorMessage.classList.remove('hidden'); }
             updateStreamTypeButtons(true); // Disable buttons on error
        }
    }

    /** Initializes Plyr player */
    function initializePlyrPlayer(videoEl, sourceUrl, isHls, type, tracks = []) {
        console.log("Attempting to initialize Plyr Player...");
        if (plyrPlayer) { try { plyrPlayer.destroy(); console.log("Destroyed previous Plyr instance."); } catch(e){ console.warn("Error destroying previous Plyr:", e); } plyrPlayer = null; }
        if (hlsInstance) { try { hlsInstance.destroy(); console.log("Destroyed previous HLS instance."); } catch(e){ console.warn("Error destroying previous HLS:", e); } hlsInstance = null; }

        // *** DEBUGGING: Check Plyr Options ***
        const plyrOptions = {
            debug: true, // Enable Plyr debugging output
            title: `${currentEpisodeData.animeTitle} - Ep ${currentEpisodeData.currentEpisodeNumber} (${type.toUpperCase()})`,
            controls: [ 'play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen' ],
            settings: ['captions', 'quality', 'speed', 'loop'], // *** CRITICAL: Ensure 'settings', 'quality', 'captions' are here ***
            captions: { active: true, language: 'en', update: true },
            tooltips: { controls: true, seek: true },
            keyboard: { focused: true, global: true },
            tracks: tracks // Pass formatted subtitles
        };
        console.log("Plyr Options:", plyrOptions);

        try {
            if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
                console.log("Initializing Plyr with HLS.js support...");
                hlsInstance = new Hls({ capLevelToPlayerSize: true, /* Other HLS options */ });
                console.log("HLS instance created.");
                hlsInstance.on(Hls.Events.MEDIA_ATTACHED, () => { console.log("HLS attached to video element."); });
                hlsInstance.on(Hls.Events.MANIFEST_PARSED, (event, data) => { console.log(`HLS Manifest Parsed: ${data.levels.length} levels found.`); });
                hlsInstance.loadSource(sourceUrl);
                hlsInstance.attachMedia(videoEl);
                window.hls = hlsInstance; // For debugging
                hlsInstance.on(Hls.Events.ERROR, (event, data) => { console.error('HLS Error:', data); /* ... HLS error handling ... */ });
                plyrPlayer = new Plyr(videoEl, plyrOptions);
                console.log("Plyr initialized with HLS.");
            } else {
                console.log("Initializing Plyr with native source...");
                videoEl.src = sourceUrl; // Set src directly for non-HLS
                plyrPlayer = new Plyr(videoEl, plyrOptions);
                console.log("Plyr initialized with native source.");
            }
            window.player = plyrPlayer; // For debugging

            plyrPlayer.on('ready', () => { console.log("Plyr player ready event fired."); setupSkipButtons(); });
            plyrPlayer.on('error', (event) => { console.error("Plyr Player Error Event:", event); /* ... handle player errors ... */ });
            // *** DEBUGGING: Listen for settings menu events (if they exist) ***
            // Note: Plyr doesn't have explicit 'settingsopened' events in v3 docs.
            // We rely on checking if the config was correct and if CSS is hiding it.
            console.log("Plyr event listeners attached.");

        } catch (initError) {
             console.error("!!! CRITICAL ERROR INITIALIZING PLYR !!!", initError);
              if(playerOverlay && playerOverlayMessage) {
                 playerOverlayMessage.textContent = `Player Initialization Failed: ${initError.message}`;
                 playerOverlay.classList.remove('hidden');
             }
             if (errorMessage) {
                 errorMessage.textContent = `Failed to initialize video player: ${initError.message}`;
                 errorMessage.classList.remove('hidden');
             }
        }
    }

    /** Updates source and tracks of existing Plyr player */
    function updatePlyrSource(sourceUrl, isHls, type, tracks = []) {
        if (!plyrPlayer) { console.warn("Player not ready, initializing instead of updating."); initializePlyrPlayer(videoElement, sourceUrl, isHls, type, tracks); return; }
        console.log(`Updating Plyr source: ${sourceUrl} (HLS: ${isHls})`);
        const newSource = { type: 'video', title: `${currentEpisodeData.animeTitle} - Ep ${currentEpisodeData.currentEpisodeNumber} (${type.toUpperCase()})`, sources: [{ src: sourceUrl, type: isHls ? 'application/x-mpegURL' : 'video/mp4' }], tracks: tracks };
        try {
            if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
                if (!hlsInstance) { // Safety check if HLS instance was lost
                    console.warn("HLS instance missing during update, re-initializing HLS.");
                    hlsInstance = new Hls({ capLevelToPlayerSize: true });
                    hlsInstance.attachMedia(videoElement);
                    window.hls = hlsInstance;
                    hlsInstance.on(Hls.Events.ERROR, (event, data) => { console.error('HLS Error:', data); /* ... */ });
                }
                console.log("Updating HLS source...");
                hlsInstance.loadSource(sourceUrl);
                plyrPlayer.source = newSource; // Update Plyr's source info
                console.log("Plyr source updated for HLS.");
            } else {
                console.log("Updating native source...");
                plyrPlayer.source = newSource;
                console.log("Plyr source updated for native.");
            }
        } catch (updateError) {
             console.error("Error updating Plyr source:", updateError);
              if(playerOverlay && playerOverlayMessage) {
                 playerOverlayMessage.textContent = `Error switching source: ${updateError.message}`;
                 playerOverlay.classList.remove('hidden');
             }
        }
    }

    /** Updates SUB/DUB button states */
    function updateStreamTypeButtons(isError = false) {
        let subAvailable = false, dubAvailable = false;
        if (!isError && currentEpisodeData?.currentSourceData?.sources?.length > 0) {
            const sources = currentEpisodeData.currentSourceData.sources;
            const isDub = (s) => (s.quality?.toLowerCase().includes('dub') || s.url?.toLowerCase().includes('dub'));
            dubAvailable = sources.some(isDub);
            subAvailable = sources.some(s => !isDub(s));
            console.log(`Source Availability Check: SUB=${subAvailable}, DUB=${dubAvailable}`);
        } else {
             console.log("Updating buttons state (Error or No Sources)");
        }
        // Update button classes...
        if(subButton) { subButton.disabled = !subAvailable; subButton.classList.toggle('bg-purple-600', currentEpisodeData.selectedType === 'sub' && subAvailable); subButton.classList.toggle('text-white', currentEpisodeData.selectedType === 'sub' && subAvailable); subButton.classList.toggle('bg-gray-700', currentEpisodeData.selectedType !== 'sub' || !subAvailable); subButton.classList.toggle('text-gray-200', currentEpisodeData.selectedType !== 'sub' || !subAvailable); subButton.classList.toggle('opacity-50', !subAvailable); subButton.classList.toggle('cursor-not-allowed', !subAvailable); }
        if(dubButton) { dubButton.disabled = !dubAvailable; dubButton.classList.toggle('bg-purple-600', currentEpisodeData.selectedType === 'dub' && dubAvailable); dubButton.classList.toggle('text-white', currentEpisodeData.selectedType === 'dub' && dubAvailable); dubButton.classList.toggle('bg-gray-700', currentEpisodeData.selectedType !== 'dub' || !dubAvailable); dubButton.classList.toggle('text-gray-200', currentEpisodeData.selectedType !== 'dub' || !dubAvailable); dubButton.classList.toggle('opacity-50', !dubAvailable); dubButton.classList.toggle('cursor-not-allowed', !dubAvailable); }
    }

    /** Sets up skip intro/outro buttons */
    function setupSkipButtons() {
        console.log("Setting up skip buttons...");
        if (!plyrPlayer || !skipIntroButton || !skipOutroButton) { console.warn("Skip buttons or player not ready."); return; }
        const intro = currentEpisodeData.intro;
        const outro = currentEpisodeData.outro;
        let introVisible = false, outroVisible = false;

        plyrPlayer.off('timeupdate', handleTimeUpdate); // Remove previous listener first
        clearTimeout(skipIntroTimeout); clearTimeout(skipOutroTimeout);
        skipIntroButton.removeEventListener('click', handleSkipIntro);
        skipOutroButton.removeEventListener('click', handleSkipOutro);
        skipIntroButton.classList.remove('visible'); skipOutroButton.classList.remove('visible');

        function handleTimeUpdate() { /* ... (logic to show/hide buttons) ... */ }
        function handleSkipIntro() { /* ... (logic to seek player) ... */ }
        function handleSkipOutro() { /* ... (logic to seek player) ... */ }

        if ((intro && intro.end > 0) || (outro && outro.start > 0)) {
             console.log("Attaching timeupdate listener for skip buttons.");
             plyrPlayer.on('timeupdate', handleTimeUpdate);
        } else {
             console.log("No valid intro/outro times, skip buttons disabled.");
        }
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
        const currentEp = animeInfo.episodes.find(ep => ep.id === currentEpisodeData.episodeId);
        currentEpisodeData.currentEpisodeNumber = currentEp?.number || (animeInfo.episodes.length === 1 ? 'Movie/Special' : '?');

        document.title = `Watching ${currentEpisodeData.animeTitle} - Ep ${currentEpisodeData.currentEpisodeNumber}`;
        if(episodeTitleArea) episodeTitleArea.textContent = `${currentEpisodeData.animeTitle} - Episode ${currentEpisodeData.currentEpisodeNumber}`;
        if (sidebarAnimeTitle) sidebarAnimeTitle.textContent = currentEpisodeData.animeTitle;

        // Populate Episode List Sidebar
        if (episodeListUL && episodeListContainer) { /* ... (same as before) ... */ }

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

// IMPORTANT: Ensure the corresponding init function is called in HTML.
