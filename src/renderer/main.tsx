import { createRoot } from 'react-dom/client';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Renderer mount point #root not found in index.html');
createRoot(root).render(<h1>KyDog booting…</h1>);
