import mongoose from 'mongoose';
import { createClient } from 'redis';
import axios from 'axios';
import logger from './utils/logger.js';
import Job from './models/Job.js';

class VendorWorker {
  constructor() {
    this.redisClient = null;
    this.isRunning = false;
    this.rateLimiters = new Map();
    this.maxRetries = 3;
    this.retryDelay = 1000;

    this.rateLimits = {
      sync: { limit: 30, window: 60000 },
      async: { limit: 20, window: 60000 }
    };

    this.vendorUrls = {
      sync: process.env.MOCK_VENDOR_SYNC_URL || 'http://localhost:3001',
      async: process.env.MOCK_VENDOR_ASYNC_URL || 'http://localhost:3002'
    };
  }

  async initialize() {
    try {
      const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/vendor_service';
      await mongoose.connect(mongoUri);
      logger.info('Worker connected to MongoDB');

      this.redisClient = createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379'
      });

      this.redisClient.on('error', (err) => {
        logger.error('Redis error:', err);
      });

      await this.redisClient.connect();
      logger.info('Worker connected to Redis');

      this.initializeRateLimiters();
    } catch (error) {
      logger.error('Worker initialization failed:', error);
      throw error;
    }
  }

  initializeRateLimiters() {
    for (const [vendor, config] of Object.entries(this.rateLimits)) {
      this.rateLimiters.set(vendor, {
        requests: [],
        limit: config.limit,
        window: config.window
      });
    }
  }

  async checkRateLimit(vendor) {
    const rateLimiter = this.rateLimiters.get(vendor);
    if (!rateLimiter) return true;

    const now = Date.now();
    const windowStart = now - rateLimiter.window;
    rateLimiter.requests = rateLimiter.requests.filter(time => time > windowStart);

    if (rateLimiter.requests.length >= rateLimiter.limit) {
      const oldestRequest = Math.min(...rateLimiter.requests);
      const waitTime = rateLimiter.window - (now - oldestRequest);
      logger.info(`Rate limit reached for ${vendor}, waiting ${waitTime}ms`);
      return false;
    }

    rateLimiter.requests.push(now);
    return true;
  }

  async waitForRateLimit(vendor) {
    while (!(await this.checkRateLimit(vendor))) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  async processJob(jobData) {
    const { request_id, payload } = jobData;

    try {
      logger.info('Processing job:', { request_id });

      const job = await Job.findOne({ request_id });
      if (!job) {
        logger.error('Job not found:', { request_id });
        return;
      }

      job.status = 'processing';
      job.started_processing_at = new Date();
      job.updated_at = new Date();
      await job.save();

      const vendors = ['sync', 'async'];
      const selectedVendor = vendors[Math.floor(Math.random() * vendors.length)];
      job.vendor = selectedVendor;
      await job.save();

      logger.info('Selected vendor:', { request_id, vendor: selectedVendor });

      await this.waitForRateLimit(selectedVendor);

      const result = await this.callVendor(selectedVendor, { request_id, payload });

      if (selectedVendor === 'sync') {
        await this.processSyncResult(job, result);
      } else {
        job.status = 'processing';
        job.updated_at = new Date();
        await job.save();
        logger.info('Async job submitted, waiting for webhook:', { request_id });
      }

    } catch (error) {
      logger.error('Error processing job:', { request_id, error: error.message });
      await this.handleJobError(request_id, error);
    }
  }

  async callVendor(vendor, data) {
    const url = this.vendorUrls[vendor];
    const timeout = vendor === 'sync' ? 30000 : 10000;

    try {
      logger.info('Calling vendor:', { vendor, url, request_id: data.request_id });

      const response = await axios.post(`${url}/process`, data, {
        timeout,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'VendorWorker/1.0'
        }
      });

      logger.info('Vendor response received:', {
        vendor,
        request_id: data.request_id,
        status: response.status
      });

      return response.data;
    } catch (error) {
      logger.error('Vendor call failed:', {
        vendor,
        request_id: data.request_id,
        error: error.message
      });
      throw error;
    }
  }

  async processSyncResult(job, result) {
    try {
      if (result && result.status === 'success') {
        const cleanedData = this.cleanVendorData(result.data);
        job.result = cleanedData;
        job.status = 'complete';
        job.completed_at = new Date();
        logger.info('Sync job completed:', { request_id: job.request_id });
      } else {
        job.status = 'failed';
        job.error_message = result?.error || 'Vendor processing failed';
        job.failed_at = new Date();
        logger.warn('Sync job failed:', {
          request_id: job.request_id,
          error: job.error_message
        });
      }

      job.updated_at = new Date();
      await job.save();
    } catch (error) {
      logger.error('Error processing sync result:', error);
      throw error;
    }
  }

  cleanVendorData(data) {
    if (!data || typeof data !== 'object') return data;

    const cleaned = { ...data };
    const piiFields = ['ssn', 'social_security_number', 'credit_card', 'password', 'secret'];

    piiFields.forEach(field => {
      if (cleaned[field]) delete cleaned[field];
    });

    Object.keys(cleaned).forEach(key => {
      if (typeof cleaned[key] === 'string') {
        cleaned[key] = cleaned[key].trim();
      } else if (typeof cleaned[key] === 'object' && cleaned[key] !== null) {
        cleaned[key] = this.cleanVendorData(cleaned[key]);
      }
    });

    return cleaned;
  }

  async handleJobError(requestId, error) {
    try {
      const job = await Job.findOne({ request_id: requestId });
      if (!job) return;

      job.retry_count = (job.retry_count || 0) + 1;

      if (job.retry_count < this.maxRetries) {
        job.status = 'pending';
        job.updated_at = new Date();
        await job.save();

        setTimeout(async () => {
          const queuePayload = {
            request_id: requestId,
            payload: job.payload,
            retry: true,
            retry_count: job.retry_count
          };

          await this.redisClient.lPush('job_queue', JSON.stringify(queuePayload));
          logger.info('Job requeued for retry:', {
            request_id: requestId,
            retry_count: job.retry_count
          });
        }, this.retryDelay * job.retry_count);

      } else {
        job.status = 'failed';
        job.error_message = `Max retries reached: ${error.message}`;
        job.failed_at = new Date();
        job.updated_at = new Date();
        await job.save();

        logger.error('Job failed after max retries:', {
          request_id: requestId,
          error: error.message
        });
      }
    } catch (saveError) {
      logger.error('Error handling job error:', saveError);
    }
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Worker is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Worker started, waiting for jobs...');

    while (this.isRunning) {
      try {
        const result = await this.redisClient.brPop('job_queue', 5);

        if (result) {
          const jobData = JSON.parse(result.element);
          await this.processJob(jobData);
        }
      } catch (error) {
        logger.error('Error in worker loop:', error);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  async stop() {
    logger.info('Stopping worker...');
    this.isRunning = false;

    if (this.redisClient) {
      await this.redisClient.quit();
    }

    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }

    logger.info('Worker stopped');
  }
}

const worker = new VendorWorker();

const gracefulShutdown = async (signal) => {
  logger.info(`Received ${signal}. Shutting down worker gracefully...`);
  await worker.stop();
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const startWorker = async () => {
    try {
      await worker.initialize();
      await worker.start();
    } catch (error) {
      logger.error('Failed to start worker:', error);
      process.exit(1);
    }
  };

  startWorker();
}

export default VendorWorker;
