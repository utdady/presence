# syntax=docker/dockerfile:1

# --- frontend build ---
FROM node:22-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
COPY frontend/plugins ./plugins
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- runtime ---
FROM python:3.12-slim
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    STATIC_DIR=/app/frontend/dist \
    USERS_FILE=/data/users.json \
    INVITES_FILE=/data/invites.json \
    CORS_ORIGINS=*

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY backend/hash_password.py ./hash_password.py
# Do not bake a roster — seed from USERS_JSON onto the data volume at first boot.
COPY --from=frontend /src/frontend/dist ./frontend/dist

EXPOSE 8000

# JWT_SECRET and USERS_JSON must be set at deploy time (fly secrets set)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
