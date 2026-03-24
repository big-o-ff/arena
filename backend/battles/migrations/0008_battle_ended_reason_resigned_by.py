from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("battles", "0007_battle_ends_at"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="battle",
            name="ended_reason",
            field=models.CharField(
                blank=True,
                help_text="How the battle ended: resign, hp_zero, timeout, etc.",
                max_length=32,
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="battle",
            name="resigned_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="battles_resigned",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
