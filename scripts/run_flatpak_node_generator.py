#!/usr/bin/env python3
"""Run the pinned generator with a bounded limit for GitHub response headers."""

import contextlib
from collections.abc import AsyncIterator

import aiohttp
from flatpak_node_generator.main import main as generator_main
from flatpak_node_generator.requests import Requests


MAX_HEADER_FIELD_SIZE = 65536


class HeaderLimitedRequests(Requests):
    """Keep upstream fetching behavior while accepting larger CSP headers."""

    @contextlib.asynccontextmanager
    async def _open_stream(self, url: str) -> AsyncIterator[aiohttp.StreamReader]:
        # Match the pinned Requests._open_stream; change only this parser limit.
        # TLS validation, status errors, redirects, retries and caching remain
        # with aiohttp and the upstream Requests implementation.
        async with (
            aiohttp.ClientSession(
                raise_for_status=True, max_field_size=MAX_HEADER_FIELD_SIZE
            ) as session,
            session.get(url) as response,
        ):
            yield response.content


if __name__ == "__main__":
    Requests.instance = HeaderLimitedRequests()
    generator_main()
