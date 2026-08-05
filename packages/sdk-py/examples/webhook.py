from smscode import parse_webhook_event, verify_webhook_signature


def handle_webhook(raw_body: bytes, signature_header: str | None, secret: str) -> tuple[int, str]:
    if not verify_webhook_signature(raw_body, signature_header or "", secret):
        return 401, "bad signature"

    event = parse_webhook_event(raw_body)
    if event["event"] == "order.otp_received":
        otp_code = event["data"].get("otp_code")
        otp_message = event["data"].get("otp_message")
        if otp_code:
            print("OTP:", otp_code)
        else:
            print("SMS received without a classified code:", otp_message)
    return 204, "ok"
