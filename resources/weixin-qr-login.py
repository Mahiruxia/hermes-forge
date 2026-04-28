import asyncio
import datetime
import json
import sys
import time

from hermes_constants import get_hermes_home
from gateway.platforms import weixin as wx


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def expires_at(seconds):
    return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=seconds)).isoformat()


async def fetch_qr(session, bot_type):
    qr_resp = await wx._api_get(
        session,
        base_url=wx.ILINK_BASE_URL,
        endpoint=f"{wx.EP_GET_BOT_QR}?bot_type={bot_type}",
        timeout_ms=wx.QR_TIMEOUT_MS,
    )
    qrcode_value = str(qr_resp.get("qrcode") or "")
    qrcode_url = str(qr_resp.get("qrcode_img_content") or "")
    if not qrcode_value:
        raise RuntimeError("二维码响应缺少 qrcode。")
    emit({
        "type": "qr",
        "qrUrl": qrcode_url or qrcode_value,
        "expiresAt": expires_at(120),
        "message": "请使用微信扫描二维码，并在手机上确认。",
    })
    return qrcode_value


async def main():
    if not wx.AIOHTTP_AVAILABLE:
        emit({"type": "error", "code": "missing_aiohttp", "message": "缺少 Weixin 扫码依赖 aiohttp。"})
        return 2

    bot_type = "3"
    timeout_seconds = 480
    hermes_home = str(get_hermes_home())
    emit({"type": "phase", "phase": "fetching_qr", "message": "正在获取微信二维码..."})

    async with wx.aiohttp.ClientSession(trust_env=True, connector=wx._make_ssl_connector()) as session:
        try:
            qrcode_value = await fetch_qr(session, bot_type)
        except Exception as exc:
            emit({"type": "error", "code": "fetch_qr_failed", "message": f"获取微信二维码失败：{exc}"})
            return 1

        deadline = time.time() + timeout_seconds
        current_base_url = wx.ILINK_BASE_URL
        refresh_count = 0
        last_phase = "waiting_scan"
        while time.time() < deadline:
            try:
                status_resp = await wx._api_get(
                    session,
                    base_url=current_base_url,
                    endpoint=f"{wx.EP_GET_QR_STATUS}?qrcode={qrcode_value}",
                    timeout_ms=wx.QR_TIMEOUT_MS,
                )
            except asyncio.TimeoutError:
                await asyncio.sleep(1)
                continue
            except Exception as exc:
                emit({"type": "phase", "phase": last_phase, "message": f"扫码状态检查暂时失败，正在重试：{exc}"})
                await asyncio.sleep(1)
                continue

            status = str(status_resp.get("status") or "wait")
            if status == "wait":
                if last_phase != "waiting_scan":
                    emit({"type": "phase", "phase": "waiting_scan", "message": "等待微信扫码..."})
                    last_phase = "waiting_scan"
            elif status == "scaned":
                emit({"type": "phase", "phase": "waiting_confirm", "message": "已扫码，请在微信手机端确认登录。"})
                last_phase = "waiting_confirm"
            elif status == "scaned_but_redirect":
                redirect_host = str(status_resp.get("redirect_host") or "")
                if redirect_host:
                    current_base_url = f"https://{redirect_host}"
                emit({"type": "phase", "phase": "waiting_confirm", "message": "已扫码，正在切换确认服务器..."})
                last_phase = "waiting_confirm"
            elif status == "expired":
                refresh_count += 1
                if refresh_count > 3:
                    emit({"type": "error", "code": "expired", "message": "二维码多次过期，请重新扫码。"})
                    return 1
                emit({"type": "phase", "phase": "fetching_qr", "message": f"二维码已过期，正在刷新 ({refresh_count}/3)..."})
                try:
                    qrcode_value = await fetch_qr(session, bot_type)
                    current_base_url = wx.ILINK_BASE_URL
                    last_phase = "waiting_scan"
                except Exception as exc:
                    emit({"type": "error", "code": "refresh_qr_failed", "message": f"刷新微信二维码失败：{exc}"})
                    return 1
            elif status == "confirmed":
                account_id = str(status_resp.get("ilink_bot_id") or "")
                token = str(status_resp.get("bot_token") or "")
                base_url = str(status_resp.get("baseurl") or wx.ILINK_BASE_URL)
                user_id = str(status_resp.get("ilink_user_id") or "")
                if not account_id or not token:
                    emit({"type": "error", "code": "incomplete_credentials", "message": "微信已确认，但返回凭据不完整。"})
                    return 1
                wx.save_weixin_account(hermes_home, account_id=account_id, token=token, base_url=base_url, user_id=user_id)
                emit({"type": "confirmed", "accountId": account_id, "token": token, "baseUrl": base_url, "userId": user_id})
                return 0
            else:
                emit({"type": "phase", "phase": last_phase, "message": f"等待微信确认，当前状态：{status}"})
            await asyncio.sleep(1)

    emit({"type": "error", "code": "timeout", "message": "微信扫码登录超时，请重新扫码。"})
    return 1


sys.exit(asyncio.run(main()))
