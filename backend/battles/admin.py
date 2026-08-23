from django.contrib import admin

from .models import Battle, Round, Submission


@admin.register(Battle)
class BattleAdmin(admin.ModelAdmin):
    list_display = (
        "id",
        "player1",
        "player2",
        "status",
        "current_round",
        "player1_hp",
        "player2_hp",
        "winner",
        "created_at",
    )
    list_filter = ("status", "created_at")
    search_fields = ("player1__username", "player2__username")


@admin.register(Round)
class RoundAdmin(admin.ModelAdmin):
    list_display = (
        "battle",
        "round_number",
        "problem",
        "started_at",
    )
    list_filter = ("round_number", "problem__difficulty")


@admin.register(Submission)
class SubmissionAdmin(admin.ModelAdmin):
    list_display = (
        "player",
        "problem",
        "battle",
        "language",
        "status",
        "passed_cases",
        "total_cases",
        "execution_time_ms",
        "submitted_at",
    )
    list_filter = ("language", "status", "submitted_at")
    search_fields = ("player__username", "problem__title")

