import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const jobCreationErrorRate = new Rate('job_creation_errors');
const jobStatusErrorRate = new Rate('job_status_errors');
const jobCompletionTime = new Trend('job_completion_time');

export const options = {
  stages: [
    { duration: '10s', target: 50 },   
    { duration: '40s', target: 200 },  
    { duration: '60s', target: 200 },  
    { duration: '10s', target: 0 },    
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'], 
    http_req_failed: ['rate<0.05'],    
    job_creation_errors: ['rate<0.02'], 
    job_status_errors: ['rate<0.02'],   
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

const samplePayloads = [
  { 
    user_id: 'user_123', 
    operation: 'data_enrichment',
    parameters: { depth: 'full', include_social: true }
  },
  { 
    customer_id: 'cust_456', 
    operation: 'risk_assessment',
    parameters: { model_version: 'v2.1', threshold: 0.7 }
  },
  { 
    entity: 'company', 
    entity_id: 'comp_789',
    operation: 'compliance_check',
    parameters: { jurisdiction: 'US', include_sanctions: true }
  },
  { 
    transaction_id: 'txn_999', 
    operation: 'fraud_detection',
    parameters: { real_time: true, models: ['ml_v3', 'rule_engine'] }
  },
  { 
    account_id: 'acc_111', 
    operation: 'credit_scoring',
    parameters: { bureau_sources: ['experian', 'equifax'], include_history: true }
  }
];

let createdJobs = [];

export default function () {
  const shouldCreateJob = Math.random() < 0.7; 
  
  if (shouldCreateJob || createdJobs.length === 0) {
    createJob();
  } else {
    checkJobStatus();
  }
  
  sleep(Math.random() * 2 + 0.5); 
}

function createJob() {
  const payload = samplePayloads[Math.floor(Math.random() * samplePayloads.length)];
  
  payload.timestamp = new Date().toISOString();
  payload.request_source = 'load_test';
  payload.test_id = Math.random().toString(36).substring(7);
  
  const response = http.post(
    `${BASE_URL}/jobs`,
    JSON.stringify(payload),
    {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: '30s',
    }
  );
  
  const success = check(response, {
    'job creation status is 201': (r) => r.status === 201,
    'job creation response has request_id': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body && body.request_id;
      } catch (e) {
        return false;
      }
    },
    'job creation response time < 2s': (r) => r.timings.duration < 2000,
  });
  
  if (!success) {
    jobCreationErrorRate.add(1);
  } else {
    jobCreationErrorRate.add(0);
    try {
      const body = JSON.parse(response.body);
      if (body.request_id) {
        createdJobs.push({
          request_id: body.request_id,
          created_at: Date.now()
        });
        
        // Keep only last 1000 jobs to prevent memory issues
        if (createdJobs.length > 1000) {
          createdJobs = createdJobs.slice(-1000);
        }
      }
    } catch (e) {
      console.log('Error parsing job creation response:', e);
    }
  }
}

function checkJobStatus() {
  if (createdJobs.length === 0) return;
  
  const jobIndex = Math.floor(Math.random() * createdJobs.length);
  const job = createdJobs[jobIndex];
  
  const response = http.get(
    `${BASE_URL}/jobs/${job.request_id}`,
    {
      timeout: '10s',
    }
  );
  
  const success = check(response, {
    'job status check is 200 or 404': (r) => r.status === 200 || r.status === 404,
    'job status response time < 1s': (r) => r.timings.duration < 1000,
    'job status response has valid structure': (r) => {
      if (r.status === 404) return true; 
      try {
        const body = JSON.parse(r.body);
        return body && body.request_id && body.status;
      } catch (e) {
        return false;
      }
    },
  });
  
  if (!success) {
    jobStatusErrorRate.add(1);
  } else {
    jobStatusErrorRate.add(0);
    
    if (response.status === 200) {
      try {
        const body = JSON.parse(response.body);
        if (body.status === 'complete' || body.status === 'failed') {
          const completionTime = Date.now() - job.created_at;
          jobCompletionTime.add(completionTime);
          
          createdJobs.splice(jobIndex, 1);
        }
      } catch (e) {
        console.log('Error parsing job status response:', e);
      }
    }
  }
}

export function setup() {
  console.log('Starting load test against:', BASE_URL);
  
  const healthResponse = http.get(`${BASE_URL}/health`, { timeout: '10s' });
  
  if (healthResponse.status !== 200) {
    throw new Error(`API health check failed: ${healthResponse.status}`);
  }
  
  console.log('API health check passed, starting load test...');
}

export function teardown(data) {
  console.log('Load test completed');
  console.log(`Jobs still being tracked: ${createdJobs.length}`);
  
  if (createdJobs.length > 0) {
    console.log('Checking final status of remaining jobs...');
    let completedCount = 0;
    let failedCount = 0;
    let processingCount = 0;
    
    for (const job of createdJobs.slice(0, 10)) { // Check first 10 jobs
      const response = http.get(`${BASE_URL}/jobs/${job.request_id}`);
      if (response.status === 200) {
        try {
          const body = JSON.parse(response.body);
          if (body.status === 'complete') completedCount++;
          else if (body.status === 'failed') failedCount++;
          else processingCount++;
        } catch (e) {
        }
      }
    }
    
    console.log(`Final job status sample (first 10): Complete: ${completedCount}, Failed: ${failedCount}, Processing: ${processingCount}`);
  }
}