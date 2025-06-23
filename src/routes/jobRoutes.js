import { Router } from 'express';
import { createJob, getJob,vendorWebhook } from '../controllers/jobController.js';

const router = Router();

router.post('/jobs', createJob);
router.get('/jobs/:request_id', getJob);
router.post('/vendor-webhook/:vendor', vendorWebhook);

export default router;