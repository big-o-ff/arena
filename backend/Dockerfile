FROM python:3.12-slim

# Code execution needs node (javascript submissions) and g++ (cpp submissions)
# on PATH in every process image, not just the worker, since execution.py
# resolves tools lazily from whichever process runs it.
RUN apt-get update && apt-get install -y --no-install-recommends \
    g++ \
    curl \
    ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN python manage.py collectstatic --noinput --settings=config.settings || true

ENV PYTHONUNBUFFERED=1
EXPOSE 8000

CMD ["daphne", "-b", "0.0.0.0", "-p", "8000", "config.asgi:application"]
