import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { Root } from './app/Root';
import { bootstrap } from './bootstrap';
import './index.css';

const root = document.getElementById('root');
if (root) {
  bootstrap().catch((err) => {
    console.error('bootstrap failed', err);
  });
  createRoot(root).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
