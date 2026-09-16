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

SDSS color cutouts are retrieved from the public SkyServer DR20 interface; MaNGA DR17 measurement arrays are retrieved through the public Marvin API. They are credited to SDSS / SDSS-IV / MaNGA, with source URLs and releases preserved. The continuous SDSS DR9 color and g/r/i maps are served by CDS HiPS; their registry lists ODbL-1.0. See [SDSS science](https://www.sdss4.org/science/), [MaNGA](https://www.sdss4.org/surveys/manga/), [SDSS software citation guidance](https://www.sdss.org/dr20/software/), and the [CDS SDSS color registry](https://alasky.cds.unistra.fr/MocServer/query?ID=CDS%2FP%2FSDSS9%2Fcolor&fmt=html&get=record). No SDSS or Marvin software distribution is vendored by this integration.

These notices describe third-party components. An independent license for the original Universe Explorer application code has not yet been selected.

The CEFCA Virgo Cluster route follows the numerical positions, fields and order published in the [original Spanish tour](https://www.cefca.es/divulgacion/tour_cumulo_virgo). English stories are original summaries of astronomical facts; primary research references are recorded per stop in `tour_content/` and linked under **Story sources**. The JAST80 / T80Cam mosaic and unchanged tour-cover image are credited to **CEFCA Foundation**; the cover's source and checksum are recorded in `static/assets/cefca-virgo-provenance.json`. CEFCA's [media-use policy](https://www.cefca.es/cefca_en/media_use_policy) allows noncommercial use with credit; commercial use requires its authorization. The map retains linked CEFCA credit and Aladin attribution. No CEFCA Tour Navigator plugin code is bundled, and the original website is linked rather than framed.

Optional OpenAI voice narration uses the [Speech API](https://developers.openai.com/api/docs/guides/text-to-speech). Generated audio is labeled AI-generated, kept locally with its model, voice, input text and source metadata, and excluded from this repository.
