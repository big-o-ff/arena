from django.urls import path

from .views import ProblemListView


urlpatterns = [
    path("", ProblemListView.as_view(), name="problem-list"),
]

