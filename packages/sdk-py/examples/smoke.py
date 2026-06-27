from smscode import (
    AsyncSmscodeClient,
    SmscodeClient,
    is_webhook_event,
    parse_webhook_event,
    verify_webhook_signature,
)


def main() -> None:
    assert SmscodeClient.__name__ == "SmscodeClient"
    assert AsyncSmscodeClient.__name__ == "AsyncSmscodeClient"
    assert callable(verify_webhook_signature)
    event = parse_webhook_event('{"event":"webhook.test","data":{"message":"ok"}}')
    assert is_webhook_event(event)


if __name__ == "__main__":
    main()
