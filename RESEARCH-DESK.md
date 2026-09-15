# Research desk

Launch `Launch.cmd`, then choose **Research desk** in the sidebar. The app remains local at http://127.0.0.1:8765. Internet is used for public archive/catalog queries, map tiles, videos and optional cloud AI. Existing originals, routes and notebook entries are retained.

## Explore and fly

- **Fly → Autopilot to observations** builds a saved journey through distinct nearby archive pointings. **Take controls**, **Stop**, Escape, leaving the window, or opening another workspace stops movement.
- Standard gamepads: enable **Gamepad** during flight; left stick steers, right stick zooms and rolls, A or Start stops. Stopping disarms gamepad input; enable it again to resume. Keyboard and mouse remain available. Hardware input needs a standard-mapped browser gamepad.
- Automatic science cutouts first load at 512 pixels. **Refine settled views to 1024 pixels** requests a larger original-data display after a stationary pause. Up to four adjoining cutouts from the same original are retained while crossing that product. Changing products clears that trail. HiPS maps continue their normal progressive tile loading.
- **Time & mosaics** can assemble up to four compatible original products on a common 1024-pixel sky grid. Click **Fly over this mosaic** to place it at its FITS coordinates. The sidebar provides **Remove research mosaic**. Automatic science loading is turned off when placing a research mosaic to avoid obscuring it; turn it back on when desired.
- Mosaic pixels use the first valid source, with later sources filling gaps. FITS `SOURCE` and `COVERAGE` extensions identify the contributing input and number of valid inputs. No generated pixels, feathering or photometric coaddition. Different observation dates can contribute; provenance lists them.

## Time and original imagery

1. Use the current sky position, enter ICRS coordinates, or resolve a target name. Radius is in degrees.
2. Retrieve **all-date field history**. This searches public calibrated HST/JWST science image observations in that cone, including older Hubble records. All pages and row counts must pass completeness checks before the search is saved. There is a 20,000-record ceiling per cone. The existing complete since-2022 index is separate.
3. Filter by telescope/instrument/filter, target, observation identifier or date. The date slider walks through actual observation timestamps. Archive JPEG previews are explicitly unregistered.
4. Choose **Earlier** and **Later** products, and prepare an aligned comparison. Partial FITS reads produce the same WCS grid, orientation and field for both epochs. A matching DQ plane is masked when present. Science HDUs are chosen by sky location for multi-chip products.
5. Use **Swipe** or **Blink epochs**. Source links and exports retain the observation IDs, dates, exact product URIs, native sections, WCS, transfer metadata and processing details.

Brightness stretching is shared when image units agree. Different/unknown units use independent display stretches for structure only, clearly labeled as unsuitable for brightness comparisons. A difference image requires known compatible telescope, instrument, filter and units, nonoverlapping observation intervals, distinct products, and user-supplied PSF FWHM estimates. Gaussian broadening matches those estimates; it is not a measured instrument PSF calibration. Raw count images require exposure calibration and are excluded from difference displays. Large smoothing kernels are rejected.

WCS alignment is not a guarantee of absolute astrometric agreement. Calibration differences, sampling, PSF structure, detector artifacts and correlated noise remain possible. Difference images have no discovery or detection-significance claims. Derived display FITS files are marked `VISONLY` and cannot enter the new source-measurement pipeline.

Each partial source read is bounded: automatic quick views use 96 MB; refined views, epoch displays and mosaic inputs use 192 MB per product, with transfer deadlines. Native crop size limits the actual field. Uncovered pixels remain missing. The existing 1 GB atlas cache holds derived files and exact downloaded TESS products; unpinned files can be evicted.

## Source evidence

Import a FITS image in **Image lab**, then open the evidence workbench. Select the original, a detection threshold and estimated FWHM in native pixels. Photutils 3.0 performs DAO detection and grouped Gaussian-PRF fitting, using matching `DQ` and `ERR` extensions where available. The brightest 150 detected peaks are fitted. The fixed Gaussian approximation is not an instrument-specific PSF or a completeness model.

Inspect the source position on the original display, fitted flux/error, fit S/N, group and decoded fit flags. Without `ERR`, uncertainty estimates use background noise and omit source Poisson noise. Even with `ERR`, covariance and systematic errors are not fully modeled. Fluxes are exploratory values in image units; the app does not claim calibrated magnitudes.

**3 catalogs** queries Gaia DR3, SIMBAD and the TESS Input Catalog independently within three arcseconds. Service failures are distinguished from no matches. Proper motion is not propagated to the image epoch; these are possible positional associations. **Analyze & associate** checks another original, rejects identical content, and marks ambiguous many-to-one associations. Different files can share exposures, so association is not independent confirmation. Save selected evidence to the notebook or export the full report, catalog checks and repeat associations.

## TESS light curves

