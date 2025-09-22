"""
Profile router for user profile management
"""

from typing import List
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from sqlalchemy.orm import Session

from app.database import get_db
from app.utils.auth import get_current_user
from app.models import User
from app.services.profile import ProfileService
from app.services.file_service import file_service
from app.schemas.profile import (
    UserProfileUpdate,
    UserProfileResponse,
    VisitedCountryCreate,
    VisitedCountryResponse,
    UserPlaceCreate,
    UserPlaceUpdate,
    UserPlaceResponse,
    PlaceImageCreate,
    PlaceImageResponse,
    ProfileSummaryResponse,
    CountryOption
)

router = APIRouter()


@router.get("/me", response_model=UserProfileResponse)
async def get_my_profile(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get current user profile"""
    return current_user


@router.put("/me", response_model=UserProfileResponse)
async def update_my_profile(
    profile_data: UserProfileUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update current user profile"""
    updated_user = ProfileService.update_user_profile(db, current_user.id, profile_data)
    if not updated_user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    return updated_user


@router.post("/avatar", response_model=dict)
async def upload_avatar(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Upload and update user avatar"""

    # Delete old avatar files if exists
    if current_user.avatar_url:
        file_service.delete_avatar_files(current_user.avatar_url)

    # Process and save new avatar
    saved_files = await file_service.process_and_save_avatar(file, current_user.id)

    # Update user avatar_url in database
    avatar_url = file_service.get_avatar_url(saved_files, "medium")
    profile_data = UserProfileUpdate(avatar_url=avatar_url)
    updated_user = ProfileService.update_user_profile(db, current_user.id, profile_data)

    if not updated_user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )

    return {
        "message": "Avatar uploaded successfully",
        "avatar_url": avatar_url,
        "available_sizes": saved_files
    }


@router.delete("/avatar")
async def delete_avatar(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Delete user avatar"""

    if current_user.avatar_url:
        # Delete files from filesystem
        file_service.delete_avatar_files(current_user.avatar_url)

        # Remove avatar_url from database
        profile_data = UserProfileUpdate(avatar_url=None)
        updated_user = ProfileService.update_user_profile(db, current_user.id, profile_data)

        if not updated_user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )

    return {"message": "Avatar deleted successfully"}


@router.get("/dashboard", response_model=ProfileSummaryResponse)
async def get_profile_dashboard(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get profile dashboard with summary"""
    summary = ProfileService.get_profile_summary(db, current_user.id)
    if not summary:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Profile not found"
        )
    return summary


# Visited Countries endpoints
@router.get("/visited-countries", response_model=List[VisitedCountryResponse])
async def get_visited_countries(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get user's visited countries"""
    return ProfileService.get_visited_countries(db, current_user.id)


@router.post("/visited-countries", response_model=VisitedCountryResponse)
async def add_visited_country(
    country_data: VisitedCountryCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Add visited country"""
    return ProfileService.add_visited_country(db, current_user.id, country_data)


@router.delete("/visited-countries/{country_id}")
async def remove_visited_country(
    country_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Remove visited country"""
    success = ProfileService.remove_visited_country(db, current_user.id, country_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Country not found"
        )
    return {"message": "Country removed successfully"}


# User Places endpoints
@router.get("/places", response_model=List[UserPlaceResponse])
async def get_my_places(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get user's places"""
    return ProfileService.get_user_places(db, current_user.id)


@router.post("/places", response_model=UserPlaceResponse)
async def create_place(
    place_data: UserPlaceCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Create new user place"""
    return ProfileService.create_user_place(db, current_user.id, place_data)


@router.put("/places/{place_id}", response_model=UserPlaceResponse)
async def update_place(
    place_id: int,
    place_data: UserPlaceUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update user place"""
    updated_place = ProfileService.update_user_place(db, current_user.id, place_id, place_data)
    if not updated_place:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Place not found"
        )
    return updated_place


@router.delete("/places/{place_id}")
async def delete_place(
    place_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Delete user place"""
    success = ProfileService.delete_user_place(db, current_user.id, place_id)
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Place not found"
        )
    return {"message": "Place deleted successfully"}


@router.post("/places/{place_id}/images", response_model=PlaceImageResponse)
async def add_place_image(
    place_id: int,
    image_data: PlaceImageCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Add image to place"""
    place_image = ProfileService.add_place_image(db, current_user.id, place_id, image_data)
    if not place_image:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Place not found"
        )
    return place_image


# Utility endpoints
@router.get("/countries", response_model=List[CountryOption])
async def get_countries_list():
    """Get list of countries for selection"""
    return ProfileService.get_countries_list()