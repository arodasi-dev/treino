FROM python:3.12-alpine
WORKDIR /app
COPY server.py .
ENV DATA_DIR=/data PORT=8787 STATIC_DIR=/site
VOLUME /data
EXPOSE 8787
CMD ["python", "-u", "server.py"]
