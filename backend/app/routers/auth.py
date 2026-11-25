"""
Authentication routes: register, login, password reset by email, email verification, change password.
Rate-limited; no credentials, tokens or emails in the logs.
"""

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.user import User
from app.schemas.auth import (UserRegister, UserResponse, Token, MessageResponse, ForgotPasswordIn,
                              ResetPasswordIn, TokenIn, ChangePasswordIn)
from app.services import auth as svc
from app.services import mailer
from app.utils.auth import get_current_user, token_for, client_ip, normalize_email
from app.utils import ratelimit as rl
from fastapi import HTTPException, status

router = APIRouter()

HOUR = 3600


def _link(path: str, token: str) -> str:
    # token in the #fragment: browsers never send it to the server or in the Referer
    return f"{settings.APP_BASE_URL.rstrip('/')}{path}#token={token}"


def _send_verification(db: Session, user: User, background: BackgroundTasks):
    token = svc.issue_token(db, user, "verify")
    background.add_task(mailer.verify_email_mail, user.email, user.name, _link("/verify-email", token), svc.VERIFY_HOURS)


@router.post("/register", response_model=MessageResponse)
def register_user(user_data: UserRegister, request: Request, background: BackgroundTasks,
                  db: Session = Depends(get_db)):
    """Same answer whether the email is free or taken (the owner of a taken address gets an email instead)."""
    rl.check_and_record(f"register:ip:{client_ip(request)}", 10, HOUR)
    user = svc.create_user(db, user_data)
    if user:
        _send_verification(db, user, background)
    else:
        background.add_task(mailer.someone_registered_mail, user_data.email)
    return {"message": "Done. You can sign in now - we also sent you an email to confirm your address."}


@router.post("/login", response_model=Token)
def login_user(request: Request, form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    ip = client_ip(request)
    email = normalize_email(form_data.username)
    rl.check_and_record(f"login:ip:{ip}", 30, 600)
    fail_key = f"login:fail:{email}"
    wait = rl.retry_after(fail_key, 5, 900)          # 5 wrong passwords per account in 15 min
    if wait:
        rl.too_many(wait)
    user = svc.authenticate_user(db, email, form_data.password)
    if not user:
        rl.record(fail_key)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    rl.reset(fail_key)
    return {"access_token": token_for(user), "token_type": "bearer"}


@router.get("/me", response_model=UserResponse)
def get_current_user_info(current_user: User = Depends(get_current_user)):
    return current_user


@router.post("/forgot-password", response_model=MessageResponse)
def forgot_password(body: ForgotPasswordIn, request: Request, background: BackgroundTasks,
                    db: Session = Depends(get_db)):
    """Always the same answer, so the form cannot be used to find out who has an account."""
    rl.check_and_record(f"forgot:ip:{client_ip(request)}", 5, HOUR)
    email = normalize_email(str(body.email))
    answer = {"message": "If an account with this email exists, we have sent a link to reset the password. "
                         "Check your inbox (and the spam folder)."}
    if rl.retry_after(f"forgot:email:{email}", 3, HOUR):
        return answer                                  # quietly: no more than 3 mails per hour to one address
    rl.record(f"forgot:email:{email}")
    user = svc.get_user_by_email(db, email)
    if user and user.is_active:
        token = svc.issue_token(db, user, "reset")
        background.add_task(mailer.password_reset_mail, user.email, user.name,
                            _link("/reset-password", token), svc.RESET_MINUTES)
    return answer


@router.post("/reset-password", response_model=MessageResponse)
def reset_password(body: ResetPasswordIn, request: Request, db: Session = Depends(get_db)):
    rl.check_and_record(f"reset:ip:{client_ip(request)}", 20, HOUR)
    svc.reset_password(db, body.token, body.password)
    return {"message": "Password changed. Sign in with the new password - other devices have been signed out."}


@router.post("/verify-email", response_model=MessageResponse)
def verify_email(body: TokenIn, request: Request, db: Session = Depends(get_db)):
    rl.check_and_record(f"verify:ip:{client_ip(request)}", 20, HOUR)
    svc.verify_email(db, body.token)
    return {"message": "Email confirmed. Thank you!"}


@router.post("/resend-verification", response_model=MessageResponse)
def resend_verification(background: BackgroundTasks, current_user: User = Depends(get_current_user),
                        db: Session = Depends(get_db)):
    if current_user.email_verified:
        return {"message": "Your email is already confirmed."}
    rl.check_and_record(f"resend:user:{current_user.id}", 3, HOUR)
    _send_verification(db, current_user, background)
    return {"message": "We sent a new confirmation link to your email."}


@router.post("/change-password", response_model=Token)
def change_password(body: ChangePasswordIn, current_user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    """New password; every other session is signed out, this one gets a fresh token."""
    fail_key = f"change:fail:{current_user.id}"
    wait = rl.retry_after(fail_key, 5, 900)
    if wait:
        rl.too_many(wait)
    try:
        user = svc.change_password(db, current_user, body.current_password, body.new_password)
    except HTTPException as e:
        if e.detail == "Current password is wrong":
            rl.record(fail_key)
        raise
    return {"access_token": token_for(user), "token_type": "bearer"}


@router.post("/logout-all", response_model=Token)
def logout_all(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Sign out on every other device (stolen token, shared computer)."""
    user = svc.logout_everywhere(db, current_user)
    return {"access_token": token_for(user), "token_type": "bearer"}
