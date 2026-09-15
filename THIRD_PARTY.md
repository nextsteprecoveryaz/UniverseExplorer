# Third-party software and telescope imagery

Universe Explorer retrieves third-party software during setup instead of storing those downloaded distributions in Git. Their licenses and attribution remain with the installed files.

| Component | Source | Installed files and notices |
| --- | --- | --- |
| Aladin Lite 3.8.2 | [CDS Aladin Lite](https://github.com/cds-astro/aladin-lite) | `static/vendor/aladin.js`, `ALADIN-LGPL.txt`, `ALADIN-LICENSE.txt`, and a download manifest. |
| Aladin Desktop | [Official CDS downloads](https://aladin.cds.unistra.fr/java/nph-aladin.pl?frame=downloading) | `vendor/aladin/` contains the application, installer, original source archive, `COPYING`, and download manifests. |
| Eclipse Temurin Java runtime | [Adoptium](https://adoptium.net/) | Installed with its original notices in `vendor/aladin/runtime/`; the downloaded archive is checked against the checksum provided by Adoptium. |
| FSRCNN x2 model | [FSRCNN TensorFlow](https://github.com/Saafke/FSRCNN_Tensorflow) | `models/FSRCNN_x2.pb` and `models/LICENSE-FSRCNN.txt`. The model is checked against the SHA-256 pinned in `setup_model.py`. |
| Python dependencies | Listed in `requirements-lock.txt` | Installed in `.venv/` with each package's own licensing metadata. |

The small Pillars of Creation preview in `static/assets/` is a released Webb outreach composite retrieved through the CDS HiPS service. Its retrieval URL and credit are recorded in `static/assets/provenance.json`. Image credit: NASA, ESA, CSA, STScI; J. DePasquale, A. Koekemoer, A. Pagan (STScI); projection by CDS.

Retrieved science products, catalogs, survey maps, videos and outreach images retain their publisher credits and terms. Consult each source before republishing its material. The app exposes source links and preserves original-product provenance; its AI visualization label does not replace the source credit.

These notices describe third-party components. An independent license for the original Universe Explorer application code has not yet been selected.
