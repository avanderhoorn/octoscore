import { createRoot } from 'react-dom/client';
import { Options } from '../../options/Options';
import './options.css';

const el = document.getElementById('root');
if (el) createRoot(el).render(<Options />);
