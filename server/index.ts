import { createAccountApp, loadConfig } from './app';

const config = loadConfig(process.env);
const port = Number(process.env.PORT ?? 8787);
const app = createAccountApp({ config });
app.listen(port, '0.0.0.0', () => {
  console.log(`World Builder server listening on port ${port}.`);
  if (!config) console.log('Google account storage is not configured. See docs/GOOGLE_ACCOUNT.md.');
});
