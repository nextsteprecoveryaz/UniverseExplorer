# Universe Explorer

A local Windows astronomy app, built around visual exploration of released observations. Open **Launch.cmd**, or visit **http://127.0.0.1:8765** while the app is running. Use **Stop.cmd** to stop this app's own background process. It listens only on 127.0.0.1.

## Install on your Windows PC

1. Install **64-bit Python 3.11** from [python.org](https://www.python.org/downloads/windows/), including its Python launcher. A modern browser with WebGL is needed for the sky map.
2. Download this repository using **Code → Download ZIP** and extract it, or clone it with Git. Open the extracted project folder.
3. Run **Setup.cmd**. It creates an isolated `.venv`, installs pinned Python dependencies, downloads the small local enhancement model, and installs the official Aladin Lite and Aladin Desktop distributions plus portable Java. The first setup needs internet access and may take several minutes.
4. Open **Launch.cmd**, then choose **Update images** to build your own Hubble, Webb and NASA gallery indexes. You can explore the all-sky map while the indexes populate. The initial archive update can take some time.
5. Use **Stop.cmd** when finished. Optionally run **Create-DesktopShortcut.ps1** to add a launcher to your desktop.

For Python in a custom location, run `Setup.cmd -Python "C:\path\to\python.exe"`. To install the browser workbench first and add the full desktop Aladin package later, use `Setup.cmd -SkipDesktop`; rerun without that option when ready. Running `powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-UniverseExplorer.ps1 -CheckOnly` checks Python without installing anything.

**No API key or GPU is needed for basic exploration or local enhancement.** Optional cloud enhancement requires your own OpenAI API access and incurs the provider's charges. Each installation has its own notebooks, routes, downloaded images, caches and credentials; those personal files are excluded from Git.

This repository distributes the application for people to run on their own PCs. It is not a hosted, multi-user website. To update an installation, stop the app, update the source files, rerun Setup.cmd, then launch again. Preserve and back up your `data/` folder. See [third-party notices](THIRD_PARTY.md) for downloaded components and image credits.

## Telescope Live map

Open **Telescope Live map** in the sidebar to browse the same continuous sky surveys used by [Space Telescope Live](https://spacetelescopelive.org/user-guide): **2MASS near-infrared color** for Webb and **DSS2 visible color** for Hubble. Both apps use Aladin Lite; this app bundles version 3.8.2 locally. These are ground-based survey images around telescope pointings, not freshly captured Hubble or Webb exposures.

Choose **Latest observation** or step through **Previous/Next observation**. Expand **Find an observation** to select a **Schedule date & time (UTC)** or paste an official Webb or Hubble observation link. Date lookup follows the official schedule; reported execution times may differ. Observation and feed-retrieval times are shown in UTC. The target marker, program, times and source link come from the official feed. Its latest record is not always an observation confirmed to be executing at this instant.

Drag and zoom across the sky, use **Center target** to restore the observation's 0.5-degree field, or select **All sky**. **Follow updates** checks the feed once per minute while this page is visible; refreshes preserve your view until the target changes. The original **Explore the sky** workspace keeps its separate position and layers. The image wall is no longer in the navigation; existing cached images and saved layouts are preserved.

Open **Pixel mapping** to adjust the survey display. Drag the three triangles for black point, midtone gamma, and white point; arrow keys and numeric inputs provide precise changes. Unlike Aladin Desktop's two-segment midpoint curve, the middle handle uses Aladin Lite's native gamma correction. The histogram samples up to 640 unadjusted RGB pixels across the visible field; its brightness scale is 0–255 and bar heights use logarithmic counts. Unavailable or transparent samples are excluded; valid black pixels are included. **Refresh histogram** resamples the view; **Auto levels** uses its 1st and 99.5th percentile brightness to choose cut levels. Sampling is an approximate display aid, not photometry or calibrated detector intensity.

Choose linear, asinh, logarithmic, square-root or squared stretch; survey colors, grayscale or a scientific color map; inversion; or a quick look. Expand **Fine adjustment** for brightness, contrast and saturation. **Show original** temporarily shows the untouched survey display; **Show adjustments** restores your edits, and **Reset display** clears this survey's adjustments. Settings save separately for Webb/2MASS and Hubble/DSS2 in this browser. These controls affect the Telescope Live map and never alter source files or the original explorer's layers. Cut levels, stretch, color maps and gamma use CDS Aladin; additional color grading uses GPU filters on the image canvas to avoid a negative-color gamma issue in Aladin 3.8.2. Catalog markers remain unchanged.

Checks: `.venv\Scripts\python.exe -m pytest tests/test_live_feed.py -q` and `node --test tests/test_telescope_live.cjs tests/test_pixel_mapping_math.cjs tests/test_pixel_mapping.cjs`.

**Color intensity** adjusts existing red, yellow and green tones separately. Additional palettes include red, yellow, green, blue, inferno, plasma and rainbow. Yellow uses a custom black-to-yellow Aladin color map. These are display adjustments, not measurements of chemical abundance.

**Save PNG** exports the visible Telescope Live map with its current levels, palette and color adjustments. Catalog markers keep their original colors. A source-credit strip is added below the map, and survey URLs, coordinates and full display settings are embedded in the PNG. **Settings JSON** saves that information separately. **Show original** also applies to exports; neither action changes the source imagery.

## Start exploring

1. The app opens to a **360° all-sky overview** in the visible-light survey. Drag to pan and scroll to zoom into any region; no destination is required. **All sky** returns to this overview at any time. The destination cards are optional shortcuts, and the search accepts object names or decimal `RA, Dec`.
2. Use **Webb**, **Hubble**, or the wavelength selector to switch actual datasets. Hydrogen, oxygen, sulfur, nitrogen, molecular-hydrogen-band, and dust views have different resolutions and coverage. **Visible** restores a wide-field sky survey for orientation.
3. The **Telescope Live** panel refreshes every minute while the app tab is visible. Click a target to travel to its reported pointing; the supplied Webb observation is pinned below the panel. Start/end times and execution status come from the feed. Its current record is not always an observation confirmed to be executing at this instant.
4. Choose **Explore observations** to search public MAST images around the current coordinates. Filter by telescope or band, then open data products. Calibrated image products are ordered ahead of raw files where metadata permits. Previews are representations; the original FITS is the scientific input.
5. **Open this view in image lab** captures the current sky visualization. **AI enhance** runs FSRCNN x2 locally on the CPU. The comparison and exported PNG are clearly labeled. Open your own FITS, PNG, JPEG, TIFF, or WebP files as well.
6. Save fields and images to the **Discovery notebook**. Recent images and their AI outputs remain in the image lab after reopening the app. Export notes and analyses as JSON.

## Glide through telescope imagery

The map has a **− minimize button** on its panels. Use **Panels** at the top right to show individual panels again, or **Hide sidebar** for more map space. **Clear view** (keyboard **H**, outside text fields) hides the map panels and sidebar together; **Restore layout** brings back your previous arrangement. Your choices survive a browser reload. A compact Stop/Exit bar stays available when flight controls are minimized, and tours keep their Pause/Resume and End controls. Minimizing information panels does not turn off imagery or catalog markers.

Click **Fly** beside **All sky** to enter the flight cockpit at your current coordinates. From the full-sky overview it narrows to a 70-degree perspective view; you can start anywhere. Select Webb, Hubble or a wavelength lens as you explore. The wide visible survey provides context where individual telescope datasets have no coverage.

- **Arrow keys:** look left, right, up and down. **A / D** also steer left/right.
- **W / S:** move closer or farther by smoothly changing magnification. The mouse wheel still works.
- **Q / E:** roll the view. **North up** levels it again.
- **Shift:** temporarily boost speed. **Steering pace** selects Slow, Normal or Fast.
- **Cruise:** continuously sweep to the right. **Space**, **Escape**, or **Stop** immediately stops motion.
- Hold the on-screen buttons, or click them for a small movement. Dragging the sky takes over from cruise.
- **Show panels** restores the information panels; image-location and object-map switches remain available. Image locations refresh while you glide. Nearby SIMBAD entries refresh after you stop moving.
- **Images in view** opens actual Hubble and Webb observations around your current field, ready to inspect or project onto the sky.
- **Save waypoint** opens a notebook entry for the current position and zoom. **Exit flight** returns to the normal map at the current field; **All sky** returns to the overview.

Flight pauses when a dialog opens, you focus a text field, the window loses focus, or the tab becomes hidden. Switching workspaces exits flight. Selecting a destination now follows a smooth path across the celestial sphere and eases the zoom into the target; dragging or scrolling cancels that travel. Reduced-motion preferences disable destination animations and inertial easing.

This is navigation through actual projected imagery: forward/back changes magnification, and steering changes viewing direction. It does not reconstruct distances or reveal the unobserved back of an object. Image originals and scientific measurements are unchanged.

Developer flight checks: `node --test tests/test_flight.cjs tests/test_flight_controls.cjs`.

## Guided tours, saved routes, and nearby images

**CEFCA: Virgo Cluster** is available at the top of **Tours & routes**. Start its 23-stop itinerary or choose **Customize route** to save your own version. The published stop order, coordinates and fields follow CEFCA's [original Spanish tour](https://www.cefca.es/divulgacion/tour_cumulo_virgo); short English navigation notes accompany the JAST80 / T80Cam mosaic. The two introduction slides are summarized in the overview. The CEFCA site currently lists this one complete tour. Its imagery and original cover remain credited to CEFCA Foundation, with source links. This integration uses our existing Aladin 3 viewer and route player.

The CEFCA mosaic covers a limited region. Visited tiles use the local cache. Prepared offline tour-view downloads are unavailable for this legacy survey, so the app skips unsupported background previews and explains this limitation if you request a download. Automatic Hubble/Webb cutouts pause while this survey is selected; **Load here** still allows an explicit archive overlay.

Turn on **Voice narration** in the tour player and expand **Voice options** to choose OpenAI's Cedar, Marin or Coral voice, or your browser's voice. OpenAI narration uses `gpt-4o-mini-tts` and the app's existing encrypted API connection. Guide text is sent to OpenAI when creating audio, and new generation uses your API billing. Speech is labeled as AI-generated; MP3 audio and provenance are cached in `data/narration/`, excluded from Git, and cached replay requires no API call. Pause, resume and stop navigation control the audio, and the tour waits for narration before advancing. **Replay narration** reuses the saved clip; changing text or voice creates a different clip. No paid requests are retried automatically.

Open **Tours & routes** for seven starting itineraries: sky landmarks, stellar nurseries, Webb galaxies, star-forming regions, recent located NASA releases, and recent public Hubble and Webb fields. The NASA tours use located publisher images and captions; the archive tours use actual MAST observations. Tour availability depends on the local indexes. **Update images** refreshes those indexes, and reopening Tours & routes rebuilds the suggested itineraries. Starting a tour saves a local copy that you can customize.

The guide shows each stop's source, coordinates, selected survey, and available exposure/filter metadata. Archive and NASA JPEG previews appear beside the sky map. Their presence does not mean that the current HiPS survey contains that exposure. **Inspect source image** opens the existing original-product viewer; use **Project FITS on sky** there for WCS registration. Featured guides use the credited HiPS imagery directly, with optional publisher videos. A gallery target marker locates the named subject; it does not register the JPEG's pixels. Large MAST JPEG previews use decoder reduction before display, within compressed-file, source-dimension, and decoded-pixel limits.

Playback follows great-circle paths with smooth zoom and rotation. Long hops show the real DSS optical sky for context, then restore the destination survey on arrival. Use **Pause**, **Previous/Next**, the position slider, and **0.5–2×** playback speed. **Take controls** switches to manual flight. Space pauses/resumes the tour when you are not editing a field; Escape pauses. Changing the survey, steering the map, opening a dialog, leaving Explore, or losing window focus pauses playback. Resume is manual. A stop waits for its preview and pending map activity, and pauses with an explanation if loading fails or takes too long. Settled tiles do not prove that a survey has valid pixels at that location. **Voice narration** supports OpenAI audio or browser speech; browser voice availability and local processing depend on your browser and installed voices. Videos play only when requested and retain their publisher classification and credits.

**Customize**, **+ New route**, **+ Current view**, and **+ Route** on nearby images build your itinerary. Edit stop titles, notes, coordinates, field size, survey, travel time, and exploration time; reorder or remove stops. Routes allow up to 100 stops. **Order nearby stops** uses a greedy angular nearest-neighbor heuristic, not a guaranteed shortest route. The overview plots RA and Dec, not physical distances. Timing and text edits autosave after 1.5 seconds; **Save route** saves immediately. Revision checks prevent another window's changes being overwritten. If a save fails, **Export route** still preserves the current edits in a recovery file. **Reload saved version** restores the database version after confirmation when edits are pending.

Routes, source references, and paused playback positions are stored in `data/flight-routes.sqlite3`. After reopening a saved route, **Resume saved position** returns to its last saved timeline position and original starting view. Editing a route invalidates old playback progress. Export creates a portable `.universe-route.json` file; import validates it and creates an independent copy. These files contain camera paths and source references, not the telescope images. Missing sources are labeled unavailable while saved coordinates remain intact.

For your own flight, choose **Record a flight** or **Fly → Record flight**. It samples RA, Dec, zoom, rotation, projection, and survey twice per second, for up to 30 minutes or 3,600 samples. Recording pauses while the window is unfocused, another workspace/dialog is open, or the recording pause control is selected. Steering can be stopped while recording continues to capture a stationary view. Autosave runs approximately every five recorded seconds; **Stop & save** flushes the final samples and opens the saved route. **Backup** exports the in-memory recording if saving fails. A sudden browser/process crash can lose samples since the last successful autosave. Replay interpolates between recorded samples; it does not store a video or cache all image tiles.

Toggle **Nearby images** to get suggestions as you explore, without choosing a destination first. Choose Hubble, Webb, or both, and a radius that follows zoom or spans the entire sky. Suggestions prioritize supported archive footprints containing the view center, then angular distance. Distinct-region suggestions are separated by at least 0.012 degrees. The spatial index searches every supported footprint for containment, including footprints whose pointing center is outside the selected radius, then ranks nearby regions across the full local coordinate index. During a rebuild, the interface explicitly identifies the temporary nearest-pointing fallback. Moving-target observations are excluded. ICRS circle and supported small polygon footprints are tested on the celestial sphere, including the RA seam and poles. Unsupported footprints remain nearby pointings rather than claims of containment. A footprint boundary does not guarantee usable detector pixels, depth, image quality, or a HiPS mosaic. NASA releases are separately labeled **Published target location**. **Tour these observations** saves and plays the current archive suggestions.

Navigation checks: `.venv\Scripts\python.exe -m pytest -q` and `node --test tests/test_flight.cjs tests/test_flight_controls.cjs tests/test_route_timeline.cjs tests/test_route_player.cjs`. With the server running, `.venv\Scripts\python.exe verify_navigation.py` checks source/coordinate correspondence, live Hubble and Webb preview decoding, footprint filtering, revision conflicts, playback persistence, and export/import equality. It deletes only the disposable routes it creates and writes evidence to `data/verification/navigation-api.json`.

## Automatic original-FITS imagery

**Auto-load science cutouts** is enabled in the sidebar. Below a 1-degree field, pausing over a supported fixed-target archive footprint requests a small section of its public science FITS. Choose Hubble, Webb, or both; adjust **Science layer opacity**, use **Load here** to retry, and open **Source details** for the observation, filter, native pixel scale, download size, processing and hashes. A delayed response cannot move the camera or insert a cutout after you have left its field.

The reader uses validated HTTP byte ranges, with a 96 MB transfer budget and a time limit. The selected 2D SCI extension is transformed through its original WCS, including available distortion information, into a 512 × 512 TAN display FITS. The source region is intentionally small (approximately 640 native pixels across); zoom closer for detail. The original multi-GB product stays at MAST. The cutout is bilinearly resampled, missing data stays missing, and no AI runs in this pipeline. It is a display derivative, not flux-conserving photometry; detector quality flags are not applied. Unsupported files, unavailable pixels and archive failures are reported instead of substituting invented imagery. Use the original FITS and the existing science tools for measurements.

The installation was verified with an actual 5.42 GB JWST F187N product and a 217.8 MB Hubble F600LP product. Their display cutouts required about 44.3 MB and 11.0 MB of archive transfers respectively. See `data/verification/atlas-api.json` for exact identifiers, retrieval dates, WCS metadata and checksums. A WCS round-trip check verifies transformation consistency, not the telescope's absolute astrometric accuracy.

## Compare wavelength lenses

Open **Compare lenses** to see two independently rendered survey layers at the same ICRS position, field size and rotation. Drag the map or use the zoom buttons to steer both views. Choose **Swipe divider**, drag its handle or move its keyboard-accessible slider; choose **Blend layers** to adjust the right layer's opacity. **Use explorer position** copies your latest sky field, and **Explore this field** returns there with the left lens selected.

All telescope and wavelength lenses, including the SDSS color and g/r/i layers, are available on either side. Each has a source description and loading status. The canvases have opaque backgrounds so absent coverage cannot masquerade as the other telescope's image. Angular alignment does not equal matched resolution, observing epoch, intensity calibration or gas abundance. The interface preserves these distinctions.

## SDSS galaxies and MaNGA spectral maps

Open **SDSS galaxies** for a 2048 × 2048 optical color image from the SkyServer DR20 service. Use a showcase, enter ICRS coordinates, or copy the current map position. Brightness, contrast and saturation controls create a display edit; **Save styled PNG** labels the exported pixels. Download the untouched JPEG or send it to **Image Lab** for the existing local and optional cloud enhancement workflows. The source URL, retrieval date and original SHA-256 are retained. The native SDSS camera sampling is about 0.396 arcseconds per pixel; larger output sizes do not add resolved detail. Very dark fields may be outside survey coverage.

For continuous flight, select **SDSS · galaxy color**, or its individual **g**, **r** and **i** bands, in the map lenses. These are **DR9** HiPS mosaics from CDS, with the existing disk cache, saved routes and comparison tools. The image studio uses the **DR20 interface to legacy imaging**; it does not label these as new DR20 exposures.

The **MaNGA gas & motion** tab searches for the nearest 25 observations within one degree or accepts a plate-IFU identifier. It retrieves **DR17** maps through the public Marvin API, with HYB10 / MILESHC-MASTARSSP processing. Available views are H-alpha, [O III], [S II] 6718, H-alpha gas velocity, stellar velocity and an assigned-color S/H/O composite. Emission-line channel names use the SDSS vacuum-wavelength convention.

Flagged samples, nonfinite measurements and nonpositive inverse variance are excluded. Gas maps also require positive flux and the selected signal-to-noise threshold; gas velocity uses the corresponding H-alpha flux quality. Stellar velocities keep both signs and zero. All three gas channels must pass for the composite, whose channels are stretched independently. Colors show flux or line-of-sight velocity, not gas abundance. MaNGA spatial resolution is much coarser than the color photographs; display scaling retains the native grid.

Hover over a map to inspect its measured value. Download the map PNG with embedded provenance, or the source measurements, inverse variance, masks and WCS as JSON. **Show measured map on sky** registers it using the supplied celestial WCS; **Remove MaNGA overlay** turns it off. Map visualizations sent to Image Lab remain display images and cannot enter source detection. The full observation, flags and additional spectral tools remain accessible through **Marvin**.

SDSS requests run only when this workspace is used. Retrieved data shares the configured atlas disk budget and remains reusable in cached-only mode. Existing map-detail priority remains unchanged. No SDSS login or extra Python package is required. Scientific context and software links are included in the workspace: [SDSS science](https://www.sdss4.org/science/), [MaNGA](https://www.sdss4.org/surveys/manga/), [DR20 software](https://www.sdss.org/dr20/software/).

Slow connections and temporary service errors are retried automatically with bounded backoff. The status shows the current source, attempt and elapsed time. SDSS has a separate persistent connection pool from map tiles, and simultaneous requests for the same MaNGA data share one download. Cached images are reused without a network request.

For optical images, an initial SkyServer timeout switches to the **SDSS DR9 color mosaic through CDS HiPS2FITS**, at the requested coordinates, field width and output size. Both independent CDS endpoints are available; if they are unavailable too, the app retries SkyServer. Backup images have distinct cache keys, source labels, filenames and export credits. **Try SkyServer image** requests the primary image explicitly. This backup is a reprojected DR9 mosaic, not the identical SkyServer rendering or a substitute for measured MaNGA maps. A complete service outage can still prevent uncached downloads. [CDS service documentation](https://alasky.cds.unistra.fr/hips-image-services/hips2fits)

With the app running, `.venv\Scripts\python.exe verify_sdss.py` checks a real 2048-pixel color image, its hash, a nearby catalog search, all six MaNGA views, quality-mask transparency and celestial WCS round trips. It writes `data/verification/sdss-live.json` and retains the fetched public data in the atlas cache.

`.venv\Scripts\python.exe verify_sdss_recovery.py` checks automatic image delivery, an explicit CDS image, source attribution and cached reuse through the running app. It saves timings in `data/verification/sdss-recovery-live.json`. The Python regression suite separately injects timeouts, transport failures and complete outages to verify automatic recovery without depending on a live outage.

## Flight preloading and downloaded tours

**Prioritize visible map detail** is enabled by default and remembered in your browser. It pauses the offscreen flight preview and waits for visible tiles before requesting automatic science cutouts or upcoming tour previews. Manual **Load here** and downloaded tour playback remain available. This gives the imagery you are looking at first access to download slots without lowering its resolution.

**Preload flight & tour views** requests rendered views for the next two waypoint stops. With visible-map priority off, it also warms survey tiles about one second ahead of flight velocity, at most once every two seconds, and uses a prepared view at the current stop while detailed tiles arrive. Preloading is optional and pauses in cached-only mode. Transfers still depend on archive and CDS response times.

Open **Downloads & cache**, select a saved waypoint tour and choose **Download tour views**. Each stop saves a coordinate-registered 768 × 768 survey rendering, captions, its route revision and available source previews. Play it with **Play downloaded tour**. This uses the saved revision even if the editable route has subsequently changed. Partial or interrupted downloads remain visible; cancel skips remaining views after the current bounded transfer finishes. Removing a download releases its cache protection and leaves the saved route intact.

The atlas cache defaults to an **8 GiB disk budget**, adjustable from 1 to 64 GiB in **Downloads & cache → Map cache on disk**. The limit persists across restarts and grows into use as you explore; it does not allocate GPU memory. Saved pack files are protected; older unprotected tiles and display cutouts are evicted when space is needed. A smaller limit is refused if it would require removing existing files. **Cached-only atlas** prevents new requests by the atlas download/cache service. Downloaded fields and previously visited tiles can be explored locally. It does not disable separate live feeds or catalogs. Unvisited sky areas, higher detail, videos, new catalog searches and cloud AI require internet. Continuous recorded flights use the visited-tile cache; downloadable packs currently support waypoint tours. A saved survey view can be blank where that survey has no coverage.

Map tile downloads share persistent HTTP connections, and simultaneous requests for the same tile share one transfer. Cached tiles display immediately; after 24 hours, a bounded background refresh checks for updated copies without delaying the cached response. Original retrieval timestamps remain available in response headers. Larger disk caches help revisits, while first visits still depend on the survey server and network. A powerful GPU helps render the map but cannot supply imagery that has not arrived or detail beyond the source survey's resolution.

Aladin Lite 3.8.2, its embedded WebAssembly and license files are bundled under `static/vendor/`; the viewer itself no longer depends on loading a remote script at startup. Survey source metadata and timestamps remain in the local cache.

## Object mapping, summaries, and videos

Turn on **Object map** at the upper left of the sky. Click a dot or an object in the right-hand list to read its summary, coordinates, and source links. **Labels** hides or shows the names while retaining clickable dots. Turning **Object map** off hides both markers and the information panel and pauses its video. Your map preference is remembered in this browser.

The six featured destinations include sourced descriptions and embedded videos from ESA/Webb, ESA/Hubble, or ESO. Each video identifies whether it is an image tour, a scientific visualization, or an artist's impression. Playback is manual; the publisher page contains full credits and a fallback player. The catalog entries beyond these featured destinations have factual classification summaries and SIMBAD reference links, but no invented object-specific videos.

The overview shows featured guide markers. Once you zoom to a field of five degrees or smaller, the map queries SIMBAD as you pan and zoom. It loads up to 120 nearby entries within a radius capped at one degree, prioritizing the nearest entries. At most 18 ordinary labels are shown to reduce overlap. Use the list or its name/type filter to find loaded entries. This is a partial catalog overlay, not a complete identification of every point in an image. Coordinate epochs, proper motion, and source extent can produce offsets. Retrieval time and unavailable/stale states are shown. Featured objects remain available when SIMBAD cannot be reached.

## Recent Hubble and Webb images

**Update images** refreshes both the MAST index and the NASA Webb Flickr collections. The MAST index covers all public, science-purpose Hubble and Webb image observation records at calibration levels 2 and 3, observed from January 1, 2022 through the refresh time. Every API page is checked against the reported record count. A failed refresh retains the previous complete index. Newly released older observations within this date range are picked up too. Private data, spectra and observations before 2022 are outside this index.

Open **Image journeys → Recent Hubble + Webb data** to browse actual MAST previews by telescope, target or current field. Each record shows its observation date, filter, instrument and coordinates. **Travel to footprint** draws the recorded exposure boundary. **Project FITS on sky** downloads the original FITS and places it using its celestial WCS; **Clear projected FITS** removes that display layer. **Original files / image lab** opens the full product list. A record can represent several files; the indexed record count is not a count of downloaded FITS files. The first verified complete index contained 174,411 records: 72,787 Webb and 101,624 Hubble.

**Image locations** toggles the coordinate overlay. Gold marks Webb, teal marks Hubble and pink marks NASA published-image targets. At wide zoom, numbered groups account for all indexed positions; click to zoom in and separate them. Files and previews download when opened, so the refresh does not download an entire telescope archive to your PC. Space Telescope Live continues to provide the observing schedule; MAST provides the released science data. Aladin renders the map.

## NASA Webb image journeys

The gallery includes the supplied **2026**, **2025**, and **Galaxies + Webb** albums and NASA Webb's full public photostream. Open an image to zoom and pan, read its publisher caption and credits, visit its original source, or send it to the image lab for local/cloud enhancement. The verified album counts were 79, 97 and 266. Images shared between collections are stored once.

The initial photostream traversal found **4,401 distinct accessible items** across all 45 public pages. Flickr inconsistently reported 4,435 on earlier pages and 4,401 on the last page. The app retains an explicit incomplete-count warning instead of claiming that the extra 34 items were retrieved. Refresh checks every public page again. This collection also includes mission photographs, graphics and illustrations, which are labeled separately from observations where the publisher text identifies them.

Sky positions are resolved from identifiable astronomical target names, with provenance shown. The initial import located 225 published items. Unlocated items remain fully browsable; Earth-based Flickr geotags are never treated as celestial coordinates. A resolved target center is not pixel registration for a published JPEG. Use WCS-bearing FITS for accurate image projection. Gallery dates are publication dates, not exposure dates.

## VizieR photometry

Open **Photometry & Aladin**, enter a name or coordinates and a radius in arcseconds (default 5, range 0.1–30), then choose **Get photometry**. This uses the requested CDS service, `https://vizier.cds.unistra.fr/viz-bin/sed`, with an official VizieR mirror fallback if needed. Queries preserve the original VOTable and cache results for 24 hours; **Refresh saved measurements** forces a new query. Retrieval time, mirror, stale results and service truncation are explicit.

The interactive plot displays frequency in GHz or wavelength in micrometers against flux density in **Jy**, with supplied error bars. Scroll to zoom, drag to pan, filter by catalog and click a point to inspect its table row. Export CSV or the original VOTable. Nonpositive values remain in the table even though logarithmic axes cannot display them. The live HD100 query returned 321 measurements from 55 catalog tables.

These are catalog measurements within a sky cone. They can include different sources, observing epochs, apertures and calibrations; they do not automatically form a single object's uncontaminated spectrum. No extinction correction or gas-identification inference is applied. The original catalog links and identifiers are retained.

## Full Aladin Desktop

The complete official **CDS Aladin Desktop 12.060** distribution is installed in `vendor/aladin`, alongside the browser's Aladin Lite renderer. Choose **Photometry & Aladin → Open full Aladin Desktop**, or run **Open-Aladin.cmd**. Aladin opens its own native desktop window with its full tools: FITS extensions and cubes, catalog overlays, cross-matching, image arithmetic, mosaics, MOCs, HiPS creation, scripts and plugin support. Its datasets and optional external services load as needed; the package does not include copies of all remote astronomical archives.

Use **Send current sky position** to point Aladin at the explorer's current field, **Send table to Aladin** to load VizieR measurements, and **Image lab → Open original in Aladin** to load the saved original. These use SAMP locally and address the Aladin application. All FITS HDUs remain in the original handoff. For some multi-extension FITS files, Aladin omits a completion acknowledgement; the bridge checks its actual loaded image planes and never automatically resends the file after a timeout.

The official application JAR, original source archive, GPLv3 license, download provenance and checksums are retained. A private Eclipse Temurin Java 21 runtime is included and its download checksum was verified against the Adoptium API. No global Java or PATH changes are needed. **Stop.cmd** stops the explorer server; close Aladin separately when finished. On a fresh installation, **Setup.cmd** also installs this desktop package.

## Optional OpenAI enhancement

In **Image lab**, open an image and select **OpenAI · cloud image editing**. Use **Cloud connection** to enter an OpenAI API key privately in the app, then choose **Verify & connect**. This checks account access to `gpt-image-2.5-sunburst`. The key stays in backend memory for the session unless you enable **Remember on this Windows account**, which stores it encrypted using Windows DPAPI. Keys are never returned by the status endpoint or stored in browser storage. `OPENAI_API_KEY` is also supported when supplied to the server environment.

Choose quality and optional visual preferences, then click **Enhance with OpenAI**. This sends the current display preview (up to 1,600 pixels on the long edge) and the enhancement prompt to OpenAI. API usage is billed separately through the connected API account. No image is uploaded merely by changing the provider or connecting a key. There is one cloud edit at a time and no automatic retry after a failed or timed-out request. Check your API dashboard before retrying a timeout, since the provider may have processed it.

Cloud outputs are saved separately, watermarked, and carry input hashes, provider, model, prompt, and request ID when returned. **Compare with** switches between the local result and saved cloud/imported versions. Both local and cloud modes preserve original measurement data; source detection never reads AI pixels. Generative editing is not scientific reconstruction and can alter sources despite preservation instructions. The cloud request path has automated coverage with simulated OpenAI responses; a paid end-to-end request requires your own connected key.

If you prefer image enhancement in ChatGPT, select **ChatGPT · export & bring back**. Download the ZIP, extract it, attach `astronomy-preview.png` to your conversation, and use `prompt.txt`. Download the returned image and choose **Import returned enhancement** in the same image lab entry. This is a manual handoff, not an automatic call into a ChatGPT subscription. Imported results are explicitly labeled as externally supplied, with unverified provider/model details.

## Investigation tools

- **FITS source candidates:** Open a 2D FITS image, expand *Investigate source candidates*, and choose a background threshold. The detector analyzes original image values, never AI pixels. Coordinates use the original HDU's celestial WCS when interpretable. Results are capped at 200 unclassified peaks and are not confirmed new stars. The aperture sums are exploratory, not calibrated photometry; PSF fitting, DQ masks, full variance models, deblending, and multi-epoch confirmation are not implemented.
- **Gaia DR3 check:** Search within 3 arcseconds of a candidate. Absence from one catalog does not establish novelty. Extinction, faintness, epoch, proper motion, WCS uncertainty, and catalog incompleteness matter.
- **Known exoplanets:** Query confirmed systems from the NASA Exoplanet Archive near your sky position. TRAPPIST-1 is a convenient starting field. Its planets are not resolved in the sky map.
- **Transit lab:** Upload TESS/Kepler light-curve FITS with TIME and PDCSAP_FLUX/SAP_FLUX, or a CSV headed `time,flux`. Time must be in days; flux must be positive. Quality flags are applied when provided in FITS. An approximately one-day running median detrend precedes a 3,500-period logarithmic BLS grid. The highest peak is a preliminary fit, not a detection probability. Use one reasonably continuous segment; inspect gaps, detrending effects, aliases, eclipsing binaries, contamination, and repeat sectors. Spectroscopic analysis and automated discovery confirmation are not implemented.

## Data and scientific limits

The explorer is a **2D angular sky atlas**, not a reconstructed three-dimensional universe. Many regions lack high-resolution Hubble/Webb coverage. Tile loading can briefly leave gaps; wait for the loading indicator to settle before capturing. Separate released images may meet at visible mosaic boundaries.

Space Telescope Live supplies **observation metadata**, not real-time camera frames. Public science data comes from MAST. Outreach mosaics and filter mosaics have their own update cadence and do not necessarily include the latest released exposure. Network failures are shown explicitly; saved API responses are labeled stale when refresh fails.

The gas lenses are real wavelength datasets, not colored copies of one image. Narrowband views include continuum and sometimes neighboring lines; gas isolation requires continuum subtraction and appropriate calibration. They are not abundance measurements or automatic gas identification. In particular, CDS names one HST layer `SIII`, but its listed F673N/FQ672N/FQ674N filters cover the [S II] band; the UI names the filter physics and explains this mismatch.

The bundled **FSRCNN x2** model is a small, general image super-resolution model. It is not trained or validated for scientific astronomy reconstruction. It may introduce or distort apparent features. It processes the default display preview at a maximum 1,200 pixels on the long edge and creates a separate, watermarked 2x PNG. A changed FITS display stretch does not alter the input to local AI; cloud editing and ChatGPT exports use the selected stretch. New imports preserve original bytes separately from display previews with SHA-256 provenance. Local mode uses the CPU and does not require CUDA or send images to a cloud AI provider.

Browser image-lab imports are limited to **100 MB and 25 million image pixels**. The browser selects the first suitable SCI 2D HDU, otherwise the first 2D image HDU. Use the full **Aladin Desktop** window for cubes, other extensions and larger files. Light-curve FITS belongs in the transit lab.

## Files and setup

- `data/images/`: original files, preview images, AI PNGs, metadata, and candidate exports. AI artifacts contain provenance in PNG metadata and a visible label.
- `data/notebook.sqlite3`: local notebook. Back up the entire `data` folder, or use notebook export for a readable copy.
- `data/flight-routes.sqlite3`: saved tours, recorded camera paths, route revisions and playback progress. Export individual routes from Tours & routes; stop the app before making a raw database backup.
- `data/cache/`: public API response cache with retrieval timestamps.
- `data/coverage-index.sqlite3`: derived full-archive spatial index; rebuilt when the completed archive generation changes.
- `data/atlas-cache/`: bounded survey tile / FITS display cache and protected downloaded tour views.
- `static/vendor/`: pinned Aladin Lite viewer, LGPL/GPL notices and download checksum manifest.
- `data/recent-archive.sqlite3` and `data/webb-gallery.sqlite3`: refreshable MAST and NASA image indexes.
- `data/photometry/`: original VizieR VOTables and parsed measurements.
- `vendor/aladin/`: full desktop application, original source, license, portable Java runtime and download manifests.
- `models/FSRCNN_x2.pb`: installed local model, validated against a pinned SHA-256 hash before use.
- `logs/`: server logs and the PID used by the app's stop launcher.
- `data/verification/`: live integration evidence from this installation.

Run `Setup.cmd` for a fresh installation. It detects 64-bit Python 3.11 through the Python launcher or PATH, creates this project's own `.venv`, installs `requirements-lock.txt`, verifies/downloads the 39 KB model, and installs both Aladin packages. New map tiles load through the local cache from CDS, and optional fonts load from Google Fonts. Internet access is needed for new imagery, catalogs, public archives, videos, and optional cloud editing. Local enhancement and scientific analysis run on this PC. Keep the server bound to 127.0.0.1; this personal app has no multi-user authentication. Exclude `data/openai-key.dpapi` from shared backups; a saved key is tied to this Windows account.

Developer checks: `.venv\Scripts\python.exe -m pytest -q` and `node --check static/app.js`. `verify_live.py` exercises live feeds, MAST, name resolution, Gaia, and the exoplanet archive. `verify_product.py` imports/verifies a real Hubble NICMOS product and runs original-FITS source detection. Test-injected stars and transit signals are confined to automated tests; they are never displayed as real discoveries.

Run `.venv\Scripts\python.exe -m pytest -q` and `node --test tests/test_atlas_ui.cjs tests/test_flight.cjs tests/test_flight_controls.cjs tests/test_map_panels.cjs tests/test_route_timeline.cjs tests/test_route_player.cjs tests/spatial-math.test.js tests/test_sdss_ui.cjs`. These include shared tile transfers, background cache refreshes, persistent cache quotas, visible-map priority, SDSS source preservation, MaNGA masks and registration, and flight behavior. With the app running, `.venv\Scripts\python.exe verify_atlas.py` verifies real original-FITS cutouts, saved view files, the spatial index and cached-only behavior. Results are in `data/verification/atlas-api.json` and `atlas-ui.json`.

## Sources and attribution

- [NASA: what Space Telescope Live shows](https://science.nasa.gov/missions/hubble/what-are-hubble-and-webb-observing-right-now-nasa-tool-has-the-answer/)
- [The supplied Webb observation](https://spacetelescopelive.org/webb?obsId=01M0T4XYBKBP63HYG18QQ1QT8S)
- [MAST API services and public product access](https://mast.stsci.edu/api/v0/_services.html)
- [CDS Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/doc/) and [HiPS registry](https://aladin.cds.unistra.fr/hips/)
- [CDS HiPS2FITS](https://alasky.cds.unistra.fr/hips-image-services/hips2fits) supplies explicitly projected saved survey views. [Astropy remote FITS sections](https://docs.astropy.org/en/stable/io/fits/usage/cloud.html) describe partial science-image access; this app uses a bounded HTTP range reader.
- [Complete Aladin Desktop package](https://aladin.cds.unistra.fr/java/nph-aladin.pl?frame=downloading), [desktop documentation](https://aladin.cds.unistra.fr/AladinDesktop/) and [SAMP interoperability](https://aladin.cds.unistra.fr/java/FAQ.htx).
- [VizieR photometry service documentation](https://vizier.cds.unistra.fr/vizier/sed/doc/).
- NASA Webb Flickr: [2026 album](https://www.flickr.com/photos/nasawebbtelescope/albums/72177720331299130/), [2025 album](https://www.flickr.com/photos/nasawebbtelescope/albums/72177720323168468/), [Galaxies + Webb](https://www.flickr.com/photos/nasawebbtelescope/albums/72177720332131144/), and [photostream](https://www.flickr.com/photos/nasawebbtelescope/).
- [Pillars of Creation coordinates and credits](https://esawebb.org/images/weic2216a/)
- [Hubble F673N / S II filter](https://hst-docs.stsci.edu/wfc3ihb/appendix-a-wfc3-filter-throughputs/a-2-throughputs-and-signal-to-noise-ratio-data/uvis-f673n)
- [NASA Exoplanet Archive TAP service](https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html)
- [Astropy box least squares](https://docs.astropy.org/en/stable/timeseries/bls.html)
- [FSRCNN model source](https://github.com/Saafke/FSRCNN_Tensorflow); its license is included in `models/LICENSE-FSRCNN.txt`.
- [OpenAI image editing API](https://developers.openai.com/api/docs/guides/image-generation) and [GPT Image 2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst).
- [SIMBAD astronomical database](https://simbad.cds.unistra.fr/simbad/) supplies known-object positions and classifications. Featured video source links and full credits are included in each object's panel.

Telescope images belong to their credited observing teams and institutions, including NASA, ESA, CSA, and STScI; CDS supplies sky projections. Retain the original product's full credit line for publication. The opening Pillars image credit is NASA, ESA, CSA, STScI; J. DePasquale, A. Koekemoer, A. Pagan (STScI). The Aladin logo and source link remain visible in the app and sky captures.

## Research desk upgrade

See [RESEARCH-DESK.md](RESEARCH-DESK.md) for all-date history, aligned epochs, original-data mosaics, source fits with detector masks and uncertainties, automatic TESS retrieval, measured Gaia 3D flight, a persistent watchlist and the source-linked field guide. Open **Research desk** in the sidebar. Refined science views, adjoining cutouts from one original, and gamepad/autopilot controls are integrated into sky flight.
