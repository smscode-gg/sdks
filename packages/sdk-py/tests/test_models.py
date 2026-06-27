from smscode.models import OrderCapabilities, V2Fx


def test_core_models_are_inspectable() -> None:
    caps = OrderCapabilities(can_finish=True, can_resend=True, can_cancel=False, can_replace=False)
    fx = V2Fx(pair="USD/IDR", rate="17970", source="manual", as_of="2026-06-27T00:00:00Z")
    assert caps.can_finish is True
    assert fx.pair == "USD/IDR"
