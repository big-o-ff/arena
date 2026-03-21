from django.urls import path

from .views import SabotageTriggerView


urlpatterns = [
    path("<int:battle_id>/sabotage/", SabotageTriggerView.as_view(), name="battle-sabotage"),
]

