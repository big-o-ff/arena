"""Project-wide DRF exception handling."""
from __future__ import annotations

import re

from rest_framework.views import exception_handler as drf_exception_handler

# `django.shortcuts.get_object_or_404` raises Http404("No %s matches the given
# query."), and DRF hands that string straight to the client as `detail`. Pages
# that surface `detail` verbatim were therefore showing players Django's model
# name and ORM phrasing — "No Battle matches the given query." — on the battle
# review and ended screens.
_ORM_404 = re.compile(r"^No .+ matches the given query\.?$")

# Matches DRF's own NotFound default, so both 404 paths read identically.
FRIENDLY_404 = "Not found."


def exception_handler(exc, context):
    response = drf_exception_handler(exc, context)
    if response is None or response.status_code != 404:
        return response
    if isinstance(response.data, dict):
        detail = response.data.get("detail")
        if isinstance(detail, str) and _ORM_404.match(detail):
            response.data["detail"] = FRIENDLY_404
    return response
