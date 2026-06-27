import pytest
import respx

from smscode import (
    AsyncSmscodeClient,
    NotFoundError,
    SmscodeClient,
    SmscodeError,
    ValidationError,
)


def test_sync_request_builds_auth_query_and_result() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        route = router.get("/v2/balance", params={"x": "1"}).respond(
            200,
            json={"success": True, "data": {"balance": {"amount": "1.00"}}},
            headers={"X-Request-Id": "req_1"},
        )
        with SmscodeClient(token="tok") as client:
            result = client.request("GET", "/v2/balance", params={"x": 1})
        assert route.called
        assert route.calls[0].request.headers["authorization"] == "Bearer tok"
        assert result.status == 200
        assert result.request_id == "req_1"


@pytest.mark.asyncio
async def test_async_request_maps_error() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v2/orders/1").respond(
            422,
            json={"success": False, "error": {"code": "VALIDATION_ERROR", "message": "bad"}},
        )
        async with AsyncSmscodeClient(token="tok") as client:
            with pytest.raises(ValidationError):
                await client.request("GET", "/v2/orders/1")


def test_success_false_envelope_maps_error_even_on_http_200() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v2/orders/1").respond(
            200,
            json={"success": False, "error": {"code": "NOT_FOUND", "message": "missing"}},
        )
        with SmscodeClient(token="tok") as client, pytest.raises(NotFoundError):
            client.request("GET", "/v2/orders/1")


def test_unstructured_success_false_falls_back_to_base_error() -> None:
    with respx.mock(base_url="https://api.smscode.gg") as router:
        router.get("/v2/orders/1").respond(200, json={"success": False})
        with SmscodeClient(token="tok") as client, pytest.raises(SmscodeError) as exc:
            client.request("GET", "/v2/orders/1")
        assert type(exc.value) is SmscodeError
