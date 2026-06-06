FROM node:20-slim

# poppler-utils provides pdftoppm (PDF → image), pdfinfo, and pdftotext (-bbox word boxes)
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.js ./

EXPOSE 5001
CMD ["node", "server.js"]
