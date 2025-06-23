import mongoose from 'mongoose';

const jobSchema = new mongoose.Schema({
  request_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'complete', 'failed'],
    default: 'pending',
    index: true
  },
  vendor: {
    type: String,
    enum: ['sync', 'async'],
    index: true
  },
  result: {
    type: mongoose.Schema.Types.Mixed
  },
  error_message: {
    type: String
  },
  retry_count: {
    type: Number,
    default: 0
  },
  created_at: {
    type: Date,
    default: Date.now,
    index: true
  },
  updated_at: {
    type: Date,
    default: Date.now
  },
  started_processing_at: {
    type: Date
  },
  completed_at: {
    type: Date
  },
  failed_at: {
    type: Date
  },
  vendor_response_received_at: {
    type: Date
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

jobSchema.index({ status: 1, created_at: 1 });
jobSchema.index({ vendor: 1, status: 1 });

jobSchema.index({ 
  updated_at: 1 
}, { 
  expireAfterSeconds: 30 * 24 * 60 * 60,
  partialFilterExpression: { 
    status: { $in: ['complete', 'failed'] }
  }
});

export default mongoose.model('Job', jobSchema);