/**
 * 把"地址 + 口令"从**代码里**挪到**环境变量** ✗→✓
 *
 * 为什么必须这么做：这两个值是**你这台电脑的钥匙** ✗ —— 写进 App.tsx 就会被提交进 git ✗。
 * 现在：本地放 `.env`（已 gitignore ✓ 不提交 ✓），云端构建用 `eas env:create` 注入 ✓。
 */
import type { ExpoConfig } from 'expo/config';

export default ({ config }: { config: ExpoConfig }): ExpoConfig => ({
  ...config,
  extra: {
    ...(config.extra ?? {}),
    // 构建时注入；缺失也只是页面连不上，不会崩 ✓
    server: process.env.EXPO_PUBLIC_SERVER ?? '',
    token: process.env.EXPO_PUBLIC_TOKEN ?? '',
  },
});
