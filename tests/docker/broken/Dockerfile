FROM python:3.11-alpine
COPY broken_server.py /app/broken_server.py
EXPOSE 5353/udp 49155/tcp
CMD ["python3", "/app/broken_server.py"]
