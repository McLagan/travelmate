"""
Outgoing email (password reset, email verification) over SMTP.

- SMTP_HOST set: that server (e.g. Gmail with an app password, or a mail service once there is a domain)
- SMTP_HOST empty in development: the Mailpit container from docker-compose.dev.yml; open http://localhost:8025
- otherwise: nothing is sent and a warning is logged (the link itself is never logged)
Called from BackgroundTasks, so the HTTP answer does not wait for the mail server.
"""

import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from app.config import settings

log = logging.getLogger("travelmate.mail")


def _server():
    if settings.SMTP_HOST:
        return settings.SMTP_HOST, settings.SMTP_PORT, settings.SMTP_SECURITY, settings.SMTP_USER, settings.SMTP_PASSWORD
    if settings.is_development and settings.DEV_MAIL_CATCHER:
        host, _, port = settings.DEV_MAIL_CATCHER.partition(":")
        return host, int(port or 1025), "none", "", ""
    return None


def configured() -> bool:
    return _server() is not None


def send_mail(to: str, subject: str, text: str, html: str = None) -> bool:
    srv = _server()
    if not srv:
        log.warning("Email is not configured (SMTP_HOST is empty): '%s' was not sent", subject)
        print(f"⚠️  Email not configured: '{subject}' was not sent")
        return False
    host, port, security, user, password = srv
    sender = settings.MAIL_FROM or user or "no-reply@travelmate.local"
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr(("TravelMate", sender))
    msg["To"] = to
    msg["Message-ID"] = make_msgid(domain=sender.split("@")[-1] if "@" in sender else None)
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    try:
        if security == "ssl":
            with smtplib.SMTP_SSL(host, port, timeout=20, context=ssl.create_default_context()) as s:
                if user:
                    s.login(user, password)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=20) as s:
                if security == "starttls":
                    s.starttls(context=ssl.create_default_context())
                if user:
                    s.login(user, password)
                s.send_message(msg)
        print(f"✉️  Email sent: '{subject}'")
        return True
    except Exception as e:      # never let a mail problem break the request; no addresses/links in the log
        print(f"❌ Email '{subject}' failed: {type(e).__name__}: {e}")
        return False


def _html(title: str, body: str, button: str, url: str, note: str) -> str:
    from html import escape
    return f"""<!DOCTYPE html><html><body style="margin:0;background:#f3f4f6;font-family:Arial,sans-serif">
<div style="max-width:480px;margin:24px auto;background:#fff;border-radius:12px;padding:28px;color:#111827">
<h2 style="margin:0 0 12px">{escape(title)}</h2><p style="line-height:1.5">{escape(body)}</p>
<p style="margin:24px 0"><a href="{escape(url, quote=True)}" style="background:#2563eb;color:#fff;padding:12px 20px;
border-radius:8px;text-decoration:none;display:inline-block">{escape(button)}</a></p>
<p style="font-size:13px;color:#6b7280;line-height:1.5">{escape(note)}</p>
<p style="font-size:12px;color:#9ca3af;word-break:break-all">{escape(url)}</p></div></body></html>"""


def password_reset_mail(to: str, name: str, url: str, minutes: int):
    hello = f"Hi {name}," if name else "Hi,"
    text = (f"{hello}\n\nSomeone (hopefully you) asked to reset the password of your TravelMate account.\n"
            f"Open this link to choose a new password (valid for {minutes} minutes, works once):\n\n{url}\n\n"
            "If you did not ask for this, just ignore this email - your password stays the same.\n")
    send_mail(to, "Reset your TravelMate password", text,
              _html("Reset your password", f"{hello} someone (hopefully you) asked to reset the password of your TravelMate account.",
                    "Choose a new password", url,
                    f"The link is valid for {minutes} minutes and works once. If you did not ask for this, ignore this email."))


def verify_email_mail(to: str, name: str, url: str, hours: int):
    hello = f"Hi {name}," if name else "Hi,"
    text = (f"{hello}\n\nPlease confirm this email address for your TravelMate account:\n\n{url}\n\n"
            f"The link is valid for {hours} hours. If you did not create an account, ignore this email.\n")
    send_mail(to, "Confirm your email for TravelMate", text,
              _html("Confirm your email", f"{hello} please confirm this email address for your TravelMate account.",
                    "Confirm email", url,
                    f"The link is valid for {hours} hours. If you did not create an account, ignore this email."))


def someone_registered_mail(to: str):
    """Sent instead of a second account when someone signs up with an address that already has one."""
    url = f"{settings.APP_BASE_URL}/"
    text = ("Someone tried to create a TravelMate account with this email address, but you already have one.\n"
            f"If it was you, sign in at {url} - or use 'Forgot password?' there.\n"
            "If it was not you, ignore this email.\n")
    send_mail(to, "You already have a TravelMate account", text)
