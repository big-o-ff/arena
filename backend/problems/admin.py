from django.contrib import admin

from .models import Problem


@admin.register(Problem)
class ProblemAdmin(admin.ModelAdmin):
    list_display = ("title", "difficulty", "is_active", "created_at")
    list_filter = ("difficulty", "is_active")
    search_fields = ("title",)

