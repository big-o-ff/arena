from django.contrib import admin

from .models import SabotageMove


@admin.register(SabotageMove)
class SabotageMoveAdmin(admin.ModelAdmin):
    list_display = ("battle", "attacker", "move_type", "triggered_at")
    list_filter = ("move_type", "triggered_at")
    search_fields = ("attacker__username", "battle__id")

