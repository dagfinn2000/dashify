import express from 'express';
import { readFileSync, watchFile } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config', 'config.yaml');
const PORT = process.env.PORT || 6969;

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

let config = loadConfig();

function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    return yaml.load(raw);
  } catch (e) {
    console.error('Failed to load config:', e.message);
    return { title: 'Dashify', groups: [], refresh_interval: 30, columns: 3, theme: 'dark' };
  }
}

watchFile(CONFIG_PATH, () => {
  console.log('Config reloaded');
  config = loadConfig();
});

async function checkService(service) {
  if (!service.check) return { status: 'unknown' };

  const checkUrl = service.check_path
    ? new URL(service.check_path, service.url).href
    : service.url;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(checkUrl, {
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);
    return { status: res.ok || res.status < 400 ? 'up' : 'down', code: res.status };
  } catch (e) {
    clearTimeout(timeout);
    return { status: 'down', error: e.name === 'AbortError' ? 'timeout' : 'unreachable' };
  }
}

app.get('/api/config', (_req, res) => {
  res.json(config);
});

app.get('/api/status', async (_req, res) => {
  const results = {};

  const checks = config.groups?.flatMap(group =>
    (group.services || [])
      .filter(s => s.check)
      .map(async s => {
        const key = `${group.name}::${s.name}`;
        results[key] = await checkService(s);
      })
  ) ?? [];

  await Promise.allSettled(checks);
  res.json(results);
});

app.listen(PORT, () => {
  console.log(`Dashify running on http://0.0.0.0:${PORT}`);
});
