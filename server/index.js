// Ложа — свой маленький кинозал. Точка входа.
import http from 'node:http';
import https from 'node:https';
import { PORT, HTTPS_PORT, USE_HTTPS, APP_NAME, HOST, TRUST_PROXY, lanAddresses, DEV_TOKEN } from './config.js';
import { checkTools, installHelp, tools, refreshYtdlp, scheduleYtdlpUpdates } from './tools.js';
import { killAllChildren, reapOrphans } from './procs.js';
import { ensureOwner } from './auth.js';
import { handle } from './http.js';
import * as hub from './hub.js';
import { registerRoutes } from './routes.js';
import { initRooms, saveRoomsNow } from './rooms.js';
import { recover } from './queue.js';
import { cleanupUploads } from './uploads.js';
import { ensureCert } from './cert.js';
import { log } from './util.js';

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => { server.off('error', reject); resolve(); });
  });
}

async function main() {
  console.log(`\n  ${APP_NAME} — свой маленький кинозал\n`);

  const missing = await checkTools();
  if (missing.length) {
    for (const line of installHelp(missing)) console.log(`  ${line}`);
    console.log('');
    if (missing.includes('ffmpeg') || missing.includes('ffprobe')) process.exit(1);
  }

  const orphans = reapOrphans();
  if (orphans) log(`остановлены процессы, оставшиеся от прошлого запуска: ${orphans}`);
  await ensureOwner();
  initRooms();
  await recover();
  await cleanupUploads();
  registerRoutes();

  const servers = [];
  const tune = (s) => { s.requestTimeout = 0; s.keepAliveTimeout = 65000; servers.push(s); return s; };

  const plain = tune(http.createServer(handle));
  hub.attach(plain);
  try { await listen(plain, PORT); } catch (e) {
    if (e.code === 'EADDRINUSE') console.error(`  Порт ${PORT} уже занят. Останови другую программу или запусти так: PORT=3001 npm start`);
    else console.error('  Не удалось запустить сервер:', e.message);
    process.exit(1);
  }

  const local = /^(127\.|localhost$|::1$)/.test(HOST);
  const lan = local ? [] : lanAddresses();
  console.log(local ? `  Сервер слушает только этот компьютер (${HOST})${TRUST_PROXY ? ' — снаружи его открывает обратный прокси' : ''}:` : '  Открой в браузере:');
  console.log(`    http://localhost:${PORT}`);
  for (const ip of lan) console.log(`    http://${ip}:${PORT}      ← с телефона в той же сети`);

  if (USE_HTTPS) {
    const cert = ensureCert();
    const secure = tune(https.createServer({ key: cert.key, cert: cert.cert }, handle));
    hub.attach(secure);
    try {
      await listen(secure, HTTPS_PORT);
      console.log('\n  HTTPS (нужен голосовому чату на телефоне):');
      console.log(`    https://localhost:${HTTPS_PORT}`);
      for (const ip of lan) console.log(`    https://${ip}:${HTTPS_PORT}     ← с телефона`);
      console.log('  Сертификат самоподписанный: браузер предупредит один раз —');
      console.log('  нажми «Дополнительно» → «Перейти на сайт» (в Safari: «Подробнее» → «Посетить сайт»).');
    } catch (e) {
      console.error(`  HTTPS не запустился на порту ${HTTPS_PORT}: ${e.code === 'EADDRINUSE' ? 'порт занят (задай HTTPS_PORT=…)' : e.message}`);
    }
  } else if (!local) {
    console.log('\n  Голосовой чат с телефона требует HTTPS: запусти  npm run https');
  }
  console.log('');
  log(`ffmpeg: ${tools.ffmpeg}`);
  log(tools.ytdlp ? `yt-dlp ${tools.ytdlpVersion}: ${tools.ytdlp}` : 'yt-dlp не найден — загрузка по ссылке отключена');
  if (DEV_TOKEN) log('включён режим автопроверки (LOZHA_DEV_TOKEN)');

  // yt-dlp всегда свежий: проверяем при старте и потом раз в несколько часов.
  refreshYtdlp({ force: true }).catch(() => {});
  scheduleYtdlpUpdates();

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    saveRoomsNow();
    killAllChildren();
    for (const s of servers) s.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
}

process.on('unhandledRejection', (e) => log('необработанная ошибка:', e));
process.on('uncaughtException', (e) => {
  log('непойманное исключение:', e);
  if (e?.code === 'EADDRINUSE') process.exit(1);
});

main().catch((e) => { console.error(e); process.exit(1); });
