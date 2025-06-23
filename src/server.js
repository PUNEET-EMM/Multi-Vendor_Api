
import app from './app.js';
import connectDB from './config/db.js';
import { initRedis, getRedisClient } from './config/redis.js';
import logger from './utils/logger.js';
import mongoose from 'mongoose';

const port = process.env.PORT || 3000;

const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}. Initiating graceful shutdown...`);

  try {
    const redisClient = getRedisClient();
    if (redisClient) await redisClient.quit();

    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      logger.info('MongoDB connection closed.');
    }

    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const startServer = async () => {
  try {
    await connectDB();
    await initRedis();

    app.listen(port, () => {
      logger.info(` Server is running on http://localhost:${port}`);
    });
  } catch (error) {
    logger.error('Startup failed:', error);
    process.exit(1);
  }
};

startServer();
