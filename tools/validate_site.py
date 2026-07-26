#!/usr/bin/env python3
"""Validate the dependency-free FiveCut download site before deployment."""

from __future__ import annotations

import json
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"


class SiteParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: set[str] = set()
        self.references: list[tuple[str, str]] = []
        self.title = ""
        self.description = ""
        self._in_title = False

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        values = dict(attrs)
        element_id = values.get("id")
        if element_id:
            self.ids.add(element_id)

        for attribute in ("href", "src"):
            value = values.get(attribute)
            if value:
                self.references.append((attribute, value))

        if tag == "meta" and values.get("name") == "description":
            self.description = values.get("content", "")
        if tag == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data


def fail(message: str) -> None:
    print(f"site validation failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def validate_html() -> None:
    index = SITE / "index.html"
    if not index.is_file():
        fail("site/index.html is missing")

    parser = SiteParser()
    parser.feed(index.read_text(encoding="utf-8"))
    parser.close()

    if not parser.title.strip():
        fail("the page title is empty")
    if len(parser.description.strip()) < 40:
        fail("the meta description is missing or too short")

    for attribute, raw_reference in parser.references:
        parsed = urlsplit(raw_reference)
        if parsed.scheme in {"http", "https", "mailto", "data"}:
            if parsed.scheme == "http":
                fail(f"insecure external URL: {raw_reference}")
            continue

        if raw_reference.startswith("#"):
            fragment = unquote(parsed.fragment)
            if fragment and fragment not in parser.ids:
                fail(f"missing page fragment: {raw_reference}")
            continue

        relative_path = unquote(parsed.path)
        if not relative_path:
            continue
        target = SITE / relative_path
        if not target.is_file():
            fail(f"{attribute} points to missing file: {raw_reference}")


def validate_supporting_files() -> None:
    required = (
        SITE / ".nojekyll",
        SITE / "styles.css",
        SITE / "app.js",
        SITE / "robots.txt",
        SITE / "sitemap.xml",
        SITE / "manifest.webmanifest",
        SITE / "assets" / "fivecut-mark.svg",
        SITE / "assets" / "fivecut-social.png",
    )
    for path in required:
        if not path.is_file():
            fail(f"required file is missing: {path.relative_to(ROOT)}")

    with (SITE / "manifest.webmanifest").open(encoding="utf-8") as handle:
        manifest = json.load(handle)
    if manifest.get("name") != "FiveCut":
        fail("web manifest has the wrong product name")

    ET.parse(SITE / "sitemap.xml")
    ET.parse(SITE / "assets" / "fivecut-mark.svg")

    social = SITE / "assets" / "fivecut-social.png"
    if social.stat().st_size > 1_000_000:
        fail("social preview image exceeds 1 MB")


def main() -> None:
    validate_html()
    validate_supporting_files()
    print("FiveCut site validation passed")


if __name__ == "__main__":
    main()
