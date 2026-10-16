# Nightly pg_dump with rotation and optional S3-compatible upload (ADR-0015).
FROM postgres:17-alpine
RUN apk add --no-cache aws-cli tzdata
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
ENTRYPOINT ["/usr/local/bin/backup.sh"]
CMD ["loop"]
