import { buildApp } from './wire.js';

const port = Number(process.env.PORT ?? 8787);
buildApp().listen(port, () => console.log(`tool server on http://localhost:${port}`));
