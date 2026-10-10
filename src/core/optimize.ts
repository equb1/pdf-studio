/**
 * 体积与结构优化：垃圾回收（对象流/重压缩/清理未引用资源）与线性化（Web 快速打开）。
 *
 * ## 为什么走 qpdf
 *
 * 这几件事都是**对象层的重写**，自己实现等于重写一个 PDF 写出器；而插件早已依赖 qpdf
 * （`src/core/qpdf.ts`，用于结构校验），复用它是"零新增重依赖"的选择。qpdf 的能力在真机上
 * 逐个探过：`--linearize`、`--object-streams=generate`、`--compress-streams=y --recompress-flate`、
 * `--remove-unreferenced-resources=yes` 都 exit 0。
 *
 * ## 实测的诚实预期
 *
 * 对**图片占主导**的文档，优化通常只省 ~2%（1256KB → 1228–1230KB）——因为大头是已经压过的
 * 图片流。所以结果里会同时给出"优化前后字节数"与"省了多少"，**不承诺"大幅瘦身"**；
 * 真正想大幅变小，得走 `pdf_images action=export`（降采样/转 JPEG）那条路。
 */

import { runQpdf } from './qpdf.ts'

/** 优化档位。 */
export type OptimizeProfile = 'gc' | 'linearize' | 'both'

/** 各档位对应的 qpdf 参数。 */
export function profileArgs(profile: OptimizeProfile): string[] {
  const gc = ['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--remove-unreferenced-resources=yes']
  switch (profile) {
    case 'gc': return gc
    case 'linearize': return ['--linearize']
    case 'both': return [...gc, '--linearize']
  }
}

/**
 * 跑一次优化，返回新字节与诊断文本。
 *
 * 注意 qpdf 的 `rewrite` 模式下结果在 `bytes` 里，`output` 只是诊断信息（早前踩过这个坑）。
 */
export async function optimizePdf(
  bytes: Uint8Array,
  profile: OptimizeProfile,
): Promise<{ bytes: Uint8Array; diagnostics: string }> {
  const result = await runQpdf(profileArgs(profile), bytes, 'rewrite')
  if (result.exit !== 0 || result.bytes === undefined) {
    throw new Error(`优化失败（qpdf exit ${result.exit}）：${result.output.slice(0, 200)}`)
  }
  return { bytes: result.bytes, diagnostics: result.output }
}

/** 人类可读的体积变化描述。 */
export function describeSaving(before: number, after: number): { text: string; ratio: number } {
  const ratio = before === 0 ? 0 : (before - after) / before
  const percent = (ratio * 100).toFixed(1)
  if (after >= before) return { text: `体积没有变小（${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB）`, ratio }
  return {
    text: `体积 ${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB，省了 ${percent}%`,
    ratio,
  }
}
