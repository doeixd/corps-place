# Use Node 20 as base
FROM node:20-slim

# Install system dependencies for TFJS and Libsql
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    curl \
    sqlite3 \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including production native binaries)
RUN npm install

# Copy source code
COPY . .

# Build the project (if necessary, though we use tsx)
# RUN npm run build

# Expose the webhook port
EXPOSE 3000

# Metadata
ENV NODE_ENV=production
ENV DATABASE_URL="file:./dci-relational.db"

# Start the refresh server (to be implemented)
CMD ["npx", "tsx", "src/production/refreshServer.ts"]
