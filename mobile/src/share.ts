/**
 * M2 · 接收"微信里分享过来的 PDF"。
 *
 * 用 expo-share-intent：它的 config plugin 负责原生 intent-filter（app.json 里那 3 条 ✓），
 * 并把分享进来的文件暴露成可读的 uri ✓ —— 我们自己不用写 Kotlin ✓。
 *
 * 注意：`expo-file-system/legacy` 用的是老 API（readAsStringAsync ✓）。
 * SDK 54+ 虽然推了新的 File/Directory API，但老 API 仍可用且更稳 ✓ —— 这里刻意选它 ✓。
 */
import { useCallback, useEffect, useRef } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import { useShareIntent } from 'expo-share-intent';

export interface SharedPdf {
  name: string;
  base64: string;
}

export function useSharedPdf(onReady: (file: SharedPdf) => void): { clear: () => void } {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({ debug: false });
  const busy = useRef(false);

  useEffect(() => {
    if (!hasShareIntent || busy.current) {
      return;
    }
    const files = Array.isArray(shareIntent?.files) ? shareIntent.files : [];
    const first = files[0] as { path?: string; fileName?: string | null } | undefined;
    if (first?.path === undefined) {
      resetShareIntent();
      return;
    }
    busy.current = true;
    const name = typeof first.fileName === 'string' && first.fileName !== '' ? first.fileName : '分享的文件.pdf';
    FileSystem.readAsStringAsync(first.path, { encoding: FileSystem.EncodingType.Base64 })
      .then(base64 => { onReady({ name, base64 }); })
      .catch(() => { /* 读不到就忽略，不弹假错误 */ })
      .finally(() => { busy.current = false; resetShareIntent(); });
  }, [hasShareIntent, shareIntent, onReady, resetShareIntent]);

  return { clear: useCallback(() => resetShareIntent(), [resetShareIntent]) };
}
