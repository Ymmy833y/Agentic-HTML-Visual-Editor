import { startView } from './bootstrap/view-bootstrap';

// Start exactly once when the bundle loads. The host sends the body only after receiving this
// notification, so do not delay startup until after user interaction.
startView(window);
