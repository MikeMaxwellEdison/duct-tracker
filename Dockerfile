FROM node:20-alpine AS fe
WORKDIR /app
COPY frontend/package.json ./frontend/package.json
RUN cd frontend && npm install --no-audit --no-fund
COPY frontend ./frontend
RUN cd frontend && npm run build

FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ./app.py
COPY server ./server
COPY static ./static
COPY --from=fe /app/frontend/dist ./static
RUN mkdir -p /app/data /tmp/uploads/low /tmp/uploads/hi
ENV PORT=10000
CMD ["bash","-lc","exec gunicorn -k uvicorn.workers.UvicornWorker -w 2 -b 0.0.0.0:${PORT} app:app"]