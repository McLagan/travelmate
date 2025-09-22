"""
File upload and management service
"""

import os
import uuid
import aiofiles
from typing import Optional
from fastapi import UploadFile, HTTPException
from PIL import Image
import io


class FileService:
    """Service for handling file uploads, especially avatars"""

    def __init__(self):
        self.upload_dir = "uploads"
        self.avatar_dir = os.path.join(self.upload_dir, "avatars")
        self.max_file_size = 5 * 1024 * 1024  # 5MB
        self.allowed_extensions = {".jpg", ".jpeg", ".png", ".webp"}
        self.avatar_sizes = {
            "original": None,  # Keep original size
            "large": (400, 400),
            "medium": (200, 200),
            "small": (100, 100)
        }

        # Create upload directories
        os.makedirs(self.avatar_dir, exist_ok=True)

    def validate_image_file(self, file: UploadFile) -> None:
        """Validate uploaded image file"""

        # Check file size
        if file.size and file.size > self.max_file_size:
            raise HTTPException(
                status_code=413,
                detail=f"File too large. Maximum size is {self.max_file_size // (1024*1024)}MB"
            )

        # Check file extension
        if file.filename:
            ext = os.path.splitext(file.filename)[1].lower()
            if ext not in self.allowed_extensions:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid file type. Allowed: {', '.join(self.allowed_extensions)}"
                )

        # Check MIME type
        if not file.content_type or not file.content_type.startswith('image/'):
            raise HTTPException(
                status_code=400,
                detail="File must be an image"
            )

    def generate_filename(self, original_filename: str, user_id: int) -> str:
        """Generate unique filename for uploaded file"""
        ext = os.path.splitext(original_filename)[1].lower()
        unique_id = str(uuid.uuid4())
        return f"user_{user_id}_{unique_id}{ext}"

    async def process_and_save_avatar(self, file: UploadFile, user_id: int) -> dict:
        """Process and save avatar in multiple sizes"""

        # Validate file
        self.validate_image_file(file)

        # Generate filename
        filename = self.generate_filename(file.filename or "avatar.jpg", user_id)

        # Read file content
        content = await file.read()
        await file.seek(0)  # Reset file pointer

        # Process image with PIL
        try:
            image = Image.open(io.BytesIO(content))

            # Convert to RGB if necessary (for JPEG compatibility)
            if image.mode in ('RGBA', 'LA', 'P'):
                image = image.convert('RGB')

            saved_files = {}

            # Save in different sizes
            for size_name, dimensions in self.avatar_sizes.items():
                if dimensions:
                    # Resize image maintaining aspect ratio
                    resized_image = image.copy()
                    resized_image.thumbnail(dimensions, Image.Resampling.LANCZOS)

                    # Create new image with exact dimensions (center crop if needed)
                    final_image = Image.new('RGB', dimensions, (255, 255, 255))

                    # Calculate position to center the image
                    x = (dimensions[0] - resized_image.width) // 2
                    y = (dimensions[1] - resized_image.height) // 2
                    final_image.paste(resized_image, (x, y))
                else:
                    final_image = image

                # Save file
                size_filename = f"{size_name}_{filename}"
                file_path = os.path.join(self.avatar_dir, size_filename)

                final_image.save(file_path, "JPEG", quality=85, optimize=True)
                saved_files[size_name] = f"/uploads/avatars/{size_filename}"

            return saved_files

        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail=f"Error processing image: {str(e)}"
            )

    def delete_avatar_files(self, avatar_url: str) -> None:
        """Delete avatar files from filesystem"""
        if not avatar_url or not avatar_url.startswith("/uploads/avatars/"):
            return

        # Extract filename from URL
        filename = os.path.basename(avatar_url)

        # Remove size prefix to get base filename
        if "_" in filename:
            parts = filename.split("_", 1)
            if len(parts) > 1:
                base_filename = parts[1]

                # Delete all size variants
                for size_name in self.avatar_sizes.keys():
                    size_filename = f"{size_name}_{base_filename}"
                    file_path = os.path.join(self.avatar_dir, size_filename)
                    try:
                        if os.path.exists(file_path):
                            os.remove(file_path)
                    except Exception:
                        pass  # Ignore deletion errors

    def get_avatar_url(self, saved_files: dict, size: str = "medium") -> str:
        """Get avatar URL for specific size"""
        return saved_files.get(size, saved_files.get("medium", saved_files.get("original", "")))


# Global instance
file_service = FileService()