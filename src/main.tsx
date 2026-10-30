import './styles/globals.css'; // first: declares the cascade-layer order
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { registerStudioWorker } from './pwa/register';
import { slugFromPath } from './lib/tenant';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

const slug = slugFromPath();
if (slug) registerStudioWorker(slug);
