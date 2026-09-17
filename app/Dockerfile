FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py pricing_defaults.json ./
COPY static ./static

ENV CLAUDE_PROJECTS_DIR=/data/projects \
    PRICING_CONFIG=/config/pricing.json \
    PORT=8687

EXPOSE 8687

CMD ["python", "server.py"]
