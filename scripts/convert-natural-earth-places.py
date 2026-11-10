import hashlib
import json
import sys
import urllib.request
from pathlib import Path

SOURCE_COMMIT = "ca96624a56bd078437bca8184e78163e5039ad19"
SOURCE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    f"{SOURCE_COMMIT}/geojson/ne_50m_populated_places_simple.geojson"
)
SOURCE_SHA256 = "8e70756b39fae9bcdc1e332bfc510c024c5edd3a13203ffd20092ee37b61d978"

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "processed" / "places" / "places.json"

COORDINATE_DECIMALS = 5


def download_source() -> bytes:
    with urllib.request.urlopen(SOURCE_URL) as response:
        body = response.read()
    digest = hashlib.sha256(body).hexdigest()
    if digest != SOURCE_SHA256:
        sys.exit(f"The source file has SHA-256 {digest}, expected {SOURCE_SHA256}")
    return body


def place_tags(properties: dict) -> list[str]:
    tags = []
    if properties.get("adm0cap") == 1:
        tags.append("national capital")
    if properties.get("worldcity") == 1:
        tags.append("world city")
    if properties.get("megacity") == 1:
        tags.append("megacity")
    return tags


def population_estimates(properties: dict) -> list[int]:
    estimates = []
    for key in ("pop_min", "pop_other", "pop_max"):
        value = properties.get(key)
        if isinstance(value, (int, float)) and value > 0:
            estimates.append(int(value))
    return estimates


def place_summary(name: str, region: str | None, country: str, tags: list[str]) -> str:
    where = ", ".join(part for part in (name, region, country) if part)
    if not tags:
        return f"{where}."
    described = ", ".join(tags)
    return f"{where}. {described[0].upper()}{described[1:]}."


def to_place(feature: dict) -> dict:
    properties = feature["properties"]
    raw_region = properties.get("adm1name")
    region = raw_region.strip() if isinstance(raw_region, str) and raw_region.strip() else None
    tags = place_tags(properties)
    place = {
        "id": str(properties["ne_id"]),
        "name": properties["name"],
        "summary": place_summary(properties["name"], region, properties["adm0name"], tags),
        "country": properties["adm0name"],
    }
    if region is not None:
        place["region"] = region
    place["kind"] = properties["featurecla"]
    place["tags"] = tags
    place["population"] = int(properties.get("pop_max") or 0)
    place["populations"] = population_estimates(properties)
    place["location"] = {
        "lat": round(float(properties["latitude"]), COORDINATE_DECIMALS),
        "lon": round(float(properties["longitude"]), COORDINATE_DECIMALS),
    }
    return place


def main() -> None:
    collection = json.loads(download_source())
    places = sorted((to_place(feature) for feature in collection["features"]), key=lambda place: place["id"])
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(places, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {len(places)} places to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
