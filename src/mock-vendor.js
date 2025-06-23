import express from 'express';
import axios from 'axios';
import logger from './utils/logger.js';

const app = express();
const port = process.env.PORT || 3001;
const vendorType = process.env.VENDOR_TYPE || 'sync';
const apiServerUrl = process.env.API_SERVER_URL || 'http://localhost:3000';

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    vendor_type: vendorType,
    timestamp: new Date().toISOString()
  });
});

const generateMockData = (payload) => {
  const mockData = {
    processed_at: new Date().toISOString(),
    vendor_id: `${vendorType}-vendor`,
    original_payload_keys: Object.keys(payload || {}),
    processed_data: {
      id: Math.random().toString(36).substr(2, 9),
      status: 'processed',
      score: Math.floor(Math.random() * 100),
      metadata: {
        processing_time_ms: Math.floor(Math.random() * 1000) + 100,
        vendor_version: '1.2.3',
        confidence: Math.random().toFixed(2)
      }
    }
  };

  if (Math.random() > 0.7) {
    mockData.ssn = '123-45-6789';
    mockData.credit_card = '4111-1111-1111-1111';
  }

  mockData.description = '  This is a test description with extra spaces  ';
  mockData.note = '\t\nNote with whitespace\n\t';

  return mockData;
};

const getProcessingDelay = () => {
  return Math.floor(Math.random() * 2000) + 500;
};

const shouldSimulateError = () => {
  return Math.random() < 0.1;
};

app.post('/process', async (req, res) => {
  const { request_id, payload } = req.body;

  logger.info(`${vendorType} vendor processing request:`, { request_id });

  try {
    if (!request_id) {
      return res.status(400).json({
        status: 'error',
        error: 'Missing request_id'
      });
    }

    if (Math.random() < 0.05) {
      logger.info(`${vendorType} vendor rate limited:`, { request_id });
      return res.status(429).json({
        status: 'error',
        error: 'Rate limit exceeded',
        retry_after: 60
      });
    }

    if (shouldSimulateError()) {
      logger.info(`${vendorType} vendor simulating error:`, { request_id });
      return res.status(500).json({
        status: 'error',
        error: 'Internal vendor error'
      });
    }

    const processingDelay = getProcessingDelay();

    if (vendorType === 'sync') {
      await new Promise(resolve => setTimeout(resolve, processingDelay));
      const mockData = generateMockData(payload);
      logger.info(`${vendorType} vendor completed processing:`, { request_id, processing_time: processingDelay });

      res.json({
        status: 'success',
        data: mockData,
        processing_time_ms: processingDelay
      });

    } else if (vendorType === 'async') {
      res.status(202).json({
        status: 'accepted',
        request_id,
        message: 'Processing started, result will be sent via webhook'
      });

      setTimeout(async () => {
        try {
          const mockData = generateMockData(payload);
          const status = shouldSimulateError() ? 'error' : 'success';
          const data = status === 'error' 
            ? { error: 'Async processing failed' }
            : mockData;

          const webhookPayload = { request_id, status, data };

          logger.info(`${vendorType} vendor sending webhook:`, {
            request_id,
            webhook_url: `${apiServerUrl}/vendor-webhook/${vendorType}`
          });

          await axios.post(
            `${apiServerUrl}/vendor-webhook/${vendorType}`,
            webhookPayload,
            {
              timeout: 10000,
              headers: {
                'Content-Type': 'application/json',
                'User-Agent': `MockVendor-${vendorType}/1.0`
              }
            }
          );

          logger.info(`${vendorType} vendor webhook sent successfully:`, { request_id });

        } catch (webhookError) {
          logger.error(`${vendorType} vendor webhook failed:`, {
            request_id,
            error: webhookError.message
          });

          setTimeout(async () => {
            try {
              const retryPayload = {
                request_id,
                status: 'error',
                data: { error: 'Webhook delivery failedpayload, retry attempted' }
              };

              await axios.post(
                `${apiServerUrl}/vendor-webhook/${vendorType}`,
                retryPayload,
                { timeout: 10000 }
              );

              logger.info(`${vendorType} vendor webhook retry successful:`, { request_id });
            } catch (retryError) {
              logger.error(`${vendorType} vendor webhook retry failed:`, {
                request_id,
                error: retryError.message
              });
            }
          }, 5000);
        }
      }, processingDelay);
    }

  } catch (error) {
    logger.error(`${vendorType} vendor error:`, { request_id, error: error.message });
    res.status(500).json({
      status: 'error',
      error: 'Internal server error'
    });
  }
});

app.get('/status', (req, res) => {
  res.json({
    vendor_type: vendorType,
    status: 'operational',
    uptime: process.uptime(),
    version: '1.0.0',
    rate_limit: {
      sync: '30 requests/minute',
      async: '20 requests/minute'
    }[vendorType] || 'unknown',
    features: vendorType === 'sync'
      ? ['immediate_response', 'synchronous_processing']
      : ['webhook_delivery', 'asynchronous_processing', 'high_volume']
  });
});

app.use((err, req, res, next) => {
  logger.error('Mock vendor error:', err);
  res.status(500).json({
    status: 'error',
    error: 'Internal server error'
  });
});

app.listen(port, () => {
  logger.info(`Mock ${vendorType} vendor running on port ${port}`);
});

export default app;
