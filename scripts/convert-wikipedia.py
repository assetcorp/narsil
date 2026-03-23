import json
import sys
import time
from pathlib import Path

from datasets import load_dataset

LANGUAGES = {
    "ha": "Hausa",
    "yo": "Yoruba",
    "ig": "Igbo",
    "sw": "Swahili",
    "ee": "Ewe",
    "tw": "Twi",
    "zu": "Zulu",
    "dag": "Dagbani",
    "en": "English",
    "fr": "French",
}

WIKIPEDIA_SNAPSHOT = "20231101"

MIN_TEXT_LENGTH = 100

DEFAULT_LIMIT = 10_000


def fetch_articles(lang_code: str, limit: int) -> list[dict]:
    config_name = f"{WIKIPEDIA_SNAPSHOT}.{lang_code}"
    print(f"  Loading wikimedia/wikipedia config '{config_name}' (streaming)...")

    try:
        ds = load_dataset("wikimedia/wikipedia", config_name, split="train", streaming=True)
    except Exception as e:
        print(f"  Error loading dataset: {e}")
        return []

    articles = []
    skipped = 0
    t0 = time.time()

    for record in ds:
        text = record.get("text", "")
        title = record.get("title", "")

        if len(text) < MIN_TEXT_LENGTH:
            skipped += 1
            continue

        articles.append(
            {
                "id": str(record.get("id", len(articles))),
                "title": title,
                "text": text,
                "language": lang_code,
                "length": len(text),
            }
        )

        if len(articles) % 1000 == 0:
            elapsed = time.time() - t0
            print(f"    {len(articles)} articles collected ({elapsed:.1f}s, {skipped} skipped)...")

        if len(articles) >= limit:
            break

    elapsed = time.time() - t0
    print(f"  Collected {len(articles)} articles in {elapsed:.1f}s ({skipped} skipped as too short)")
    return articles


def main():
    args = sys.argv[1:]

    lang_filter = None
    limit = DEFAULT_LIMIT

    for arg in args:
        if arg.startswith("--lang="):
            lang_filter = arg.replace("--lang=", "").split(",")
        elif arg.startswith("--limit="):
            limit = int(arg.replace("--limit=", ""))

    selected = {k: v for k, v in LANGUAGES.items() if lang_filter is None or k in lang_filter}

    if not selected:
        print(f"No valid languages selected. Available: {', '.join(LANGUAGES.keys())}")
        sys.exit(1)

    print("Wikipedia article converter for Narsil examples")
    print(f"Languages: {', '.join(f'{k} ({v})' for k, v in selected.items())}")
    print(f"Limit per language: {limit}")
    print(f"Wikipedia snapshot: {WIKIPEDIA_SNAPSHOT}")
    print()

    output_dir = Path(__file__).parent.parent / "data" / "processed" / "wikipedia"
    output_dir.mkdir(parents=True, exist_ok=True)

    for lang_code, lang_name in selected.items():
        print(f"[{lang_code}] {lang_name}")
        articles = fetch_articles(lang_code, limit)

        if not articles:
            print("  No articles fetched, skipping\n")
            continue

        output_path = output_dir / f"wikipedia-{lang_code}.json"
        with open(output_path, "w") as f:
            json.dump(articles, f, ensure_ascii=False)
            f.write("\n")

        size_mb = output_path.stat().st_size / 1024 / 1024
        avg_len = sum(a["length"] for a in articles) // len(articles)
        print(f"  Written: {output_path} ({len(articles)} articles, {size_mb:.1f} MB)")
        print(f"  Avg text length: {avg_len} chars")
        print()

    print("Done.")


if __name__ == "__main__":
    main()
