from django.contrib import admin

from .models import SpectatorSession


@admin.register(SpectatorSession)
class SpectatorSessionAdmin(admin.ModelAdmin):
    list_display = ("battle", "user", "joined_at")
    list_filter = ("joined_at",)
    search_fields = ("user__username", "battle__id")

