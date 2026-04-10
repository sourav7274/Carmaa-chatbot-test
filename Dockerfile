# Use an official Node runtime as a parent image
FROM node:22-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies (including devDependencies needed for tsx and vite build)
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the frontend assets using Vite
RUN npm run build

# Expose port 3000 to the outside world
EXPOSE 3000

# Set Node to production mode
ENV NODE_ENV=production

# Command to run the application
CMD ["npm", "run", "start"]
