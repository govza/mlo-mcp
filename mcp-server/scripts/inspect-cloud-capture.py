"""Print a credential-safe structural summary of captured MLO SOAP flows."""

from __future__ import annotations

import json
import re
from mitmproxy import http


SENSITIVE = re.compile(r"pass|credential|token|secret|session|cookie|email|user|login", re.I)


TAG = re.compile(r"<(?!/)(?:[\w.-]+:)?([\w.-]+)(?:\s[^>]*)?>", re.I)


def body_xml(content: bytes) -> str:
    """Extract the SOAP Body without an XML dependency.

    The standalone Windows mitmproxy build intentionally ships a very small
    Python runtime, so even parts of the standard library may be unavailable.
    This is structural logging only, not protocol parsing.
    """
    text = content.decode("utf-8", errors="replace")
    match = re.search(
        r"<(?:[\w.-]+:)?Body(?:\s[^>]*)?>(.*?)</(?:[\w.-]+:)?Body\s*>",
        text,
        re.I | re.S,
    )
    return match.group(1) if match else ""


def operation_shape(content: bytes) -> tuple[str, list[str]]:
    body = body_xml(content)
    operation = TAG.search(body)
    if not operation:
        return "<unknown>", []
    operation_name = operation.group(1)
    start = operation.end()
    close = re.search(rf"</(?:[\w.-]+:)?{re.escape(operation_name)}\s*>", body[start:], re.I)
    inner = body[start:start + close.start()] if close else body[start:]
    fields = list(dict.fromkeys(match.group(1) for match in TAG.finditer(inner)))
    return operation_name, fields


class SoapSummary:
    def response(self, flow: http.HTTPFlow) -> None:
        if flow.request.host.lower() != "sync.mylifeorganized.net":
            return
        content_type = flow.response.headers.get("content-type", "")
        if "xml" not in content_type:
            return
        operation, request_fields = operation_shape(flow.request.raw_content or b"")
        response_operation, response_fields = operation_shape(flow.response.raw_content or b"")
        print(json.dumps({
            "operation": operation,
            "soapAction": flow.request.headers.get("soapaction", "").strip('"'),
            "requestFields": request_fields,
            "status": flow.response.status_code,
            "responseOperation": response_operation,
            "responseFields": [
                field if not SENSITIVE.search(field) else "<sensitive-field>"
                for field in response_fields
            ],
        }, separators=(",", ":")))


addons = [SoapSummary()]
