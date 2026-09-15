"""Read public source metadata to validate app integrations."""
import concurrent.futures
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "UniverseExplorer/0.1"})
    with urllib.request.urlopen(req, timeout=35) as r:
        return r.read().decode()

def main():
    dest = ROOT / "data" / "research"
    dest.mkdir(parents=True, exist_ok=True)
    base = "https://spacetelescopelive.org"
    page = fetch(base + "/webb?obsId=01M0T4XYBKBP63HYG18QQ1QT8S")
    paths = sorted(set(re.findall(r'src="([^\"]+\.js)"', page)))
    def inspect(path):
        body = fetch(base + path)
        (dest / path.rsplit("/", 1)[-1]).write_text(body, encoding="utf-8")
        matches = []
        for match in re.finditer(r'https?://[^\s\"\x27<>`]+|/api/[^\s\"\x27<>`]+', body):
            value = match.group()
            if any(x in value.lower() for x in ["api", "observation", "stsci", "schedule"]):
                matches.append(value[:240])
        return {"file": path, "urls": sorted(set(matches))[:40]}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for item in pool.map(inspect, paths):
            if item["urls"]:
                print(json.dumps(item))
    hips = fetch("https://alasky.cds.unistra.fr/MocServer/query?expr=dataproduct_type%3Dimage%20%26%26%20(obs_title%3D*JWST*%20%7C%7C%20obs_title%3D*Hubble*%20%7C%7C%20obs_title%3D*Halpha*%20%7C%7C%20obs_title%3D*Finkbeiner*)&get=record&fmt=json")
    (dest / "surveys.json").write_text(hips, encoding="utf-8")
    items=json.loads(hips)
    print("SURVEYS", json.dumps([{k:v for k,v in x.items() if k in ['ID','obs_title','hips_service_url','hips_frame','obs_description']} for x in items])[:14000])

if __name__ == "__main__":
    main()
