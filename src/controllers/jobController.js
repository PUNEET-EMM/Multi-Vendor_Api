import { v4 as uuidv4 } from 'uuid';
import Job from '../models/Job.js';
import { validateJobPayload } from '../utils/validation.js';
import { getRedisClient } from '../config/redis.js';
import logger from '../utils/logger.js';



export const createJob = async (req, res) => {
    const requestId = uuidv4();
    req.requestId = requestId;

    const { error, value } = validateJobPayload(req.body);
    if (error) {
        logger.warn('Invalid job payload:', { error: error.details, requestId });
        return res.status(400).json({ error: 'Invalid payload', details: error.details, request_id: requestId });
    }

    const job = new Job({ request_id: requestId, payload: value, status: 'pending' });
    await job.save();
    logger.info('Job created:', { requestId });

    const queuePayload = { request_id: requestId, payload: value, created_at: new Date().toISOString() };
    await getRedisClient().lPush('job_queue', JSON.stringify(queuePayload));
    logger.info('Job queued:', { requestId });

    res.status(201).json({ request_id: requestId });
};




export const getJob = async (req, res) => {
    const { request_id } = req.params;
    const job = await Job.findOne({ request_id });

    if (!job) return res.status(404).json({ error: 'Job not found', request_id });

    const response = { request_id, status: job.status, created_at: job.created_at, updated_at: job.updated_at };
    if (job.status === 'complete') response.result = job.result;
    else if (job.status === 'failed') response.error = job.error_message;

    res.json(response);
};

export const vendorWebhook = async (req, res) => {
    const { vendor } = req.params;
    const { request_id, data, status } = req.body;
    logger.info('Vendor webhook received:', { vendor, request_id, status });

    const job = await Job.findOne({ request_id });
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (status === 'success' && data) {
        job.result = cleanVendorData(data);
        job.status = 'complete';
        job.completed_at = new Date();
    } else {
        job.status = 'failed';
        job.error_message = data?.error || 'Vendor failed';
        job.failed_at = new Date();
    }
    job.updated_at = new Date();
    job.vendor_response_received_at = new Date();
    await job.save();
    res.json({ success: true, request_id, status: job.status });
};

function cleanVendorData(data) {
    if (!data || typeof data !== 'object') return data;
    const cleaned = { ...data };
    ['ssn', 'password', 'credit_card'].forEach(f => delete cleaned[f]);
    Object.keys(cleaned).forEach(key => {
        if (typeof cleaned[key] === 'string') cleaned[key] = cleaned[key].trim();
        else if (typeof cleaned[key] === 'object') cleaned[key] = cleanVendorData(cleaned[key]);
    });
    return cleaned;
}