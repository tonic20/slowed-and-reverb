import { defineBackground } from 'wxt/utils/define-background';
import { registerWorker } from '../utils/service-worker.js';
export default defineBackground(registerWorker);
