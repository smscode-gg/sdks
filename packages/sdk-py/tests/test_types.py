from smscode import ApiResult, RequestOptions
from smscode.types import OrderStatus, SortQuery


def test_api_result_shape() -> None:
    result = ApiResult(data={"ok": True}, meta={"fx": "receipt"}, request_id="r1", status=200)
    assert result.data == {"ok": True}
    assert result.meta == {"fx": "receipt"}
    assert result.request_id == "r1"
    assert result.status == 200


def test_public_literal_values() -> None:
    status: OrderStatus = "OTP_RECEIVED"
    sort: SortQuery = "price_asc"
    assert status == "OTP_RECEIVED"
    assert sort == "price_asc"


def test_request_options_defaults() -> None:
    opts = RequestOptions()
    assert opts.params is None
    assert opts.json is None
    assert opts.headers is None
    assert opts.retry is None
