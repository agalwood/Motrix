FROM python:3.11-alpine
COPY pcp_server.py /app/pcp_server.py
EXPOSE 5351/udp
# Standard PCP port: the container runs on the compose bridge network in its
# own namespace, so it cannot clash with natpmp's host-mode miniupnpd.
CMD ["python3", "/app/pcp_server.py", "--bind=0.0.0.0", "--port=5351"]
