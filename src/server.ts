// vercel's express support wants src/server.ts (or app/index) to import express and
// default-export the app, so the real app gets mounted on a thin top-level one here
import express from 'express';
import { buildApp } from './wire.js';

const app = express();
app.use(buildApp());

export default app;
