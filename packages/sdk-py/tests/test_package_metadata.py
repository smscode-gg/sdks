from importlib import metadata

import smscode


def test_version_export_matches_package_metadata() -> None:
    assert metadata.version("smscode") == smscode.VERSION
    assert smscode.__version__ == smscode.VERSION


def test_public_clients_are_exported() -> None:
    assert smscode.SmscodeClient.__name__ == "SmscodeClient"
    assert smscode.AsyncSmscodeClient.__name__ == "AsyncSmscodeClient"


def test_idempotency_pattern_is_exported() -> None:
    assert smscode.IDEMPOTENCY_KEY_PATTERN.match("stable-key")


def test_spec_required_public_models_are_exported() -> None:
    for name in [
        "BalanceV1",
        "BalanceV2",
        "CancelResult",
        "CancelResultV2",
        "Country",
        "CreateOrderResult",
        "CreateOrderResultV1",
        "CreateOrderResultV2",
        "ExchangeRate",
        "Order",
        "OrdersList",
        "OrdersListV2",
        "Product",
        "ProductV2",
        "ProductsPage",
        "ProductsPageV1",
        "ProductsPageV2",
        "Service",
    ]:
        assert hasattr(smscode, name), name
