/**
 * M3 · 完成/失败通知（不依赖 FCM —— 国内 FCM 不通 ✗）。
 *
 * 做法：提交任务后弹一条**前台服务**通知（"正在处理…"），它会让 App 进程保持存活 ✓，
 * 于是我们的 JS 里那个轮询定时器能继续跑 ✓；状态变成 ok/error/timeout 时，
 * 停掉前台服务并把通知替换成结果 ✓。
 *
 * 已知限制（如实记录）：如果用户把 App 从后台**彻底划掉** ✗，进程没了 → 通知不会来 ✗。
 * 要彻底可靠只能上厂商推送（小米/华为/OPPO/vivo 各自注册 ✗）—— 对"提交后等 1~3 分钟"够用 ✓。
 */
import notifee, { AndroidForegroundServiceType, AndroidImportance } from '@notifee/react-native';

const CHANNEL_ID = 'pdf-tasks';
const WATCH_NOTIFICATION_ID = 'watching-task';

export async function ensureReady(): Promise<void> {
  try {
    await notifee.requestPermission();
    await notifee.createChannel({ id: CHANNEL_ID, name: '任务进度', importance: AndroidImportance.DEFAULT });
  } catch {
    /* 用户拒绝通知权限也不能让 App 崩 ✗ */
  }
}

export async function notifyResult(ok: boolean, detail: string): Promise<void> {
  try {
    await notifee.displayNotification({
      title: ok ? '✅ 处理完成' : '❌ 处理失败',
      body: detail,
      android: { channelId: CHANNEL_ID, pressAction: { id: 'default' } },
    });
  } catch { /* 忽略 */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 盯着一个任务；结束时弹结果通知。返回一个取消函数。 */
export function watchTask(options: {
  taskId: string;
  server: string;
  token: string;
  onDone?: (status: string) => void;
}): () => void {
  let stopped = false;

  const run = async () => {
    await ensureReady();
    let started = false;
    try {
      await notifee.displayNotification({
        id: WATCH_NOTIFICATION_ID,
        title: '试卷工坊正在处理…',
        body: '完成后会通知你（可以退出 App）',
        android: {
          channelId: CHANNEL_ID,
          asForegroundService: true,
          ongoing: true,
          importance: AndroidImportance.LOW,
          foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
          pressAction: { id: 'default' },
        },
      });
      started = true;
    } catch { /* 前台服务起不来也继续轮询 ✓ */ }

    while (!stopped) {
      await sleep(5000);
      if (stopped) { break; }
      try {
        const res = await fetch(`${options.server}/api/task/${encodeURIComponent(options.taskId)}`, {
          headers: { Authorization: `Bearer ${options.token}` },
        });
        const body = (await res.json()) as { status?: string };
        const status = String(body?.status ?? '');
        if (status === 'ok' || status === 'error' || status === 'timeout') {
          if (started) { try { await notifee.stopForegroundService(); } catch { /* 忽略 */ } }
          await notifyResult(status === 'ok', status === 'ok' ? '点开查看并转发到微信' : '点开看看原因');
          options.onDone?.(status);
          return;
        }
      } catch { /* 网络抖动：下一轮再试 ✓ */ }
    }
    if (started) { try { await notifee.stopForegroundService(); } catch { /* 忽略 */ } }
  };

  void run();
  return () => { stopped = true; };
}
