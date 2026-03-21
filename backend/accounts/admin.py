from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import HeatmapEntry, User


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    list_display = (
        "username",
        "display_name",
        "email",
        "role",
        "total_wins",
        "total_losses",
        "is_active",
        "is_staff",
    )
    list_filter = ("role", "is_active", "is_staff")
    search_fields = ("username", "display_name", "email")
    fieldsets = DjangoUserAdmin.fieldsets + (
        (
            "Bigoff Profile",
            {
                "fields": (
                    "role",
                    "display_name",
                    "avatar_url",
                    "total_wins",
                    "total_losses",
                )
            },
        ),
    )


@admin.register(HeatmapEntry)
class HeatmapEntryAdmin(admin.ModelAdmin):
    list_display = ("user", "date", "problems_solved")
    list_filter = ("date",)
    search_fields = ("user__username",)

