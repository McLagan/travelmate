"""
Profile service for user profile operations
"""

from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.models import User, VisitedCountry, UserPlace, PlaceImage, Route
from app.schemas.profile import (
    UserProfileUpdate,
    VisitedCountryCreate,
    UserPlaceCreate,
    UserPlaceUpdate,
    PlaceImageCreate,
    CountryOption
)


class ProfileService:
    """Service class for profile operations"""

    @staticmethod
    def get_user_profile(db: Session, user_id: int) -> Optional[User]:
        """Get user profile by ID"""
        return db.query(User).filter(User.id == user_id).first()

    @staticmethod
    def update_user_profile(db: Session, user_id: int, profile_data: UserProfileUpdate) -> Optional[User]:
        """Update user profile"""
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            return None

        update_data = profile_data.model_dump(exclude_unset=True)
        for field, value in update_data.items():
            setattr(user, field, value)

        db.commit()
        db.refresh(user)
        return user

    @staticmethod
    def get_visited_countries(db: Session, user_id: int) -> List[VisitedCountry]:
        """Get user's visited countries"""
        return db.query(VisitedCountry).filter(VisitedCountry.user_id == user_id).all()

    @staticmethod
    def add_visited_country(db: Session, user_id: int, country_data: VisitedCountryCreate) -> VisitedCountry:
        """Add visited country"""
        # Check if country already exists for user
        existing = db.query(VisitedCountry).filter(
            VisitedCountry.user_id == user_id,
            VisitedCountry.country_code == country_data.country_code
        ).first()

        if existing:
            return existing

        visited_country = VisitedCountry(
            user_id=user_id,
            **country_data.model_dump()
        )
        db.add(visited_country)
        db.commit()
        db.refresh(visited_country)
        return visited_country

    @staticmethod
    def remove_visited_country(db: Session, user_id: int, country_id: int) -> bool:
        """Remove visited country"""
        country = db.query(VisitedCountry).filter(
            VisitedCountry.id == country_id,
            VisitedCountry.user_id == user_id
        ).first()

        if not country:
            return False

        db.delete(country)
        db.commit()
        return True

    @staticmethod
    def get_user_places(db: Session, user_id: int) -> List[UserPlace]:
        """Get user's places"""
        return db.query(UserPlace).filter(UserPlace.user_id == user_id).all()

    @staticmethod
    def create_user_place(db: Session, user_id: int, place_data: UserPlaceCreate) -> UserPlace:
        """Create new user place"""
        # Extract images data
        images_data = place_data.images or []
        place_dict = place_data.model_dump(exclude={"images"})

        # Create place
        user_place = UserPlace(
            user_id=user_id,
            **place_dict
        )
        db.add(user_place)
        db.flush()  # Get the ID without committing

        # Add images
        for image_data in images_data:
            place_image = PlaceImage(
                place_id=user_place.id,
                **image_data.model_dump()
            )
            db.add(place_image)

        db.commit()
        db.refresh(user_place)
        return user_place

    @staticmethod
    def update_user_place(db: Session, user_id: int, place_id: int, place_data: UserPlaceUpdate) -> Optional[UserPlace]:
        """Update user place"""
        place = db.query(UserPlace).filter(
            UserPlace.id == place_id,
            UserPlace.user_id == user_id
        ).first()

        if not place:
            return None

        update_data = place_data.model_dump(exclude_unset=True)
        for field, value in update_data.items():
            setattr(place, field, value)

        db.commit()
        db.refresh(place)
        return place

    @staticmethod
    def delete_user_place(db: Session, user_id: int, place_id: int) -> bool:
        """Delete user place"""
        place = db.query(UserPlace).filter(
            UserPlace.id == place_id,
            UserPlace.user_id == user_id
        ).first()

        if not place:
            return False

        db.delete(place)
        db.commit()
        return True

    @staticmethod
    def add_place_image(db: Session, user_id: int, place_id: int, image_data: PlaceImageCreate) -> Optional[PlaceImage]:
        """Add image to user place"""
        # Verify place belongs to user
        place = db.query(UserPlace).filter(
            UserPlace.id == place_id,
            UserPlace.user_id == user_id
        ).first()

        if not place:
            return None

        place_image = PlaceImage(
            place_id=place_id,
            **image_data.model_dump()
        )
        db.add(place_image)
        db.commit()
        db.refresh(place_image)
        return place_image

    @staticmethod
    def get_profile_summary(db: Session, user_id: int) -> dict:
        """Get profile summary with statistics"""
        user = ProfileService.get_user_profile(db, user_id)
        if not user:
            return {}

        visited_countries = ProfileService.get_visited_countries(db, user_id)
        user_places = ProfileService.get_user_places(db, user_id)

        total_routes = db.query(func.count(Route.id)).filter(Route.user_id == user_id).scalar()

        return {
            "user": user,
            "visited_countries": visited_countries,
            "user_places": user_places,
            "total_routes": total_routes,
            "total_places": len(user_places),
            "total_countries": len(visited_countries)
        }

    @staticmethod
    def get_countries_list() -> List[CountryOption]:
        """Get list of countries for selection"""
        # This is a basic list. In a real app, you'd use a comprehensive country database
        countries = [
            {"code": "RU", "name": "Russia", "flag": "🇷🇺"},
            {"code": "US", "name": "United States", "flag": "🇺🇸"},
            {"code": "CN", "name": "China", "flag": "🇨🇳"},
            {"code": "JP", "name": "Japan", "flag": "🇯🇵"},
            {"code": "DE", "name": "Germany", "flag": "🇩🇪"},
            {"code": "FR", "name": "France", "flag": "🇫🇷"},
            {"code": "IT", "name": "Italy", "flag": "🇮🇹"},
            {"code": "ES", "name": "Spain", "flag": "🇪🇸"},
            {"code": "GB", "name": "United Kingdom", "flag": "🇬🇧"},
            {"code": "CA", "name": "Canada", "flag": "🇨🇦"},
            {"code": "AU", "name": "Australia", "flag": "🇦🇺"},
            {"code": "BR", "name": "Brazil", "flag": "🇧🇷"},
            {"code": "IN", "name": "India", "flag": "🇮🇳"},
            {"code": "KR", "name": "South Korea", "flag": "🇰🇷"},
            {"code": "MX", "name": "Mexico", "flag": "🇲🇽"},
            {"code": "TH", "name": "Thailand", "flag": "🇹🇭"},
            {"code": "TR", "name": "Turkey", "flag": "🇹🇷"},
            {"code": "EG", "name": "Egypt", "flag": "🇪🇬"},
            {"code": "ZA", "name": "South Africa", "flag": "🇿🇦"},
            {"code": "AR", "name": "Argentina", "flag": "🇦🇷"},
        ]

        return [CountryOption(**country) for country in countries]