Click an object on the sky and choose **Find TESS light curves**, use a source candidate, select a Gaia neighborhood star, or resolve a target in the Research desk. The search retrieves all pages of public TESS mission time-series records for that small cone. It does not cover every TESS HLSP collection. Combined validation records are labeled separately from single-sector light curves.

**Retrieve & analyze** downloads a supported original light-curve FITS under 100 MB, records its SHA-256, reads the header's sector/TIC/crowding metadata, and opens the local transit lab. The original download remains available. Analyze sectors independently and save or export each result. CROWDSAP and FLFRCSAP report aperture contamination/flux-fraction estimates; they do not eliminate false positives.

The exploratory BLS search accepts 100–500,000 valid samples, uses quality-zero FITS rows, and searches up to half the time baseline. The running median uses at most 1,001 samples; its actual window duration is included in exported results. Fixed trial durations, detrending, cadence, gaps, missing uncertainty weighting and aliases can affect recovered periods. A best fit is not a confirmed planet.

## Measured 3D neighborhood

Load a 10, 25, 50 or 100 parsec neighborhood from ESA's Gaia DR3 archive. Selection: positive parallax, parallax/error at least 10, RUWE below 1.4; capped at the nearest 5,000 qualifying records. The returned row count and truncation are shown. This is an incomplete selected star sample.

Distances use `1000 / parallax_mas`, with approximate statistical error and an inverse-parallax ±1σ interval. No parallax zero-point correction, covariance model or motion propagation is applied. Cartesian coordinates are heliocentric ICRS, based on catalog epoch 2016.0. Stars are display symbols, not resolved surfaces; their sizes and colors are illustrative.

Drag the view to look around. Focus the canvas and use W/A/S/D to move and R/F vertically. Escape stops; leaving the tab/window stops motion. Click a star or choose one of the nearest 250 in the accessible selector. **Approach star**, **Return to Sun**, **See its real sky field** and **Find TESS light curves** connect the measured neighborhood to the existing sky explorer.

## Watchlist and field guide

Watch fields persist in `data/research.sqlite3`. The app checks the local recent-index generation once a minute while visible, or on **Check now**. Use **Update images** to download fresh archive metadata. Checks include pointing centers within the radius plus supported footprints containing the watched center. Unsupported footprints outside that radius may be missed. Initial records form a baseline; later unseen records generate in-app notifications. These describe newly indexed public records, not discoveries or necessarily recent exposures. Up to 50 observation links appear in each notification, with the full new-record count shown. Mark notices read or remove a watch. Opening watch history selects a same-telescope/instrument/filter earlier/latest pair when available for review.

The **Field guide** produces local, source-linked answers from SIMBAD/featured object descriptions and actual indexed observations. It is a record-based guide, not an LLM. Unknown chemistry, distance and novelty are not inferred from pixels. Catalog source pages link to references; unseen papers are not summarized. No API key or cloud text model is needed.

## Sources and validation

- [MAST services](https://mast.stsci.edu/api/v0/_services.html), [TESS archive](https://archive.stsci.edu/missions-and-data/tess), [TESS data product specification](https://archive.stsci.edu/files/live/sites/mast/files/home/missions-and-data/active-missions/tess/_documents/EXP-TESS-ARC-ICD-TM-0014-Rev-F.pdf)
- [Gaia DR3](https://www.cosmos.esa.int/web/gaia/dr3), [ESA programmatic archive access](https://www.cosmos.esa.int/web/gaia-users/archive/programmatic-access)
- [Photutils PSF photometry](https://photutils.readthedocs.io/en/stable/user_guide/psf.html), [SIMBAD](https://simbad.cds.unistra.fr/simbad/)

The upgrade passed 68 Python and 32 JavaScript checks on this PC, including planted blended stars, bad-pixel masking, repeat associations, mosaic missing-data/source ownership, Gaussian resolution matching, difference gating, multi-chip selection, history completeness, watchlist persistence and coordinate/gamepad math. The physical gamepad has not been tested.

Live archive checks are recorded in `data/verification/research-api.json`. The Pillars history returned 186 records from 1995 onward; a 1995/2021 comparison and a two-exposure Hubble mosaic returned approximately 20.8% valid coverage in the deliberately fixed test field, with missing areas preserved. The Gaia query returned 3,900 qualifying stars within 25 pc. A WASP-18 TESS sector-2 test returned a period near 0.9417 days and retained the original FITS hash. Browser checks exercised the 3D coordinate view, source fitting, historical selection, blink/swipe and automatic TESS handoff. These are verification examples, not accuracy guarantees for other data.

Run `.venv\Scripts\python.exe -m pytest -q` and `node --test tests/test_atlas_ui.cjs tests/test_flight.cjs tests/test_flight_controls.cjs tests/test_route_timeline.cjs tests/test_route_player.cjs tests/spatial-math.test.js`. With the app running, `verify_research.py` supports explicit archive verification jobs and polling. `Setup.cmd` installs the pinned Photutils dependency with the existing requirements lock.
