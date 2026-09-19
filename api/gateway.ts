import { createVercelGateway } from '../server/vercel-gateway.js';

export default createVercelGateway({ backendUrl: process.env.POG_BACKEND_URL });
