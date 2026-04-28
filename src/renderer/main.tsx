import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { AppShell } from './app/AppShell';
import { bootstrap } from './bootstrap';
import './index.css';

const root = document.getElementById('root');
if (root) {
  bootstrap().catch((err) => {
    console.error('bootstrap failed', err);
  });
  createRoot(root).render(
    <StrictMode>
      <AppShell />
    </StrictMode>,
  );
}
