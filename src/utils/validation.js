import Joi from 'joi';

const jobPayloadSchema = Joi.object({
}).unknown(true).min(1); 

const webhookPayloadSchema = Joi.object({
  request_id: Joi.string().uuid().required(),
  status: Joi.string().valid('success', 'error').required(),
  data: Joi.object().unknown(true).optional(),
  error: Joi.string().optional()
});

export const validateJobPayload = (payload) => {
  return jobPayloadSchema.validate(payload, { 
    abortEarly: false,
    stripUnknown: false
  });
};

export const validateWebhookPayload = (payload) => {
  return webhookPayloadSchema.validate(payload, { 
    abortEarly: false 
  });
};
