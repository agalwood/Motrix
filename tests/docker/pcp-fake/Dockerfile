FROM python:3.11-alpine
COPY pcp_server.py /app/pcp_server.py
EXPOSE 5351/udp 5352/udp
CMD ["python3", "/app/pcp_server.py", "--bind=0.0.0.0", "--port=5352"]
